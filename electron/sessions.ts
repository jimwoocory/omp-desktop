import { constants } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { JsonObject, SessionRecord } from '../shared/contracts.js';
import { messageText, object, objectSchema, text } from '../shared/validation.js';
import { redactSecrets, sanitizeForDesktop } from './rpc.js';

const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const ARCHIVE_PAGE_BYTES = 4 * 1024 * 1024;
const ARCHIVE_RECORD_BYTES = 32 * 1024 * 1024 - 8192;
const CHILD_PARENT_MISMATCH = 'Child journal does not match the stored parent session identity';
const headerSchema = z.object({
  type: z.literal('session'), id: z.string().min(1), cwd: z.string().optional(),
  version: z.number().int().positive().optional(),
  timestamp: z.string().optional(), title: z.string().optional(),
  additionalDirectories: z.array(z.string()).optional(),
  parentSession: z.string().optional(), previousSessionFiles: z.array(z.string()).optional(),
}).passthrough();
const titleSlotSchema = z.object({ type: z.literal('title'), v: z.literal(1), title: z.string(), updatedAt: z.string() });
const titleChangeSchema = z.object({ type: z.literal('title_change'), title: z.string(), timestamp: z.string() });
const childInitSchema = z.object({
  type: z.literal('session_init'), agent: z.string().min(1),
  task: z.string().optional(), resolvedModel: z.string().optional(), modelRole: z.string().optional(),
});

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function within(root: string, file: string): boolean {
  const relative = path.relative(pathKey(root), pathKey(file));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function report(file: string, error: unknown): void {
  // Never log the malformed record itself: a journal can contain credentials or provider replay data.
  console.warn(`Skipping unreadable OMP session ${redactSecrets(file)}: ${redactSecrets(error instanceof Error ? error.message : 'invalid session file').slice(0, 2000)}`);
}
function displayText(value: string, length: number): string {
  return redactSecrets(value).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length);
}

async function visitRecords(file: string, visit: (entry: JsonObject, startByte: number, endByte: number) => boolean | void, options: { start?: number; completeOnly?: boolean; maxRecordBytes?: number } = {}): Promise<number> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const stream = handle.createReadStream({ autoClose: false, start: options.start ?? 0 });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let parts: Buffer[] = [];
  let bytes = 0;
  let lineNumber = 0;
  let cursor = options.start ?? 0;
  let finished = false;
  const consume = (terminated = true): void => {
    lineNumber++;
    const startByte = cursor;
    cursor += bytes + (terminated ? 1 : 0);
    const line = decoder.decode(parts.length === 1 ? parts[0] : Buffer.concat(parts, bytes)).trim();
    parts = []; bytes = 0;
    if (!line) return;
    let entry: JsonObject;
    try { entry = objectSchema.parse(JSON.parse(line)); }
    catch { throw new Error(`Malformed JSON object at record ${lineNumber}`); }
    if (visit(entry, startByte, cursor) === false) finished = true;
  };
  try {
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const part = chunk.subarray(offset, end);
        bytes += part.length;
        if (bytes > (options.maxRecordBytes ?? MAX_RECORD_BYTES)) throw new Error(`Record ${lineNumber + 1} exceeds the journal reader byte limit`);
        if (part.length) parts.push(part);
        if (newline < 0) break;
        consume(); offset = newline + 1;
        if (finished) break;
      }
      if (finished) break;
    }
    if (bytes && !options.completeOnly && !finished) consume(false);
    return cursor;
  } finally { stream.destroy(); await handle.close(); }
}

async function readCanonicalHeader(file: string): Promise<z.infer<typeof headerSchema>> {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Parent session journal is not an ordinary file');
  const parsed: { header?: z.infer<typeof headerSchema> } = {};
  await visitRecords(file, entry => {
    if (entry.type === 'title') { titleSlotSchema.parse(entry); return; }
    parsed.header = headerSchema.parse(entry); return false;
  }, { completeOnly: true });
  if (!parsed.header) throw new Error('Missing canonical parent session header');
  return parsed.header;
}

