import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { DesktopEvent, Json, JsonObject, OwnerSnapshot, RpcCommand, RpcFrame } from '../shared/contracts.js';
import { array, commandSchema, flag, messageText, number, object, objectSchema, text } from '../shared/validation.js';
import { listSubagentSessionFiles, readSubagentTranscript } from './sessions.js';

const PHYSICAL_LIMIT = 1024 * 1024;
const LOGICAL_LIMIT = 64 * 1024 * 1024;
const CHUNK_LIMIT = 256 * 1024;
const STDERR_LIMIT = 16 * 1024;
const frameSchema = z.object({ type: z.string().min(1) }).catchall(z.json());
const stateSchema = z.object({
  sessionId: z.string().min(1), sessionFile: z.string().min(1),
  isStreaming: z.boolean(), isCompacting: z.boolean(), isSettled: z.boolean(),
  hasPendingAsyncWork: z.boolean(), queuedMessageCount: z.number().int().nonnegative(),
}).catchall(z.json());
const settingsStateSchema = stateSchema.extend({ sessionFile: z.string().min(1).optional() });
const chunkSchema = z.object({
  type: z.literal('rpc_chunk'), chunkId: z.string().min(1).max(128),
  index: z.number().int().nonnegative(), count: z.number().int().min(2).max(256),
  byteLength: z.number().int().min(PHYSICAL_LIMIT).max(LOGICAL_LIMIT),
  data: z.string().min(1).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
const uiResponseSchema = z.union([
  z.object({ type: z.literal('extension_ui_response'), id: z.string().min(1), cancelled: z.literal(true), timedOut: z.boolean().optional() }),
  z.object({ type: z.literal('extension_ui_response'), id: z.string().min(1), confirmed: z.boolean() }),
  z.object({ type: z.literal('extension_ui_response'), id: z.string().min(1), value: z.string() }),
  z.object({ type: z.literal('extension_ui_response'), id: z.string().min(1), answers: z.array(z.object({ id: z.string(), selectedOptions: z.array(z.string()), customInput: z.string().optional() })) }),
]);
const authorizationUrlSchema = z.string().min(1).refine(value => {
  if (/[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password;
  } catch { return false; }
}, 'Authorization handoff must be an HTTP/HTTPS URL without embedded credentials');
const openUrlRequestSchema = z.object({
  type: z.literal('extension_ui_request'), method: z.literal('open_url'), id: z.string().min(1),
  url: authorizationUrlSchema, launchUrl: authorizationUrlSchema.optional(),
});
const HIDDEN_FIELDS: Record<string, true> = {
  systemprompt: true, accountaccess: true, credentials: true, credential: true, apikey: true,
  accesstoken: true, refreshtoken: true, idtoken: true, password: true, clientsecret: true, secret: true, token: true,
  authorization: true, headers: true, cookie: true, cookies: true, providerpayload: true,
  providermetadata: true, requestcontrols: true, fallbackcredithandle: true, fallbackcreditredemption: true,
  encryptedcontent: true, thinkingsignature: true, thoughtsignature: true, textsignature: true,
  providerpromptcachekey: true, providerfile: true, replay: true, replaypayload: true,
};
const DIALOG_METHODS: Record<string, true> = { ask: true, select: true, confirm: true, input: true, editor: true };
const SESSION_COMMANDS: Record<string, true> = { new_session: true, switch_session: true, open_session: true, branch: true, fork: true };
const REFRESH_COMMANDS: Record<string, true> = {
  set_model: true, cycle_model: true, set_thinking_level: true, cycle_thinking_level: true,
  set_fast_mode: true, set_slow_mode: true, set_steering_mode: true, set_follow_up_mode: true,
  set_interrupt_mode: true, set_auto_compaction: true, set_session_name: true, set_todos: true,
  compact: true, handoff: true, goal: true, steer: true, follow_up: true, remove_queued_message: true,
  promote_queued_message: true, abort: true, abort_and_restore_queue: true, bash: true, abort_bash: true,
};
const UNTIMED_COMMANDS: Record<string, true> = {
  prompt: true, abort_and_prompt: true, bash: true, compact: true, handoff: true, login: true,
};
const WORK_COMMANDS: Record<string, true> = {
  prompt: true, abort_and_prompt: true, steer: true, follow_up: true, bash: true,
  compact: true, handoff: true, goal: true, live_start: true,
};
const SETTINGS_COMMANDS: Record<string, true> = {
  get_state: true, get_login_providers: true, login: true,
  get_logout_accounts: true, logout: true, get_available_models: true,
};

/** Redacts recognizable authentication material, not arbitrary source code or model token counts. */
export function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:sk-(?:proj-|ant-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*[=:]\s*["']?)[^\s,"';&]+/gi, '$1[redacted]')
    .replace(/([?&](?:code|token|access_token|refresh_token|api_key)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]');
}

const diagnosticModelSelectorSchema = z.string().max(321).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/);

/** Classifies only known pre-ready failures; never returns arbitrary stderr or provider payloads. */
export function classifyStartupFailure(stderr: string): string | undefined {
  const lines = stderr.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/);
  for (const line of lines) {
    const restored = line.match(/^\s*(?:error:?\s+)?Could not restore model ([^\s]+)\s*$/i);
    if (restored) {
      const selector = diagnosticModelSelectorSchema.safeParse(restored[1]);
      if (selector.success) {
        const provider = selector.data.slice(0, selector.data.indexOf('/'));
        return redactSecrets(`Could not restore model ${selector.data}. Sign in to ${provider} or restore that provider's credential configuration, then reopen the saved conversation. The saved model was not changed.`);
      }
    }
    if (/^\s*(?:error:?\s+)?No default model selected(?:[.:]|\s|$)/i.test(line)) {
      return 'No default model selected. Open Settings > Runtime to choose an initial provider/model, then configure that provider or sign in. An initial model is used only for new conversations; saved conversations keep their recorded model.';
    }
  }
  return undefined;
}

/** The renderer is a display boundary, never a provider-native replay or authentication boundary. */
export function sanitizeForDesktop(value: Json): Json {
  const handoff = value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.type === 'extension_ui_request' && value.method === 'open_url'
    ? openUrlRequestSchema.parse(value) : undefined;
  return sanitizeValue(value, handoff);
}

function sanitizeValue(value: Json, handoff?: z.infer<typeof openUrlRequestSchema>): Json {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item));
  if (value === null || typeof value !== 'object') return value;
  if (value.type === 'redactedThinking' || value.type === 'anthropicServerTool') return { type: text(value.type), omitted: true };
  const cleaned: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (HIDDEN_FIELDS[key.replace(/[_-]/g, '').toLowerCase()] || key.startsWith('__')) continue;
    if (handoff && key === 'url') cleaned[key] = handoff.url;
    else if (handoff && key === 'launchUrl' && handoff.launchUrl !== undefined) cleaned[key] = handoff.launchUrl;
    else cleaned[key] = sanitizeValue(item);
  }
  return cleaned;
}

