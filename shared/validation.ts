import { z } from 'zod';
import type { Json, JsonObject, Preferences, SessionRecord } from './contracts.js';

export const jsonSchema = z.json();
export const objectSchema = z.record(z.string(), jsonSchema);
export const commandSchema = z.object({ type: z.string().min(1) }).catchall(jsonSchema);
export const workspaceSchema = z.object({ id: z.string(), name: z.string(), path: z.string() });
export const preferencesSchema = z.object({
  executable: z.string(), workspaces: z.array(workspaceSchema), activeWorkspace: z.string(),
  theme: z.enum(['dark', 'light']), notifications: z.boolean(),
  initialModel: z.string().max(200).refine(value => !/[\r\n\0]/.test(value)).optional(),
}) satisfies z.ZodType<Preferences>;
export const sessionSchema = z.object({
  id: z.string(), name: z.string(), path: z.string(), workspace: z.string(),
  updatedAt: z.string(), preview: z.string(), messageCount: z.number(), managed: z.boolean(),
}) satisfies z.ZodType<SessionRecord>;
export const ownerSchema = z.object({
  id: z.string(), workspace: z.string(), status: z.enum(['starting', 'ready', 'error', 'closed']),
  state: objectSchema, messages: z.array(objectSchema), pendingUi: z.array(objectSchema),
  error: z.string().optional(),
});
export const bootstrapSchema = z.object({
  preferences: preferencesSchema, owners: z.array(ownerSchema), sessions: z.array(sessionSchema), version: z.string(),
});
export const eventSchema = z.object({ ownerId: z.string(), sequence: z.number(), frame: objectSchema, scope: z.enum(['conversation', 'settings']) });
export const fileEntrySchema = z.object({ name: z.string(), path: z.string(), directory: z.boolean(), size: z.number() });
export const filePreviewSchema = z.object({
  path: z.string(), kind: z.enum(['text', 'image', 'binary']), content: z.string(), truncated: z.boolean(),
});
export const attachmentSchema = z.object({ name: z.string(), mimeType: z.string(), data: z.string(), path: z.string().optional() });
export const text = (value: Json | undefined, fallback = ''): string => typeof value === 'string' ? value : fallback;
export const number = (value: Json | undefined, fallback = 0): number => typeof value === 'number' ? value : fallback;
export const object = (value: Json | undefined): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
export const array = (value: Json | undefined): Json[] => Array.isArray(value) ? value : [];
export const flag = (value: Json | undefined): boolean => value === true;
export const messageText = (message: JsonObject): string => typeof message.content === 'string' ? message.content : array(message.content).map(block => {
  const item = object(block); return item.type === 'text' ? text(item.text) : '';
}).filter(Boolean).join('\n');
