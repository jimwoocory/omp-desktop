import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { OwnerManager, RpcFrameDecoder, classifyStartupFailure, mergeSubagentRoster, redactSecrets, sanitizeForDesktop } from '../dist-electron/electron/rpc.js';
import { SettingsRuntime } from '../dist-electron/electron/settings-runtime.js';
import { listSessionFiles } from '../dist-electron/electron/sessions.js';

function chunksFor(frame) {
  const bytes = Buffer.from(JSON.stringify(frame));
  const count = Math.ceil(bytes.length / (256 * 1024));
  return Array.from({ length: count }, (_, index) => ({
    type: 'rpc_chunk', chunkId: 'logical-1', index, count, byteLength: bytes.length,
    data: bytes.subarray(index * 256 * 1024, (index + 1) * 256 * 1024).toString('base64'),
  }));
}

test('JSONL transport preserves split multibyte UTF-8 and multiple frames', () => {
  const decoder = new RpcFrameDecoder();
  const frames = [];
  const expected = [{ type: 'notice', message: '中文🙂' }, { type: 'session_settled' }];
  const bytes = Buffer.from(expected.map(frame => JSON.stringify(frame)).join('\n') + '\n');
  for (let offset = 0; offset < bytes.length; offset += 3) decoder.write(bytes.subarray(offset, offset + 3), frame => frames.push(frame));
  decoder.finish();
  assert.deepEqual(frames, expected);
});

test('v2 reassembly preserves the complete large frame and UTF-8 bytes', () => {
  const decoder = new RpcFrameDecoder();
  const expected = { type: 'response', command: 'get_messages', success: true, data: { messages: [{ role: 'assistant', content: '🙂汉字'.repeat(160000) }] } };
  let decoded;
  for (const chunk of chunksFor(expected)) decoded = decoder.push(chunk) ?? decoded;
  decoder.finish();
  assert.deepEqual(decoded, expected);
});

test('v2 rejects interleaved, interrupted, duplicated and incomplete sequences', () => {
  const chunks = chunksFor({ type: 'notice', message: 'x'.repeat(1200000) });
  const interrupted = new RpcFrameDecoder(); interrupted.push(chunks[0]);
  assert.throws(() => interrupted.push({ type: 'notice', message: 'not a chunk' }), /interrupted/);
  const interleaved = new RpcFrameDecoder(); interleaved.push(chunks[0]);
  assert.throws(() => interleaved.push({ ...chunks[1], chunkId: 'another' }), /mismatch/);
  const duplicate = new RpcFrameDecoder(); duplicate.push(chunks[0]);
  assert.throws(() => duplicate.push(chunks[0]), /mismatch/);
  const incomplete = new RpcFrameDecoder(); incomplete.push(chunks[0]);
  assert.throws(() => incomplete.finish(), /incomplete/);
  assert.throws(() => new RpcFrameDecoder().push(chunks[1]), /start at zero/);
});

test('transport enforces physical, logical, byte-length, base64 and strict UTF-8 limits', () => {
  assert.throws(() => new RpcFrameDecoder().write(Buffer.alloc(1024 * 1024, 65), () => {}), /physical/);
  assert.throws(() => new RpcFrameDecoder().write(Buffer.from([123, 34, 116, 121, 112, 101, 34, 58, 34, 0xff, 34, 125, 10]), () => {}), /invalid UTF-8/);
  const chunks = chunksFor({ type: 'notice', message: 'x'.repeat(1200000) });
  assert.throws(() => new RpcFrameDecoder().push({ ...chunks[0], byteLength: 64 * 1024 * 1024 + 1 }));
  assert.throws(() => new RpcFrameDecoder().push({ ...chunks[0], data: '!invalid=' }));
  const wrongLength = new RpcFrameDecoder();
  assert.throws(() => { for (const chunk of chunks) wrongLength.push({ ...chunk, byteLength: chunk.byteLength + 1 }); }, /byte length mismatch/);
  const decoder = new RpcFrameDecoder(); decoder.write(Buffer.from('{"type":"notice"}'), () => {});
  assert.throws(() => decoder.finish(), /incomplete/);
});