const subagentRowsSchema = z.array(z.object({
  id: z.string().min(1), status: z.string().optional(), sessionFile: z.string().optional(),
}).catchall(z.json()));
const TERMINAL_SUBAGENT_STATUSES: Record<string, true> = { completed: true, failed: true, aborted: true };
const SUBAGENT_LOOKUP_MISS = /^Unknown subagent(?: or session file unavailable:.*| session file)$/;

/** Core's live registry is not a history: retain observed terminal states and canonical archived journals. */
export function mergeSubagentRoster(retained: JsonObject[], records: JsonObject[], source: 'live' | 'event' | 'archive'): JsonObject[] {
  const merged = new Map<string, JsonObject>();
  for (const record of retained) {
    const id = text(record.id);
    if (!id) throw new Error('Retained subagent has no identity');
    const copy = { ...record };
    if (source === 'live') {
      copy.live = false; copy.canControl = false;
      if (!TERMINAL_SUBAGENT_STATUSES[text(copy.status)]) copy.status = 'archived';
    }
    merged.set(id, copy);
  }
  for (const record of subagentRowsSchema.parse(records)) {
    const existing = merged.get(record.id);
    const status = record.status === 'started' ? 'running' : text(record.status) || text(existing?.status) || 'archived';
    if (source === 'archive') {
      merged.set(record.id, {
        ...record, ...existing, id: record.id,
        sessionFile: text(existing?.sessionFile) || text(record.sessionFile),
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        status: text(existing?.status) || 'archived', live: flag(existing?.live), canControl: flag(existing?.canControl),
      });
    } else {
      const active = status === 'running' || status === 'pending';
      const sessionFile = text(record.sessionFile) || text(existing?.sessionFile);
      merged.set(record.id, {
        ...existing, ...record, id: record.id,
        sessionFile, status,
        live: source === 'live' || active, canControl: active && Boolean(sessionFile),
      });
    }
  }
  return [...merged.values()];
}

/** Strict bounded JSONL decoder, including lossless protocol-v2 logical frames. */
export class RpcFrameDecoder {
  maxFrameBytes = PHYSICAL_LIMIT;
  maxReassembledFrameBytes = LOGICAL_LIMIT;
  private parts: Buffer[] = [];
  private lineBytes = 0;
  private pending?: { id: string; count: number; length: number; next: number; bytes: number; parts: Buffer[] };
  private utf8 = new TextDecoder('utf-8', { fatal: true });

  acceptReady(frame: RpcFrame): void {
    const ready = z.object({
      type: z.literal('ready'), protocolVersion: z.literal(1),
      supportedProtocolVersions: z.array(z.number().int()),
      maxFrameBytes: z.number().int().min(256).max(PHYSICAL_LIMIT),
      maxReassembledFrameBytes: z.number().int().min(PHYSICAL_LIMIT).max(LOGICAL_LIMIT),
    }).parse(frame);
    if (!ready.supportedProtocolVersions.includes(2)) throw new Error('OMP must support lossless RPC protocol v2');
    this.maxFrameBytes = ready.maxFrameBytes;
    this.maxReassembledFrameBytes = ready.maxReassembledFrameBytes;
  }

  write(chunk: Buffer, receive: (frame: RpcFrame) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      this.lineBytes += part.length;
      if (this.lineBytes + 1 > this.maxFrameBytes) throw new Error('OMP stdout frame exceeds the physical transport limit');
      if (part.length) this.parts.push(part);
      if (newline < 0) return;
      const bytes = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.lineBytes);
      this.parts = []; this.lineBytes = 0;
      let frame: RpcFrame;
      try { frame = frameSchema.parse(JSON.parse(this.utf8.decode(bytes))); }
      catch { throw new Error('OMP emitted an invalid UTF-8 JSON object'); }
      const decoded = this.push(frame);
      if (decoded) receive(decoded);
      offset = newline + 1;
    }
  }

  push(frame: RpcFrame): RpcFrame | undefined {
    if (frame.type !== 'rpc_chunk') {
      if (this.pending) throw new Error('OMP rpc_chunk sequence was interrupted');
      return frameSchema.parse(frame);
    }
    const chunk = chunkSchema.parse(frame);
    if (chunk.index >= chunk.count || chunk.byteLength > this.maxReassembledFrameBytes) throw new Error('Invalid OMP rpc_chunk metadata');
    const bytes = Buffer.from(chunk.data, 'base64');
    if (bytes.length > CHUNK_LIMIT || bytes.toString('base64') !== chunk.data) throw new Error('Invalid OMP rpc_chunk payload');
    if (!this.pending) {
      if (chunk.index !== 0) throw new Error('OMP rpc_chunk sequence must start at zero');
      this.pending = { id: chunk.chunkId, count: chunk.count, length: chunk.byteLength, next: 0, bytes: 0, parts: [] };
    }
    const pending = this.pending;
    if (pending.id !== chunk.chunkId || pending.count !== chunk.count || pending.length !== chunk.byteLength || pending.next !== chunk.index) {
      throw new Error('OMP rpc_chunk sequence metadata or index mismatch');
    }
    pending.bytes += bytes.length;
    pending.next++;
    pending.parts.push(bytes);
    if (pending.bytes > pending.length) throw new Error('OMP rpc_chunk sequence exceeds its declared byte length');
    if (pending.next < pending.count) return undefined;
    if (pending.bytes !== pending.length) throw new Error('OMP rpc_chunk sequence byte length mismatch');
    this.pending = undefined;
    let decoded: RpcFrame;
    try { decoded = frameSchema.parse(JSON.parse(this.utf8.decode(Buffer.concat(pending.parts, pending.bytes)))); }
    catch { throw new Error('Reassembled OMP frame is not a valid UTF-8 JSON object'); }
    if (decoded.type === 'rpc_chunk') throw new Error('Nested OMP rpc_chunk frames are forbidden');
    return decoded;
  }

  finish(): void {
    if (this.pending || this.lineBytes) throw new Error('OMP stdout ended with an incomplete RPC frame');
  }
}

interface PendingRequest {
  command: string; resolve: (data: Json) => void; reject: (error: Error) => void; archiveFallback?: boolean;
  timer?: NodeJS.Timeout;
}
interface Owner {
  id: string; workspace: string; directory: string; sessionPath?: string;
  status: OwnerSnapshot['status']; state: RpcFrame; messages: RpcFrame[];
  pendingUi: Map<string, RpcFrame>; requests: Map<string, PendingRequest>; prompts: Map<string, boolean>;
  loginHandoffs: Map<string, RpcFrame>;
  messageIndices: Map<string, number>; activeTools: Map<string, string>;
  child?: ChildProcessWithoutNullStreams; decoder: RpcFrameDecoder; sequence: number; requestSequence: number;
  error?: string; stderr: string; stderrPending: string; stderrDecoder: StringDecoder;
  readyResolve?: () => void; readyReject?: (error: Error) => void; hasReady: boolean;
  exit: Promise<void>; exitResolve: () => void; stopping: boolean; closing: boolean; explicitStop: boolean;
  refresh?: NodeJS.Timeout; refreshing?: Promise<void>; changed: boolean; needsHistory?: boolean; historyRevision: number;
  needsSubagentDiscovery?: boolean;
}
export interface OwnerManagerOptions {
  getExecutable: () => string; sessionsRoot: string; emit: (event: DesktopEvent) => void;
  getInitialModel?: () => string | undefined;
  settingsOnly?: boolean;
}

