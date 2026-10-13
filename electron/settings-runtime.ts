import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DesktopEvent, Json, OwnerSnapshot, RpcCommand, RpcFrame } from '../shared/contracts.js';
import { OwnerManager } from './rpc.js';

export interface SettingsRuntimeOptions {
  getExecutable: () => string;
  sessionsRoot: string;
  emit: (event: DesktopEvent) => void;
}

/** Native account/catalog runtime, deliberately separate from conversation ownership. */
export class SettingsRuntime {
  private readonly manager: OwnerManager;
  private readonly workspaces = new Map<string, string>();
  private readonly openings = new Map<string, Promise<OwnerSnapshot>>();
  private resolving = 0;
  private readonly cancellations = new Map<string, Promise<void>>();
  private shuttingDown = false;
  private restarting = false;

  constructor(options: SettingsRuntimeOptions) {
    this.manager = new OwnerManager({ ...options, settingsOnly: true, getInitialModel: () => 'openai-codex/' });
  }

  async get(workspace: string): Promise<OwnerSnapshot> {
    if (this.shuttingDown || this.restarting) throw new Error('Settings runtime is shutting down or restarting');
    this.resolving++;
    try {
      const canonical = await realpath(path.resolve(workspace));
      if (!(await stat(canonical)).isDirectory()) throw new Error('Workspace is not a directory');
      if (this.shuttingDown || this.restarting) throw new Error('Settings runtime is shutting down or restarting');
      const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      const pending = this.openings.get(key);
      if (pending) return await pending;
      const existing = this.workspaces.get(key);
      if (existing) {
        const cancellation = this.cancellations.get(existing);
        if (cancellation) await cancellation;
        const snapshot = this.manager.snapshot(existing);
        if (snapshot.status !== 'closed' && snapshot.status !== 'error') return snapshot;
      }
      const opening = (async () => {
        if (existing) await this.manager.close(existing);
        try {
          const snapshot = await this.manager.create(canonical);
          this.workspaces.set(key, snapshot.id);
          return snapshot;
        } catch (error) {
          const failed = this.manager.snapshots().find(snapshot => snapshot.workspace === canonical && snapshot.status === 'error');
          if (failed) this.workspaces.set(key, failed.id);
          throw error;
        }
      })();
      this.openings.set(key, opening);
      try { return await opening; }
      finally { this.openings.delete(key); }
    } finally { this.resolving--; }
  }

  request(id: string, command: RpcCommand): Promise<Json> {
    return this.manager.request(id, command);
  }

  async reply(id: string, frame: RpcFrame): Promise<void> {
    if (frame.cancelled === true && this.manager.snapshot(id).state.desktopLoginPending === true) {
      const pending = this.manager.cancelSettingsLogin(id, frame);
      this.cancellations.set(id, pending);
      try { await pending; }
      finally { this.cancellations.delete(id); }
    } else this.manager.reply(id, frame);
  }

  has(id: string): boolean {
    return this.manager.has(id);
  }

  snapshots(): OwnerSnapshot[] {
    return this.manager.snapshots();
  }

  assertIdle(): void {
    if (this.shuttingDown || this.restarting || this.resolving || this.openings.size || this.cancellations.size) throw new Error('Wait for settings runtime startup or shutdown before restarting');
    this.manager.assertIdle();
  }

  async restartAll(): Promise<void> {
    this.assertIdle();
    this.restarting = true;
    try { await this.manager.restartAll(); }
    finally { this.restarting = false; }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.manager.shutdown();
  }
}
