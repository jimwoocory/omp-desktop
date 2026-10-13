import { spawn, type ChildProcess } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { auth, extractWWWAuthenticateParams, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Json, JsonObject, ManagementOperation } from '../shared/contracts.js';
import { array, flag, jsonSchema, object, objectSchema, text } from '../shared/validation.js';

interface Options { getExecutable: () => string; getWorkspace: () => string; agentDir: string; restartOwners: () => Promise<void>; openExternal: (url: string) => Promise<void> }
const scopeSchema = z.enum(['user', 'project']).default('user');
const nameSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+(?: [A-Za-z0-9_.:-]+)*$/).refine(value => !['__proto__', 'constructor', 'prototype'].includes(value), 'Reserved server name');
const stringsSchema = z.record(z.string(), z.string());
const common = { enabled: z.boolean().optional(), timeout: z.number().finite().nonnegative().optional(), instructions: z.boolean().optional(), requestIdFormat: z.enum(['number', 'string']).optional(), auth: objectSchema.optional(), oauth: objectSchema.optional() };
const httpUrl = z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol) && !new URL(value).username && !new URL(value).password, 'Use an HTTP(S) URL without embedded credentials');
export const mcpServerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stdio'), command: z.string().min(1).refine(value => !/[\r\n\0]/.test(value)), args: z.array(z.string()).optional(), env: stringsSchema.optional(), cwd: z.string().optional(), ...common }).catchall(jsonSchema),
  z.object({ type: z.literal('http'), url: httpUrl, headers: stringsSchema.optional(), ...common }).catchall(jsonSchema),
  z.object({ type: z.literal('sse'), url: httpUrl, headers: stringsSchema.optional(), ...common }).catchall(jsonSchema),
]);
const secretName = /(?:^|[._-])(?:api.?key|token|password|secret|credentials|authorization|cookie)(?:$|[._-])/i;
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
function parseJson(raw: string): Json {
  try { return jsonSchema.parse(JSON.parse(raw) as unknown); }
  catch { throw new Error('OMP returned invalid JSON; raw output is withheld to protect private configuration'); }
}
function redact(value: Json, key = ''): Json {
  if (secretName.test(key) && value !== null && value !== '') return null;
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}
async function readObject(file: string): Promise<JsonObject> {
  let content: string;
  try { content = await fs.readFile(file, 'utf8'); } catch (error) { if (missing(error)) return {}; throw error; }
  try { return objectSchema.parse(JSON.parse(content) as unknown); }
  catch { throw new Error(`Configuration is not a valid JSON object: ${file}. Contents are withheld.`); }
}
async function writeObject(file: string, value: JsonObject): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await fs.rename(tmp, file); } finally { await fs.rm(tmp, { force: true }); }
}
function inside(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
async function persistedSettings(directory: string, project = false): Promise<JsonObject> {
  for (const filename of project ? ['config.yml'] : ['config.yml', 'config.yaml']) {
    try { return object(jsonSchema.parse(parseYaml(await fs.readFile(path.join(directory, filename), 'utf8')) as unknown)); }
    catch (error) { if (!missing(error)) throw new Error('Native settings YAML could not be read safely'); }
  }
  return readObject(path.join(directory, 'settings.json'));
}
function containsSetting(settings: JsonObject, key: string): boolean {
  let value: Json | undefined = settings;
  for (const segment of key.split('.')) {
    const current = object(value);
    if (!Object.hasOwn(current, segment)) return false;
    value = current[segment];
  }
  return true;
}
async function boundedWait(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  const pending = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => pending.resolve(false), milliseconds);
  void promise.then(() => pending.resolve(true), () => pending.resolve(true));
  try { return await pending.promise; } finally { clearTimeout(timer); }
}