test('recognized startup failures never expose private diagnostics and unknown failures remain unclassified', () => {
  const classified = classifyStartupFailure('ERROR No default model selected\nproviderPayload=private-replay\napi_key=private-credential');
  assert.doesNotMatch(classified, /private-replay|private-credential|providerPayload|api_key/);
  assert.equal(classifyStartupFailure('Unexpected provider failure with private data'), undefined);
});

test('saved-model error classification excludes compiled stacks, secrets and invalid selectors', () => {
  const classified = classifyStartupFailure('123 | throw new Error("No default model selected");\nERROR: Could not restore model openai/gpt-5.2\n    at compiled-source private-replay api_key=private-credential');
  assert.doesNotMatch(classified, /compiled-source|private-replay|private-credential|No default model selected/);
  assert.equal(classifyStartupFailure('ERROR: Could not restore model openai/model?token=private'), undefined);
  assert.equal(classifyStartupFailure('123 | throw new Error(`Could not restore model ${sessionModelStrings[0]}`);'), undefined);
});

test('ready negotiation requires v2 and rejects unbounded advertised limits', () => {
  const ready = { type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 };
  const decoder = new RpcFrameDecoder(); decoder.acceptReady(ready);
  assert.equal(decoder.maxFrameBytes, 1048576);
  assert.throws(() => new RpcFrameDecoder().acceptReady({ ...ready, supportedProtocolVersions: [1] }), /v2/);
  assert.throws(() => new RpcFrameDecoder().acceptReady({ ...ready, maxReassembledFrameBytes: 2 ** 40 }));
});

test('desktop snapshots retain model capabilities and prose while removing nested authentication and replay data', () => {
  const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
  const input = {
    model: { id: 'available-model', provider: 'provider', input: ['text', 'image'], reasoning: true, accountAccess: { accessToken: 'opaque' }, headers: { Authorization: 'Bearer opaque' } },
    systemPrompt: ['private instruction'], messages: [{ role: 'assistant', content: [{ type: 'text', text: 'visible prose' }, { type: 'thinking', thinking: 'displayable thought', thinkingSignature: 'opaque replay' }, { type: 'redactedThinking', data: 'encrypted' }], providerPayload: { raw: 'opaque replay' } }],
    nested: { api_key: secret, password: 'private', refresh_token: 'private' },
  };
  const output = sanitizeForDesktop(input);
  assert.deepEqual(output.model, { id: 'available-model', provider: 'provider', input: ['text', 'image'], reasoning: true });
  assert.equal(output.systemPrompt, undefined);
  assert.equal(output.messages[0].providerPayload, undefined);
  assert.equal(output.messages[0].content[0].text, 'visible prose');
  assert.equal(output.messages[0].content[1].thinking, 'displayable thought');
  assert.equal(output.messages[0].content[1].thinkingSignature, undefined);
  assert.equal(output.messages[0].content[2].data, undefined);
  assert.deepEqual(output.nested, {});
  assert.equal(input.messages[0].providerPayload.raw, 'opaque replay');
  assert.ok(!redactSecrets(`api_key=${secret} Authorization=Bearer TOKEN`).includes(secret));
  assert.ok(!redactSecrets('https://callback.invalid/?code=private-code&ok=1').includes('private-code'));
});