export class OwnerManager {
  private owners = new Map<string, Owner>();
  private paths = new Map<string, string>();
  private openings = new Map<string, Promise<OwnerSnapshot>>();
  private shuttingDown = false;
  private restarting = false;
  constructor(private readonly options: OwnerManagerOptions) {}

  async create(workspace: string, resumePath?: string): Promise<OwnerSnapshot> {
    if (this.shuttingDown || this.restarting) throw new Error('OMP owners are shutting down or restarting');
    if (this.options.settingsOnly && resumePath) throw new Error('Settings runtime cannot resume conversations');
    const resolvedWorkspace = await realpath(path.resolve(workspace));
    if (!(await stat(resolvedWorkspace)).isDirectory()) throw new Error('Workspace is not a directory');
    const resolvedResume = resumePath ? await realpath(path.resolve(resumePath)) : undefined;
    if (resolvedResume && !(await stat(resolvedResume)).isFile()) throw new Error('Resume path must be an exact session file');
    if (this.shuttingDown || this.restarting) throw new Error('OMP owners are shutting down or restarting');
    const key = resolvedResume ? this.pathKey(resolvedResume) : undefined;
    if (key) {
      const opening = this.openings.get(key);
      if (opening) return opening;
      const existing = this.paths.get(key);
      if (existing) {
        const owner = this.requireOwner(existing);
        if (owner.status !== 'closed' && owner.status !== 'error') return this.snapshot(existing);
      }
    }
    const id = randomUUID();
    const directory = path.resolve(this.options.sessionsRoot, id);
    let exitResolve: () => void = () => {};
    const owner: Owner = {
      id, workspace: resolvedWorkspace, directory, sessionPath: resolvedResume, status: 'starting', state: {}, messages: [],
      pendingUi: new Map(), loginHandoffs: new Map(), requests: new Map(), prompts: new Map(), messageIndices: new Map(), activeTools: new Map(),
      decoder: new RpcFrameDecoder(), sequence: 0, requestSequence: 0,
      stderr: '', stderrPending: '', stderrDecoder: new StringDecoder('utf8'),
      exit: new Promise<void>(resolve => { exitResolve = resolve; }), exitResolve: () => exitResolve(),
      stopping: false, closing: false, explicitStop: false, changed: false, hasReady: false, historyRevision: 0,
    };
    this.owners.set(id, owner);
    if (key) this.paths.set(key, id);
    const opening = (async () => {
      try {
        if (!this.options.settingsOnly) await mkdir(directory, { recursive: true });
        await this.start(owner, resolvedResume);
        return this.snapshot(id);
      } catch (error) {
        this.fail(owner, error instanceof Error ? error.message : 'Could not create the managed session directory');
        throw new Error(owner.error);
      }
    })();
    if (key) this.openings.set(key, opening);
    try { return await opening; }
    finally { if (key) this.openings.delete(key); }
  }
  has(id: string): boolean {
    return this.owners.has(id);
  }


  snapshots(): OwnerSnapshot[] {
    return [...this.owners.values()].filter(owner => owner.status !== 'closed').map(owner => this.snapshot(owner.id));
  }
  snapshot(id: string): OwnerSnapshot {
    const owner = this.requireOwner(id);
    return structuredClone({
      id: owner.id, workspace: owner.workspace, status: owner.status,
      state: {
        ...owner.state, desktopBusy: this.busy(owner),
        ...(this.options.settingsOnly ? { desktopLoginPending: [...owner.requests.values()].some(request => request.command === 'login') } : {}),
      },
      messages: owner.messages, pendingUi: [...owner.pendingUi.values(), ...owner.loginHandoffs.values()],
      ...(owner.error ? { error: owner.error } : {}),
    });
  }

  async request(id: string, raw: RpcCommand): Promise<Json> {
    const owner = this.requireOwner(id);
    if (owner.status !== 'ready' || owner.closing || this.shuttingDown || this.restarting) throw new Error('OMP session is not accepting commands');
    const command = commandSchema.parse(raw);
    if (this.options.settingsOnly && !SETTINGS_COMMANDS[command.type]) throw new Error(`Settings runtime does not allow ${command.type}`);
    if (this.options.settingsOnly && (command.type === 'login' || command.type === 'logout')
      && [...owner.requests.values()].some(request => request.command === 'login' || request.command === 'logout')) {
      throw new Error('Wait for the pending account operation to finish or cancel it');
    }
    if (SESSION_COMMANDS[command.type] && this.busy(owner)) throw new Error('Stop active work before changing the session');
    if (command.type === 'switch_session') {
      const target = await realpath(path.resolve(text(command.sessionPath)));
      const other = this.paths.get(this.pathKey(target));
      if (other && other !== id && this.requireOwner(other).status !== 'closed') throw new Error('That session already has an owner; focus its conversation instead');
    }
    if (WORK_COMMANDS[command.type]) owner.explicitStop = false;
    const isStop = command.type === 'abort' || command.type === 'abort_and_restore_queue';
    if (isStop) this.cancelUi(owner);
    let data: Json | undefined;
    try {
      data = command.type === 'get_subagent_messages'
        ? await this.readSubagentMessages(owner, command)
        : await this.send(owner, command, UNTIMED_COMMANDS[command.type] ? 0 : 120_000);
      if (isStop) owner.explicitStop = true;
      if (SESSION_COMMANDS[command.type] && !flag(object(data).cancelled)) {
        owner.prompts.clear(); owner.messageIndices.clear();
        await this.hydrate(owner);
      } else if ((command.type === 'prompt' && object(data).agentInvoked === false)
        || command.type === 'compact' || command.type === 'handoff'
        || command.type === 'bash' || command.type === 'abort_bash') await this.hydrate(owner);
      else if (REFRESH_COMMANDS[command.type]) await this.refreshState(owner);
      else if (command.type === 'get_state' && owner.needsHistory) await this.loadHistory(owner);
      return data;
    } finally {
      if (command.type === 'bash') {
        const result = object(data);
        this.emit(owner, {
          type: 'desktop_command_complete', command: 'bash',
          success: result.exitCode === 0 && !flag(result.cancelled) && !flag(result.timedOut),
        });
        this.notify(owner);
      }
    }
  }

