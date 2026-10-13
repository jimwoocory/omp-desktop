import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ManagementService, mcpServerSchema } from '../dist-electron/electron/management.js';

async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'omp-management-'));
  const agentDir = path.join(directory, 'agent'), workspace = path.join(directory, 'workspace');
  await mkdir(agentDir); await mkdir(workspace);
  const service = new ManagementService({ agentDir, getWorkspace: () => workspace, getExecutable: () => process.env.OMP_EXECUTABLE ?? 'omp', restartOwners: async () => {}, openExternal: async () => {} });
  mockMcpCli(service, agentDir);
  try { await run({ directory, agentDir, workspace, service }); } finally { await service.shutdown(); await rm(directory, { recursive: true, force: true }); }
}

function mockMcpCli(service, agentDir) {
  service.cli = async (args, _signal, input) => {
    if (args[0] !== 'mcp' || args[1] !== 'config') throw new Error('Unexpected CLI operation');
    const action = args[2], scope = args[args.indexOf('--scope') + 1], name = args.includes('--name') ? args[args.indexOf('--name') + 1] : undefined;
    const file = path.join(scope === 'user' ? agentDir : path.join(service.getWorkspace(), '.omp'), 'mcp.json');
    let data;
    try { data = JSON.parse(await readFile(file, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') data = {};
      else throw new Error(`Configuration is not a valid JSON object: ${file}. Contents are withheld.`);
    }
    if (action === 'list') return JSON.stringify({ ...data, scope, path: file, mcpServers: data.mcpServers ?? {} });
    if (action === 'get') {
      if (!data.mcpServers?.[name]) throw new Error('Server not found');
      return JSON.stringify({ scope, name, config: data.mcpServers[name] });
    }
    data.mcpServers ??= {};
    const cleanOverride = key => {
      if (!Array.isArray(data[key])) return;
      const remaining = data[key].filter(value => value !== name);
      if (remaining.length) data[key] = remaining; else delete data[key];
    };
    if (action === 'set') {
      data.mcpServers[name] = input;
      if (input.enabled === false) {
        data.disabledServers = [...new Set([...(data.disabledServers ?? []), name])].sort();
        cleanOverride('enabledServers');
      } else if (input.enabled === true) {
        cleanOverride('disabledServers'); cleanOverride('enabledServers');
      }
    } else if (action === 'remove') {
      delete data.mcpServers[name]; cleanOverride('disabledServers'); cleanOverride('enabledServers');
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data));
    return JSON.stringify({ scope, name, ok: true });
  };
}
test('skill actions use validated argument arrays and preserve safe JSON results', async () => fixture(async ({ service }) => {
  let invocation;
  service.cli = async (args, _signal, input, sensitive) => { invocation = { args, input, sensitive }; return '[{"name":"example"}]'; };
  const result = await service.invoke('skills.cli', { action: 'search', targets: ['multi word'], flags: { json: true } });
  assert.deepEqual(invocation.args, ['skill', 'search', '--json', '--', 'multi word']);
  assert.equal(invocation.sensitive, false);
  assert.deepEqual(result, [{ name: 'example' }]);
}));

test('skill token output is withheld and token actions require confirmation', async () => fixture(async ({ service }) => {
  let sensitive;
  service.cli = async (_args, _signal, _input, isSensitive) => { sensitive = isSensitive; return 'private-token'; };
  await assert.rejects(service.invoke('skills.cli', { action: 'token', targets: ['ls'], flags: {} }), /Confirm/);
  const result = await service.invoke('skills.cli', { action: 'token', targets: ['ls'], flags: {}, confirmed: true });
  assert.equal(sensitive, true);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
}));
test('registry skill installs require explicit confirmation', async () => fixture(async ({ service }) => {
  let invocations = 0;
  service.cli = async () => { invocations++; return 'Installed'; };
  await assert.rejects(service.invoke('skills.cli', { action: 'install', targets: ['owner/skill'], flags: {} }), /Confirm/);
  assert.equal(invocations, 0);
  await service.invoke('skills.cli', { action: 'install', targets: ['owner/skill'], flags: {}, confirmed: true });
  assert.equal(invocations, 1);
}));

test('MCP edits preserve unrelated schema, entries and stored secrets without returning them', async () => fixture(async ({ agentDir, service }) => {
  const file = path.join(agentDir, 'mcp.json');
  await writeFile(file, JSON.stringify({ $schema: 'custom-schema', vendorData: { keep: true }, disabledServers: ['remote', 'other'], mcpServers: { remote: { type: 'http', url: 'https://example.org/mcp', enabled: false, headers: { Authorization: 'secret-token', 'X-Private': 'private-value' }, oauth: { clientSecret: 'hidden', clientId: 'desktop' }, timeout: 4200 }, other: { type: 'stdio', command: 'node', args: ['server.js'] } } }));
  await service.invoke('mcp.save', { name: 'remote', config: { type: 'http', enabled: true } });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.$schema, 'custom-schema'); assert.deepEqual(saved.vendorData, { keep: true });
  assert.equal(saved.mcpServers.remote.headers.Authorization, 'secret-token');
  assert.equal(saved.mcpServers.remote.timeout, 4200); assert.equal(saved.mcpServers.other.command, 'node');
  assert.deepEqual(saved.disabledServers, ['other']);
  const listed = await service.invoke('mcp.list', {}), serialized = JSON.stringify(listed);
  assert.equal(serialized.includes('secret-token'), false); assert.equal(serialized.includes('private-value'), false); assert.equal(serialized.includes('hidden'), false);
  const fetched = await service.invoke('mcp.config.get', { scope: 'user', name: 'remote' });
  assert.equal(JSON.stringify(fetched).includes('secret-token'), false);
}));

