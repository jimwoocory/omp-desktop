import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listSessionFiles, listSubagentSessionFiles, readSubagentTranscript } from '../dist-electron/electron/sessions.js';

const timestamp = '2026-10-01T12:00:00.000Z';
async function journal(file, entries) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
}
const header = (id, cwd, extra = {}) => ({ type: 'session', version: 3, id, timestamp, cwd, ...extra });
const message = (id, role, content) => ({ type: 'message', id, parentId: null, timestamp, message: { role, content } });
const childInit = (task = 'Compute the sum') => ({ type: 'session_init', id: 'init-entry', parentId: null, timestamp, agent: 'sonic', task, systemPrompt: ['private system instruction'], tools: ['bash'] });

test('recursively reads native title slots and audit titles without changing canonical files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-session-listing-'));
  try {
    const native = path.join(root, 'native'); const managed = path.join(root, 'managed'); const workspace = path.join(root, 'project');
    const first = path.join(native, 'project', 'one.jsonl'); const second = path.join(managed, 'conversation', 'two.jsonl');
    await journal(first, [
      { type: 'title', v: 1, title: 'Slot title', source: 'user', updatedAt: timestamp, pad: ' '.repeat(40) },
      header('canonical-native', workspace, { title: 'Old header title' }),
      message('u1', 'user', [{ type: 'text', text: 'First prompt' }]),
      { type: 'title_change', id: 't1', parentId: 'u1', timestamp: '2026-10-02T12:00:00.000Z', title: 'Actual latest title', source: 'user' },
      message('a1', 'assistant', [{ type: 'thinking', thinking: 'Not preview text' }, { type: 'text', text: 'Latest visible answer' }]),
    ]);
    await journal(second, [header('canonical-managed', workspace), message('u2', 'user', 'Managed prompt title')]);
    await utimes(first, new Date('2026-10-03T00:00:00Z'), new Date('2026-10-03T00:00:00Z'));
    await utimes(second, new Date('2026-10-04T00:00:00Z'), new Date('2026-10-04T00:00:00Z'));
    const before = await readFile(first);
    const records = await listSessionFiles([native, managed, native], workspace, [managed]);
    assert.equal(records.length, 2);
    assert.equal(records[0].id, 'canonical-managed'); assert.equal(records[0].name, 'Managed prompt title'); assert.equal(records[0].managed, true);
    assert.equal(records[1].id, 'canonical-native'); assert.equal(records[1].name, 'Actual latest title'); assert.equal(records[1].managed, false);
    assert.equal(records[1].messageCount, 2); assert.equal(records[1].preview, 'Latest visible answer');
    assert.equal(records[1].workspace, workspace); assert.equal(records[1].updatedAt, '2026-10-03T00:00:00.000Z');
    assert.deepEqual(await readFile(first), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace filters honor canonical additional workspace directories and legacy headers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-session-workspaces-'));
  try {
    const primary = path.join(root, 'primary'); const additional = path.join(root, 'additional');
    await journal(path.join(root, 'multi.jsonl'), [header('multi-root', primary, { additionalDirectories: [additional] })]);
    await journal(path.join(root, 'legacy.jsonl'), [{ type: 'session', id: 'canonical-legacy', cwd: primary, timestamp, title: 'Legacy title' }]);
    assert.equal((await listSessionFiles([root], additional))[0].id, 'multi-root');
    assert.equal((await listSessionFiles([root], primary)).length, 2);
    assert.deepEqual(await listSessionFiles([root], path.join(root, 'unrelated')), []);
    assert.equal((await listSessionFiles([root])).find(record => record.id === 'canonical-legacy').name, 'Legacy title');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('malformed individual journals are reported and skipped without losing valid neighbors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-session-invalid-'));
  try {
    await journal(path.join(root, 'valid.jsonl'), [header('stable-id', root), message('u1', 'user', 'Valid history')]);
    await writeFile(path.join(root, 'malformed.jsonl'), '{not json}\n');
    await journal(path.join(root, 'no-identity.jsonl'), [{ type: 'session', cwd: root, timestamp }]);
    await journal(path.join(root, 'missing-header.jsonl'), [message('u2', 'user', 'No header')]);
    await writeFile(path.join(root, 'bad-utf8.jsonl'), Buffer.from([0xff, 10]));
    const records = await listSessionFiles([root]);
    assert.equal(records.length, 1); assert.equal(records[0].id, 'stable-id');
    assert.deepEqual(await listSessionFiles([path.join(root, 'does-not-exist')]), []);
    await assert.rejects(listSessionFiles([path.join(root, 'valid.jsonl')]), /Cannot read session root/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('does not follow directory symlinks or Windows junctions', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-session-links-'));
  try {
    const supplied = path.join(root, 'supplied'); const outside = path.join(root, 'outside');
    await mkdir(supplied); await journal(path.join(outside, 'private.jsonl'), [header('outside-session', root)]);
    const link = path.join(supplied, 'linked');
    try { await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (error.code === 'EPERM') { t.skip('OS does not permit creating test links'); return; } throw error; }
    assert.deepEqual(await listSessionFiles([supplied]), []);
    assert.deepEqual(await listSessionFiles([link]), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('canonical parent-stem children are archived separately while root forks and agent-context roots remain sidebar sessions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-child-inventory-'));
  try {
    const parent = path.join(root, 'parent.jsonl'); const fork = path.join(root, 'fork.jsonl');
    const child = path.join(root, 'parent', 'FutureStingray.jsonl');
    await journal(parent, [header('canonical-parent', root), message('p1', 'user', 'Parent history')]);
    await journal(fork, [header('canonical-fork', root, { parentSession: 'canonical-parent' }), message('f1', 'user', 'Fork history')]);
    await journal(path.join(root, 'agent-root.jsonl'), [header('canonical-agent-root', root), childInit('Root context, not a child'), message('r1', 'user', 'Root history')]);
    const childEntries = [header('canonical-child', root, { parentSession: parent }), childInit(), message('c1', 'assistant', [{ type: 'text', text: '5050 汉字🙂' }])];
    await journal(child, childEntries);
    await journal(path.join(root, 'fork', 'FutureStingray.jsonl'), childEntries);
    const roots = await listSessionFiles([root]);
    assert.deepEqual(roots.map(record => record.id).sort(), ['canonical-agent-root', 'canonical-fork', 'canonical-parent']);
    const inventory = await listSubagentSessionFiles(parent);
    assert.equal(inventory.length, 1); assert.equal(inventory[0].id, 'FutureStingray');
    assert.equal(inventory[0].sessionId, 'canonical-child'); assert.equal(inventory[0].sessionFile, child);
    assert.equal(inventory[0].status, 'archived'); assert.equal(inventory[0].live, false); assert.equal(inventory[0].canControl, false);
    assert.equal((await listSubagentSessionFiles(fork))[0].sessionId, 'canonical-child');
    const transcript = await readSubagentTranscript(parent, child);
    assert.equal(transcript.nextByte, (await readFile(child)).length);
    assert.match(JSON.stringify(transcript.messages), /5050 汉字🙂/);
    assert.equal(transcript.entries.find(entry => entry.type === 'session_init').systemPrompt, undefined);
    const wrong = path.join(root, 'parent', 'WrongParent.jsonl');
    await journal(wrong, [header('wrong-child', root, { parentSession: path.join(root, 'unrelated.jsonl') }), childInit(), message('w1', 'assistant', 'Must not be adopted')]);
    assert.equal((await listSubagentSessionFiles(parent)).length, 1);
    await assert.rejects(readSubagentTranscript(parent, wrong), /stored parent session identity/);
    await assert.rejects(readSubagentTranscript(parent, fork), /outside this parent session archive/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('archive cursors preserve UTF-8 boundaries, ignore incomplete tails and reset after journal truncation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-child-cursors-'));
  try {
    const parent = path.join(root, 'parent.jsonl'); const child = path.join(root, 'parent', 'FutureStingray.jsonl');
    await journal(parent, [header('canonical-parent', root)]);
    const initial = [header('canonical-child', root, { parentSession: parent }), childInit(), message('c1', 'assistant', '5050')];
    await journal(child, initial);
    const first = await readSubagentTranscript(parent, child);
    const nextRecord = Buffer.from(JSON.stringify(message('c2', 'assistant', '下一次🙂')) + '\n');
    const cut = nextRecord.indexOf(Buffer.from('🙂')) + 1;
    await appendFile(child, nextRecord.subarray(0, cut));
    const partial = await readSubagentTranscript(parent, child, first.nextByte);
    assert.deepEqual(partial.entries, []); assert.equal(partial.nextByte, first.nextByte); assert.equal(partial.reset, false);
    await appendFile(child, nextRecord.subarray(cut));
    const completed = await readSubagentTranscript(parent, child, first.nextByte);
    assert.equal(completed.messages[0].content, '下一次🙂');
    assert.equal(completed.nextByte, (await readFile(child)).length);
    await journal(child, initial.slice(0, 2));
    const reset = await readSubagentTranscript(parent, child, completed.nextByte);
    assert.equal(reset.reset, true); assert.equal(reset.fromByte, 0);
    await assert.rejects(readSubagentTranscript(parent, child, -1));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('archive responses page at complete record boundaries instead of allocating the whole journal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-child-pages-'));
  try {
    const parent = path.join(root, 'parent.jsonl'); const child = path.join(root, 'parent', 'FutureStingray.jsonl');
    await journal(parent, [header('canonical-parent', root)]);
    await journal(child, [header('canonical-child', root, { parentSession: parent }), childInit(), ...Array.from({ length: 3 }, (_, index) => message(`c${index}`, 'assistant', 'x'.repeat(2 * 1024 * 1024)))]);
    let cursor = 0; let pages = 0; const messages = [];
    let page;
    do {
      page = await readSubagentTranscript(parent, child, cursor);
      assert.ok(page.nextByte > cursor);
      cursor = page.nextByte; messages.push(...page.messages); pages++;
      assert.ok(pages <= 4);
    } while (page.hasMore);
    assert.equal(messages.length, 3); assert.ok(pages > 1);
    assert.equal(cursor, (await readFile(child)).length);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('permission failures on a supplied root are explicit, not an empty session list', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-session-permissions-'));
  const denied = path.join(root, 'denied'); await mkdir(denied); await chmod(denied, 0);
  try { await assert.rejects(listSessionFiles([denied]), /Cannot read session root/); }
  finally { await chmod(denied, 0o700); await rm(root, { recursive: true, force: true }); }
});