  reply(id: string, raw: RpcFrame): void {
    const owner = this.requireOwner(id);
    if ((owner.status !== 'ready' && owner.status !== 'starting') || !owner.hasReady || owner.closing) throw new Error('OMP session is not accepting UI replies');
    const response = uiResponseSchema.parse(raw);
    const pending = owner.pendingUi.get(response.id);
    if (!pending) throw new Error('The requested approval or question is no longer pending');
    const method = text(pending.method);
    if (!('cancelled' in response)) {
      if (method === 'confirm' && !('confirmed' in response)) throw new Error('Approval requires a boolean confirmation');
      if (method === 'ask' && !('answers' in response)) throw new Error('Ask dialog requires question answers');
      if ((method === 'select' || method === 'input' || method === 'editor') && !('value' in response)) throw new Error('Dialog requires a text value');
      if (method === 'select' && 'value' in response && !array(pending.options).includes(response.value)) throw new Error('Select value is not an available option');
      if (method === 'ask' && 'answers' in response) {
        const questions = array(pending.questions).map(object);
        if (questions.length !== response.answers.length) throw new Error('Every ask question must be answered');
        for (let index = 0; index < questions.length; index++) {
          const question = questions[index]; const answer = response.answers[index];
          if (answer.id !== text(question.id)) throw new Error('Ask question IDs or order do not match');
          const options = array(question.options).map(option => text(object(option).label));
          if (answer.selectedOptions.some(option => !options.includes(option))) throw new Error('Ask answer contains an unavailable option');
          if (!flag(question.multi) && answer.selectedOptions.length > 1) throw new Error('Ask question accepts one selected option');
        }
      }
    }
    this.writeFrame(owner, response);
    owner.pendingUi.delete(response.id);
    this.notify(owner);
  }

  async cancelSettingsLogin(id: string, raw: RpcFrame): Promise<void> {
    if (!this.options.settingsOnly) throw new Error('Conversation owners cannot be cancelled through settings authorization');
    const owner = this.requireOwner(id);
    const response = uiResponseSchema.parse(raw);
    if (!('cancelled' in response) || !owner.pendingUi.has(response.id)) throw new Error('The requested authorization prompt is no longer pending');
    const login = [...owner.requests].find(([, pending]) => pending.command === 'login');
    if (!login) throw new Error('No settings authorization is pending');
    const [requestId, pending] = login;
    owner.requests.delete(requestId); clearTimeout(pending.timer);
    this.clearLoginUi(owner);
    try {
      // Native Codex keeps its browser callback alive after dismissing manual input.
      // This ephemeral actor owns no chat journal or model work; stop only this actor.
      owner.child?.kill('SIGKILL');
      await this.stop(owner, false);
    } finally { pending.resolve({ cancelled: true }); }
  }

  async close(id: string): Promise<void> {
    const owner = this.requireOwner(id);
    if (owner.status === 'closed') return;
    if (owner.status === 'starting') throw new Error('Wait for OMP initialization before closing this conversation');
    if (owner.status === 'error') {
      await this.stop(owner, false);
      owner.status = 'closed'; this.notify(owner); return;
    }
    if (this.busy(owner) || owner.pendingUi.size > 0) {
      if (!owner.explicitStop) throw new Error('Stop active work before closing this conversation');
      await this.stop(owner, true); return;
    }
    await this.refreshState(owner);
    const active = this.busy(owner) || owner.pendingUi.size > 0;
    if (active && !owner.explicitStop) throw new Error('Stop active work before closing this conversation');
    await this.stop(owner, active);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all([...this.owners.values()].map(owner => this.stop(owner, true)));
    for (const owner of this.owners.values()) {
      if (owner.status !== 'error') owner.status = 'closed';
      this.notify(owner);
    }
  }

  assertIdle(): void {
    if (this.shuttingDown || this.restarting) throw new Error('OMP runtime is already shutting down or restarting');
    const live = [...this.owners.values()].filter(owner => owner.status !== 'closed');
    if (live.some(owner => owner.status === 'starting' || (owner.stopping && owner.child))) throw new Error('Wait for OMP startup or shutdown before restarting');
    if (live.some(owner => this.busy(owner) || owner.pendingUi.size || owner.requests.size)) throw new Error('Stop all work and answer or cancel pending dialogs before restarting');
  }

  async restartAll(): Promise<void> {
    this.assertIdle();
    this.restarting = true;
    try {
      const live = [...this.owners.values()].filter(owner => owner.status !== 'closed');
      if (live.some(owner => owner.status === 'starting' || (owner.stopping && owner.child))) throw new Error('Wait for OMP startup or shutdown before restarting');
      if (live.some(owner => this.busy(owner) || owner.pendingUi.size || owner.requests.size)) throw new Error('Stop all work and answer or cancel pending dialogs before restarting');
      await Promise.all(live.map(owner => this.refreshState(owner)));
      if (this.shuttingDown) throw new Error('OMP runtime shutdown cancelled its restart');
      if (live.some(owner => this.busy(owner) || owner.pendingUi.size || owner.requests.size)) throw new Error('Stop all work and answer or cancel pending dialogs before restarting');
      const resumePaths = new Map<string, string | undefined>();
      await Promise.all(live.map(async owner => {
        if (!owner.sessionPath) { resumePaths.set(owner.id, undefined); return; }
        try {
          if (!(await stat(owner.sessionPath)).isFile()) throw new Error('The saved OMP session path is not a file');
          resumePaths.set(owner.id, owner.sessionPath);
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
          // Core's allocated journal can remain absent for an empty conversation: restart it as genuinely fresh.
          resumePaths.set(owner.id, undefined);
        }
      }));
      if (this.shuttingDown) throw new Error('OMP runtime shutdown cancelled its restart');
      for (const owner of live) { owner.status = 'starting'; this.notify(owner); }
      await Promise.all(live.map(owner => this.stop(owner, false, true)));
      if (this.shuttingDown) throw new Error('OMP runtime shutdown cancelled its restart');
      await Promise.all(live.map(async owner => {
        owner.stopping = false; owner.closing = false; owner.status = 'starting'; owner.error = undefined;
        owner.hasReady = false;
        owner.decoder = new RpcFrameDecoder(); owner.stderr = ''; owner.stderrPending = ''; owner.stderrDecoder = new StringDecoder('utf8');
        owner.exit = new Promise<void>(resolve => { owner.exitResolve = resolve; });
        owner.messageIndices.clear(); owner.activeTools.clear(); owner.prompts.clear();
        await this.start(owner, resumePaths.get(owner.id), true);
      }));
    } finally { this.restarting = false; }
  }