test('MCP removal is scoped and preserves unknown configuration', async () => fixture(async ({ agentDir, workspace, service }) => {
  await mkdir(path.join(workspace, '.omp'));
  const userFile = path.join(agentDir, 'mcp.json'), projectFile = path.join(workspace, '.omp', 'mcp.json');
  const source = { future: { retained: 7 }, mcpServers: { same: { type: 'stdio', command: 'server' } }, disabledServers: ['same'], enabledServers: ['same', 'another'] };
  await writeFile(userFile, JSON.stringify(source)); await writeFile(projectFile, JSON.stringify(source));
  await service.invoke('mcp.remove', { name: 'same', scope: 'project' });
  const user = JSON.parse(await readFile(userFile, 'utf8')), project = JSON.parse(await readFile(projectFile, 'utf8'));
  assert.deepEqual(user, source); assert.deepEqual(project.mcpServers, {}); assert.deepEqual(project.future, { retained: 7 });
  assert.equal((project.disabledServers ?? []).includes('same'), false); assert.deepEqual(project.enabledServers, ['another']);
}));

test('scoped MCP config list/get/set/remove use the CLI contract', async () => fixture(async ({ service }) => {
  await service.invoke('mcp.config.set', { scope: 'project', name: 'api-server', config: { type: 'stdio', command: 'node', customExtension: { enabled: true } } });
  const listed = await service.invoke('mcp.config.list', { scope: 'project' });
  assert.equal(listed.scope, 'project');
  assert.deepEqual(listed.mcpServers['api-server'].customExtension, { enabled: true });
  const fetched = await service.invoke('mcp.config.get', { scope: 'project', name: 'api-server' });
  assert.deepEqual(fetched.config.customExtension, { enabled: true });
  assert.deepEqual(await service.invoke('mcp.config.remove', { scope: 'project', name: 'api-server' }), { status: 'removed', restartRequired: true });
}));
test('MCP schema rejects shell-line commands, non-string arguments and embedded URL credentials', () => {
  assert.equal(mcpServerSchema.safeParse({ type: 'stdio', command: 'node\nmalicious' }).success, false);
  assert.equal(mcpServerSchema.safeParse({ type: 'stdio', command: 'node', args: [7] }).success, false);
  assert.equal(mcpServerSchema.safeParse({ type: 'http', url: 'file:///secret' }).success, false);
  assert.equal(mcpServerSchema.safeParse({ type: 'http', url: 'https://user:password@example.org' }).success, false);
  assert.equal(mcpServerSchema.safeParse({ type: 'http', url: 'https://example.org/mcp', timeout: 0 }).success, true);
});