test('live registry snapshots retain completed roster rows without inventing completion for missing workers', () => {
  const sessionFile = path.join(os.tmpdir(), 'parent-stem', 'FutureStingray.jsonl');
  const running = mergeSubagentRoster([], [{ id: 'FutureStingray', status: 'running', sessionFile, task: 'Compute a sum' }], 'live');
  assert.equal(running[0].live, true); assert.equal(running[0].canControl, true);
  const completed = mergeSubagentRoster(running, [{ id: 'FutureStingray', status: 'completed', progress: { status: 'completed', output: '5050' } }], 'event');
  const queried = mergeSubagentRoster(completed, [], 'live');
  assert.equal(queried[0].status, 'completed');
  assert.equal(queried[0].sessionFile, sessionFile);
  assert.equal(queried[0].live, false); assert.equal(queried[0].canControl, false);
  assert.equal(queried[0].progress.output, '5050');
  const unknown = mergeSubagentRoster(running, [], 'live');
  assert.equal(unknown[0].status, 'archived'); assert.equal(unknown[0].canControl, false);
  const rediscovered = mergeSubagentRoster(queried, [{ id: 'FutureStingray', status: 'archived', sessionId: 'canonical-child', sessionFile }], 'archive');
  assert.equal(rediscovered[0].status, 'completed');
  assert.equal(rediscovered[0].sessionId, 'canonical-child');
  assert.equal(running[0].status, 'running'); assert.equal(running[0].live, true);
  const unresolved = mergeSubagentRoster([], [{ id: 'FutureStingray', status: 'started' }], 'event');
  const located = mergeSubagentRoster(unresolved, [{ id: 'FutureStingray', status: 'archived', sessionFile }], 'archive');
  assert.equal(located[0].sessionFile, sessionFile);
});

test('tool inventory retains names, descriptions and parameter metadata while scrubbing credential values', () => {
  const descriptor = {
    name: 'read', description: 'Read a workspace file',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path' } }, required: ['path'] },
  };
  const sanitized = sanitizeForDesktop({ dumpTools: [{ ...descriptor, apiKey: 'private-credential' }], systemPrompt: ['private instruction'] });
  assert.deepEqual(sanitized.dumpTools, [descriptor]);
  assert.equal(sanitized.systemPrompt, undefined);
});

test('typed authorization handoff preserves exact validated links without exempting prose or nested payloads', () => {
  const url = 'https://auth.example.invalid/authorize?token=handoff-token&code=one-use-code&code_challenge=a%2Bb&state=opaque%2Fstate';
  const launchUrl = 'http://127.0.0.1:8989/launch?token=local-handoff-token&state=opaque';
  const handoff = { type: 'extension_ui_request', id: 'auth-1', method: 'open_url', url, launchUrl, instructions: `Diagnostic link: ${url}` };
  const sanitized = sanitizeForDesktop(handoff);
  assert.equal(sanitized.url, url);
  assert.equal(sanitized.launchUrl, launchUrl);
  assert.ok(!sanitized.instructions.includes('handoff-token'));
  assert.ok(!sanitized.instructions.includes('one-use-code'));
  assert.equal(new URL(sanitized.url).searchParams.get('code_challenge'), 'a+b');
  assert.equal(new URL(sanitized.url).searchParams.get('state'), 'opaque/state');
  const prose = sanitizeForDesktop({ content: url });
  assert.ok(!prose.content.includes('handoff-token'));
  assert.ok(!prose.content.includes('one-use-code'));
  const nested = sanitizeForDesktop({ type: 'response', data: handoff });
  assert.ok(!nested.data.url.includes('handoff-token'));
  for (const unsafe of ['javascript:alert(1)', 'file:///private/config', 'https://user:password@example.invalid/authorize', 'https://example.invalid/path\nhidden']) {
    assert.throws(() => sanitizeForDesktop({ ...handoff, url: unsafe }));
  }
});