  private pathKey(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
  private requireOwner(id: string): Owner {
    const owner = this.owners.get(id);
    if (!owner) throw new Error('Unknown OMP conversation');
    return owner;
  }
  private busy(owner: Owner): boolean {
    if (owner.status === 'error' || owner.status === 'closed') return false;
    if (owner.status === 'starting') return true;
    return flag(owner.state.isStreaming) || flag(owner.state.isCompacting) || flag(owner.state.hasPendingAsyncWork)
      || flag(owner.state.isRetrying) || number(owner.state.queuedMessageCount) > 0 || owner.prompts.size > 0 || owner.activeTools.size > 0
      || [...owner.requests.values()].some(request => request.command === 'login' || request.command === 'bash' || request.command === 'compact' || request.command === 'handoff');
  }

  private async start(owner: Owner, resumePath?: string, restarted = false): Promise<void> {
    if (this.shuttingDown) throw new Error('OMP runtime has been disposed');
    this.notify(owner);
    const ready = new Promise<void>((resolve, reject) => { owner.readyResolve = resolve; owner.readyReject = reject; });
    const timer = setTimeout(() => this.fail(owner, 'OMP did not emit its ready frame within 90 seconds'), 90_000);
    const args = ['--mode', 'rpc-ui', '--approval-mode', 'always-ask'];
    if (this.options.settingsOnly) args.push('--no-session', '--no-tools');
    else args.push('--session-dir', owner.directory);
    if (resumePath) args.push('--resume', resumePath);
    let child: ChildProcessWithoutNullStreams;
    try {
      if (!resumePath) {
        // Resumed conversations keep their saved model; fresh owners use the configured selector.
        const initialModel = this.options.getInitialModel?.()?.trim();
        if (initialModel) args.push('--model', initialModel);
      }
      child = spawn(this.options.getExecutable(), args, { cwd: owner.workspace, windowsHide: true, shell: false, stdio: 'pipe' });
    }
    catch (error) {
      clearTimeout(timer); owner.readyResolve = undefined; owner.readyReject = undefined; owner.exitResolve();
      this.fail(owner, `Cannot start OMP: ${error instanceof Error ? redactSecrets(error.message) : 'invalid executable'}`);
      throw new Error(owner.error);
    }
    owner.child = child;
    child.stdout.on('data', (chunk: Buffer) => {
      if (owner.status === 'error') return; // Keep the pipe flowing even after a fatal decode failure.
      try { owner.decoder.write(chunk, frame => this.receive(owner, frame)); }
      catch { this.fail(owner, 'OMP transport failed: malformed, interrupted, or oversized UTF-8 JSONL frame'); }
    });
    child.stderr.on('data', (chunk: Buffer) => this.consumeStderr(owner, owner.stderrDecoder.write(chunk)));
    child.stderr.on('end', () => { this.consumeStderr(owner, owner.stderrDecoder.end()); this.consumeStderr(owner, '\n'); });
    child.stdout.on('end', () => {
      if (owner.status === 'error') return;
      try { owner.decoder.finish(); }
      catch { this.fail(owner, 'OMP stdout ended with an incomplete RPC frame'); }
    });
    child.stdout.on('error', () => this.fail(owner, 'OMP stdout pipe failed'));
    child.stderr.on('error', () => this.fail(owner, 'OMP stderr pipe failed'));
    child.stdin.on('error', () => { if (!owner.stopping) this.fail(owner, 'OMP stdin pipe failed'); });
    child.on('error', error => this.fail(owner, `Cannot start OMP: ${redactSecrets(error.message)}`));
    child.on('close', (code, signal) => {
      owner.child = undefined;
      owner.exitResolve();
      const startupFailure = !owner.hasReady ? classifyStartupFailure(`${owner.stderr}${owner.stderrPending}`) : undefined;
      if (startupFailure && owner.status === 'error') {
        owner.error = startupFailure;
        this.emit(owner, { type: 'owner_error', message: startupFailure }); this.notify(owner);
      }
      if (!owner.stopping && owner.status !== 'error') {
        this.fail(owner, startupFailure ?? `OMP exited unexpectedly (${signal ?? `code ${code ?? 'unknown'}`}); stderr diagnostics are retained privately, not exposed as chat or replay data`);
      } else if (owner.stopping && code !== 0 && code !== null && owner.status !== 'error') {
        this.fail(owner, `OMP failed during shutdown (code ${code}); stderr diagnostics are retained privately`);
      }
      this.rejectPending(owner, new Error(owner.error ?? 'OMP session closed'));
    });
    try {
      await ready;
      if (this.shuttingDown) throw new Error('OMP runtime shutdown cancelled startup');
      await this.send(owner, { type: 'negotiate_protocol', protocolVersion: 2 });
      await this.send(owner, { type: 'set_ask_dialog', enabled: true });
      if (!this.options.settingsOnly) {
        await this.send(owner, { type: 'set_subagent_subscription', level: 'events' });
        await this.send(owner, { type: 'set_event_filter', events: null, messageUpdates: 'full' });
        await this.hydrate(owner);
      } else await this.refreshState(owner);
      if (this.shuttingDown) throw new Error('OMP runtime shutdown cancelled startup');
      owner.status = 'ready';
      this.emit(owner, { type: 'owner_ready', restarted });
      this.notify(owner);
    } catch (error) {
      this.fail(owner, error instanceof Error ? error.message : 'OMP initialization failed');
      throw new Error(owner.error);
    } finally { clearTimeout(timer); owner.readyResolve = undefined; owner.readyReject = undefined; }
  }

  private writeFrame(owner: Owner, frame: RpcFrame): void {
    const child = owner.child;
    if (!child || child.stdin.destroyed || child.stdin.writableEnded) throw new Error('OMP stdin is closed');
    const serialized = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(serialized) > owner.decoder.maxFrameBytes) throw new Error(`Command exceeds OMP's ${owner.decoder.maxFrameBytes}-byte input limit`);
    if (child.stdin.writableLength + Buffer.byteLength(serialized) > 4 * PHYSICAL_LIMIT) throw new Error('OMP command input is backpressured; wait for accepted commands to drain');
    child.stdin.write(serialized, error => { if (error && !owner.stopping) this.fail(owner, 'OMP command could not be written to stdin'); });
  }

  private send(owner: Owner, command: RpcCommand, timeout = 120_000, archiveFallback = false): Promise<Json> {
    if (owner.requests.size >= 256) return Promise.reject(new Error('Too many outstanding OMP requests'));
    const id = text(command.id) || `${owner.id}:${++owner.requestSequence}`;
    if (id.length > 256 || owner.requests.has(id) || owner.prompts.has(id)) return Promise.reject(new Error('OMP request ID is invalid or already active'));
    const prompt = command.type === 'prompt' || command.type === 'abort_and_prompt';
    return new Promise<Json>((resolve, reject) => {
      const pending: PendingRequest = { command: command.type, resolve, reject, archiveFallback };
      if (timeout > 0) pending.timer = setTimeout(() => {
        owner.requests.delete(id);
        reject(new Error(`OMP ${command.type} did not respond within ${Math.round(timeout / 1000)} seconds`));
        this.emit(owner, { type: 'owner_error', message: `OMP ${command.type} request timed out` });
        this.notify(owner);
      }, timeout);
      owner.requests.set(id, pending);
      if (prompt) owner.prompts.set(id, false);
      this.notify(owner);
      try { this.writeFrame(owner, { ...command, id }); }
      catch (error) {
        owner.requests.delete(id); owner.prompts.delete(id); clearTimeout(pending.timer);
        reject(error instanceof Error ? error : new Error('OMP command could not be sent'));
      }
    });
  }