export class ManagementService {
  private active?: AbortController;
  private mutation: Promise<unknown> = Promise.resolve();
  private workspaceScope = new AsyncLocalStorage<string>();
  private disposed = false;
  private stopping?: Promise<void>;
  private sequence = 0;
  private controllers: Record<string, AbortController> = {};
  private children: Record<string, { child: ChildProcess; closed: Promise<void> }> = {};
  constructor(private options: Options) {}
  private getWorkspace(): string { return this.workspaceScope.getStore() ?? this.options.getWorkspace(); }
  async invoke(operation: ManagementOperation, rawArgs: JsonObject): Promise<Json> {
    if (this.disposed) throw new Error('Management service is shutting down');
    const args = objectSchema.parse(rawArgs);
    const workspace = text(args.workspace) || this.options.getWorkspace();
    if (operation === 'runtime.restart' && flag(args.cancel)) { this.active?.abort(); return { status: 'cancelled' }; }
    const readOnly = ['config.list', 'config.get', 'credentials.providers', 'mcp.list', 'mcp.config.list', 'mcp.config.get', 'skills.list', 'plugins.list', 'extensions.list'].includes(operation);
    const execute = (): Promise<Json> => this.workspaceScope.run(workspace, async () => {
      if (this.disposed) throw new Error('Management service is shutting down');
      const controller = new AbortController();
      const id = String(++this.sequence);
      this.controllers[id] = controller;
      if (!readOnly) this.active = controller;
      try { return await this.dispatch(operation, args, controller.signal); }
      finally { delete this.controllers[id]; if (this.active === controller) this.active = undefined; }
    });
    if (readOnly) return execute();
    const result = this.mutation.then(execute, execute);
    this.mutation = result.catch(() => undefined);
    return result;
  }
  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.disposed = true;
    this.stopping = this.stop();
    return this.stopping;
  }
  private async stop(): Promise<void> {
    const children = Object.values(this.children);
    const terminations = children.map(({ child }) => this.terminate(child));
    for (const controller of Object.values(this.controllers)) controller.abort();
    const settled = await boundedWait(Promise.allSettled([...terminations, ...children.map(entry => entry.closed), this.mutation]), 3000);
    if (!settled) {
      for (const { child } of Object.values(this.children)) child.kill('SIGKILL');
      await boundedWait(Promise.allSettled(Object.values(this.children).map(entry => entry.closed)), 1000);
    }
  }
  private async terminate(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32' && child.pid) {
      // Terminate native installer descendants too; killing just OMP can orphan its package-manager child.
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      const completion = Promise.withResolvers<void>();
      killer.once('close', () => completion.resolve());
      killer.once('error', () => completion.resolve());
      if (!await boundedWait(completion.promise, 1500)) killer.kill('SIGKILL');
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  private async cli(args: string[], signal: AbortSignal, input?: JsonObject, sensitive = false): Promise<string> {
    signal.throwIfAborted();
    const { promise, resolve, reject } = Promise.withResolvers<string>();
      const child = spawn(this.options.getExecutable(), args, { cwd: this.getWorkspace(), env: { ...process.env, PI_CODING_AGENT_DIR: this.options.agentDir, NO_COLOR: '1' }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const id = String(++this.sequence), completion = Promise.withResolvers<void>();
      this.children[id] = { child, closed: completion.promise };
      const abort = (): void => { if (!this.disposed) void this.terminate(child); };
      signal.addEventListener('abort', abort, { once: true });
      let out = '', err = '', overflow = false;
      const collect = (chunk: Buffer, stderr: boolean): void => {
        if (out.length + err.length + chunk.length > 8 * 1024 * 1024) { overflow = true; void this.terminate(child); return; }
        if (stderr) err += chunk.toString('utf8'); else out += chunk.toString('utf8');
      };
      child.stdout.on('data', chunk => collect(chunk, false)); child.stderr.on('data', chunk => collect(chunk, true));
      child.on('error', error => reject(signal.aborted ? new Error('Operation cancelled') : sensitive ? new Error('Native credential import could not start; check executable and native auth broker settings') : error));
      child.stdin.on('error', () => { /* Exit status is the authoritative result when native stdin closes. */ });
      child.on('close', code => {
        signal.removeEventListener('abort', abort);
        delete this.children[id];
        completion.resolve();
        if (signal.aborted) reject(new Error('Operation cancelled'));
        else if (overflow) reject(new Error('Native CLI output exceeded the safety limit'));
        else if (code !== 0) reject(new Error(sensitive ? 'Native credential import failed. Auth-broker stores require login on the broker host; no credential was reported saved.' : (err || out || `OMP exited with status ${code}`).replace(/\x1b\[[0-9;]*m/g, '').trim()));
        else resolve(out);
      });
      child.stdin.end(input ? JSON.stringify(input) : undefined);
    return promise;
  }
  private async configList(signal: AbortSignal): Promise<JsonObject> {
    const values = objectSchema.parse(parseJson(await this.cli(['config', 'list', '--json'], signal)));
    const [globalSettings, projectSettings] = await Promise.all([persistedSettings(this.options.agentDir), persistedSettings(path.join(this.getWorkspace(), '.omp'), true)]);
    for (const [key, raw] of Object.entries(values)) {
      const entry = object(raw);
      if (secretName.test(key) || flag(entry.redacted)) { const configured = flag(entry.redacted) || (entry.value !== undefined && entry.value !== '' && entry.value !== null); delete entry.value; entry.redacted = configured; entry.secret = true; }
      else if (entry.value !== undefined) entry.value = redact(entry.value);
      entry.scope = 'user';
      // CLI list/get omit effective provenance; report observed persisted layers, not a guessed environment winner.
      entry.provenance = containsSetting(projectSettings, key) ? 'Project override stored; environment may supersede' : containsSetting(globalSettings, key) ? 'User override stored; other discovery/environment layers may supersede' : 'No native persisted override; default/discovery/environment value';
      values[key] = entry;
    }
    return values;
  }
  private async mcpConfig(scope: 'user' | 'project', action: 'list' | 'get' | 'set' | 'remove', signal: AbortSignal, name?: string, config?: JsonObject): Promise<Json> {
    const args = ['mcp', 'config', action, '--scope', scope, '--json'];
    if (name) args.push('--name', name);
    return parseJson(await this.cli(args, signal, config));
  }
  private async mcpList(signal: AbortSignal): Promise<Json[]> {
    const result: Json[] = [], scopes: Record<'user' | 'project', JsonObject> = { user: {}, project: {} };
    for (const scope of ['project', 'user'] as const) scopes[scope] = object(await this.mcpConfig(scope, 'list', signal));
    const userData = scopes.user, projectData = scopes.project;
    for (const scope of ['project', 'user'] as const) {
      const listed = scopes[scope], file = text(listed.path);
      for (const [name, value] of Object.entries(object(listed.mcpServers))) {
        const config = object(value);
        const normalized = { ...config, type: text(config.type) || (config.url ? 'http' : 'stdio') };
        const disabled = array(listed.disabledServers).includes(name) || config.enabled === false;
        const denied = array(userData.disabledServers).includes(name), forced = array(userData.enabledServers).includes(name);
        const shadowed = scope === 'user' && Object.hasOwn(object(projectData.mcpServers), name);
        const effectiveEnabled = !shadowed && !denied && (forced || config.enabled !== false);
        const override = shadowed ? 'Project definition takes precedence' : denied ? 'Disabled by user denylist' : forced && config.enabled === false ? 'Enabled by user allowlist' : '';
        const safe = object(redact(normalized));
        if (safe.env) safe.env = Object.fromEntries(Object.keys(object(config.env)).map(key => [key, '(stored; not displayed)']));
        if (safe.headers) safe.headers = Object.fromEntries(Object.keys(object(config.headers)).map(key => [key, '(stored; not displayed)']));
        const oauth = object(safe.oauth); delete oauth.clientSecret;
        const authConfig = object(safe.auth); delete authConfig.clientSecret;
        result.push({ name, scope, path: file, config: safe, enabled: !disabled, effectiveEnabled, override, hasEnvironment: Object.keys(object(config.env)).length > 0, hasHeaders: Object.keys(object(config.headers)).length > 0 });
      }
    }
    return result;
  }
  private async dispatch(operation: ManagementOperation, args: JsonObject, signal: AbortSignal): Promise<Json> {
    switch (operation) {
      case 'config.list': return this.configList(signal);
      case 'config.get': {
        const key = z.string().min(1).parse(args.key), listed = await this.configList(signal);
        if (!listed[key]) throw new Error('Unknown setting');
        if (flag(object(listed[key]).secret)) return { key, ...object(listed[key]) };
        return redact(parseJson(await this.cli(['config', 'get', key, '--json'], signal)));
      }
      case 'config.set': case 'config.reset': {
        if (args.scope !== undefined && args.scope !== 'user') throw new Error('OMP config CLI writes only user/global settings; project overrides are preserved');
        const key = z.string().min(1).parse(args.key), listed = await this.configList(signal), entry = object(listed[key]);
        if (!listed[key]) throw new Error('Unknown setting');
        const secret = flag(entry.secret);
        const cliArgs = ['config', operation === 'config.set' ? 'set' : 'reset', key];
        if (operation === 'config.set') {
          const value = jsonSchema.parse(args.value);
          if (secret) throw new Error('Use the provider API-key form for credentials; secret config values must not be command arguments');
          if (entry.type === 'boolean') z.boolean().parse(value);
          if (entry.type === 'number') z.number().finite().parse(value);
          if (entry.type === 'array') z.array(jsonSchema).parse(value);
          if (entry.type === 'record') objectSchema.parse(value);
          cliArgs.push(typeof value === 'string' ? value : JSON.stringify(value));
        }
        cliArgs.push('--json');
        const output = parseJson(await this.cli(cliArgs, signal, undefined, secret));
        return { result: secret ? { key, redacted: true } : redact(output), scope: 'user', restartRequired: true };
      }
      case 'credentials.providers': {
        const models = parseJson(await this.cli(['models', 'ls', '--json'], signal));
        const names: Record<string, boolean> = {};
        const visit = (value: Json): void => { if (Array.isArray(value)) { value.forEach(visit); return; } const item = object(value); if (typeof item.provider === 'string') names[item.provider] = true; for (const child of Object.values(item)) if (child && typeof child === 'object') visit(child); };
        visit(models);
        return Object.keys(names).sort().map(id => ({ id, name: id }));
      }
      case 'credentials.save': {
        const provider = z.string().min(1).regex(/^[a-zA-Z0-9_.:-]+$/).parse(args.provider), key = z.string().min(1).parse(args.key);
        // OMP commands/auth.ts AuthExport v1: import merges this single entry and preserves other accounts/providers.
        await this.cli(['auth', 'import', '-'], signal, { version: 1, credentials: [{ provider, credential: { type: 'api_key', key } }] }, true);
        return { status: 'saved', provider, restartRequired: true };
      }
      case 'mcp.list': return this.mcpList(signal);
      case 'mcp.config.list': {
        const scope = scopeSchema.parse(args.scope);
        const result = object(await this.mcpConfig(scope, 'list', signal));
        return redact(result);
      }
      case 'mcp.config.get': {
        const scope = scopeSchema.parse(args.scope), name = nameSchema.parse(args.name);
        return redact(await this.mcpConfig(scope, 'get', signal, name));
      }
      case 'mcp.save': case 'mcp.remove': case 'mcp.config.set': case 'mcp.config.remove': {
        const scope = scopeSchema.parse(args.scope), name = nameSchema.parse(args.name);
        const remove = operation === 'mcp.remove' || operation === 'mcp.config.remove';
        let config: JsonObject | undefined;
        if (!remove) {
          const incoming = objectSchema.parse(args.config);
          const listed = object(await this.mcpConfig(scope, 'list', signal));
          const current = Object.hasOwn(object(listed.mcpServers), name) ? await this.mcpConfig(scope, 'get', signal, name) : null;
          const existing = object(object(current).config);
          // Fetching before merging keeps extension fields and secret values intact.
          const merged = { ...existing, ...incoming };
          if (incoming.type === 'stdio') { delete merged.url; delete merged.headers; }
          else { delete merged.command; delete merged.args; delete merged.env; delete merged.cwd; }
          config = mcpServerSchema.parse(merged);
        }
        await this.mcpConfig(scope, remove ? 'remove' : 'set', signal, name, config);
        return { status: remove ? 'removed' : 'saved', restartRequired: true };
      }
      case 'mcp.authenticate': return this.authenticate(args, signal);
      case 'mcp.reconnect': case 'runtime.restart': await this.options.restartOwners(); return { status: 'restarted' };
      case 'skills.list': return this.skills(signal);
      case 'skills.cli': {
        const action = z.enum(['publish', 'version', 'tag', 'yank', 'deprecate', 'owner', 'token', 'import', 'install', 'update', 'uninstall', 'search', 'info', 'list']).parse(args.action);
        const targets = z.array(z.string().refine(value => !/[\r\n\0]/.test(value))).parse(args.targets);
        const flags = objectSchema.parse(args.flags);
        const booleanFlags = ['dryRun', 'allowSecrets', 'undo', 'global', 'yes', 'json'] as const;
        const stringFlags = ['tag', 'registry', 'scope', 'sort'] as const;
        const cliArgs = ['skill', action];
        for (const key of Object.keys(flags)) {
          if ((booleanFlags as readonly string[]).includes(key)) {
            cliArgs.push(...(z.boolean().parse(flags[key]) ? [`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`] : []));
          } else if ((stringFlags as readonly string[]).includes(key)) {
            const value = z.string().min(1).refine(item => !/[\r\n\0]/.test(item)).parse(flags[key]);
            cliArgs.push(`--${key}`, key === 'sort' ? z.enum(['relevance', 'downloads', 'recent']).parse(value) : value);
          } else if (key === 'package') {
            for (const value of z.array(z.string().min(1).refine(item => !/[\r\n\0]/.test(item))).parse(flags[key])) cliArgs.push('--package', value);
          } else if (key === 'expires') {
            cliArgs.push('--expires', String(z.number().int().positive().parse(flags[key])));
          } else throw new Error(`Unsupported skill flag: ${key}`);
        }
        if (targets.length) cliArgs.push('--', ...targets);
        const sensitive = action === 'token';
        const needsConfirmation = ['publish', 'version', 'tag', 'yank', 'deprecate', 'owner', 'token', 'import', 'install', 'update', 'uninstall'].includes(action);
        if (needsConfirmation && !flag(args.confirmed)) throw new Error('Confirm this skill registry or installation action before continuing');
        const output = await this.cli(cliArgs, signal, undefined, sensitive);
        if (sensitive) return { status: 'completed', output: 'Skill token operation completed. Result withheld.' };
        if (flag(flags.json)) {
          try { return parseJson(output); } catch { return { status: 'completed', output }; }
        }
        return { status: 'completed', output };
      }
      case 'skills.install': {
        const source = await fs.realpath(z.string().min(1).parse(args.sourcePath)), scope = scopeSchema.parse(args.scope);
        const name = path.basename(source); z.string().regex(/^[a-zA-Z0-9_-]+$/).parse(name);
        if (!(await fs.stat(source)).isDirectory()) throw new Error('Select a skill directory');
        const skill = await fs.lstat(path.join(source, 'SKILL.md'));
        if (!skill.isFile() || skill.isSymbolicLink()) throw new Error('Selected directory must contain a regular SKILL.md');
        const root = path.join(scope === 'user' ? this.options.agentDir : path.join(this.getWorkspace(), '.omp'), 'skills');
        await fs.mkdir(root, { recursive: true });
        const destination = path.join(root, name);
        const realRoot = await fs.realpath(root);
        if (source === realRoot || inside(source, path.join(realRoot, name))) throw new Error('Cannot import a skill into its own source directory');
        await fs.mkdir(destination); // EEXIST intentionally refuses to replace authored files.
        try {
          await this.copySkill(source, destination, signal);
          const registryFile = path.join(root, '.desktop-managed.json'), registry = await readObject(registryFile); registry[name] = true; await writeObject(registryFile, registry);
        } catch (error) { await fs.rm(destination, { recursive: true, force: true }); throw error; }
        return { status: 'installed', path: destination, restartRequired: true };
      }
      case 'skills.remove': {
        const selected = z.string().min(1).parse(args.path), candidates = await this.skills(signal);
        const record = candidates.map(object).find(item => item.path === selected && flag(item.managed));
        if (!record || !flag(args.confirmed)) throw new Error('Confirm removal of an imported desktop-managed skill');
        const root = path.dirname(selected), realRoot = await fs.realpath(root), realSelected = await fs.realpath(selected);
        if (!inside(realRoot, realSelected) || path.dirname(realSelected) !== realRoot) throw new Error('Skill path escapes managed directory');
        await fs.rm(realSelected, { recursive: true });
        const file = path.join(root, '.desktop-managed.json'), registry = await readObject(file); delete registry[path.basename(selected)]; await writeObject(file, registry);
        return { status: 'removed', restartRequired: true };
      }
      case 'plugins.list': return parseJson(await this.cli(['plugin', 'list', '--json'], signal));
      case 'plugins.install': case 'plugins.remove': {
        const target = z.string().min(1).refine(value => !value.startsWith('-') && !/[\r\n\0]/.test(value)).parse(args.target);
        if (!flag(args.confirmed)) throw new Error('Confirm plugin installation/removal; plugins execute trusted code');
        const cliArgs = ['plugin', operation === 'plugins.install' ? 'install' : 'uninstall', target, '--json'];
        if (args.scope !== undefined) cliArgs.push('--scope', scopeSchema.parse(args.scope));
        await this.cli(cliArgs, signal); return { status: operation === 'plugins.install' ? 'installed' : 'removed', restartRequired: true };
      }
      case 'extensions.list': return this.extensions(signal);
    }
  }
  private async copySkill(source: string, destination: string, signal: AbortSignal): Promise<void> {
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      signal.throwIfAborted();
      if (entry.isSymbolicLink()) throw new Error('Skill imports cannot contain symbolic links or junctions');
      const from = path.join(source, entry.name), to = path.join(destination, entry.name);
      if (entry.isDirectory()) { await fs.mkdir(to); await this.copySkill(from, to, signal); }
      else if (entry.isFile()) await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      else throw new Error('Skill imports can contain only regular files and directories');
    }
  }
  private async skills(signal: AbortSignal): Promise<Json[]> {
    const list = await this.configList(signal), roots: { directory: string; scope: string; native: boolean }[] = [
      { directory: path.join(this.getWorkspace(), '.omp', 'skills'), scope: 'project', native: true },
      { directory: path.join(this.options.agentDir, 'skills'), scope: 'user', native: true },
    ];
    for (const value of array(object(list['skills.customDirectories']).value)) if (typeof value === 'string') roots.push({ directory: path.resolve(this.getWorkspace(), value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value), scope: 'custom', native: false });
    const result: Json[] = [];
    const scan = async (directory: string, scope: string, managedRoot: string | undefined, depth: number): Promise<void> => {
      if (depth > 12) return; signal.throwIfAborted();
      let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (missing(error)) return; throw error; }
      if (entries.some(entry => entry.name === 'SKILL.md' && entry.isFile())) {
        const file = path.join(directory, 'SKILL.md'), content = await fs.readFile(file, 'utf8');
        const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
        const metadata = front ? object(jsonSchema.parse(parseYaml(front[1]) as unknown)) : {};
        const registry = managedRoot ? await readObject(path.join(managedRoot, '.desktop-managed.json')) : {};
        result.push({ name: text(metadata.name, path.basename(directory)), description: text(metadata.description), content, path: directory, file, scope, managed: !!managedRoot && path.dirname(directory) === managedRoot && flag(registry[path.basename(directory)]) });
        return;
      }
      for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.')) await scan(path.join(directory, entry.name), scope, managedRoot, depth + 1);
    };
    for (const root of roots) await scan(root.directory, root.scope, root.native ? root.directory : undefined, 0);
    return result;
  }
  private async extensions(signal: AbortSignal): Promise<Json[]> {
    const list = await this.configList(signal), result: Json[] = [];
    for (const scope of ['user', 'project'] as const) {
      const root = scope === 'user' ? this.options.agentDir : path.join(this.getWorkspace(), '.omp');
      for (const kind of ['extensions', 'hooks', 'tools', 'commands']) {
        const directory = path.join(root, kind);
        let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (missing(error)) continue; throw error; }
        for (const entry of entries) result.push({ name: entry.name, path: path.join(directory, entry.name), scope, kind, directory: entry.isDirectory() });
      }
    }
    for (const value of array(object(list.extensions).value)) if (typeof value === 'string') result.push({ name: path.basename(value), path: value, scope: 'effective config', kind: 'configured package', disabled: array(object(list.disabledExtensions).value).includes(value) });
    return result;
  }
  private async authenticate(args: JsonObject, signal: AbortSignal): Promise<Json> {
    const scope = scopeSchema.parse(args.scope), name = nameSchema.parse(args.name), stored = object(object(await this.mcpConfig(scope, 'get', signal, name)).config);
    if (!Object.keys(stored).length) throw new Error('Server no longer exists');
    const config = mcpServerSchema.parse({ ...stored, type: text(stored.type) || (stored.url ? 'http' : 'stdio') });
    if (config.type === 'stdio') return { status: 'not-needed', reason: 'stdio servers do not use remote OAuth' };
    if (Object.keys(config.headers ?? {}).some(key => key.toLowerCase() === 'authorization')) return { status: 'not-needed', reason: 'This server has an explicit Authorization header' };
    const fetchFn: typeof fetch = (input, init) => fetch(input, { ...init, signal });
    const probe = await fetchFn(config.url, { method: config.type === 'sse' ? 'GET' : 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...config.headers }, ...(config.type === 'http' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'omp-desktop-auth', version: '0.1.0' } } }) } : {}) });
    await probe.body?.cancel();
    const explicit = object(config.oauth);
    if (probe.ok && !Object.keys(explicit).length && object(config.auth).type !== 'oauth') return { status: 'not-needed', reason: 'Server accepted the transport request without an OAuth challenge' };
    if (!probe.ok && probe.status !== 401 && probe.status !== 403 && !Object.keys(explicit).length) throw new Error(`Server returned HTTP ${probe.status}; OAuth was not advertised`);
    const hints = extractWWWAuthenticateParams(probe), state = randomBytes(32).toString('hex');
    let verifier = '';
    const session: { tokens?: OAuthTokens; client?: OAuthClientInformationMixed; discovery?: OAuthDiscoveryState } = {};
    const { promise: codePromise, resolve: resolveCode, reject: rejectCode } = Promise.withResolvers<string>();
    // Prevent unhandled rejection if cancellation arrives before discovery completes.
    void codePromise.catch(() => undefined);
    const redirect = explicit.redirectUri ? new URL(z.string().parse(explicit.redirectUri)) : undefined;
    if (redirect && (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(redirect.hostname))) throw new Error('Desktop OAuth requires an HTTP loopback redirect URI');
    const rawCallbackPath = redirect?.pathname || text(explicit.callbackPath, '/callback');
    const callbackPath = rawCallbackPath.startsWith('/') ? rawCallbackPath : `/${rawCallbackPath}`;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== callbackPath) { response.writeHead(404).end(); return; }
      if (url.searchParams.get('state') !== state) { response.writeHead(400).end('Invalid OAuth state'); return; }
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.has('error')) { response.writeHead(400).end('Authorization was declined. Return to OMP Desktop.'); rejectCode(new Error('OAuth authorization declined')); return; }
      response.writeHead(200, { 'content-type': 'text/plain' }).end('Authorization received. You can close this window and return to OMP Desktop.'); resolveCode(code);
    });
    const abort = (): void => { rejectCode(new Error('OAuth cancelled')); server.close(); };
    const timer = setTimeout(() => { rejectCode(new Error('OAuth authorization timed out')); server.close(); }, 300_000);
    signal.addEventListener('abort', abort, { once: true });
    try {
      const listening = Promise.withResolvers<void>();
      server.once('error', listening.reject);
      server.listen(redirect ? Number(redirect.port || 80) : typeof explicit.callbackPort === 'number' ? explicit.callbackPort : 0, redirect?.hostname || '127.0.0.1', listening.resolve);
      await listening.promise;
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('OAuth callback listener unavailable');
      const redirectUrl = redirect?.href ?? `http://127.0.0.1:${address.port}${callbackPath.startsWith('/') ? callbackPath : `/${callbackPath}`}`;
      if (explicit.clientId) session.client = { client_id: z.string().parse(explicit.clientId), ...(typeof explicit.clientSecret === 'string' ? { client_secret: explicit.clientSecret } : {}) };
      if (explicit.authorizationUrl && explicit.tokenUrl) session.discovery = { authorizationServerUrl: new URL(z.string().parse(explicit.authorizationUrl)).origin, authorizationServerMetadata: { issuer: new URL(z.string().parse(explicit.authorizationUrl)).origin, authorization_endpoint: httpUrl.parse(explicit.authorizationUrl), token_endpoint: httpUrl.parse(explicit.tokenUrl), response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], ...(explicit.registrationUrl ? { registration_endpoint: httpUrl.parse(explicit.registrationUrl) } : {}) } };
      const provider: OAuthClientProvider = {
        redirectUrl, clientMetadata: { client_name: 'OMP Desktop', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: session.client?.client_secret ? 'client_secret_post' : 'none' },
        state: () => state, clientInformation: () => session.client, saveClientInformation: value => { session.client = value; }, tokens: () => session.tokens, saveTokens: value => { session.tokens = value; },
        redirectToAuthorization: url => {
          const requestedPrompt = typeof explicit.prompt === 'string' ? explicit.prompt : /(?:^|\s)offline_access(?:\s|$)/.test(text(explicit.scope) || hints.scope || '') ? 'consent' : undefined;
          if (requestedPrompt) url.searchParams.set('prompt', requestedPrompt);
          else if (requestedPrompt === '') url.searchParams.delete('prompt');
          return this.options.openExternal(url.href);
        }, saveCodeVerifier: value => { verifier = value; }, codeVerifier: () => verifier,
        discoveryState: () => session.discovery, saveDiscoveryState: value => { session.discovery = value; },
      };
      const options = { serverUrl: config.url, scope: text(explicit.scope) || hints.scope, resourceMetadataUrl: hints.resourceMetadataUrl, fetchFn };
      const first = await auth(provider, options);
      if (first === 'REDIRECT') { const code = await codePromise; if (await auth(provider, { ...options, authorizationCode: code }) !== 'AUTHORIZED') throw new Error('OAuth did not complete'); }
      const { tokens: token, client, discovery } = session;
      if (!token?.access_token || !discovery?.authorizationServerMetadata?.token_endpoint || !client?.client_id) throw new Error('OAuth completed without usable token/refresh metadata');
      // OMP mcp/oauth-flow.ts embeds refresh material in the OAuth row keyed by profile + verbatim URL.
      const rawProfile = process.env.OMP_PROFILE !== undefined ? process.env.OMP_PROFILE : process.env.PI_PROFILE;
      const profile = rawProfile?.trim() || 'default';
      const credential: JsonObject = { type: 'oauth', access: token.access_token, refresh: token.refresh_token ?? '', expires: Date.now() + (token.expires_in ?? 3600) * 1000, tokenUrl: discovery.authorizationServerMetadata.token_endpoint, clientId: client.client_id, authorizationUrl: discovery.authorizationServerMetadata.authorization_endpoint ?? discovery.authorizationServerUrl.toString() };
      if (client.client_secret) credential.clientSecret = client.client_secret;
      if (discovery.resourceMetadata?.resource) credential.resource = discovery.resourceMetadata.resource;
      const credentialId = `mcp_oauth:profile:${profile}:${config.url}`;
      await this.cli(['auth', 'import', '-'], signal, { version: 1, credentials: [{ provider: credentialId, credential }] }, true);
      return { status: 'authenticated', restartRequired: true };
    } catch (error) {
      if (signal.aborted) throw new Error('OAuth cancelled');
      // SDK token errors may contain response bodies; never send those to the renderer.
      if (error instanceof Error && /OAuth (authorization declined|authorization timed out|did not complete|completed without)|callback listener|loopback/.test(error.message)) throw error;
      throw new Error('MCP OAuth failed. Check server OAuth discovery, client registration and native auth-broker configuration. No credential was reported saved.');
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); server.close(); }
  }
}