// Optional real-core integration: no mock transport, model call, credential write, or user configuration change.
test('real OMP hydrates exact saved history, attaches duplicate opens and restarts lazy fresh owners', { skip: !process.env.OMP_TEST_EXECUTABLE, timeout: 240000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omp-owner-regression-'));
  const workspace = path.join(temporary, 'workspace'); const agentDir = path.join(temporary, 'agent');
  await mkdir(workspace); await mkdir(agentDir);
  const isolatedEnvironment = { PI_CODING_AGENT_DIR: agentDir, HOME: temporary, USERPROFILE: temporary, OMP_PROFILE: '', PI_PROFILE: '', PI_CONFIG_DIR: '.omp', OPENAI_API_KEY: 'transport-regression-key-not-used-for-model-requests' };
  const previousEnvironment = Object.fromEntries(Object.keys(isolatedEnvironment).map(key => [key, process.env[key]]));
  Object.assign(process.env, isolatedEnvironment);
  const events = [];
  const fixtureModel = process.env.OMP_TEST_MODEL || 'openai/gpt-5.2';
  const manager = new OwnerManager({ getExecutable: () => process.env.OMP_TEST_EXECUTABLE, getInitialModel: () => fixtureModel, sessionsRoot: path.join(temporary, 'managed'), emit: event => events.push(event) });
  try {
    const sessionFile = path.join(temporary, 'history.jsonl');
    const timestamp = new Date().toISOString();
    await writeFile(sessionFile, [
      { type: 'session', version: 3, id: 'canonical-owner-regression', cwd: workspace, timestamp },
      { type: 'model_change', id: 'model-entry', parentId: null, timestamp, model: fixtureModel, role: 'default' },
      { type: 'message', id: 'user-entry', parentId: 'model-entry', timestamp, message: { role: 'user', content: [{ type: 'text', text: 'Stored history, no model call requested.' }], timestamp: Date.now() } },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const childDirectory = sessionFile.slice(0, -6);
    await mkdir(childDirectory);
    const childFile = path.join(childDirectory, 'ArchivedStingray.jsonl');
    await writeFile(childFile, [
      { type: 'session', version: 3, id: 'canonical-archived-child', cwd: workspace, timestamp, parentSession: sessionFile },
      { type: 'session_init', id: 'child-init', parentId: null, timestamp, agent: 'sonic', task: 'Stored sum result', systemPrompt: ['private instruction'], tools: [] },
      { type: 'message', id: 'child-output', parentId: 'child-init', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: '5050' }], timestamp: Date.now() } },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const [first, attached] = await Promise.all([manager.create(workspace, sessionFile), manager.create(workspace, sessionFile)]);
    assert.equal(first.id, attached.id);
    assert.equal(first.status, 'ready');
    assert.equal(first.state.sessionId, 'canonical-owner-regression');
    const [fixtureProvider, ...fixtureModelParts] = fixtureModel.split('/');
    assert.equal(first.state.model.provider, fixtureProvider);
    assert.equal(first.state.model.id, fixtureModelParts.join('/'));
    assert.match(JSON.stringify(first.messages), /Stored history/);
    const roster = await manager.request(first.id, { type: 'get_subagents' });
    const archived = roster.subagents.find(agent => agent.id === 'ArchivedStingray');
    assert.equal(archived.sessionId, 'canonical-archived-child');
    assert.equal(archived.live, false); assert.equal(archived.canControl, false);
    const archivedMessages = await manager.request(first.id, { type: 'get_subagent_messages', subagentId: archived.id, sessionFile: archived.sessionFile, fromByte: 0 });
    assert.match(JSON.stringify(archivedMessages.messages), /5050/);
    assert.equal(archivedMessages.entries.find(entry => entry.type === 'session_init').systemPrompt, undefined);
    const bashResult = await manager.request(first.id, { type: 'bash', command: 'echo $((6 * 7))' });
    assert.equal(bashResult.exitCode, 0);
    assert.match(bashResult.output, /(?:^|\r?\n)42(?:\r?\n|$)/);
    const afterBash = manager.snapshot(first.id);
    assert.ok(afterBash.messages.some(message => message.role === 'bashExecution' && typeof message.output === 'string' && message.output.trim() === '42'));
    assert.ok(events.some(event => event.ownerId === first.id && event.frame.type === 'desktop_command_complete' && event.frame.command === 'bash' && event.frame.success === true));
    assert.equal(first.state.systemPrompt, undefined);
    const fresh = await manager.create(workspace);
    assert.deepEqual(fresh.messages, []);
    await manager.restartAll();
    const resumed = manager.snapshot(first.id);
    assert.equal(resumed.id, first.id);
    assert.equal(resumed.state.sessionFile, first.state.sessionFile);
    assert.equal(resumed.state.sessionId, first.state.sessionId);
    assert.match(JSON.stringify(resumed.messages), /Stored history/);
    assert.ok(resumed.messages.some(message => message.role === 'bashExecution' && typeof message.output === 'string' && message.output.trim() === '42'));
    assert.ok(events.some(event => event.ownerId === first.id && event.frame.type === 'owner_ready' && event.frame.restarted === true));
    const restoredRoster = await manager.request(first.id, { type: 'get_subagents' });
    assert.ok(restoredRoster.subagents.some(agent => agent.id === 'ArchivedStingray' && agent.canControl === false));
    const restoredMessages = await manager.request(first.id, { type: 'get_subagent_messages', subagentId: 'ArchivedStingray', fromByte: 0 });
    assert.match(JSON.stringify(restoredMessages.messages), /5050/);
    const restartedFresh = manager.snapshot(fresh.id);
    assert.equal(restartedFresh.id, fresh.id);
    assert.deepEqual(restartedFresh.messages, []);
    assert.equal(restartedFresh.state.model.provider, fixtureProvider);
    assert.equal(restartedFresh.state.model.id, fixtureModelParts.join('/'));
    const lastSequences = new Map();
    for (const event of events) {
      assert.ok(event.sequence > (lastSequences.get(event.ownerId) ?? 0));
      lastSequences.set(event.ownerId, event.sequence);
    }
    await manager.close(first.id); assert.equal(manager.snapshot(first.id).status, 'closed');
    const readyCount = events.filter(event => event.frame.type === 'owner_ready').length;
    const racingRestart = manager.restartAll();
    const disposing = manager.shutdown();
    const [restartResult, shutdownResult] = await Promise.allSettled([racingRestart, disposing]);
    assert.equal(restartResult.status, 'rejected'); assert.equal(shutdownResult.status, 'fulfilled');
    assert.equal(events.filter(event => event.frame.type === 'owner_ready').length, readyCount);
    assert.ok(manager.snapshots().every(snapshot => snapshot.status === 'error' && snapshot.state.desktopBusy === false));
    await assert.rejects(manager.create(workspace), /shutting down/);
    await assert.rejects(manager.restartAll(), /shutting down/);
  } finally {
    try { await manager.shutdown(); }
    finally {
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(temporary, { recursive: true, force: true });
    }
  }
});

test('global settings stay independent of chats and cancel native authorization without changing conversation models', { skip: !process.env.OMP_TEST_EXECUTABLE, timeout: 120000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omp-global-settings-'));
  const workspace = path.join(temporary, 'workspace');
  await mkdir(workspace);
  const agentDir = path.join(temporary, 'agent');
  await mkdir(agentDir);
  const portReservation = createServer();
  await new Promise(resolve => portReservation.listen(0, '127.0.0.1', resolve));
  const callbackPort = portReservation.address().port;
  await new Promise(resolve => portReservation.close(resolve));
  await writeFile(path.join(agentDir, 'config.yml'), `oauth:\n  redirectUri: http://localhost:${callbackPort}/auth/callback\n`);
  const environment = { PI_CODING_AGENT_DIR: agentDir, HOME: temporary, USERPROFILE: temporary, OMP_PROFILE: '', PI_PROFILE: '', PI_CONFIG_DIR: '.omp' };
  for (const key of Object.keys(process.env)) {
    if (/(?:API_KEY|OAUTH_TOKEN|ACCESS_TOKEN)$/.test(key) || key === 'COPILOT_GITHUB_TOKEN') environment[key] = undefined;
  }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  let defaultModel;
  const events = [], settingsRoot = path.join(temporary, 'settings'), authorizationInput = Promise.withResolvers();
  const settings = new SettingsRuntime({ getExecutable: () => process.env.OMP_TEST_EXECUTABLE, sessionsRoot: settingsRoot, emit: event => {
    events.push(event);
    if (event.frame.type === 'extension_ui_request' && event.frame.method === 'input') authorizationInput.resolve(event.frame);
  } });
  const conversations = new OwnerManager({ getExecutable: () => process.env.OMP_TEST_EXECUTABLE, getInitialModel: () => defaultModel, sessionsRoot: path.join(temporary, 'chats'), emit: () => {} });
  try {
    const [first, concurrent] = await Promise.all([settings.get(workspace), settings.get(path.join(workspace, '.'))]);
    assert.equal(first.id, concurrent.id);
    assert.equal(first.status, 'ready');
    const login = await settings.request(first.id, { type: 'get_login_providers' });
    const codex = login.providers.find(provider => provider.id === 'openai-codex');
    assert.equal(codex.available, true);
    assert.equal(codex.authenticated, false);
    for (const type of ['prompt', 'bash', 'set_model', 'new_session']) {
      await assert.rejects(settings.request(first.id, { type }));
    }
    assert.deepEqual(await listSessionFiles([settingsRoot]), []);
    defaultModel = 'openai-codex/';
    const chat = await conversations.create(workspace);
    const original = { sessionId: chat.state.sessionId, model: chat.state.model };
    defaultModel = 'openai/gpt-5.2';
    await settings.restartAll();
    const refreshed = await settings.get(workspace);
    assert.equal(refreshed.id, first.id);
    const afterSettings = conversations.snapshot(chat.id);
    assert.deepEqual({ sessionId: afterSettings.state.sessionId, model: afterSettings.state.model }, original);
    const authorization = settings.request(refreshed.id, { type: 'login', providerId: 'openai-codex' });
    let inputDeadline;
    const input = await Promise.race([
      authorizationInput.promise,
      authorization.then(() => { throw new Error('Native authorization returned without requesting input'); }),
      new Promise((_, reject) => { inputDeadline = setTimeout(() => reject(new Error('Native authorization did not request input')), 10000); }),
    ]).finally(() => clearTimeout(inputDeadline));
    assert.throws(() => settings.assertIdle());
    await settings.reply(refreshed.id, { type: 'extension_ui_response', id: input.id, cancelled: true });
    assert.equal((await authorization).cancelled, true);
    const recovered = await settings.get(workspace);
    assert.equal(recovered.status, 'ready');
    assert.equal(recovered.state.desktopLoginPending, false);
    assert.deepEqual(recovered.pendingUi, []);
    const survivingChat = await conversations.request(chat.id, { type: 'get_state' });
    assert.equal(survivingChat.sessionId, original.sessionId);
    assert.equal(survivingChat.model.id, original.model.id);
    await conversations.close(chat.id);
    const stillAvailable = await settings.request(recovered.id, { type: 'get_login_providers' });
    assert.equal(stillAvailable.providers.find(provider => provider.id === 'openai-codex').available, true);
    const timestamp = new Date().toISOString(), saved = path.join(temporary, 'saved.jsonl');
    await writeFile(saved, [
      { type: 'session', version: 3, id: 'saved-before-global-settings', cwd: workspace, timestamp },
      { type: 'model_change', id: 'model', parentId: null, timestamp, model: defaultModel, role: 'default' },
      { type: 'message', id: 'user', parentId: 'model', timestamp, message: { role: 'user', content: [{ type: 'text', text: 'Keep the saved model.' }], timestamp: Date.now() } },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    await assert.rejects(conversations.create(workspace, saved), /Could not restore model openai\/gpt-5\.2/);
    assert.ok(events.every(event => event.scope === 'settings'));
    assert.deepEqual(await listSessionFiles([settingsRoot]), []);
    await settings.shutdown();
    await assert.rejects(settings.get(workspace));
  } finally {
    try { await Promise.all([settings.shutdown(), conversations.shutdown()]); }
    finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