  private receive(owner: Owner, raw: RpcFrame): void {
    if (raw.type === 'ready') {
      if (!owner.readyResolve) throw new Error('Unexpected duplicate OMP ready frame');
      owner.decoder.acceptReady(raw); owner.hasReady = true; owner.readyResolve(); owner.readyResolve = undefined;
      return;
    }
    const frame = object(sanitizeForDesktop(raw));
    const type = text(frame.type);
    if (type === 'response') {
      const response = z.object({ type: z.literal('response'), id: z.string().optional(), command: z.string(), success: z.boolean() }).passthrough().parse(frame);
      const id = response.id ?? '';
      const pending = owner.requests.get(id);
      if (pending && pending.command !== response.command) throw new Error('OMP response command does not match request ID');
      if (pending) {
        owner.requests.delete(id); clearTimeout(pending.timer);
        if (this.options.settingsOnly && pending.command === 'login') this.clearLoginUi(owner);
        if (!response.success) { owner.prompts.delete(id); pending.reject(new Error(text(frame.error, `OMP ${response.command} failed`).slice(0, 8000))); }
        else {
          if (owner.prompts.has(id)) {
            if (object(frame.data).agentInvoked === false) owner.prompts.delete(id);
            else { owner.prompts.set(id, true); owner.state.isSettled = false; }
          }
          try {
            if (response.command === 'get_state') this.applyState(owner, object(frame.data));
            if (response.command === 'get_messages') this.installHistory(owner, array(object(frame.data).messages));
            if (response.command === 'get_subagents') {
              const merged = mergeSubagentRoster(array(owner.state.subagents).map(object), array(object(frame.data).subagents).map(object), 'live');
              owner.state.subagents = merged;
              frame.data = { ...object(frame.data), subagents: merged };
            }
            if (response.command === 'bash') {
              const result = object(frame.data);
              if (flag(result.timedOut) || (typeof result.exitCode === 'number' && result.exitCode !== 0)) {
                this.emit(owner, { type: 'owner_error', message: `Bash ${flag(result.timedOut) ? 'timed out' : `exited with code ${number(result.exitCode)}`}: ${text(result.output).slice(0, 2000)}`, requestId: id });
              }
            }
          } catch (error) {
            pending.reject(new Error('OMP returned invalid or conflicting authoritative session data'));
            throw error;
          }
          pending.resolve(frame.data ?? null);
        }
      }
      if (!response.success) {
        const message = text(frame.error, `OMP ${response.command} failed`).slice(0, 8000);
        if (!(pending?.archiveFallback && SUBAGENT_LOOKUP_MISS.test(message))) {
          this.emit(owner, { type: 'owner_error', message, requestId: id, command: response.command });
        }
      }
      // Do not broadcast history/query responses: requests return sanitized data to their own callers.
      this.notify(owner);
      return;
    }
    if (this.options.settingsOnly && type !== 'extension_ui_request' && type !== 'notice'
      && type !== 'rpc_frame_error' && type !== 'extension_error'
      && type !== 'config_update' && type !== 'model_changed') return;
    if (type === 'message_start' || type === 'message_update' || type === 'message_end') this.updateMessage(owner, frame);
    if (type === 'agent_start') { owner.state.isStreaming = true; owner.state.isSettled = false; }
    if (type === 'agent_end') {
      // message_end is authoritative; agent_end may have a compacted tail, never replace the full transcript.
      owner.state.isStreaming = false;
      owner.state.hasPendingAsyncWork = flag(frame.awaitingAsyncWork);
      this.scheduleRefresh(owner);
    }
    if (type === 'queue_update') {
      owner.state.queuedMessages = { steering: array(frame.steering), followUp: array(frame.followUp), liveSteered: number(frame.liveSteered) };
      owner.state.queuedMessageCount = array(frame.steering).length + array(frame.followUp).length;
      if (number(owner.state.queuedMessageCount)) owner.state.isSettled = false;
    }
    if (type === 'tool_execution_start') owner.activeTools.set(text(frame.toolCallId), text(frame.toolName));
    if (type === 'tool_execution_start' || type === 'tool_execution_update' || type === 'tool_execution_end') {
      const executions = array(owner.state.toolExecutions).map(object);
      const existing = executions.findIndex(item => item.toolCallId === frame.toolCallId);
      const entry = { ...(existing >= 0 ? executions[existing] : {}), ...frame };
      if (existing >= 0) executions[existing] = entry;
      else executions.push(entry);
      owner.state.toolExecutions = executions.slice(-256);
    }
    if (type === 'tool_execution_update') {
      const result = object(frame.partialResult);
      if (flag(result.isError) || object(object(result.details).async).state === 'failed') {
        this.emit(owner, { type: 'owner_error', message: `${text(frame.toolName, 'Background tool')} failed: ${messageText(result).slice(0, 2000) || 'execution reported an error'}`, toolCallId: text(frame.toolCallId) });
      }
    }
    if (type === 'tool_execution_end') {
      owner.activeTools.delete(text(frame.toolCallId));
      if (flag(frame.isError) || flag(object(frame.result).isError)) {
        const result = object(frame.result);
        this.emit(owner, { type: 'owner_error', message: `${text(frame.toolName, 'Tool')} failed: ${messageText(result).slice(0, 2000) || 'execution reported an error'}`, toolCallId: text(frame.toolCallId) });
      }
    }
    if (type === 'subagent_lifecycle' || type === 'subagent_progress') {
      const payload = object(frame.payload);
      const progress = object(payload.progress);
      const id = text(payload.id, text(progress.id));
      if (!id) throw new Error('OMP subagent event has no identity');
      owner.state.subagents = mergeSubagentRoster(array(owner.state.subagents).map(object), [{
        ...payload, id, status: text(progress.status, text(payload.status)), lastUpdate: Date.now(),
      }], 'event');
    }
    if (type === 'extension_ui_request') {
      const method = text(frame.method);
      if (method === 'cancel') {
        owner.pendingUi.delete(text(frame.targetId)); owner.loginHandoffs.delete(text(frame.targetId));
      } else if (DIALOG_METHODS[method] || (this.options.settingsOnly && method === 'open_url')) {
        const id = text(frame.id);
        if (owner.pendingUi.size + owner.loginHandoffs.size >= 256) throw new Error('OMP exceeded the pending dialog limit');
        if (!id || owner.pendingUi.has(id) || owner.loginHandoffs.has(id)) throw new Error('Invalid or duplicate OMP UI request ID');
        if (method === 'open_url') owner.loginHandoffs.set(id, frame);
        else owner.pendingUi.set(id, frame);
      }
    }
    if (type === 'prompt_result') {
      owner.prompts.delete(text(frame.id));
      if (frame.status === 'error') this.emit(owner, { type: 'owner_error', message: text(object(frame.error).message, 'OMP prompt failed'), requestId: text(frame.id) });
      if (flag(frame.sessionSettled)) this.setSettled(owner);
      this.scheduleRefresh(owner);
    }
    if (type === 'session_settled') { this.setSettled(owner); this.scheduleRefresh(owner); }
    if (type === 'auto_compaction_start') { owner.state.isCompacting = true; owner.state.isSettled = false; }
    if (type === 'auto_compaction_end') { owner.state.isCompacting = false; owner.needsHistory = true; owner.historyRevision++; this.scheduleRefresh(owner); }
    if (type === 'auto_retry_start') { owner.state.isRetrying = true; owner.state.isSettled = false; }
    if (type === 'auto_retry_end') { owner.state.isRetrying = false; this.scheduleRefresh(owner); }
    if (type === 'thinking_level_changed') owner.state.thinkingLevel = frame.thinkingLevel ?? null;
    if (type === 'config_update') {
      if (frame.model) owner.state.model = frame.model;
      if (frame.thinkingLevel) owner.state.thinkingLevel = frame.thinkingLevel;
      this.scheduleRefresh(owner);
    }
    if (type === 'session_info_update') { owner.state.sessionName = frame.title ?? null; this.scheduleRefresh(owner); }
    if (type === 'model_changed' || type === 'retry_fallback_applied' || type === 'goal_updated') this.scheduleRefresh(owner);
    if (type === 'rpc_frame_error' || type === 'extension_error' || (type === 'notice' && frame.level === 'error')) {
      this.emit(owner, { type: 'owner_error', message: text(frame.error, text(frame.message, 'OMP reported an error')) });
    }
    this.emit(owner, frame);
    this.notify(owner);
  }

