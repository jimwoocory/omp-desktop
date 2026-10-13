import { useEffect, useRef, useState } from 'react';
import type { Json, JsonObject, ManagementOperation, OwnerSnapshot, Preferences, RpcCommand } from '../shared/contracts';
import { array, flag, jsonSchema, number, object, ownerSchema, preferencesSchema, text } from '../shared/validation';
import './management.css';

export type Section = 'Providers' | 'Models' | 'Settings' | 'MCP' | 'Skills' | 'Plugins' | 'Runtime';
interface Props { workspace: string; initialSection?: Section; authorizationPending?: boolean; onSettingsSession: (snapshot: OwnerSnapshot) => void; onCredentialsChanged: () => Promise<void>; onPreferencesChanged: (preferences: Preferences) => void; onClose: () => void; onError: (message: string) => void }
const sections: Section[] = ['Providers', 'Models', 'Settings', 'MCP', 'Skills', 'Plugins', 'Runtime'];
const records = (value: Json): JsonObject[] => array(value).map(object);
const unpack = (value: Json, field: string): Json => Array.isArray(value) ? value : object(value)[field] ?? value;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
function editorJson(value: string, field: string): Json {
  try { return jsonSchema.parse(JSON.parse(value) as unknown); }
  catch { throw new Error(`${field} must contain valid JSON; entered values are not included in errors`); }
}

function SettingRow({ name, entry, busy, save, reset }: { name: string; entry: JsonObject; busy: boolean; save: (value: Json) => void; reset: () => void }) {
  const kind = text(entry.type), value = entry.value;
  const [draft, setDraft] = useState(typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2));
  const [error, setError] = useState('');
  useEffect(() => { setDraft(typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2)); }, [value]);
  const submit = (): void => {
    try { const parsed = kind === 'string' || kind === 'enum' ? draft : jsonSchema.parse(JSON.parse(draft) as unknown); setError(''); save(parsed); }
    catch { setError(`Enter a valid ${kind === 'array' || kind === 'record' ? 'JSON ' : ''}${kind} value`); }
  };
  return <article className="management-setting"><div><strong>{name}</strong><span className="management-badge">{kind}</span><p>{text(entry.description)}</p><small>{text(entry.provenance)} · saves to user/global config</small></div>
    {flag(entry.secret) ? <p>{flag(entry.redacted) ? 'Credential configured; value not displayed.' : 'Credential not configured.'} Use Providers for API keys.</p> : kind === 'boolean' ? <select aria-label={`${name} value`} disabled={busy} value={draft || 'false'} onChange={event => setDraft(event.target.value)}><option value="true">true</option><option value="false">false</option></select> : <textarea aria-label={`${name} value`} rows={kind === 'array' || kind === 'record' ? 3 : 1} disabled={busy} value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false} />}
    {error && <p role="alert">{error}</p>}<div className="management-actions">{!flag(entry.secret) && <button disabled={busy} onClick={submit}>Save</button>}<button disabled={busy} onClick={reset}>Reset user override</button></div></article>;
}

