import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Command, Download, Files, FolderOpen, GitBranch, History, ListTodo, LoaderCircle, Moon, PanelRightClose, Plus, RefreshCw, Search, Settings, Sparkles, Square, Sun, Upload, Users, Wrench, X } from 'lucide-react';
import type { Attachment, DesktopEvent, Json, JsonObject, OwnerSnapshot, Preferences, RpcCommand, SessionRecord } from '../shared/contracts';
import { array, bootstrapSchema, eventSchema, flag, jsonSchema, messageText, number, object, ownerSchema, text } from '../shared/validation';
import Chat, { JsonDetails } from './Chat';
import Dialogs, { type UiRequest } from './Dialogs';
import Panels, { type PanelName } from './Panels';
import Management, { type Section as SettingsSection } from './Management';
import './styles.css';

type Draft = { text: string; attachments: Attachment[] };
type Catalog = { models: JsonObject[]; levels: string[]; commands: JsonObject[] };
type LocalDialog = { type: 'rename' | 'branch' | 'commands'; ownerId: string };
const emptyDraft: Draft = { text: '', attachments: [] };
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const busyOwner = (owner?: OwnerSnapshot) => !!owner && (owner.status === 'starting' || flag(owner.state.desktopBusy) || flag(owner.state.isStreaming) || flag(owner.state.isCompacting) || flag(owner.state.hasPendingAsyncWork) || flag(owner.state.isRetrying) || number(owner.state.queuedMessageCount) > 0);
const dialogMethods: Record<string, boolean> = { select: true, confirm: true, input: true, editor: true, ask: true, open_url: true };

