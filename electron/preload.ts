import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { z } from 'zod';
import type { DesktopApi } from '../shared/contracts.js';
import { attachmentSchema, bootstrapSchema, eventSchema, fileEntrySchema, filePreviewSchema, jsonSchema, ownerSchema, preferencesSchema, sessionSchema, workspaceSchema } from '../shared/validation.js';

async function invoke<T>(channel: string, schema: z.ZodType<T>, ...args: unknown[]): Promise<T> {
  return schema.parse(await ipcRenderer.invoke(channel, ...args));
}

const desktop: DesktopApi = {
  bootstrap: () => invoke('desktop:bootstrap', bootstrapSchema),
  preferences: patch => invoke('desktop:preferences', preferencesSchema, patch),
  chooseExecutable: () => invoke('desktop:chooseExecutable', z.string().nullable()),
  chooseWorkspace: () => invoke('desktop:chooseWorkspace', workspaceSchema.nullable()),
  listSessions: workspace => invoke('desktop:listSessions', z.array(sessionSchema), workspace),
  createSession: workspace => invoke('desktop:createSession', ownerSchema, workspace),
  settingsSession: workspace => invoke('desktop:settingsSession', ownerSchema, workspace),
  settingsRequest: (id, command) => invoke('desktop:settingsRequest', jsonSchema, id, command),
  openSession: session => invoke('desktop:openSession', ownerSchema, session),
  snapshot: id => invoke('desktop:snapshot', ownerSchema, id),
  closeSession: id => invoke('desktop:closeSession', z.undefined(), id),
  request: (id, command) => invoke('desktop:request', jsonSchema, id, command),
  reply: (id, response) => invoke('desktop:reply', z.undefined(), id, response),
  exportSession: id => invoke('desktop:exportSession', z.string().nullable(), id),
  importSession: () => invoke('desktop:importSession', ownerSchema.nullable()),
  listFiles: (root, requested) => invoke('desktop:listFiles', z.array(fileEntrySchema), root, requested),
  previewFile: (root, requested) => invoke('desktop:previewFile', filePreviewSchema, root, requested),
  chooseAttachments: () => invoke('desktop:chooseAttachments', z.array(attachmentSchema)),
  attachmentFromPath: (root, requested) => invoke('desktop:attachmentFromPath', attachmentSchema, root, requested),
  attachmentFromDrop: (root, file) => {
    const filePath = webUtils.getPathForFile(file);
    if (!filePath) return Promise.reject(new Error('拖放内容没有可读取的本机文件路径'));
    return invoke('desktop:attachmentFromDrop', attachmentSchema, root, filePath);
  },
  openExternal: url => invoke('desktop:openExternal', z.undefined(), url),
  manage: (operation, args = {}) => invoke('desktop:manage', jsonSchema, operation, args),
  onEvent: listener => {
    const receive = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(eventSchema.parse(payload));
    ipcRenderer.on('desktop:event', receive);
    return () => ipcRenderer.removeListener('desktop:event', receive);
  },
};

contextBridge.exposeInMainWorld('desktop', Object.freeze(desktop));