export default function Management({ workspace, initialSection = 'Providers', authorizationPending = false, onSettingsSession, onCredentialsChanged, onPreferencesChanged, onClose, onError }: Props) {
  const [section, setSection] = useState<Section>(initialSection);
  const [data, setData] = useState<Json>(null), [extensions, setExtensions] = useState<Json[]>([]), [providers, setProviders] = useState<JsonObject[]>([]), [models, setModels] = useState<JsonObject[]>([]);
  const [preferences, setPreferences] = useState<Preferences>();
  const [initialModel, setInitialModel] = useState('');
  useEffect(() => { setInitialModel(preferences?.initialModel ?? ''); }, [preferences?.initialModel]);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [search, setSearch] = useState('');
  const [provider, setProvider] = useState('openai'), [apiKey, setApiKey] = useState(''), [accounts, setAccounts] = useState<JsonObject[]>([]);
  const [mcpName, setMcpName] = useState(''), [mcpScope, setMcpScope] = useState('user'), [transport, setTransport] = useState('stdio');
  const [command, setCommand] = useState(''), [argumentsText, setArgumentsText] = useState('[]'), [url, setUrl] = useState(''), [cwd, setCwd] = useState(''), [enabled, setEnabled] = useState(true);
  const [envText, setEnvText] = useState(''), [headersText, setHeadersText] = useState(''), [oauthText, setOauthText] = useState('');
  const [editing, setEditing] = useState(false), [skillDetails, setSkillDetails] = useState<JsonObject>();
  const [skillAction, setSkillAction] = useState('search'), [skillTargets, setSkillTargets] = useState('[]'), [skillFlags, setSkillFlags] = useState('{}'), [skillOutput, setSkillOutput] = useState<Json>();
  const [pluginTarget, setPluginTarget] = useState(''), [pluginScope, setPluginScope] = useState('user');
  const [confirmation, setConfirmation] = useState<{ message: string; action: () => Promise<void> }>();
  const mounted = useRef(true), loadSequence = useRef(0), running = useRef(false);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const settingsSession = async () => {
    const target = workspace;
    const snapshot = ownerSchema.parse(await window.desktop.settingsSession(target));
    if (workspaceRef.current !== target) throw new Error('Workspace changed; reopen authorization for the current workspace.');
    onSettingsSession(snapshot);
    if (snapshot.status !== 'ready') throw new Error(snapshot.error || 'Settings runtime is not ready. Check the executable in Runtime.');
    return snapshot;
  };
  const settingsRpc = async (command: RpcCommand): Promise<Json> => {
    const snapshot = await settingsSession();
    return jsonSchema.parse(await window.desktop.settingsRequest(snapshot.id, command));
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const report = (failure: unknown): void => { const message = errorMessage(failure); if (mounted.current) setError(message); onError(message); };
  const load = async (target = section): Promise<void> => {
    const sequence = ++loadSequence.current;
    const operation: Partial<Record<Section, ManagementOperation>> = { Settings: 'config.list', MCP: 'mcp.list', Skills: 'skills.list', Plugins: 'plugins.list' };
    if (target === 'Providers') {
      const login = await settingsRpc({ type: 'get_login_providers' });
      if (!mounted.current || sequence !== loadSequence.current) return;
      setProviders(records(unpack(login, 'providers')));
      const configured = await window.desktop.manage('credentials.providers', { workspace });
      if (mounted.current && sequence === loadSequence.current) setData(jsonSchema.parse(configured));
      return;
    }
    if (target === 'Runtime' || target === 'Models') {
      const next = preferencesSchema.parse((await window.desktop.bootstrap()).preferences);
      if (!mounted.current || sequence !== loadSequence.current) return;
      setPreferences(next);
    } else {
      const result = await window.desktop.manage(operation[target]!, { workspace });
      if (!mounted.current || sequence !== loadSequence.current) return;
      setData(jsonSchema.parse(result));
    }
    if (target === 'Models') {
      const available = await settingsRpc({ type: 'get_available_models' });
      if (mounted.current && sequence === loadSequence.current) setModels(records(unpack(available, 'models')));
    }
    if (target === 'Plugins') { const inventory = await window.desktop.manage('extensions.list', { workspace }); if (mounted.current && sequence === loadSequence.current) setExtensions(array(inventory)); }
  };
  useEffect(() => { setData(null); setError(''); setNotice(''); setSearch(''); setSkillDetails(undefined); setAccounts([]); setApiKey(''); setEnvText(''); setHeadersText(''); setOauthText(''); setProviders([]); setModels([]); void load(section).catch(report); return () => { loadSequence.current++; }; }, [section, workspace]);
  const run = async (label: string, action: () => Promise<Json | void>, refresh = true): Promise<void> => {
    if (running.current) return; running.current = true; setBusy(label); setError(''); setNotice('');
    try {
      const result = await action();
      if (mounted.current) {
        const item = object(result ?? null), nativeResult = object(item.result), override = text(nativeResult.overriddenBy) || text(nativeResult.fallbackEnv);
        setNotice(`${flag(item.cancelled) ? 'Operation cancelled; authorization was not completed.' : text(item.reason, text(item.status, label === 'Loading stored accounts' || label === 'Refreshing' ? 'Loaded' : 'Saved'))}${override ? ` · Effective value supplied by ${override}` : ''}${flag(item.restartRequired) ? ' · Restart idle sessions to apply.' : ''}`);
        if (refresh) await load();
      }
    } catch (failure) { report(failure); }
    finally { running.current = false; if (mounted.current) setBusy(''); }
  };
  const manage = (operation: ManagementOperation, args: JsonObject = {}): Promise<Json> => window.desktop.manage(operation, { ...args, workspace });
  const confirm = (message: string, action: () => Promise<void>): void => setConfirmation({ message, action });
  const cancel = async (): Promise<void> => {
    try { await manage('runtime.restart', { cancel: true }); setNotice('Cancellation requested. Completed writes are not rolled back.'); } catch (failure) { report(failure); }
  };
  const clearMcp = (): void => { setEditing(false); setMcpName(''); setCommand(''); setUrl(''); setArgumentsText('[]'); setCwd(''); setTransport('stdio'); setEnabled(true); setEnvText(''); setHeadersText(''); setOauthText(''); };
  const executeSkill = (): void => {
    const targets = editorJson(skillTargets, 'Targets'), flags = editorJson(skillFlags, 'Flags');
    if (!Array.isArray(targets) || targets.some(item => typeof item !== 'string')) throw new Error('Targets must be a JSON string array');
    if (!flags || Array.isArray(flags) || typeof flags !== 'object') throw new Error('Flags must be a JSON object');
    const parsedFlags = flags as JsonObject;
    const destructive = ['publish', 'version', 'tag', 'yank', 'deprecate', 'owner', 'token', 'import', 'install', 'update', 'uninstall'].includes(skillAction);
    const action = async (): Promise<void> => {
      await run(`Running skill ${skillAction}`, async () => {
        const result = await manage('skills.cli', { action: skillAction, targets, flags: parsedFlags, confirmed: destructive });
        setSkillOutput(result);
        return result;
      });
    };
    if (destructive) confirm(`Run skill ${skillAction}? This may publish, change registry state, remove skills, or execute installation scripts.`, action);
    else void action();
  };
  const editMcp = (item: JsonObject): void => {
    const config = object(item.config); setEditing(true); setMcpName(text(item.name)); setMcpScope(text(item.scope)); setTransport(text(config.type)); setCommand(text(config.command)); setArgumentsText(JSON.stringify(array(config.args), null, 2)); setUrl(text(config.url)); setCwd(text(config.cwd)); setEnabled(flag(item.enabled)); setEnvText(''); setHeadersText(''); setOauthText('');
  };
  const saveMcp = async (): Promise<Json> => {
    const config: JsonObject = { type: transport, enabled };
    if (transport === 'stdio') { config.command = command; config.args = editorJson(argumentsText, 'Arguments'); if (cwd) config.cwd = cwd; if (envText.trim()) config.env = editorJson(envText, 'Environment'); }
    else { config.url = url; if (headersText.trim()) config.headers = editorJson(headersText, 'Headers'); }
    if (oauthText.trim()) config.oauth = editorJson(oauthText, 'OAuth metadata');
    const result = await manage('mcp.save', { name: mcpName, scope: mcpScope, config }); clearMcp(); return result;
  };
  const logoutAccounts = async (id: string): Promise<void> => {
    await run('Loading stored accounts', async () => { const response = await settingsRpc({ type: 'get_logout_accounts', providerId: id }); setProvider(id); setAccounts(records(unpack(response, 'accounts'))); }, false);
  };
  const credentialsChanged = async (): Promise<void> => { await onCredentialsChanged(); setAccounts([]); };
  const login = async (id: string): Promise<Json> => {
    try {
      const snapshot = await settingsSession();
      const off = window.desktop.onEvent(event => {
        if (event.scope === 'settings' && event.ownerId === snapshot.id
          && event.frame.type === 'extension_ui_request' && event.frame.method === 'open_url') {
          void window.desktop.openExternal(text(event.frame.launchUrl, text(event.frame.url))).catch(report);
        }
      });
      let response: JsonObject;
      try { response = object(await window.desktop.settingsRequest(snapshot.id, { type: 'login', providerId: id })); }
      finally { off(); }
      const discovered = records(unpack(await settingsRpc({ type: 'get_login_providers' }), 'providers'));
      const authenticated = flag(discovered.find(item => text(item.id) === id)?.authenticated);
      return { status: flag(response.cancelled) ? 'Authorization cancelled.' : authenticated ? 'Authenticated' : 'Authorization did not complete; provider is not authenticated.' };
    } finally {
      try { await credentialsChanged(); } catch (failure) { report(failure); }
      try { onSettingsSession(ownerSchema.parse(await window.desktop.settingsSession(workspace))); } catch (failure) { report(failure); }
    }
  };
  const savePreferences = async (patch: Partial<Preferences>): Promise<void> => {
    const next = await window.desktop.preferences(patch); setPreferences(next); onPreferencesChanged(next);
  };
  const chooseExecutable = async (): Promise<void> => { const executable = await window.desktop.chooseExecutable(); if (executable) await savePreferences({ executable }); };
  const chooseWorkspace = async (): Promise<void> => {
    const chosen = await window.desktop.chooseWorkspace(); if (!chosen) return;
    const current = (await window.desktop.bootstrap()).preferences;
    const workspaces = current.workspaces.some(item => item.path === chosen.path) ? current.workspaces : [...current.workspaces, chosen];
    const selected = workspaces.find(item => item.path === chosen.path)!;
    await savePreferences({ workspaces, activeWorkspace: selected.id });
  };
  return <div className="management-backdrop"><section className="management-dialog" role="dialog" aria-modal="true" aria-labelledby="management-title"><header><div><h2 id="management-title">Workbench settings</h2><small>{workspace}</small></div><button aria-label="Close settings" onClick={onClose}>Close</button></header>
    <div className="management-layout"><nav aria-label="Settings sections">{sections.map(item => <button key={item} className={section === item ? 'selected' : ''} disabled={!!busy} onClick={() => setSection(item)}>{item}</button>)}</nav>
    <main>{error && <div className="management-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss settings error">Dismiss</button></div>}{notice && <div className="management-notice" role="status">{notice}<button onClick={() => setNotice('')}>Dismiss</button></div>}
      {busy && <div className="management-busy" role="status">{busy}… {busy === 'OAuth login' ? <span>Cancel using the authorization prompt; closing settings does not stop native login.</span> : <button onClick={() => void cancel()}>Cancel operation</button>}</div>}
      {authorizationPending && busy !== 'OAuth login' && <div className="management-busy" role="status">Native settings authorization is still pending. Continue or cancel using the authorization prompt; closing settings does not cancel it.</div>}
      <div className="management-section-heading"><h3>{section}</h3><button disabled={!!busy} onClick={() => void run('Refreshing', async () => { await load(); }, false)}>Refresh</button></div>
      {section === 'Providers' && <><p>Credentials are stored globally in OMP’s native store; provider discovery uses the selected workspace’s independent settings runtime. Authorization never creates or switches a conversation. API keys travel only over local IPC and stdin, never command arguments.</p>
        {!workspace && <p>Select a workspace to discover native authorization providers.</p>}
        {workspace && !providers.length && <p>No native authorization providers loaded. Check the error above or refresh; API-key configuration remains available below.</p>}
        <div className="management-cards">{providers.map(item => <article key={text(item.id)}><strong>{text(item.name, text(item.id))}</strong><p>{flag(item.authenticated) ? 'Authenticated' : 'Not authenticated'}</p><div className="management-actions"><button disabled={!!busy || authorizationPending || !workspace || item.available === false} onClick={() => void run('OAuth login', () => login(text(item.id)))}>Sign in</button><button disabled={!!busy || authorizationPending || !workspace} onClick={() => void logoutAccounts(text(item.id))}>Accounts / Sign out</button></div></article>)}</div>
        {accounts.length > 0 && <article><h4>Stored accounts for {provider}</h4>{accounts.map(account => <div className="management-item" key={number(account.credentialId)}><div><strong>{text(account.label)}</strong><p>{text(account.detail)} · {text(account.type)}{flag(account.active) ? ' · Active' : ''}</p></div><button disabled={!!busy || authorizationPending} onClick={() => confirm(`Remove ${text(account.label)} from ${provider}?`, () => run('Signing out', async () => { const result = await settingsRpc({ type: 'logout', providerId: provider, credentialId: number(account.credentialId) }); await credentialsChanged(); return result; }))}>Sign out</button></div>)}</article>}
        <form onSubmit={event => { event.preventDefault(); const key = apiKey; setApiKey(''); void run('Saving API key', async () => { const result = await manage('credentials.save', { provider, key }); await credentialsChanged(); return result; }); }}><h4>Provider API key</h4><label>Provider ID<input list="management-provider-ids" value={provider} disabled={!!busy || authorizationPending} onChange={event => { setProvider(event.target.value); setAccounts([]); }} required autoComplete="off" /></label><datalist id="management-provider-ids">{records(data).map(item => <option key={text(item.id)} value={text(item.id)} />)}</datalist><label>API key<input type="password" value={apiKey} disabled={!!busy || authorizationPending} onChange={event => setApiKey(event.target.value)} required autoComplete="new-password" spellCheck={false} /></label><button disabled={!!busy || authorizationPending || !apiKey || !provider} type="submit">Save key to native store</button></form></>}
      {section === 'Models' && <><p>The native model catalog is discovered for this workspace without opening chat history. This desktop default is global and applies only to new conversations; saved/current conversations keep their model and thinking level.</p>{!models.length && <p>No available native models. Provider authorization may be required. <button disabled={!!busy} onClick={() => setSection('Providers')}>Open Providers / Authorization</button></p>}{preferences && <form onSubmit={event => { event.preventDefault(); void run('Saving initial model', () => savePreferences({ initialModel: initialModel.trim() })); }}><h4>New-conversation default</h4><label>Available native models<select aria-label="Default model from native catalog" disabled={!!busy || !models.length} value={models.some(item => `${text(item.provider)}/${text(item.id)}` === initialModel) ? initialModel : ''} onChange={event => setInitialModel(event.target.value)}><option value="">Use native default / select a model</option>{models.map(item => <option key={`${text(item.provider)}/${text(item.id)}`} value={`${text(item.provider)}/${text(item.id)}`}>{text(item.name, text(item.id))} · {text(item.provider)}</option>)}</select></label><label>Explicit custom model (optional)<input disabled={!!busy} value={initialModel} onChange={event => setInitialModel(event.target.value)} placeholder="provider/model-id" autoComplete="off" spellCheck={false} /></label><p>Leave blank for OMP’s native default. Selecting or saving here does not invoke a model or change an existing chat.</p><button type="submit" disabled={!!busy || initialModel.trim() === (preferences.initialModel ?? '')}>Save default model</button></form>}<div className="management-cards">{models.map(item => <article key={`${text(item.provider)}/${text(item.id)}`}><strong>{text(item.name, text(item.id))}</strong><p>{text(item.provider)}/{text(item.id)}</p></article>)}</div></>}
      {section === 'Settings' && <><p>Effective settings include project and environment overrides. Save/reset affect only user/global configuration; restart idle sessions to apply. OMP reports override provenance after saving.</p><label>Search settings<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>{Object.entries(object(data)).filter(([name, entry]) => `${name} ${text(object(entry).description)}`.toLowerCase().includes(search.toLowerCase())).map(([name, entry]) => <SettingRow key={name} name={name} entry={object(entry)} busy={!!busy} save={value => void run(`Saving ${name}`, () => manage('config.set', { key: name, value, scope: 'user' }))} reset={() => confirm(`Reset the user override for ${name}? Project and environment values remain.`, () => run(`Resetting ${name}`, () => manage('config.reset', { key: name, scope: 'user' })))} />)}</>}
      {section === 'MCP' && <><p>Native user and project MCP definitions. Stored environment/header values stay private and are preserved when left blank. Servers execute trusted code or contact their configured endpoint.</p><button disabled={!!busy} onClick={() => void run('Reconnecting MCP', () => manage('mcp.reconnect'))}>Restart idle sessions / Reconnect</button>
        {records(data).filter(item => text(item.override)).map(item => <p key={`override:${text(item.scope)}:${text(item.name)}`} className="management-notice">{text(item.name)} ({text(item.scope)}): {text(item.override)} · Effective native state: {flag(item.effectiveEnabled) ? 'enabled' : 'disabled'}</p>)}
        {records(data).map(item => { const config = object(item.config); return <article className="management-item" key={`${text(item.scope)}:${text(item.name)}`}><div><strong>{text(item.name)}</strong><span className="management-badge">{text(item.scope)} · {text(config.type)}</span><p>{text(config.command) || text(config.url)}</p><small>{flag(item.enabled) ? 'Enabled' : 'Disabled'}{flag(item.hasEnvironment) ? ' · Environment configured' : ''}{flag(item.hasHeaders) ? ' · Headers configured' : ''}</small></div><div className="management-actions"><button disabled={!!busy} onClick={() => editMcp(item)}>Edit</button><button disabled={!!busy} onClick={() => void run('Updating MCP', () => manage('mcp.save', { name: text(item.name), scope: text(item.scope), config: { type: text(config.type), enabled: !flag(item.enabled) } }))}>{flag(item.enabled) ? 'Disable' : 'Enable'}</button><button disabled={!!busy} onClick={() => void run('Authorizing MCP', () => manage('mcp.authenticate', { name: text(item.name), scope: text(item.scope) }))}>Authenticate</button><button disabled={!!busy} onClick={() => confirm(`Remove ${text(item.name)} (${text(item.scope)})? Stored OAuth credentials are not removed.`, () => run('Removing MCP', () => manage('mcp.remove', { name: text(item.name), scope: text(item.scope) })))}>Remove</button></div></article>; })}
        <form onSubmit={event => { event.preventDefault(); void run('Saving MCP', saveMcp); }}><h4>{editing ? 'Edit server' : 'Add server'}</h4><div className="management-form-grid"><label>Name<input required disabled={!!busy || editing} value={mcpName} onChange={event => setMcpName(event.target.value)} /></label><label>Scope<select disabled={!!busy || editing} value={mcpScope} onChange={event => setMcpScope(event.target.value)}><option value="user">User</option><option value="project">Project</option></select></label><label>Transport<select disabled={!!busy} value={transport} onChange={event => setTransport(event.target.value)}><option value="stdio">stdio</option><option value="http">Streamable HTTP</option><option value="sse">Legacy SSE</option></select></label><label className="management-checkbox"><input type="checkbox" checked={enabled} disabled={!!busy} onChange={event => setEnabled(event.target.checked)} />Enabled</label></div>
          {transport === 'stdio' ? <><label>Executable command (no shell)<input required disabled={!!busy} value={command} onChange={event => setCommand(event.target.value)} /></label><label>Arguments (JSON string array)<textarea disabled={!!busy} value={argumentsText} onChange={event => setArgumentsText(event.target.value)} spellCheck={false} /></label><label>Working directory<input disabled={!!busy} value={cwd} onChange={event => setCwd(event.target.value)} /></label><label>Replace environment (JSON string map; blank preserves stored values)<textarea disabled={!!busy} value={envText} onChange={event => setEnvText(event.target.value)} autoComplete="off" spellCheck={false} /></label></> : <><label>Server URL<input required type="url" disabled={!!busy} value={url} onChange={event => setUrl(event.target.value)} /></label><label>Replace headers (JSON string map; blank preserves stored values)<textarea disabled={!!busy} value={headersText} onChange={event => setHeadersText(event.target.value)} autoComplete="off" spellCheck={false} /></label></>}
          <details><summary>Explicit OAuth client settings</summary><label>Replace OAuth metadata (JSON object; blank uses discovery or preserves existing metadata)<textarea disabled={!!busy} value={oauthText} onChange={event => setOauthText(event.target.value)} autoComplete="off" spellCheck={false} /></label><p>Supported native fields include authorizationUrl, tokenUrl, clientId, clientSecret, scope, redirectUri, callbackPort, callbackPath and registrationUrl. Desktop callbacks must use HTTP loopback.</p></details><div className="management-actions"><button type="submit" disabled={!!busy}>Save server</button>{editing && <button type="button" disabled={!!busy} onClick={clearMcp}>Cancel edit</button>}</div></form></>}
      {section === 'Skills' && <><p>Browse installed skills and run any supported OMP skill registry action. Targets are a JSON string array and flags are a JSON object; CLI arguments are passed directly without a shell. Publishing, registry mutations, removals and script-enabled installs require confirmation.</p>
        <details><summary>Run OMP skill action</summary><div className="management-form-grid"><label>Action<select disabled={!!busy} value={skillAction} onChange={event => setSkillAction(event.target.value)}>{['publish', 'version', 'tag', 'yank', 'deprecate', 'owner', 'token', 'import', 'install', 'update', 'uninstall', 'search', 'info', 'list'].map(action => <option key={action}>{action}</option>)}</select></label><label>Targets (JSON string array)<textarea disabled={!!busy} value={skillTargets} onChange={event => setSkillTargets(event.target.value)} spellCheck={false} /></label><label>Flags (JSON object)<textarea disabled={!!busy} value={skillFlags} onChange={event => setSkillFlags(event.target.value)} spellCheck={false} /></label></div><button disabled={!!busy} onClick={() => { try { executeSkill(); } catch (failure) { report(failure); } }}>Run skill action</button>{skillOutput !== undefined && <pre className="management-skill-content" aria-label="Skill CLI result">{JSON.stringify(skillOutput, null, 2)}</pre>}</details>
        <p>Local folder import remains available without running package scripts. Existing directories are never overwritten; only desktop-imported skills can be removed here.</p><div className="management-actions"><button disabled={!!busy} onClick={() => void run('Importing skill', () => manage('skills.install', { scope: 'user' }))}>Import to user skills…</button><button disabled={!!busy} onClick={() => void run('Importing skill', () => manage('skills.install', { scope: 'project' }))}>Import to project skills…</button></div>{records(data).map(item => <article className="management-item" key={text(item.path)}><div><strong>{text(item.name)}</strong><span className="management-badge">{text(item.scope)}</span><p>{text(item.description)}</p><small>{text(item.path)}</small></div><div className="management-actions"><button onClick={() => setSkillDetails(item)}>Details</button>{flag(item.managed) && <button disabled={!!busy} onClick={() => confirm(`Delete imported skill ${text(item.name)} and all files in ${text(item.path)}?`, () => run('Removing skill', () => manage('skills.remove', { path: text(item.path), confirmed: true })))}>Remove</button>}</div></article>)}{skillDetails && <article><div className="management-section-heading"><h4>{text(skillDetails.name)}</h4><button onClick={() => setSkillDetails(undefined)}>Close details</button></div><pre className="management-skill-content">{text(skillDetails.content)}</pre></article>}</>}
      {section === 'Plugins' && <><p>Plugins are trusted executable code. Install/remove uses OMP’s native plugin CLI; npm/git/local package targets use native user scope, while marketplace targets support user or project scope.</p><form onSubmit={event => { event.preventDefault(); confirm(`Install ${pluginTarget}? Native package installation may execute package lifecycle scripts. Install only sources you trust.`, () => run('Installing plugin', () => manage('plugins.install', { target: pluginTarget, scope: pluginScope, confirmed: true }))); }}><label>Package, marketplace ID, Git URL or local path<input value={pluginTarget} required disabled={!!busy} onChange={event => setPluginTarget(event.target.value)} /></label><label>Marketplace scope<select value={pluginScope} disabled={!!busy} onChange={event => setPluginScope(event.target.value)}><option value="user">User</option><option value="project">Project (marketplace only)</option></select></label><button disabled={!!busy || !pluginTarget}>Install plugin</button></form>
        {[...array(object(data).npm), ...array(object(data).marketplace)].map(object).map(item => { const target = text(item.id, text(item.name)); return <article className="management-item" key={`${target}:${text(item.scope)}`}><div><strong>{target}</strong><p>{text(item.version)} {text(item.scope)} {text(object(item.manifest).description)}</p></div><button disabled={!!busy} onClick={() => confirm(`Uninstall ${target}?`, () => run('Removing plugin', () => manage('plugins.remove', { target, ...(item.scope === 'user' || item.scope === 'project' ? { scope: item.scope } : {}), confirmed: true })))}>Remove</button></article>; })}<h4>Native extension inventory</h4><p>Files and effective configured packages; discovery is controlled by OMP settings.</p>{extensions.map(object).map(item => <article key={`${text(item.scope)}:${text(item.path)}`}><strong>{text(item.name)}</strong><p>{text(item.kind)} · {text(item.scope)}{flag(item.disabled) ? ' · Disabled' : ''}</p><small>{text(item.path)}</small></article>)}</>}
      {section === 'Runtime' && preferences && <><article><h4>OMP executable</h4><p className="management-path">{preferences.executable}</p><button disabled={!!busy} onClick={() => void run('Choosing executable', chooseExecutable)}>Choose executable…</button><p>Changes apply when sessions are restarted. Existing sessions remain owned by their original runtime until then.</p></article><article><h4>Workspaces</h4>{preferences.workspaces.map(item => <div className="management-item" key={item.id}><div><strong>{item.name}</strong><small>{item.path}</small></div><button disabled={!!busy || preferences.activeWorkspace === item.id} onClick={() => void run('Choosing workspace', () => savePreferences({ activeWorkspace: item.id }))}>{preferences.activeWorkspace === item.id ? 'Active' : 'Make active'}</button></div>)}<button disabled={!!busy} onClick={() => void run('Adding workspace', chooseWorkspace)}>Choose workspace…</button></article><article><label>Theme<select disabled={!!busy} value={preferences.theme} onChange={event => void run('Saving theme', () => savePreferences({ theme: event.target.value === 'light' ? 'light' : 'dark' }))}><option value="dark">Dark</option><option value="light">Light</option></select></label><label className="management-checkbox"><input type="checkbox" checked={preferences.notifications} disabled={!!busy} onChange={event => void run('Saving notifications', () => savePreferences({ notifications: event.target.checked }))} />Desktop notifications</label></article></>}
      <footer><button disabled={!!busy || authorizationPending} onClick={() => confirm('Restart all idle OMP session owners? Active runs must finish or be stopped first. Sessions retain their own saved histories.', () => run('Restarting runtime', () => manage('runtime.restart')))}>Restart idle sessions</button></footer>
    </main></div>{confirmation && <div className="management-confirm" role="alertdialog" aria-modal="true" aria-label="Confirm management change"><div><p>{confirmation.message}</p><div className="management-actions"><button onClick={() => { const action = confirmation.action; setConfirmation(undefined); void action(); }}>Confirm</button><button autoFocus onClick={() => setConfirmation(undefined)}>Cancel</button></div></div></div>}
  </section></div>;
}