export default function App() {
  const [preferences, setPreferences] = useState<Preferences>();
  const [owners, setOwners] = useState<OwnerSnapshot[]>([]);
  const ownersRef = useRef(owners);
  ownersRef.current = owners;
  const [activeId, setActiveId] = useState('');
  const activeRef = useRef('');
  const [workspace, setWorkspace] = useState('');
  const workspaceRef = useRef('');
  const historyGeneration = useRef(0);
  const updateWorkspace = useCallback((value: string) => {
    workspaceRef.current = value;
    historyGeneration.current++;
    setWorkspace(value);
  }, []);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [query, setQuery] = useState('');
  const [unread, setUnread] = useState<Record<string, boolean>>({});
  const [catalogs, setCatalogs] = useState<Record<string, Catalog>>({});
  const catalogsLoaded = useRef(new Set<string>());
  const [settingsOwners, setSettingsOwners] = useState<Record<string, OwnerSnapshot>>({});
  const settingsOwnersRef = useRef(new Map<string, OwnerSnapshot>());
  const dismissedUi = useRef(new Set<string>());
  const settingsCatalogGeneration = useRef(0);
  const [availableModels, setAvailableModels] = useState<JsonObject[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const catalogGenerations = useRef(new Map<string, number>());
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [mode, setMode] = useState<'steer' | 'follow_up'>('follow_up');
  const [panel, setPanel] = useState<PanelName | null>('files');
  const [settings, setSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('Providers');
  const [uiRequests, setUiRequests] = useState<UiRequest[]>([]);
  const [localDialog, setLocalDialog] = useState<LocalDialog>();
  const [dialogValue, setDialogValue] = useState('');
  const [entries, setEntries] = useState<JsonObject[]>([]);
  const [tree, setTree] = useState<Json>();
  const [events, setEvents] = useState<Record<string, JsonObject[]>>({});
  const [progress, setProgress] = useState<Record<string, JsonObject[]>>({});
  const [notices, setNotices] = useState<{ id: number; message: string; error: boolean }[]>([]);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState('');
  const [actionPending, setActionPending] = useState(false);
  const [sending, setSending] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const hydrateRunning = useRef(new Set<string>());
  const hydrateAgain = useRef(new Set<string>());
  const eventSequences = useRef(new Map<string, number>());
  const mounted = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const owner = owners.find(item => item.id === activeId);
  const busy = busyOwner(owner);
  const draftKey = activeId || `workspace:${workspace}`;
  const draft = drafts[draftKey] ?? emptyDraft;
  const catalog = catalogs[activeId] ?? { models: [], levels: [], commands: [] };
  const currentModel = object(owner?.state.model);
  const queued = object(owner?.state.queuedMessages);
  const ownerEvents = events[activeId] ?? [];
  const notify = useCallback((message: string, error = false) => { const id = Date.now() + Math.random(); setNotices(current => [...current.slice(-4), { id, message, error }]); if (!error) setTimeout(() => setNotices(current => current.filter(item => item.id !== id)), 6500); }, []);
  const report = useCallback((reason: unknown) => notify(errorText(reason), true), [notify]);
  const upsert = useCallback((snapshot: OwnerSnapshot) => { setOwners(current => snapshot.status === 'closed' ? current.filter(item => item.id !== snapshot.id) : current.some(item => item.id === snapshot.id) ? current.map(item => item.id === snapshot.id ? snapshot : item) : [...current, snapshot]); }, []);
  const focus = useCallback((id: string) => { activeRef.current = id; setActiveId(id); setUnread(current => ({ ...current, [id]: false })); setSidebarOpen(false); }, []);
  async function rpc(id: string, command: RpcCommand): Promise<Json> { return jsonSchema.parse(await window.desktop.request(id, command)); }
  const acceptSettingsSession = useCallback((snapshot: OwnerSnapshot) => {
    if (!mounted.current) return;
    settingsOwnersRef.current.set(snapshot.id, snapshot);
    setSettingsOwners(current => ({ ...current, [snapshot.workspace]: snapshot }));
    setUiRequests(current => {
      const pending = snapshot.pendingUi.filter(frame => dialogMethods[text(frame.method)] && !dismissedUi.current.has(`${snapshot.id}:${text(frame.id)}`));
      const retained = current.filter(request => request.ownerId !== snapshot.id || (request.frame.method === 'open_url' && snapshot.state.desktopBusy === true) || pending.some(frame => frame.id === request.frame.id));
      return [...retained, ...pending.filter(frame => !retained.some(request => request.ownerId === snapshot.id && request.frame.id === frame.id)).map(frame => ({ ownerId: snapshot.id, scope: 'settings' as const, frame, receivedAt: Date.now() }))];
    });
  }, []);
  const refreshSettingsModels = useCallback(async () => {
    const target = workspaceRef.current;
    const generation = ++settingsCatalogGeneration.current;
    setModelsError(''); setModelsLoading(true);
    try {
      if (!target) { setAvailableModels([]); return; }
      const snapshot = ownerSchema.parse(await window.desktop.settingsSession(target));
      if (!mounted.current || target !== workspaceRef.current || generation !== settingsCatalogGeneration.current) return;
      acceptSettingsSession(snapshot);
      if (snapshot.status !== 'ready') throw new Error(snapshot.error || '设置运行时尚未就绪');
      const result = jsonSchema.parse(await window.desktop.settingsRequest(snapshot.id, { type: 'get_available_models' }));
      if (mounted.current && target === workspaceRef.current && generation === settingsCatalogGeneration.current) setAvailableModels(array(object(result).models).map(object));
    } catch (reason) {
      if (mounted.current && target === workspaceRef.current && generation === settingsCatalogGeneration.current) { setAvailableModels([]); setModelsError(errorText(reason)); }
    } finally { if (mounted.current && generation === settingsCatalogGeneration.current) setModelsLoading(false); }
  }, [acceptSettingsSession]);
  async function credentialsChanged() {
    for (const item of ownersRef.current) {
      catalogsLoaded.current.delete(item.id);
      catalogGenerations.current.set(item.id, (catalogGenerations.current.get(item.id) ?? 0) + 1);
    }
    setOwners(current => [...current]);
    await refreshSettingsModels();
  }
  function settingsPreferencesChanged(next: Preferences) {
    setPreferences(next);
    const selected = next.workspaces.find(item => item.id === next.activeWorkspace || item.path === next.activeWorkspace);
    if (selected && selected.path !== workspaceRef.current) { updateWorkspace(selected.path); void refreshHistory(selected.path); }
  }
  function openSettings(section: SettingsSection = 'Providers') { setSettingsSection(section); setSettings(true); }
  async function hydrate(id: string) {
    if (hydrateRunning.current.has(id)) { hydrateAgain.current.add(id); return; }
    hydrateRunning.current.add(id);
    try { do { hydrateAgain.current.delete(id); const snapshot = ownerSchema.parse(await window.desktop.snapshot(id)); if (mounted.current) upsert(snapshot); } while (hydrateAgain.current.has(id) && mounted.current); }
    catch (reason) { if (mounted.current) report(reason); }
    finally { hydrateRunning.current.delete(id); }
  }
  async function refreshHistory(target = workspaceRef.current) {
    const generation = ++historyGeneration.current;
    try {
      const records = await window.desktop.listSessions(target || undefined);
      if (mounted.current && generation === historyGeneration.current && target === workspaceRef.current) setSessions(records);
    } catch (reason) { if (mounted.current && generation === historyGeneration.current) report(reason); }
  }
  async function syncPreferences() {
    const next = bootstrapSchema.parse(await window.desktop.bootstrap()).preferences;
    setPreferences(next);
    const selected = next.workspaces.find(item => item.id === next.activeWorkspace);
    updateWorkspace(selected?.path ?? '');
    await refreshHistory(selected?.path ?? '');
  }
  async function boot() {
    setBooting(true); setBootError('');
    try { const data = bootstrapSchema.parse(await window.desktop.bootstrap()); if (!mounted.current) return; setPreferences(data.preferences); setOwners(data.owners); setSessions(data.sessions); const selected = data.preferences.workspaces.find(item => item.path === data.preferences.activeWorkspace || item.id === data.preferences.activeWorkspace)?.path ?? data.preferences.workspaces[0]?.path ?? ''; updateWorkspace(selected); if (data.owners.length) focus(data.owners[0].id); }
    catch (reason) { setBootError(errorText(reason)); }
    finally { setBooting(false); }
  }
  useEffect(() => { mounted.current = true; void boot(); const off = window.desktop.onEvent(raw => {
    const parsed = eventSchema.safeParse(raw); if (!parsed.success) { report('收到无效的桌面事件'); return; } const event: DesktopEvent = parsed.data;
    if (event.sequence <= (eventSequences.current.get(event.ownerId) ?? -1)) return; eventSequences.current.set(event.ownerId, event.sequence);
    const frame = event.frame; const type = text(frame.type);
    if (event.scope === 'settings') {
      if (type === 'extension_ui_request') {
        const method = text(frame.method);
        if (method === 'cancel') {
          dismissedUi.current.add(`${event.ownerId}:${text(frame.targetId)}`);
          setUiRequests(current => current.filter(request => request.ownerId !== event.ownerId || text(request.frame.id) !== text(frame.targetId)));
        } else if (dialogMethods[method] && !dismissedUi.current.has(`${event.ownerId}:${text(frame.id)}`)) {
          setUiRequests(current => current.some(request => request.ownerId === event.ownerId && request.frame.id === frame.id) ? current : [...current, { ownerId: event.ownerId, scope: 'settings', frame, receivedAt: Date.now() }]);
        } else if (method === 'notify') notify(text(frame.message), text(frame.notifyType) === 'error');
      }
      if (type === 'owner_error' || type === 'rpc_frame_error' || type === 'extension_error' || type === 'notice') notify(text(frame.error, text(frame.message, '设置运行时通知')), type !== 'notice' || frame.level === 'error');
      if (type === 'owner_snapshot') {
        const snapshot = ownerSchema.safeParse(frame.snapshot);
        if (snapshot.success) acceptSettingsSession(snapshot.data);
        else report('收到无效的设置运行时快照');
      }
      return;
    }
    if (type === 'ready' || type === 'owner_ready') {
      catalogsLoaded.current.delete(event.ownerId);
      catalogGenerations.current.set(event.ownerId, (catalogGenerations.current.get(event.ownerId) ?? 0) + 1);
      setCatalogs(current => ({ ...current, [event.ownerId]: { models: [], levels: [], commands: [] } }));
    }
    if (type === 'desktop_command_complete' || type === 'owner_snapshot' || type === 'owner_ready' || type === 'ready' || type === 'agent_start' || type === 'agent_end' || type === 'message_start' || type === 'message_update' || type === 'message_end' || type === 'queue_update' || type === 'session_info_update' || type === 'session_settled' || type === 'todo_update') void hydrate(event.ownerId);
    if (activeRef.current !== event.ownerId && ['desktop_command_complete', 'message_end', 'prompt_result', 'extension_ui_request'].includes(type)) setUnread(current => ({ ...current, [event.ownerId]: true }));
    if (type === 'session_settled' || type === 'desktop_command_complete') void refreshHistory();
    if (type.startsWith('subagent_')) setEvents(current => ({ ...current, [event.ownerId]: [...(current[event.ownerId] ?? []).slice(-199), frame] }));
    if (type.startsWith('live_') || type === 'btw_record' || type === 'btw_delta') setEvents(current => ({ ...current, [event.ownerId]: [...(current[event.ownerId] ?? []).slice(-199), frame] }));
    if (type === 'tool_execution_start' || type === 'tool_execution_update' || type === 'tool_execution_end') setProgress(current => { const items = (current[event.ownerId] ?? []).filter(item => item.toolCallId !== frame.toolCallId); return { ...current, [event.ownerId]: type === 'tool_execution_end' ? items : [...items, frame] }; });
    if (type === 'available_commands_update') setCatalogs(current => ({ ...current, [event.ownerId]: { ...(current[event.ownerId] ?? { models: [], levels: [], commands: [] }), commands: array(frame.commands).map(object) } }));
    if (type === 'extension_ui_request') {
      const method = text(frame.method);
      if (method === 'cancel') setUiRequests(current => current.filter(item => !(item.ownerId === event.ownerId && text(item.frame.id) === text(frame.targetId))));
      else if (dialogMethods[method]) setUiRequests(current => {
        if (current.some(item => item.ownerId === event.ownerId && item.frame.id === frame.id)) return current;
        const request: UiRequest = { ownerId: event.ownerId, scope: 'conversation', frame, receivedAt: Date.now() };
        return [...current, request];
      });
      else if (method === 'notify') notify(text(frame.message), text(frame.notifyType) === 'error');
      else if (method === 'set_editor_text') setDrafts(current => ({ ...current, [event.ownerId]: { ...(current[event.ownerId] ?? emptyDraft), text: text(frame.text) } }));
      else if (method === 'setStatus' || method === 'setWidget') setEvents(current => ({ ...current, [event.ownerId]: [...(current[event.ownerId] ?? []).filter(item => method === 'setStatus' ? item.statusKey !== frame.statusKey : item.widgetKey !== frame.widgetKey).slice(-199), frame] }));
    }
    if (type === 'prompt_result' && frame.status === 'error') notify(text(object(frame.error).message, '模型请求失败'), true);
    if (type === 'extension_error' || type === 'rpc_frame_error' || type === 'owner_error' || type === 'notice') notify(text(frame.error, text(frame.message, 'OMP 运行时通知')), type !== 'notice' || frame.level === 'error');
    if (type === 'command_output') notify(text(frame.text, text(frame.output, JSON.stringify(frame))));
  }); return () => { mounted.current = false; off(); }; }, []);
  useEffect(() => { if (!preferences) return; document.documentElement.dataset.theme = preferences.theme; }, [preferences?.theme]);
  useEffect(() => { setAvailableModels([]); void refreshSettingsModels(); }, [workspace, preferences?.executable, refreshSettingsModels]);
  useEffect(() => {
    for (const item of owners) {
      for (const frame of item.pendingUi) if (dialogMethods[text(frame.method)] && !dismissedUi.current.has(`${item.id}:${text(frame.id)}`)) setUiRequests(current => current.some(request => request.ownerId === item.id && request.frame.id === frame.id) ? current : [...current, { ownerId: item.id, scope: 'conversation', frame, receivedAt: Date.now() }]);
      if (item.status !== 'ready' || catalogsLoaded.current.has(item.id)) continue;
      const generation = catalogGenerations.current.get(item.id) ?? 0;
      catalogsLoaded.current.add(item.id);
      void Promise.all([rpc(item.id, { type: 'get_available_models' }), rpc(item.id, { type: 'get_available_thinking_levels' }), rpc(item.id, { type: 'get_available_commands' })]).then(([models, thinking, commands]) => {
        if (generation !== (catalogGenerations.current.get(item.id) ?? 0)) return;
        setCatalogs(current => ({ ...current, [item.id]: { models: array(object(models).models).map(object), levels: array(object(thinking).levels).map(value => text(value)).filter(Boolean), commands: array(object(commands).commands).map(object) } }));
      }).catch(reason => { if (generation === (catalogGenerations.current.get(item.id) ?? 0)) { catalogsLoaded.current.delete(item.id); report(reason); } });
    }
  }, [owners]);
  function updateDraft(patch: Partial<Draft>, key = draftKey) { setDrafts(current => ({ ...current, [key]: { ...(current[key] ?? emptyDraft), ...patch } })); }
  async function chooseWorkspace() { try { const selected = await window.desktop.chooseWorkspace(); if (!selected) return; const next = await window.desktop.preferences({ activeWorkspace: selected.id }); setPreferences(next); updateWorkspace(selected.path); await refreshHistory(selected.path); } catch (reason) { report(reason); } }
  async function selectWorkspace(path: string) { const selected = preferences?.workspaces.find(item => item.path === path); if (!selected) return; updateWorkspace(path); try { setPreferences(await window.desktop.preferences({ activeWorkspace: selected.id })); await refreshHistory(path); } catch (reason) { report(reason); } }
  async function createSession() {
    setActionPending(true);
    try { let target = workspace; if (!target) { const chosen = await window.desktop.chooseWorkspace(); if (!chosen) return; target = chosen.path; updateWorkspace(target); setPreferences(await window.desktop.preferences({ activeWorkspace: chosen.id })); } const created = ownerSchema.parse(await window.desktop.createSession(target)); upsert(created); const local = drafts[`workspace:${target}`]; if (local) setDrafts(current => ({ ...current, [created.id]: local })); focus(created.id); await refreshHistory(target); }
    catch (reason) { report(reason); }
    finally { setActionPending(false); }
  }
  async function openSession(session: SessionRecord) { setActionPending(true); try { const opened = ownerSchema.parse(await window.desktop.openSession(session)); upsert(opened); focus(opened.id); await syncPreferences(); } catch (reason) { report(reason); } finally { setActionPending(false); } }
  async function closeOwner(id: string) { try { await window.desktop.closeSession(id); setOwners(current => current.filter(item => item.id !== id)); if (activeId === id) focus(owners.find(item => item.id !== id)?.id ?? ''); setUiRequests(current => current.filter(item => item.ownerId !== id)); } catch (reason) { report(reason); } }
  async function action(command: RpcCommand, id = activeId) { if (!id) return; try { const result = await rpc(id, command); if (flag(object(result).cancelled)) throw new Error('操作被扩展取消，原会话保持不变'); await hydrate(id); return result; } catch (reason) { report(reason); return undefined; } }
  async function stop() {
    if (!activeId) return;
    try { const result = object(await rpc(activeId, { type: 'abort_and_restore_queue' })); const restored = [...array(result.steering), ...array(result.followUp)].map(object); const restoredText = restored.map(item => text(item.message, text(item.text))).filter(Boolean).join('\n\n'); const restoredImages: Attachment[] = restored.flatMap(item => array(item.images).map((value, index) => { const image = object(value); return { name: `恢复的图像 ${index + 1}`, mimeType: text(image.mimeType), data: text(image.data) }; })); setDrafts(current => { const old = current[activeId] ?? emptyDraft; return { ...current, [activeId]: { text: [restoredText, old.text].filter(Boolean).join('\n\n'), attachments: [...restoredImages, ...old.attachments] } }; }); if (flag(result.imagesDropped) || restored.some(item => flag(item.imagesDropped))) notify('已停止并恢复队列文字；图像超过传输限制，请重新添加附件。', true); if (flag(result.truncated)) notify('恢复的队列被传输限制截断，请检查历史记录。', true); await hydrate(activeId); composer.current?.focus(); }
    catch (reason) { report(reason); }
  }
  async function send() {
    if (!owner || owner.status !== 'ready' || sending || (!draft.text.trim() && !draft.attachments.length)) return;
    if (/^\/settings(?:\s|$)/.test(draft.text.trimStart())) { setSettings(true); return; }
    if (draft.text.trimStart().startsWith('/')) { const command = draft.text.trimStart().slice(1).split(/\s/)[0]; if (!catalog.commands.some(item => text(item.name) === command || array(item.aliases).includes(command))) { report(`未发现 /${command} 命令。请使用命令面板或设置，不会将未知命令发送给模型。`); return; } }
    const captured = draft; const id = owner.id; setSending(true);
    try { await rpc(id, { type: busy ? mode : 'prompt', message: captured.text, ...(captured.attachments.length ? { images: captured.attachments.map(item => ({ type: 'image', mimeType: item.mimeType, data: item.data })) } : {}) }); setDrafts(current => { const now = current[id] ?? emptyDraft; return { ...current, [id]: now.text === captured.text && now.attachments === captured.attachments ? emptyDraft : now }; }); await hydrate(id); }
    catch (reason) { report(reason); }
    finally { setSending(false); }
  }
  async function addAttachments() { try { const picked = await window.desktop.chooseAttachments(); setDrafts(current => { const previous = current[draftKey] ?? emptyDraft; return { ...current, [draftKey]: { ...previous, attachments: [...previous.attachments, ...picked] } }; }); } catch (reason) { report(reason); } }
  async function dropFiles(files: FileList) { for (const file of Array.from(files)) { try { const attachment = await window.desktop.attachmentFromDrop(owner?.workspace || workspace, file); setDrafts(current => { const previous = current[draftKey] ?? emptyDraft; return { ...current, [draftKey]: { ...previous, attachments: [...previous.attachments, attachment] } }; }); } catch (reason) { report(reason); } } }
  async function showBranch() { if (!owner) return; setLocalDialog({ type: 'branch', ownerId: owner.id }); try { const [entryResult, treeResult] = await Promise.all([rpc(owner.id, { type: 'get_entries' }), rpc(owner.id, { type: 'get_tree' })]); setEntries(array(object(entryResult).entries).map(object)); setTree(treeResult); } catch (reason) { report(reason); } }
  function showCommands() { setDialogValue(''); setLocalDialog({ type: 'commands', ownerId: activeId }); }
  useEffect(() => { const handle = (event: KeyboardEvent) => { if (event.defaultPrevented) return; if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); void createSession(); } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); showCommands(); } else if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); setSettings(true); } else if (event.key === 'Escape' && !uiRequests.length) { if (localDialog) setLocalDialog(undefined); else if (settings) setSettings(false); else if (busy) void stop(); } }; window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle); });
  const filteredSessions = sessions.filter(session => (!workspace || session.workspace === workspace) && `${session.name} ${session.preview}`.toLowerCase().includes(query.toLowerCase()));
  const context = object(owner?.state.contextUsage);
  const contextPercent = number(context.percent, number(context.percentage));
  return <div className={`workbench ${sidebarOpen ? 'sidebar-mobile-open' : ''}`}>
    <aside className="sidebar"><div className="brand"><span className="brand-mark"><Sparkles size={20} /></span><div><strong>OMP Desktop</strong><small>你的智能工作台</small></div></div><label className="workspace-label">工作区<select aria-label="选择工作区" value={workspace} onChange={event => void selectWorkspace(event.target.value)}><option value="">选择工作目录</option>{preferences?.workspaces.map(item => <option key={item.id} value={item.path}>{item.name}</option>)}</select></label><button className="workspace-picker" onClick={() => void chooseWorkspace()}><FolderOpen size={16} />打开工作目录<Plus size={14} /></button><button className="new-session primary" disabled={actionPending || booting} onClick={() => void createSession()}><Plus size={17} />新建会话<kbd>Ctrl N</kbd></button><div className="sidebar-section-title"><span><History size={14} />历史记录</span><button aria-label="刷新历史" onClick={() => void refreshHistory()}><RefreshCw size={13} /></button></div><label className="search-field"><Search size={15} /><input aria-label="搜索历史会话" placeholder="搜索会话…" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="session-history">{booting ? <p className="empty-small">加载原生历史…</p> : !filteredSessions.length ? <p className="empty-small">{query ? '没有匹配的会话' : '此工作区暂无历史会话'}</p> : filteredSessions.map(session => <button className="history-row" key={session.path} disabled={actionPending} onClick={() => void openSession(session)} title={session.path}><strong>{session.name || '未命名会话'}</strong><span>{session.preview || `${session.messageCount} 条消息`}</span><small>{new Date(session.updatedAt).toLocaleDateString('zh-CN')} · {session.messageCount} 条</small></button>)}</div><footer className="sidebar-footer"><button onClick={showCommands}><Command size={16} />命令面板<kbd>Ctrl K</kbd></button><button onClick={() => { void window.desktop.importSession().then(async snapshot => { if (snapshot) { upsert(ownerSchema.parse(snapshot)); focus(snapshot.id); await syncPreferences(); } }).catch(report); }}><Upload size={16} />导入会话</button><button onClick={() => setSettings(true)}><Settings size={16} />设置<kbd>Ctrl ,</kbd></button><button onClick={() => { if (preferences) void window.desktop.preferences({ theme: preferences.theme === 'dark' ? 'light' : 'dark' }).then(setPreferences).catch(report); }}>{preferences?.theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}{preferences?.theme === 'light' ? '深色外观' : '浅色外观'}</button></footer></aside>
    <main className="main-workspace"><div className="tab-bar"><button className="mobile-menu" onClick={() => setSidebarOpen(current => !current)}><FolderOpen size={16} />工作区</button><div className="tabs">{owners.map(item => <div role="tab" tabIndex={0} aria-selected={item.id === activeId} key={item.id} className={`session-tab ${item.id === activeId ? 'active' : ''}`} onClick={() => focus(item.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') focus(item.id); }}>{busyOwner(item) ? <LoaderCircle size={13} className="spin" /> : <span className={`tab-dot ${item.status}`} />}<span>{text(item.state.sessionName, '新会话')}</span>{unread[item.id] && <span className="unread-dot" aria-label="未读消息" />}<button aria-label={`关闭 ${text(item.state.sessionName, '会话')}`} onClick={event => { event.stopPropagation(); void closeOwner(item.id); }}><X size={13} /></button></div>)}</div><button aria-label="新建会话标签页" disabled={actionPending} onClick={() => void createSession()}><Plus size={17} /></button></div>
    <header className="toolbar"><div className="session-heading"><strong>{text(owner?.state.sessionName, '工作台')}</strong><small title={owner?.workspace || workspace}>{(owner?.workspace || workspace).split(/[\\/]/).pop() || '尚未选择工作区'}</small></div>{owner && <div className="model-controls"><label>模型<select aria-label="当前模型" disabled={busy || !catalog.models.length} value={`${text(currentModel.provider)}/${text(currentModel.id)}`} onChange={event => { const model = catalog.models.find(item => `${text(item.provider)}/${text(item.id)}` === event.target.value); if (model) void action({ type: 'set_model', provider: text(model.provider), modelId: text(model.id) }).then(() => rpc(activeId, { type: 'get_available_thinking_levels' })).then(result => setCatalogs(current => ({ ...current, [activeId]: { ...(current[activeId] ?? catalog), levels: array(object(result).levels).map(value => text(value)) } }))).catch(report); }}><option value={`${text(currentModel.provider)}/${text(currentModel.id)}`}>{text(currentModel.name, text(currentModel.id, '发现模型中…'))}</option>{catalog.models.filter(item => `${text(item.provider)}/${text(item.id)}` !== `${text(currentModel.provider)}/${text(currentModel.id)}`).map(item => <option value={`${text(item.provider)}/${text(item.id)}`} key={`${text(item.provider)}/${text(item.id)}`}>{text(item.name, text(item.id))} · {text(item.provider)}</option>)}</select></label><label>思考<select aria-label="思考级别" disabled={busy || !catalog.levels.length} value={text(owner.state.thinkingLevel, 'off')} onChange={event => void action({ type: 'set_thinking_level', level: event.target.value })}>{!catalog.levels.includes(text(owner.state.thinkingLevel)) && <option value={text(owner.state.thinkingLevel, 'off')}>{text(owner.state.thinkingLevel, 'off')}</option>}{catalog.levels.map(level => <option key={level}>{level}</option>)}</select></label></div>}<button className="panel-toggle" onClick={() => setPanel(current => current ? null : 'files')}><PanelRightClose size={16} />{panel ? '收起面板' : '工作面板'}</button></header>
    {bootError && <div className="runtime-banner error-card" role="alert"><strong>桌面启动失败</strong><p>{bootError}</p><button onClick={() => void boot()}>重试启动</button><button onClick={() => { void window.desktop.chooseExecutable().then(path => { if (path) return boot(); }).catch(report); }}>选择 OMP 程序</button></div>}
    {preferences && !preferences.executable && <div className="runtime-banner"><strong>连接你的 OMP 运行时</strong><p>选择本机 OMP 可执行文件，桌面会通过原生 RPC 启动独立会话。</p><button className="primary" onClick={() => { void window.desktop.chooseExecutable().then(path => { if (path) return window.desktop.preferences({ executable: path }).then(setPreferences); }).catch(report); }}>选择 OMP 可执行文件</button></div>}
    {owner?.status === 'error' && <div className="runtime-banner error-card" role="alert"><strong>OMP 会话无法运行</strong><p>{owner.error}</p><button onClick={() => { void window.desktop.chooseExecutable().then(path => { if (path) return window.desktop.preferences({ executable: path }).then(setPreferences); }).catch(report); }}>更改运行时路径</button><button onClick={() => setSettings(true)}>检查运行时设置</button></div>}
    {(!owner || owner.status !== 'ready') && <div className="runtime-banner"><strong>新会话模型与授权</strong><p>无需打开历史会话即可配置账号和模型。默认模型仅用于新会话，不会改变已保存的会话。</p><div className="model-controls"><label>新会话默认模型<select aria-label="新会话默认模型" disabled={modelsLoading || !availableModels.length} value={preferences?.initialModel ?? ''} onChange={event => { void window.desktop.preferences({ initialModel: event.target.value }).then(setPreferences).catch(report); }}><option value="">OMP 原生默认模型</option>{preferences?.initialModel && !availableModels.some(item => `${text(item.provider)}/${text(item.id)}` === preferences.initialModel) && <option value={preferences.initialModel}>{preferences.initialModel}（自定义）</option>}{availableModels.map(item => <option key={`${text(item.provider)}/${text(item.id)}`} value={`${text(item.provider)}/${text(item.id)}`}>{text(item.name, text(item.id))} · {text(item.provider)}</option>)}</select></label><button onClick={() => openSettings('Models')}>模型设置 / 自定义模型</button><button onClick={() => openSettings('Providers')}>账号与授权</button></div>{modelsLoading ? <p>正在发现原生模型…</p> : !availableModels.length && <p>{modelsError || '尚无可用模型，请选择工作区并在 Providers 中完成授权。'} <button onClick={() => void refreshSettingsModels()}>重新发现</button></p>}{settingsOwners[workspace]?.status === 'error' && <p role="alert">{settingsOwners[workspace].error}</p>}</div>}
    <div className="center-row"><section className="conversation"><div className="conversation-actions">{owner && <><span className={`status-pill ${busy ? 'running' : ''}`}><span className={busy ? 'busy-dot' : 'ready-dot'} />{owner.status === 'starting' ? '正在启动' : owner.status === 'error' ? '运行错误' : flag(owner.state.isCompacting) ? '压缩上下文中' : busy ? '运行中' : owner.pendingUi.length ? '等待输入' : '就绪'}</span><span className="context-label" title={JSON.stringify(context)}>上下文 {contextPercent ? `${Math.round(contextPercent)}%` : number(context.tokens) ? `${number(context.tokens).toLocaleString()} tokens` : '—'}</span><button disabled={busy} onClick={() => { setDialogValue(text(owner.state.sessionName)); setLocalDialog({ type: 'rename', ownerId: owner.id }); }}>重命名</button><button disabled={busy} onClick={() => void action({ type: 'compact' })}>压缩</button><button disabled={busy} onClick={() => void showBranch()}><GitBranch size={13} />分支</button><button onClick={() => { void window.desktop.exportSession(activeId).then(path => { if (path) notify(`已导出：${path}`); }).catch(report); }}><Download size={13} />导出</button></>}</div><Chat error={text(owner?.state.lastError)} key={activeId || 'welcome'} messages={owner?.messages ?? []} busy={busy} progress={progress[activeId] ?? []} />
    <div className="composer-zone">{ownerEvents.filter(frame => frame.method === 'setStatus' && text(frame.statusText)).map(frame => <div className="extension-status" key={text(frame.statusKey)}>{text(frame.statusText)}</div>)}{ownerEvents.filter(frame => frame.method === 'setWidget').map(frame => <pre className="extension-widget" key={text(frame.widgetKey)}>{array(frame.widgetLines).map(value => text(value)).join('\n')}</pre>)}{(['steering', 'followUp'] as const).map(queue => array(queued[queue]).map((message, index) => <div className="queue-chip" key={`${queue}-${index}`}><span className="badge">{queue === 'steering' ? index < number(queued.liveSteered) ? '已送入' : '指导' : '后续'}</span><span>{text(message)}</span>{queue === 'followUp' && <button onClick={() => void action({ type: 'promote_queued_message', message: text(message) })}>提升为指导</button>}<button disabled={queue === 'steering' && index < number(queued.liveSteered)} aria-label="移除排队消息并恢复草稿" onClick={() => { void action({ type: 'remove_queued_message', message: text(message), queue }).then(result => { if (result === undefined) return; const data = object(result); if (data.removed === false) { notify('消息已进入模型，无法移除'); return; } const images = array(data.images).map((value, imageIndex) => { const image = object(value); return { name: `恢复的图像 ${imageIndex + 1}`, mimeType: text(image.mimeType), data: text(image.data) }; }); setDrafts(current => { const previous = current[activeId] ?? emptyDraft; return { ...current, [activeId]: { text: [text(message), previous.text].filter(Boolean).join('\n\n'), attachments: [...images, ...previous.attachments] } }; }); if (flag(data.imagesDropped)) notify('排队图像超过传输限制，请重新添加', true); }); }}><X size={13} /></button></div>))}
    <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { event.preventDefault(); void dropFiles(event.dataTransfer.files); }}><div className="attachment-chips">{draft.attachments.map((item, index) => <div className="attachment-chip" key={`${item.name}-${index}`}><img alt="附件" src={`data:${item.mimeType};base64,${item.data}`} /><span>{item.name}</span><button type="button" aria-label={`移除附件 ${item.name}`} onClick={() => updateDraft({ attachments: draft.attachments.filter((_, itemIndex) => itemIndex !== index) })}><X size={13} /></button></div>)}</div><textarea ref={composer} aria-label="消息内容" value={draft.text} disabled={owner?.status === 'starting'} onChange={event => updateDraft({ text: event.target.value })} placeholder={owner ? busy ? '运行中：发送指导或排队后续消息…' : '告诉 OMP 你想做什么，或拖入图像…' : '新建会话后开始工作…'} rows={3} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div className="composer-bottom"><button type="button" onClick={() => void addAttachments()}><Plus size={16} />附件</button><button type="button" onClick={showCommands}><Command size={15} />命令</button><span className="composer-spacer" />{busy && <label className="queue-mode">发送方式<select aria-label="运行时发送方式" value={mode} onChange={event => setMode(event.target.value === 'steer' ? 'steer' : 'follow_up')}><option value="follow_up">后续 · 下一轮</option><option value="steer">指导 · 当前轮</option></select></label>}{busy && <button className="stop-button" type="button" onClick={() => void stop()}><Square size={13} />停止并恢复</button>}<button className="send-button primary" type="submit" disabled={!owner || owner.status !== 'ready' || sending || (!draft.text.trim() && !draft.attachments.length)}><ArrowUp size={16} />{sending ? '发送中' : busy ? mode === 'steer' ? '发送指导' : '排队' : '发送'}</button></div></form><div className="composer-caption"><span>Enter 发送 · Shift Enter 换行</span><span>{owner ? text(owner.state.sessionId).slice(0, 8) : '独立 OMP 会话，不切换后台会话'}</span></div>{!owner && <button className="start-session" disabled={actionPending || booting} onClick={() => void createSession()}><Plus size={16} />开始新会话</button>}</div></section>
    <nav className="panel-rail" aria-label="工作面板">{([{ name: 'files', label: '文件', icon: Files }, { name: 'tasks', label: '任务', icon: ListTodo }, { name: 'agents', label: '智能体', icon: Users }, { name: 'tools', label: '工具', icon: Wrench }] satisfies { name: PanelName; label: string; icon: typeof Files }[]).map(item => <button key={item.name} className={panel === item.name ? 'active' : ''} onClick={() => setPanel(current => current === item.name ? null : item.name)} aria-pressed={panel === item.name}><item.icon size={18} /><span>{item.label}</span></button>)}</nav>{panel && <Panels key={owner?.id || workspace} owner={owner} workspace={owner?.workspace || workspace} panel={panel} events={ownerEvents} onAttach={attachment => updateDraft({ attachments: [...draft.attachments, attachment] })} onReference={path => { updateDraft({ text: [draft.text, `请读取工作区文件：${path}`].filter(Boolean).join('\n') }); composer.current?.focus(); }} onClose={() => setPanel(null)} onError={report} />}</div></main>
    <div className="toast-stack" aria-live="polite">{notices.map(notice => <div className={`toast ${notice.error ? 'error' : ''}`} key={notice.id}><span>{notice.message}</span><button aria-label="关闭通知" onClick={() => setNotices(current => current.filter(item => item.id !== notice.id))}><X size={14} /></button></div>)}</div>
    {settings && <Management key={workspace} workspace={workspace} initialSection={settingsSection} authorizationPending={flag(settingsOwners[workspace]?.state.desktopLoginPending)} onSettingsSession={acceptSettingsSession} onCredentialsChanged={credentialsChanged} onPreferencesChanged={settingsPreferencesChanged} onClose={() => { setSettings(false); void syncPreferences().catch(report); }} onError={report} />}
    {localDialog && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="local-dialog-title"><header><h2 id="local-dialog-title">{localDialog.type === 'rename' ? '重命名会话' : localDialog.type === 'branch' ? '持久会话分支' : '命令面板'}</h2><button aria-label="关闭对话框" onClick={() => setLocalDialog(undefined)}><X size={18} /></button></header>{localDialog.type === 'rename' && <form onSubmit={event => { event.preventDefault(); if (!dialogValue.trim()) return; void action({ type: 'set_session_name', name: dialogValue.trim() }, localDialog.ownerId).then(result => { if (result !== undefined) { setLocalDialog(undefined); void refreshHistory(); } }); }}><label className="field">会话名称<input autoFocus value={dialogValue} onChange={event => setDialogValue(event.target.value)} /></label><button className="primary" type="submit">保存名称</button></form>}{localDialog.type === 'commands' && <><label className="search-field"><Search size={16} /><input autoFocus aria-label="搜索已发现命令" value={dialogValue} onChange={event => setDialogValue(event.target.value)} placeholder="搜索核心提供的命令…" /></label><div className="command-list">{catalog.commands.filter(item => `${text(item.name)} ${text(item.description)}`.toLowerCase().includes(dialogValue.toLowerCase())).map(item => <button key={text(item.name)} onClick={() => { updateDraft({ text: `/${text(item.name)} ` }); setLocalDialog(undefined); composer.current?.focus(); }}><strong>/{text(item.name)}</strong><span>{text(item.description)}</span><small>{text(item.source)}</small></button>)}{!catalog.commands.length && <p className="empty-small">请打开运行正常的会话以发现可用命令。设置通过 Ctrl+, 打开，不会作为聊天提示发送。</p>}</div></>}{localDialog.type === 'branch' && <><p className="muted">分叉会生成新的持久会话文件；切换分支是在当前会话树中导航。后台标签页不会被聚焦操作切换。</p><button disabled={busy} onClick={() => { void action({ type: 'fork' }, localDialog.ownerId).then(result => { if (result !== undefined) { setLocalDialog(undefined); void refreshHistory(); } }); }}>分叉整个会话</button><div className="branch-list">{entries.filter(entry => entry.type === 'message').map(entry => <div className="branch-row" key={text(entry.id)}><div><strong>{text(object(entry.message).role)}</strong><span>{messageText(object(entry.message)).slice(0, 180) || text(entry.id)}</span></div><button onClick={() => { void action({ type: 'fork', entryId: text(entry.id) }, localDialog.ownerId).then(result => { if (result !== undefined) { setLocalDialog(undefined); void refreshHistory(); } }); }}>从此分叉</button><button onClick={() => { void action({ type: 'branch', entryId: text(entry.id) }, localDialog.ownerId).then(result => { if (result !== undefined) { const returned = text(object(result).text); if (returned) updateDraft({ text: returned }, localDialog.ownerId); setLocalDialog(undefined); } }); }}>切换分支</button></div>)}</div><JsonDetails value={tree ?? null} title="完整持久会话树" /></>}</section></div>}
    {uiRequests[0] && <Dialogs key={`${uiRequests[0].ownerId}:${text(uiRequests[0].frame.id)}`} request={uiRequests[0]} onDone={() => { const request = uiRequests[0]; dismissedUi.current.add(`${request.ownerId}:${text(request.frame.id)}`); setUiRequests(current => current.filter(item => item.ownerId !== request.ownerId || item.frame.id !== request.frame.id)); }} onError={report} />}
  </div>;
}
