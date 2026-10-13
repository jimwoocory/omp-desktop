export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type RpcFrame = JsonObject;
export type RpcCommand = { type: string; [key: string]: Json };
export interface Workspace { id: string; name: string; path: string }
export interface SessionRecord {
  id: string; name: string; path: string; workspace: string;
  updatedAt: string; preview: string; messageCount: number; managed: boolean;
}
export interface OwnerSnapshot {
  id: string; workspace: string; status: 'starting' | 'ready' | 'error' | 'closed';
  state: RpcFrame; messages: RpcFrame[]; pendingUi: RpcFrame[]; error?: string;
}
export interface Preferences {
  executable: string; workspaces: Workspace[]; activeWorkspace: string;
  theme: 'dark' | 'light'; notifications: boolean;
  initialModel?: string;
}
export interface Bootstrap { preferences: Preferences; owners: OwnerSnapshot[]; sessions: SessionRecord[]; version: string }
export interface DesktopEvent { ownerId: string; sequence: number; frame: RpcFrame; scope: 'conversation' | 'settings' }
export interface FileEntry { name: string; path: string; directory: boolean; size: number }
export interface FilePreview { path: string; kind: 'text' | 'image' | 'binary'; content: string; truncated: boolean }
export interface Attachment { name: string; mimeType: string; data: string; path?: string }
export type ManagementOperation =
  'config.list' | 'config.get' | 'config.set' | 'config.reset' |
  'credentials.save' | 'credentials.providers' |
  'mcp.list' | 'mcp.save' | 'mcp.remove' | 'mcp.authenticate' | 'mcp.reconnect' |
  'skills.list' | 'skills.install' | 'skills.remove' | 'skills.cli' |
  'plugins.list' | 'plugins.install' | 'plugins.remove' | 'extensions.list' |
  'mcp.config.list' | 'mcp.config.get' | 'mcp.config.set' | 'mcp.config.remove' |
  'runtime.restart';
export interface DesktopApi {
  bootstrap(): Promise<Bootstrap>;
  preferences(patch: Partial<Preferences>): Promise<Preferences>;
  chooseExecutable(): Promise<string | null>;
  chooseWorkspace(): Promise<Workspace | null>;
  listSessions(workspace?: string): Promise<SessionRecord[]>;
  createSession(workspace: string): Promise<OwnerSnapshot>;
  openSession(session: SessionRecord): Promise<OwnerSnapshot>;
  snapshot(ownerId: string): Promise<OwnerSnapshot>;
  closeSession(ownerId: string): Promise<void>;
  request(ownerId: string, command: RpcCommand): Promise<Json>;
  reply(ownerId: string, response: RpcFrame): Promise<void>;
  settingsSession(workspace: string): Promise<OwnerSnapshot>;
  settingsRequest(ownerId: string, command: RpcCommand): Promise<Json>;
  exportSession(ownerId: string): Promise<string | null>;
  importSession(): Promise<OwnerSnapshot | null>;
  listFiles(root: string, path?: string): Promise<FileEntry[]>;
  previewFile(root: string, path: string): Promise<FilePreview>;
  chooseAttachments(): Promise<Attachment[]>;
  attachmentFromPath(root: string, path: string): Promise<Attachment>;
  attachmentFromDrop(root: string, file: File): Promise<Attachment>;
  openExternal(url: string): Promise<void>;
  manage(operation: ManagementOperation, args?: JsonObject): Promise<Json>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
}
declare global { interface Window { desktop: DesktopApi } }