async function belongsToParent(child: z.infer<typeof headerSchema>, parentFile: string, parent: z.infer<typeof headerSchema>): Promise<boolean> {
  const stored = child.parentSession;
  if (!stored) return false;
  const references = [parentFile, parent.id, ...(parent.previousSessionFiles ?? []), ...(parent.parentSession ? [parent.parentSession] : [])];
  if (references.some(reference => reference === stored || (reference.endsWith('.jsonl') && stored.endsWith('.jsonl') && pathKey(reference) === pathKey(stored)))) return true;
  // Whole-session forks copy artifact journals unchanged; verify their recorded parent id against that lineage.
  if (stored.endsWith('.jsonl') && parent.parentSession) {
    try {
      const original = await readCanonicalHeader(stored);
      return original.id === parent.parentSession;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return false;
}

async function readSession(file: string, managedRoots: string[], wanted?: string): Promise<SessionRecord | undefined> {
  const metadata = await stat(file);
  const parsed: { header?: z.infer<typeof headerSchema> } = {};
  let hasTitleSlot = false;
  let title = '';
  let titleTime = -Infinity;
  let firstPrompt = '';
  let fallback = '';
  let preview = '';
  let messageCount = 0;
  let records = 0;
  let isSubagent = false;
  await visitRecords(file, entry => {
    const type = text(entry.type);
    if (!type) throw new Error('A session record has no type');
    records++;
    if (type === 'title') {
      if (records !== 1) throw new Error('Title slot is not the first record');
      const slot = titleSlotSchema.parse(entry);
      const timestamp = Date.parse(slot.updatedAt);
      if (!Number.isFinite(timestamp)) throw new Error('Title slot has an invalid update timestamp');
      hasTitleSlot = true; titleTime = timestamp; title = slot.title;
      return;
    }
    if (type === 'session') {
      if (parsed.header) throw new Error('Multiple session headers');
      parsed.header = headerSchema.parse(entry);
      if (!hasTitleSlot && !title) title = parsed.header.title ?? '';
      return;
    }
    if (!parsed.header) throw new Error('Missing canonical session header');
    if (type === 'session_init' && typeof entry.agent === 'string' && entry.agent.trim()) {
      childInitSchema.parse(entry); isSubagent = true;
    }
    if (type === 'title_change') {
      const change = titleChangeSchema.parse(entry);
      const timestamp = Date.parse(change.timestamp);
      if (!Number.isFinite(timestamp)) throw new Error('Title change has an invalid timestamp');
      if (!hasTitleSlot || timestamp >= titleTime) {
        title = change.title; titleTime = timestamp;
      }
    }
    if (type !== 'message') return;
    const message = object(entry.message);
    if (!text(message.role)) throw new Error('Message record has no message role');
    messageCount++;
    if (message.role === 'user' || message.role === 'assistant') {
      const content = displayText(messageText(message), 280);
      if (content) {
        fallback ||= content;
        if (message.role === 'user') firstPrompt ||= content;
        preview = content;
      }
    }
  });
  const header = parsed.header;
  if (!header) throw new Error('Missing canonical session header');
  if (isSubagent) {
    const parentFile = `${path.dirname(path.resolve(file))}.jsonl`;
    try {
      const parent = await readCanonicalHeader(parentFile);
      if (await belongsToParent(header, parentFile, parent)) return undefined;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') report(parentFile, error);
    }
  }
  if (wanted && ![header.cwd ?? '', ...(header.additionalDirectories ?? [])].some(directory => directory && pathKey(directory) === wanted)) return undefined;
  return {
    id: header.id, name: displayText(title || firstPrompt || fallback || 'Untitled conversation', 100),
    path: path.resolve(file), workspace: header.cwd ?? '', updatedAt: metadata.mtime.toISOString(),
    preview, messageCount, managed: managedRoots.some(root => within(root, file)),
  };
}

async function readChildMetadata(file: string, parentFile: string, parent: z.infer<typeof headerSchema>): Promise<JsonObject | undefined> {
  const metadata = await stat(file);
  const parsed: { header?: z.infer<typeof headerSchema>; init?: z.infer<typeof childInitSchema> } = {};
  await visitRecords(file, entry => {
    if (entry.type === 'title') { titleSlotSchema.parse(entry); return; }
    if (entry.type === 'session') {
      if (parsed.header) throw new Error('Multiple child session headers');
      parsed.header = headerSchema.parse(entry); return;
    }
    if (!parsed.header) throw new Error('Missing canonical child session header');
    if (entry.type === 'session_init' && typeof entry.agent === 'string' && entry.agent.trim()) {
      parsed.init = childInitSchema.parse(entry); return false;
    }
  }, { completeOnly: true });
  if (!parsed.header) throw new Error('Missing canonical child session header');
  if (!parsed.init) return undefined;
  if (!(await belongsToParent(parsed.header, parentFile, parent))) throw new Error(CHILD_PARENT_MISMATCH);
  const id = z.string().min(1).parse(path.basename(file, '.jsonl'));
  return {
    id, sessionId: parsed.header.id,
    agent: parsed.init.agent, sessionFile: path.resolve(file), workspace: parsed.header.cwd ?? '',
    updatedAt: metadata.mtime.toISOString(), lastUpdate: metadata.mtimeMs,
    ...(parsed.init.task ? { task: displayText(parsed.init.task, 4000) } : {}),
    ...(parsed.init.resolvedModel ? { resolvedModel: parsed.init.resolvedModel } : {}),
    ...(parsed.init.modelRole ? { modelRole: parsed.init.modelRole } : {}),
    status: 'archived', live: false, canControl: false,
  };
}

/** Direct child journals belong to the real parent journal's artifact stem, not a global session pool. */
export async function listSubagentSessionFiles(parentSessionFile: string): Promise<JsonObject[]> {
  if (!parentSessionFile.endsWith('.jsonl')) throw new Error('OMP parent session must be a canonical .jsonl journal');
  const directory = path.resolve(parentSessionFile.slice(0, -6));
  let entries;
  let parent: z.infer<typeof headerSchema>;
  try {
    parent = await readCanonicalHeader(parentSessionFile);
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Subagent archive root is not an ordinary directory');
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw new Error(`Cannot read subagent archive ${redactSecrets(directory)}: ${redactSecrets(error instanceof Error ? error.message : 'filesystem error')}`);
  }
  const result: JsonObject[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.jsonl')) continue;
    const file = path.join(directory, entry.name);
    try {
      if ((await lstat(file)).isSymbolicLink()) continue;
      const child = await readChildMetadata(file, parentSessionFile, parent);
      if (child) result.push(child);
    } catch (error) { report(file, error); }
  }
  return result.sort((left, right) => text(left.id).localeCompare(text(right.id)));
}

/** Read actual completed JSONL records with native RPC byte-cursor semantics, never follow archive links. */
export async function readSubagentTranscript(parentSessionFile: string, sessionFile: string, fromByte = 0): Promise<JsonObject> {
  const start = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(fromByte);
  if (!parentSessionFile.endsWith('.jsonl')) throw new Error('OMP parent session must be a canonical .jsonl journal');
  const directory = path.resolve(parentSessionFile.slice(0, -6));
  const file = path.resolve(sessionFile);
  if (pathKey(path.dirname(file)) !== pathKey(directory) || !file.endsWith('.jsonl')) throw new Error('Subagent transcript is outside this parent session archive');
  const rootInfo = await lstat(directory);
  const fileInfo = await lstat(file);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || fileInfo.isSymbolicLink() || !fileInfo.isFile()) throw new Error('Subagent archive links are not followed');
  const parent = await readCanonicalHeader(parentSessionFile);
  if (!(await readChildMetadata(file, parentSessionFile, parent))) throw new Error('Journal is not a canonical subagent session');
  const reset = start > fileInfo.size;
  const offset = reset ? 0 : start;
  const entries: JsonObject[] = [];
  let acceptedByte = offset;
  let hasMore = false;
  const readByte = await visitRecords(file, (entry, _startByte, endByte) => {
    if (entry.type === 'message' && !text(object(entry.message).role)) throw new Error('Archived message record has no canonical role');
    if (entries.length && endByte - offset > ARCHIVE_PAGE_BYTES) { hasMore = true; return false; }
    entries.push(entry); acceptedByte = endByte;
  }, { start: offset, completeOnly: true, maxRecordBytes: ARCHIVE_RECORD_BYTES });
  const nextByte = hasMore ? acceptedByte : readByte;
  const result = object(sanitizeForDesktop({ sessionFile: file, fromByte: offset, nextByte, reset, hasMore, entries, messages: entries.filter(entry => entry.type === 'message').map(entry => object(entry.message)) }));
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024 * 1024) throw new Error('Archived subagent response exceeds the core 64 MiB logical transport limit');
  return result;
}