test('stdio authentication is explicitly not needed and writes no credentials', async () => fixture(async ({ agentDir, service }) => {
  await writeFile(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { local: { type: 'stdio', command: 'node' } } }));
  const result = await service.invoke('mcp.authenticate', { name: 'local' });
  assert.equal(result.status, 'not-needed'); assert.match(result.reason, /stdio/);
}));

test('skill import copies content without running package scripts and refuses existing destinations', async () => fixture(async ({ directory, agentDir, service }) => {
  const source = path.join(directory, 'example-skill'); await mkdir(source); await mkdir(path.join(source, 'references'));
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: example-skill\ndescription: Example\n---\nActual instructions\n');
  await writeFile(path.join(source, 'references', 'guide.txt'), 'Reference content');
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ scripts: { postinstall: 'throw forbidden' } }));
  await service.invoke('skills.install', { sourcePath: source });
  assert.equal(await readFile(path.join(agentDir, 'skills', 'example-skill', 'references', 'guide.txt'), 'utf8'), 'Reference content');
  await assert.rejects(service.invoke('skills.install', { sourcePath: source }), /EEXIST/);
  const registry = JSON.parse(await readFile(path.join(agentDir, 'skills', '.desktop-managed.json'), 'utf8'));
  assert.equal(registry['example-skill'], true);
}));

test('skill import refuses links and rolls back only its newly-created destination', async context => fixture(async ({ directory, agentDir, service }) => {
  const source = path.join(directory, 'linked-skill'); await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), 'Safe instructions');
  const external = path.join(directory, 'external'); await mkdir(external); await writeFile(path.join(external, 'keep.txt'), 'User file');
  try { await symlink(external, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { context.skip('Creating links requires Windows developer mode'); return; } throw error; }
  await assert.rejects(service.invoke('skills.install', { sourcePath: source }), /symbolic links|junctions/);
  await assert.rejects(readFile(path.join(agentDir, 'skills', 'linked-skill', 'SKILL.md')), /ENOENT/);
  assert.equal(await readFile(path.join(external, 'keep.txt'), 'utf8'), 'User file');
}));

test('skill import rejects a destination beneath the source to prevent recursive copying', async () => fixture(async ({ agentDir, service }) => {
  await writeFile(path.join(agentDir, 'SKILL.md'), 'Instructions');
  await assert.rejects(service.invoke('skills.install', { sourcePath: agentDir }), /own source directory/);
}));

test('disabling a native MCP server removes an explicit allowlist override', async () => fixture(async ({ agentDir, service }) => {
  const file = path.join(agentDir, 'mcp.json');
  await writeFile(file, JSON.stringify({ enabledServers: ['local', 'keep'], mcpServers: { local: { type: 'stdio', command: 'node', enabled: true } } }));
  await service.invoke('mcp.save', { name: 'local', config: { type: 'stdio', enabled: false } });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.enabledServers, ['keep']);
  const listed = await service.invoke('mcp.list', {});
  assert.equal(listed[0].effectiveEnabled, false);
}));

test('MCP inventory reports project precedence and user denylist without mutating either file', async () => fixture(async ({ agentDir, workspace, service }) => {
  await mkdir(path.join(workspace, '.omp'));
  const userFile = path.join(agentDir, 'mcp.json'), projectFile = path.join(workspace, '.omp', 'mcp.json');
  const user = JSON.stringify({ disabledServers: ['same'], mcpServers: { same: { type: 'stdio', command: 'user-server' } } });
  const project = JSON.stringify({ mcpServers: { same: { type: 'stdio', command: 'project-server' } } });
  await writeFile(userFile, user); await writeFile(projectFile, project);
  const listed = await service.invoke('mcp.list', {});
  assert.equal(listed.find(item => item.scope === 'project').effectiveEnabled, false);
  assert.match(listed.find(item => item.scope === 'project').override, /user denylist/);
  assert.match(listed.find(item => item.scope === 'user').override, /Project definition/);
  assert.equal(await readFile(userFile, 'utf8'), user); assert.equal(await readFile(projectFile, 'utf8'), project);
}));

test('malformed private MCP JSON errors never echo its secret contents', async () => fixture(async ({ agentDir, service }) => {
  await writeFile(path.join(agentDir, 'mcp.json'), '{"mcpServers":{"remote":{"headers":{"Authorization":"private-secret-example"}}} broken');
  await assert.rejects(service.invoke('mcp.list', {}), error => {
    assert.match(error.message, /not a valid JSON object/);
    assert.equal(error.message.includes('private-secret-example'), false);
    return true;
  });
}));