  private updateMessage(owner: Owner, frame: RpcFrame): void {
    const id = text(frame.messageId);
    if (!id) throw new Error('OMP streaming message is missing messageId');
    const message = object(frame.message);
    if (!text(message.role)) throw new Error('OMP streaming message is missing its canonical message');
    let index = owner.messageIndices.get(id);
    if (index === undefined) {
      index = owner.messages.length; owner.messages.push(message); owner.messageIndices.set(id, index);
    } else owner.messages[index] = message;
    owner.state.messageCount = owner.messages.length;
    const executionFailed = (message.role === 'bashExecution' || message.role === 'pythonExecution') && typeof message.exitCode === 'number' && message.exitCode !== 0;
    if (frame.type === 'message_end' && (message.stopReason === 'error' || (message.role === 'toolResult' && flag(message.isError)) || executionFailed)) {
      this.emit(owner, { type: 'owner_error', message: text(message.errorMessage, messageText(message).slice(0, 2000) || text(message.output).slice(0, 2000) || 'Message reported a failed execution') });
    }
  }

  private setSettled(owner: Owner): void {
    owner.state.isStreaming = false; owner.state.isCompacting = false; owner.state.isRetrying = false;
    owner.state.hasPendingAsyncWork = false; owner.state.isSettled = true;
    for (const [id, admitted] of owner.prompts) if (admitted) owner.prompts.delete(id);
    owner.activeTools.clear();
  }

  private installHistory(owner: Owner, messages: Json[]): void {
    const history = messages.map(item => objectSchema.parse(item));
    const identities = new Map<string, number>();
    for (let index = 0; index < history.length; index++) {
      const message = history[index];
      identities.set(`${text(message.role)}:${number(message.timestamp, -1)}:${text(message.toolCallId)}`, index);
    }
    for (const [id, index] of owner.messageIndices) {
      const message = owner.messages[index];
      if (!message) { owner.messageIndices.delete(id); continue; }
      const next = identities.get(`${text(message.role)}:${number(message.timestamp, -1)}:${text(message.toolCallId)}`);
      if (next === undefined) owner.messageIndices.delete(id); else owner.messageIndices.set(id, next);
    }
    owner.messages = history; owner.state.messageCount = history.length;
  }

  private applyState(owner: Owner, state: RpcFrame): void {
    state = (this.options.settingsOnly ? settingsStateSchema : stateSchema).parse(state);
    if (this.options.settingsOnly) delete state.sessionFile;
    const sessionFile = text(state.sessionFile);
    if (sessionFile) {
      const key = this.pathKey(sessionFile);
      const existing = this.paths.get(key);
      if (existing && existing !== owner.id && this.requireOwner(existing).status !== 'closed' && this.requireOwner(existing).status !== 'error') {
        throw new Error('OMP switched to a session already owned by another process');
      }
      const changedSession = owner.sessionPath && this.pathKey(owner.sessionPath) !== key;
      if (changedSession) {
        owner.messages = []; owner.messageIndices.clear(); owner.activeTools.clear();
        owner.needsHistory = true; owner.historyRevision++;
        delete owner.state.subagents; delete owner.state.toolExecutions;
        owner.needsSubagentDiscovery = true;
      }
      if (owner.sessionPath && this.paths.get(this.pathKey(owner.sessionPath)) === owner.id) this.paths.delete(this.pathKey(owner.sessionPath));
      owner.sessionPath = path.resolve(sessionFile); this.paths.set(key, owner.id);
    }
    if (!this.options.settingsOnly) {
      state.subagents = owner.state.subagents ?? [];
      state.toolExecutions = owner.state.toolExecutions ?? [];
    }
    if (owner.state.lastError) state.lastError = owner.state.lastError;
    owner.state = state;
    if (flag(state.isSettled)) {
      owner.activeTools.clear();
      for (const [id, admitted] of owner.prompts) if (admitted) owner.prompts.delete(id);
    }
  }