/** Read canonical journals without mutating indexes, migrating files, or following directory links. */
export async function listSessionFiles(roots: string[], workspace?: string, managedRoots: string[] = []): Promise<SessionRecord[]> {
  const sessions: SessionRecord[] = [];
  const visited = new Map<string, boolean>();
  const wanted = workspace ? pathKey(workspace) : undefined;
  const scan = async (directory: string, root: boolean): Promise<void> => {
    const key = pathKey(directory);
    if (visited.has(key)) return;
    let entries;
    try {
      const info = await lstat(directory);
      if (info.isSymbolicLink()) { report(directory, new Error('Symbolic-link roots are not followed')); return; }
      if (!info.isDirectory()) throw new Error('Session root is not a directory');
      entries = await readdir(directory, { withFileTypes: true });
      visited.set(key, true);
    } catch (error) {
      if (root && error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      if (root) throw new Error(`Cannot read session root ${directory}: ${error instanceof Error ? error.message : 'filesystem error'}`);
      report(directory, error); return;
    }
    const parentFile = `${directory}.jsonl`;
    let parent: z.infer<typeof headerSchema> | undefined;
    try { parent = await readCanonicalHeader(parentFile); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') report(parentFile, error);
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await scan(file, false); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        // Re-check the file itself before opening, and use O_NOFOLLOW where supported.
        if ((await lstat(file)).isSymbolicLink()) continue;
        if (parent) {
          try { if (await readChildMetadata(file, parentFile, parent)) continue; }
          catch (error) {
            if (!(error instanceof Error) || error.message !== CHILD_PARENT_MISMATCH) throw error;
          }
        }
        const record = await readSession(file, managedRoots, wanted);
        if (record) sessions.push(record);
      } catch (error) { report(file, error); }
    }
  };
  for (const root of roots) await scan(path.resolve(root), true);
  return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.path.localeCompare(right.path));
}