test('queued project writes pin the workspace at invocation time rather than execution time', async () => fixture(async ({ directory, agentDir, workspace }) => {
  const other = path.join(directory, 'other-workspace'); await mkdir(other);
  let focused = workspace;
  const service = new ManagementService({ agentDir, getWorkspace: () => focused, getExecutable: () => 'omp', restartOwners: async () => {}, openExternal: async () => {} });
  mockMcpCli(service, agentDir);
  const first = service.invoke('mcp.save', { scope: 'project', name: 'first', config: { type: 'stdio', command: 'first-server' } });
  focused = other;
  const second = service.invoke('mcp.save', { scope: 'project', name: 'second', config: { type: 'stdio', command: 'second-server' } });
  const explicit = service.invoke('mcp.save', { workspace, scope: 'project', name: 'explicit', config: { type: 'stdio', command: 'explicit-server' } });
  await Promise.all([first, second, explicit]);
  const original = JSON.parse(await readFile(path.join(workspace, '.omp', 'mcp.json'), 'utf8'));
  const alternate = JSON.parse(await readFile(path.join(other, '.omp', 'mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(original.mcpServers).sort(), ['explicit', 'first']);
  assert.deepEqual(Object.keys(alternate.mcpServers), ['second']);
}));

test('asynchronous MCP reads retain their requested workspace across focus changes', async () => fixture(async ({ directory, agentDir, workspace }) => {
  const other = path.join(directory, 'other-workspace'); await mkdir(path.join(other, '.omp'), { recursive: true }); await mkdir(path.join(workspace, '.omp'));
  await writeFile(path.join(workspace, '.omp', 'mcp.json'), JSON.stringify({ mcpServers: { original: { type: 'stdio', command: 'original-server' } } }));
  await writeFile(path.join(other, '.omp', 'mcp.json'), JSON.stringify({ mcpServers: { alternate: { type: 'stdio', command: 'alternate-server' } } }));
  let focused = workspace;
  const service = new ManagementService({ agentDir, getWorkspace: () => focused, getExecutable: () => 'omp', restartOwners: async () => {}, openExternal: async () => {} });
  mockMcpCli(service, agentDir);
  const pending = service.invoke('mcp.list', { workspace });
  focused = other;
  assert.deepEqual((await pending).map(item => item.name), ['original']);
}));

test('shutdown rejects queued project mutations before they can write and is idempotent', async () => fixture(async ({ workspace, service }) => {
  const pending = service.invoke('mcp.save', { scope: 'project', name: 'never-started', config: { type: 'stdio', command: 'server' } });
  const rejection = assert.rejects(pending, /shutting down/);
  const first = service.shutdown(), second = service.shutdown();
  assert.equal(first, second);
  await Promise.all([first, rejection]);
  await assert.rejects(readFile(path.join(workspace, '.omp', 'mcp.json')), /ENOENT/);
  await assert.rejects(service.invoke('mcp.list', {}), /shutting down/);
}));

test('shutdown closes an actual in-flight read-only child process, not only mutation operations', async () => fixture(async ({ agentDir, workspace }) => {
  // Node executes this real long-running process; the test concerns process lifetime, not CLI forwarding or fabricated model results.
  await writeFile(path.join(workspace, 'models'), 'require(\"node:fs\").writeFileSync(\"child.pid\", String(process.pid)); setInterval(() => {}, 1000);');
  const service = new ManagementService({ agentDir, getWorkspace: () => workspace, getExecutable: () => process.execPath, restartOwners: async () => {}, openExternal: async () => {} });
  const inventory = service.invoke('credentials.providers', {});
  const rejection = assert.rejects(inventory, /cancelled/);
  try {
    let pid;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { pid = Number(await readFile(path.join(workspace, 'child.pid'), 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; await delay(10); }
    }
    assert.ok(pid > 0, 'Child must start before shutdown to exercise active process cleanup');
    await service.shutdown();
    await rejection;
    assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/i);
  } finally { await service.shutdown(); }
}));