  private async loadHistory(owner: Owner): Promise<void> {
    const revision = owner.historyRevision;
    try { await this.send(owner, { type: 'get_messages' }); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('RPC response exceeded the transport limit')) throw error;
      // Oversized histories are retrieved using core's stable snapshot cursors, not truncated or fabricated.
      const messages: Json[] = [];
      let cursor = '';
      let total: number | undefined;
      do {
        const page = object(await this.send(owner, { type: 'get_messages_page', limit: 256, ...(cursor ? { cursor } : {}) }));
        const parsed = z.object({ messages: z.array(objectSchema), totalMessages: z.number().int().nonnegative(), nextCursor: z.string().nullable().optional() }).parse(page);
        if (total !== undefined && total !== parsed.totalMessages) throw new Error('OMP history changed during pagination');
        total = parsed.totalMessages;
        messages.push(...parsed.messages);
        const next = parsed.nextCursor ?? '';
        if (next && next === cursor) throw new Error('OMP history cursor did not advance');
        if (messages.length > total || (next && parsed.messages.length === 0)) throw new Error('OMP returned inconsistent history pagination');
        cursor = next;
      } while (cursor);
      if (messages.length !== total) throw new Error('OMP history pagination ended before the complete history was delivered');
      this.installHistory(owner, messages);
    }
    if (revision === owner.historyRevision) owner.needsHistory = false;
  }

  private async restoreArchivedSubagents(owner: Owner): Promise<void> {
    const parentFile = owner.sessionPath;
    if (!parentFile) return;
    const rows = await listSubagentSessionFiles(parentFile);
    if (owner.sessionPath !== parentFile) return;
    owner.state.subagents = mergeSubagentRoster(array(owner.state.subagents).map(object), rows.map(row => object(sanitizeForDesktop(row))), 'archive');
    owner.needsSubagentDiscovery = false; this.notify(owner);
  }

  private async readSubagentMessages(owner: Owner, command: RpcCommand): Promise<Json> {
    const id = text(command.subagentId);
    const requestedFile = text(command.sessionFile);
    let retained = array(owner.state.subagents).map(object).find(row => id ? row.id === id : requestedFile && this.pathKey(text(row.sessionFile)) === this.pathKey(requestedFile));
    if (!retained || !text(retained.sessionFile)) {
      await this.restoreArchivedSubagents(owner);
      retained = array(owner.state.subagents).map(object).find(row => id ? row.id === id : requestedFile && this.pathKey(text(row.sessionFile)) === this.pathKey(requestedFile));
    }
    const sessionFile = text(retained?.sessionFile);
    if (sessionFile && requestedFile && this.pathKey(sessionFile) !== this.pathKey(requestedFile)) throw new Error('Transcript selector does not match the retained subagent identity');
    const selected: RpcCommand = { ...command, ...(sessionFile ? { sessionFile } : {}) };
    if (retained && !flag(retained.live) && sessionFile) delete selected.subagentId;
    try { return await this.send(owner, selected, 120_000, Boolean(sessionFile && owner.sessionPath)); }
    catch (error) {
      if (!(error instanceof Error) || !SUBAGENT_LOOKUP_MISS.test(error.message) || !sessionFile || !owner.sessionPath) throw error;
      try { return await readSubagentTranscript(owner.sessionPath, sessionFile, command.fromByte === undefined ? 0 : z.number().int().nonnegative().parse(command.fromByte)); }
      catch (archiveError) {
        this.emit(owner, { type: 'owner_error', message: archiveError instanceof Error ? archiveError.message : 'Could not read the canonical subagent archive' });
        throw archiveError;
      }
    }
  }

  private async hydrate(owner: Owner): Promise<void> {
    owner.needsHistory = true; owner.historyRevision++;
    if (owner.status === 'starting') owner.needsSubagentDiscovery = true;
    await this.refreshState(owner);
    if (owner.needsHistory) await this.loadHistory(owner);
    if (owner.needsSubagentDiscovery) await this.restoreArchivedSubagents(owner);
    await this.send(owner, { type: 'get_subagents' });
    this.notify(owner);
  }

  private async refreshState(owner: Owner): Promise<void> {
    if (!owner.child || owner.stopping || owner.status === 'error' || owner.status === 'closed') return;
    if (owner.refreshing) return owner.refreshing;
    let refreshed = false;
    owner.refreshing = this.send(owner, { type: 'get_state' }).then(async () => {
      if (owner.needsHistory) await this.loadHistory(owner);
      if (owner.needsSubagentDiscovery) await this.restoreArchivedSubagents(owner);
      refreshed = true;
      this.notify(owner);
    });
    try { await owner.refreshing; }
    finally {
      owner.refreshing = undefined;
      if (refreshed && owner.needsHistory) this.scheduleRefresh(owner);
    }
  }

  private scheduleRefresh(owner: Owner): void {
    if (owner.refresh || owner.stopping || owner.status === 'error') return;
    owner.refresh = setTimeout(() => {
      owner.refresh = undefined;
      void this.refreshState(owner).catch(error => this.emit(owner, { type: 'owner_error', message: error instanceof Error ? error.message : 'Could not refresh OMP state' }));
    }, 60);
  }

  private emit(owner: Owner, frame: RpcFrame): void {
    if (frame.type === 'owner_error') {
      frame.message = redactSecrets(text(frame.message, 'OMP reported an error')).slice(0, 8000);
      owner.state.lastError = frame.message;
    }
    this.options.emit({ scope: this.options.settingsOnly ? 'settings' : 'conversation', ownerId: owner.id, sequence: ++owner.sequence, frame });
  }
  private notify(owner: Owner): void {
    if (owner.changed) return;
    owner.changed = true;
    // Coalesce token bursts without copying the complete history into every event.
    setTimeout(() => {
      owner.changed = false;
      this.emit(owner, this.options.settingsOnly
        ? { type: 'owner_snapshot', snapshot: objectSchema.parse(this.snapshot(owner.id)) }
        : { type: 'owner_snapshot' });
    }, 35);
  }

  private consumeStderr(owner: Owner, chunk: string): void {
    owner.stderrPending += chunk;
    let newline = owner.stderrPending.indexOf('\n');
    while (newline >= 0) {
      const line = redactSecrets(owner.stderrPending.slice(0, newline)).slice(-4096);
      owner.stderr = `${owner.stderr}${line}\n`.slice(-STDERR_LIMIT);
      owner.stderrPending = owner.stderrPending.slice(newline + 1); newline = owner.stderrPending.indexOf('\n');
    }
    if (owner.stderrPending.length > 4096) {
      // Retain the latest bounded line but redact before discarding its prefix, to catch split tokens.
      owner.stderrPending = redactSecrets(owner.stderrPending).slice(-4096);
    }
  }

  private clearLoginUi(owner: Owner): void {
    for (const id of [...owner.pendingUi.keys(), ...owner.loginHandoffs.keys()]) this.emit(owner, { type: 'extension_ui_request', method: 'cancel', targetId: id });
    owner.pendingUi.clear(); owner.loginHandoffs.clear();
  }

  private cancelUi(owner: Owner): void {
    for (const id of owner.pendingUi.keys()) {
      try { this.writeFrame(owner, { type: 'extension_ui_response', id, cancelled: true }); }
      catch { /* Pipe close will reject the core's remaining dialog waits. */ }
    }
    if (this.options.settingsOnly) this.clearLoginUi(owner);
    else owner.pendingUi.clear();
    this.notify(owner);
  }
  private rejectPending(owner: Owner, error: Error): void {
    for (const pending of owner.requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    if (this.options.settingsOnly) this.clearLoginUi(owner);
    owner.requests.clear(); owner.prompts.clear(); owner.pendingUi.clear(); owner.loginHandoffs.clear();
    owner.readyReject?.(error);
  }
  private fail(owner: Owner, reason: string): void {
    if (owner.status === 'error') return;
    owner.error = redactSecrets(reason).slice(-24 * 1024); owner.status = 'error';
    this.rejectPending(owner, new Error(owner.error));
    this.emit(owner, { type: 'owner_error', message: owner.error }); this.notify(owner);
    if (owner.child && !owner.stopping) void this.stop(owner, true);
  }

  private async stop(owner: Owner, abort: boolean, preserveIdentity = false): Promise<void> {
    if (owner.stopping) return owner.exit;
    const child = owner.child;
    if (!child) { if (owner.status !== 'error' && !preserveIdentity) owner.status = 'closed'; this.notify(owner); return; }
    owner.stopping = true; owner.closing = true;
    if (owner.refresh) { clearTimeout(owner.refresh); owner.refresh = undefined; }
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }, 8_000);
    try {
      this.cancelUi(owner);
      if (abort && owner.hasReady && !this.options.settingsOnly) {
        // Abort bypasses core prompt execution; never wait for a prompt's eventual completion to request it.
        await Promise.race([
          Promise.allSettled([
            this.send(owner, { type: 'abort_and_restore_queue' }, 3000),
            this.send(owner, { type: 'abort_bash' }, 3000),
            this.send(owner, { type: 'abort_retry' }, 3000),
          ]),
          new Promise<void>(resolve => setTimeout(resolve, 3500)),
        ]);
      }
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      // stdout/stderr listeners remain attached until close: core can still flush journal notices and output.
      await owner.exit;
      if (owner.status !== 'error' && !preserveIdentity) owner.status = 'closed';
    } finally {
      clearTimeout(deadline); this.rejectPending(owner, new Error(owner.error ?? 'OMP session closed')); this.notify(owner);
    }
  }
}
