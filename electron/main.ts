import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { access, mkdir, readFile, rename, writeFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { OwnerManager } from './rpc.js';
import { SettingsRuntime } from './settings-runtime.js';
import { listSessionFiles } from './sessions.js';
import { ManagementService } from './management.js';
import { confinedPath, listFiles, previewFile, loadAttachment } from './native-files.js';
import { resolveNativeAgentDirectory } from './config-paths.js';
import { commandSchema, objectSchema, preferencesSchema, sessionSchema, text } from '../shared/validation.js';
import type { DesktopEvent, ManagementOperation, Preferences, Workspace } from '../shared/contracts.js';

app.setName('OMP Desktop');
if (process.platform === 'win32') app.setAppUserModelId('local.omp.desktop');
if (process.env.OMP_DESKTOP_DATA_DIR) app.setPath('userData', path.resolve(process.env.OMP_DESKTOP_DATA_DIR));
if (process.env.OMP_DESKTOP_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.OMP_DESKTOP_DEBUG_PORT);

let window: BrowserWindow | null = null;
let owners: OwnerManager;
let settings: SettingsRuntime;
let management: ManagementService;
let preferences: Preferences;
let bundledRuntime = false;
let quitting = false;
let quitPending = false;
let shuttingDown = false;
let runtimeChanging = false;
let settingsChanging = false;
const userData = app.getPath('userData');
const preferencesFile = path.join(userData, 'desktop.json');
const sessionsRoot = path.join(userData, 'sessions');
const rootDirectory = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const pageUrl = pathToFileURL(path.join(rootDirectory, 'dist', 'index.html')).href;
let agentDir: string;
const bundledExecutable = path.join(process.resourcesPath, 'omp', 'omp.exe');
const storedPreferencesSchema = preferencesSchema.extend({ bundledRuntime: z.boolean().optional() });
const workspaceId = (directory: string) => createHash('sha256').update(path.resolve(directory).toLowerCase()).digest('hex').slice(0, 16);

async function savePreferences(): Promise<void> {
  await mkdir(userData, { recursive: true });
  const temporary = `${preferencesFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...preferences, bundledRuntime }, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, preferencesFile);
}

async function loadPreferences(): Promise<Preferences> {
  try {
    const { bundledRuntime: storedBundled, ...saved } = storedPreferencesSchema.parse(JSON.parse(await readFile(preferencesFile, 'utf8')));
    bundledRuntime = storedBundled ?? (app.isPackaged && saved.executable === bundledExecutable);
    return { ...saved, executable: bundledRuntime ? bundledExecutable : saved.executable };
  }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error('桌面配置无法读取或格式无效；请修复 desktop.json，原文件没有被覆盖');
  }
  const workspacePath = await realpath(process.env.OMP_DESKTOP_WORKSPACE || process.cwd());
  const workspace = { id: workspaceId(workspacePath), name: path.basename(workspacePath) || workspacePath, path: workspacePath };
  bundledRuntime = app.isPackaged && !process.env.OMP_DESKTOP_EXECUTABLE;
  let executable = process.env.OMP_DESKTOP_EXECUTABLE || (bundledRuntime ? bundledExecutable : 'D:/downloads/omp-windows-x64_2.exe');
  try { await access(executable); } catch { executable = ''; }
  return { executable, workspaces: [workspace], activeWorkspace: workspace.id, theme: 'dark', notifications: true };
}

function activeWorkspace(): string {
  const workspace = preferences.workspaces.find(item => item.id === preferences.activeWorkspace);
  if (!workspace) throw new Error('请先选择工作区');
  return workspace.path;
}

async function authorizeWorkspace(directory: string): Promise<string> {
  const actual = await realpath(directory);
  for (const workspace of preferences.workspaces) {
    const registered = await realpath(workspace.path);
    if (registered.toLowerCase() === actual.toLowerCase()) return actual;
  }
  throw new Error('工作区未经授权，请通过目录选择器添加');
}

async function addWorkspace(directory: string): Promise<Workspace> {
  const actual = await realpath(directory);
  if (!(await stat(actual)).isDirectory()) throw new Error('工作区必须是目录');
  let workspace = preferences.workspaces.find(item => item.path.toLowerCase() === actual.toLowerCase());
  if (!workspace) {
    workspace = { id: workspaceId(actual), name: path.basename(actual) || actual, path: actual };
    preferences.workspaces.push(workspace);
  }
  preferences.activeWorkspace = workspace.id;
  await savePreferences();
  return workspace;
}

function trustedSender(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url.split('#')[0] !== pageUrl) throw new Error('拒绝未经授权的桌面调用');
}

function handle<T>(channel: string, schema: z.ZodType<T>, callback: (args: T) => unknown | Promise<unknown>): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    trustedSender(event);
    if (shuttingDown) throw new Error('桌面正在关闭，请等待后台进程退出');
    if (runtimeChanging) throw new Error('OMP 运行时正在重启，请稍后再试');
    return callback(schema.parse(args));
  });
}

const commandNames: Record<string, true> = Object.fromEntries([
  'get_state', 'get_available_commands', 'get_available_models', 'set_model', 'cycle_model',
  'get_available_thinking_levels', 'set_thinking_level', 'cycle_thinking_level', 'prompt', 'steer', 'follow_up',
  'abort', 'abort_and_restore_queue', 'abort_and_prompt', 'remove_queued_message', 'promote_queued_message',
  'get_messages', 'get_messages_page', 'get_entries', 'get_tree', 'get_session_stats', 'get_last_assistant_text',
  'set_session_name', 'fork', 'branch', 'get_branch_messages', 'compact', 'set_auto_compaction', 'handoff',
  'get_subagents', 'get_subagent_messages', 'cancel_subagent', 'steer_subagent', 'set_subagent_subscription',
  'set_todos', 'get_login_providers', 'login', 'get_logout_accounts', 'logout', 'set_fast_mode', 'set_slow_mode',
  'set_steering_mode', 'set_follow_up_mode', 'set_interrupt_mode', 'set_auto_retry', 'abort_retry', 'bash',
  'abort_bash', 'goal', 'btw', 'btw_cancel', 'get_btw_history', 'live_start', 'live_stop', 'live_mute',
].map(name => [name, true]));
const managementSchema = z.enum([
  'config.list', 'config.get', 'config.set', 'config.reset', 'credentials.save', 'credentials.providers',
  'mcp.list', 'mcp.save', 'mcp.remove', 'mcp.authenticate', 'mcp.reconnect', 'mcp.config.list', 'mcp.config.get',
  'mcp.config.set', 'mcp.config.remove', 'skills.list', 'skills.install', 'skills.remove', 'skills.cli',
  'plugins.list', 'plugins.install', 'plugins.remove', 'extensions.list', 'runtime.restart',
]);

async function openExternal(url: string): Promise<void> {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('只允许打开无内嵌凭据的 HTTP/HTTPS 链接');
  await shell.openExternal(parsed.href);
}

function emit(event: DesktopEvent): void {
  if (window && !window.isDestroyed()) window.webContents.send('desktop:event', event);
  if (event.scope === 'conversation' && (event.frame.type === 'session_settled' || event.frame.type === 'desktop_command_complete') && preferences.notifications && Notification.isSupported() && window && !window.isFocused()) {
    const owner = owners.snapshot(event.ownerId);
    const notification = new Notification({ title: 'OMP 任务已结束', body: text(owner.state.sessionName, '会话已完成，查看工具结果确认执行状态') });
    notification.on('click', () => { window?.show(); window?.focus(); });
    notification.show();
  }
}
async function restartRuntimes(): Promise<void> {
  if (runtimeChanging || settingsChanging) throw new Error('OMP 运行时正在重启或更新账号，请稍后再试');
  settings.assertIdle();
  owners.assertIdle();
  runtimeChanging = true;
  try { await Promise.all([settings.restartAll(), owners.restartAll()]); }
  finally { runtimeChanging = false; }
}


function registerIpc(): void {
  handle('desktop:bootstrap', z.tuple([]), async () => ({
    preferences, owners: owners.snapshots(), sessions: await listSessionFiles([path.join(agentDir, 'sessions'), sessionsRoot], undefined, [sessionsRoot]), version: app.getVersion(),
  }));
  handle('desktop:preferences', z.tuple([preferencesSchema.partial()]), async ([patch]) => {
    if (patch.workspaces && JSON.stringify(patch.workspaces) !== JSON.stringify(preferences.workspaces)) throw new Error('请通过目录选择器添加工作区');
    if (patch.executable && patch.executable !== preferences.executable) throw new Error('请通过程序选择器更换 OMP');
    if (patch.activeWorkspace && !preferences.workspaces.some(item => item.id === patch.activeWorkspace)) throw new Error('工作区不存在');
    preferences = preferencesSchema.parse({ ...preferences, ...patch });
    await savePreferences();
    return preferences;
  });
  handle('desktop:chooseExecutable', z.tuple([]), async () => {
    const selected = await dialog.showOpenDialog({ title: '选择 OMP 可执行程序', properties: ['openFile'], filters: [{ name: 'OMP executable', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const executable = await realpath(selected.filePaths[0]);
    if (!(await stat(executable)).isFile()) throw new Error('OMP 路径必须是文件');
    if ([...owners.snapshots(), ...settings.snapshots()].some(owner => owner.status === 'starting' || owner.state.desktopBusy === true || owner.state.isSettled === false || owner.pendingUi.length)) throw new Error('请先结束运行中的会话和账号登录再更换 OMP');
    settings.assertIdle();
    owners.assertIdle();
    if (runtimeChanging || settingsChanging) throw new Error('OMP 运行时正在重启或更新账号，请稍后再试');
    runtimeChanging = true;
    try {
      preferences.executable = executable;
      bundledRuntime = false;
      await Promise.all([settings.restartAll(), owners.restartAll()]);
      await savePreferences();
    } finally { runtimeChanging = false; }
    return executable;
  });
  handle('desktop:chooseWorkspace', z.tuple([]), async () => {
    const selected = await dialog.showOpenDialog({ title: '选择工作区', properties: ['openDirectory'] });
    return selected.canceled || !selected.filePaths[0] ? null : addWorkspace(selected.filePaths[0]);
  });
  handle('desktop:listSessions', z.tuple([z.string().optional()]), async ([workspace]) => listSessionFiles([path.join(agentDir, 'sessions'), sessionsRoot], workspace ? await authorizeWorkspace(workspace) : undefined, [sessionsRoot]));
  handle('desktop:createSession', z.tuple([z.string()]), async ([workspace]) => owners.create(await authorizeWorkspace(workspace)));
  handle('desktop:settingsSession', z.tuple([z.string()]), async ([workspace]) => {
    const authorized = await authorizeWorkspace(workspace);
    if (settingsChanging || runtimeChanging) throw new Error('设置运行时正在更新，请稍后再试');
    return settings.get(authorized);
  });
  handle('desktop:settingsRequest', z.tuple([z.string(), commandSchema]), ([id, command]) => {
    if (settingsChanging) throw new Error('设置运行时正在更新，请稍后再试');
    return settings.request(id, command);
  });
  handle('desktop:openSession', z.tuple([sessionSchema]), async ([session]) => {
    const actual = await realpath(session.path);
    const known = await listSessionFiles([path.join(agentDir, 'sessions'), sessionsRoot], undefined, [sessionsRoot]);
    const matched = known.find(item => path.resolve(item.path).toLowerCase() === actual.toLowerCase() && item.id === session.id);
    if (!matched) throw new Error('会话不在已发现列表中，请通过导入选择器打开');
    await addWorkspace(matched.workspace);
    return owners.create(matched.workspace, matched.path);
  });
  handle('desktop:snapshot', z.tuple([z.string()]), ([id]) => owners.snapshot(id));
  handle('desktop:closeSession', z.tuple([z.string()]), ([id]) => owners.close(id));
  handle('desktop:request', z.tuple([z.string(), commandSchema]), ([id, command]) => {
    if (!commandNames[command.type]) throw new Error(`桌面未开放此 RPC 操作：${command.type}`);
    return owners.request(id, command);
  });
  handle('desktop:reply', z.tuple([z.string(), objectSchema]), ([id, response]) => settings.has(id) ? settings.reply(id, response) : owners.reply(id, response));
  handle('desktop:exportSession', z.tuple([z.string()]), async ([id]) => {
    const selected = await dialog.showSaveDialog({ title: '导出会话', defaultPath: 'omp-session.html', filters: [{ name: 'HTML', extensions: ['html'] }] });
    if (selected.canceled || !selected.filePath) return null;
    await owners.request(id, { type: 'export_html', outputPath: selected.filePath });
    return selected.filePath;
  });
  handle('desktop:importSession', z.tuple([]), async () => {
    const selected = await dialog.showOpenDialog({ title: '打开 OMP 会话', properties: ['openFile'], filters: [{ name: 'OMP sessions', extensions: ['jsonl'] }] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const records = await listSessionFiles([selected.filePaths[0]]);
    const session = records[0];
    if (!session) throw new Error('文件不是有效的 OMP 会话');
    await addWorkspace(session.workspace);
    return owners.create(session.workspace, session.path);
  });
  handle('desktop:listFiles', z.tuple([z.string(), z.string().optional()]), async ([root, requested]) => listFiles(await authorizeWorkspace(root), requested || root));
  handle('desktop:previewFile', z.tuple([z.string(), z.string()]), async ([root, requested]) => previewFile(await authorizeWorkspace(root), requested));
  handle('desktop:chooseAttachments', z.tuple([]), async () => {
    const selected = await dialog.showOpenDialog({ title: '附加图片', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    return selected.canceled ? [] : Promise.all(selected.filePaths.map(loadAttachment));
  });
  handle('desktop:attachmentFromPath', z.tuple([z.string(), z.string()]), async ([root, requested]) => loadAttachment(await confinedPath(await authorizeWorkspace(root), requested)));
  handle('desktop:attachmentFromDrop', z.tuple([z.string(), z.string().min(1)]), async ([root, requested]) => {
    await authorizeWorkspace(root);
    return loadAttachment(await realpath(requested));
  });
  handle('desktop:openExternal', z.tuple([z.string()]), ([url]) => openExternal(url));
  handle('desktop:manage', z.tuple([managementSchema, objectSchema]), async ([operation, args]) => {
    args.workspace = await authorizeWorkspace(text(args.workspace, activeWorkspace()));
    if (operation === 'credentials.save') {
      if (runtimeChanging || settingsChanging) throw new Error('设置运行时正在更新，请稍后再试');
      settings.assertIdle();
      settingsChanging = true;
      try {
        const result = await management.invoke(operation, args);
        // Auth import runs in a separate native process; refresh settings catalogs without touching conversations.
        await settings.restartAll();
        return result;
      } finally { settingsChanging = false; }
    }
    if (operation === 'skills.install' && !args.sourcePath) {
      const selected = await dialog.showOpenDialog({ title: '选择包含 SKILL.md 的技能目录', properties: ['openDirectory'] });
      if (selected.canceled || !selected.filePaths[0]) throw new Error('已取消技能导入');
      args.sourcePath = selected.filePaths[0];
    }
    return management.invoke(operation satisfies ManagementOperation, args);
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 940, minHeight: 640, backgroundColor: '#14151a', title: 'OMP Desktop',
    webPreferences: { preload: path.join(rootDirectory, 'dist-electron', 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url.split('#')[0] !== pageUrl) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === window?.webContents && contents.getURL().split('#')[0] === pageUrl && permission === 'clipboard-sanitized-write');
  });
  window.webContents.session.setPermissionCheckHandler((contents, permission, origin) =>
    contents === window?.webContents && origin === 'file://' && permission === 'clipboard-sanitized-write');
  window.webContents.once('did-finish-load', () => console.log('OMP Desktop ready'));
  window.on('close', event => { if (!quitting) { event.preventDefault(); void requestQuit(); } });
  window.on('closed', () => { window = null; });
  void window.loadURL(pageUrl);
}

async function requestQuit(): Promise<void> {
  if (!owners) { quitting = true; app.quit(); return; }
  if (quitPending) return;
  quitPending = true;
  try {
    const running = [...owners.snapshots(), ...settings.snapshots()].some(owner => owner.status === 'starting' || owner.state.desktopBusy === true || owner.state.isSettled === false || owner.pendingUi.length);
    if (running) {
      const decision = await dialog.showMessageBox({ type: 'question', title: '关闭 OMP Desktop', message: '仍有会话或账号登录正在运行或等待回答。关闭会停止这些任务。', buttons: ['继续工作', '停止任务并关闭'], defaultId: 0, cancelId: 0 });
      if (decision.response !== 1) return;
    }
    shuttingDown = true;
    await management.shutdown();
    await Promise.all([settings.shutdown(), owners.shutdown()]);
    quitting = true;
    app.quit();
  } catch (error) {
    shuttingDown = false;
    dialog.showErrorBox('关闭失败', error instanceof Error ? error.message : String(error));
  } finally { quitPending = false; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void requestQuit(); } });
  app.whenReady().then(async () => {
    agentDir = resolveNativeAgentDirectory(os.homedir(), process.env, process.cwd());
    process.env.PI_CODING_AGENT_DIR = agentDir;
    preferences = await loadPreferences();
    await mkdir(sessionsRoot, { recursive: true });
    owners = new OwnerManager({ getExecutable: () => preferences.executable, getInitialModel: () => preferences.initialModel?.trim() || undefined, sessionsRoot, emit });
    settings = new SettingsRuntime({ getExecutable: () => preferences.executable, sessionsRoot, emit });
    management = new ManagementService({ getExecutable: () => preferences.executable, getWorkspace: activeWorkspace, agentDir, restartOwners: restartRuntimes, openExternal });
    registerIpc();
    createWindow();
  }).catch(error => { dialog.showErrorBox('OMP Desktop 启动失败', error instanceof Error ? error.message : String(error)); quitting = true; app.quit(); });
}
