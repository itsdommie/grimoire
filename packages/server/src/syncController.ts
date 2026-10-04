import type { SyncStatus } from '@grimoire/shared';
import type { Db } from './schema.js';
import { runSync, SyncConflict, SyncFormatError, type SyncStore } from './sync.js';
import { DriveStore, SyncAuthError } from './syncDrive.js';
import { BadRequestError } from './decks.js';

/** Signing in to Google, wherever that is done (a browser on the desktop, the system on a phone) and holding the tokens safely. */
export interface SyncAuth {
  /** Whether this build can sign in at all (it needs the app's Google client id). */
  available(): boolean;
  /** The signed-in account's email, or null. */
  account(): Promise<string | null>;
  /** Interactive: opens the sign-in and resolves when the person has finished (or throws if they didn't). */
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  accessToken(forceRefresh?: boolean): Promise<string>;
}

export interface SyncControllerOptions {
  db: Db;
  auth?: SyncAuth;
  /** Makes the store for a folder path. Present only where there is a file system (the desktop app). */
  folder?: (path: string) => SyncStore & { check(): void };
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Injected so tests need no real timers. */
  schedule?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** How often to sync in the background while connected. */
  intervalMs?: number;
  /** How long after a local change to sync (changes in quick succession share one sync). */
  debounceMs?: number;
}

const real = { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** Holds the person's sync settings and does the syncing: on demand, shortly after they change something, and every so often. */
export class SyncController {
  private running: Promise<SyncStatus> | null = null;
  private dirty = false;
  private debounce: unknown = null;
  private interval: unknown = null;
  private readonly schedule: NonNullable<SyncControllerOptions['schedule']>;

  constructor(private readonly o: SyncControllerOptions) { this.schedule = o.schedule ?? real; }

  // ----------------------------------------------------------------------------------------------------------------------- settings
  private meta(key: string): string | null { return (this.o.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null; }
  private setMeta(key: string, value: string | null): void {
    if (value === null) this.o.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    else this.o.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }
  private device(): string {
    let d = this.meta('sync_device');
    if (!d) { d = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join(''); this.setMeta('sync_device', d); }
    return d;
  }
  private provider(): 'google' | 'folder' | null {
    const p = this.meta('sync_provider');
    return p === 'google' || p === 'folder' ? p : null;
  }

  async status(): Promise<SyncStatus> {
    const provider = this.provider();
    const account = provider === 'google' && this.o.auth ? await this.o.auth.account().catch(() => null) : null;
    return {
      available: true,
      folderSupported: !!this.o.folder,
      googleSupported: !!this.o.auth?.available(),
      provider,
      folderPath: provider === 'folder' ? this.meta('sync_folder') : null,
      account,
      needsSignIn: provider === 'google' && (!account || this.meta('sync_signin') === '1'),
      running: this.running !== null,
      lastAt: this.meta('sync_last_at'),
      lastPulled: Number(this.meta('sync_last_pulled') ?? 0),
      lastPushed: this.meta('sync_last_pushed') === '1',
      error: this.meta('sync_error'),
    };
  }

  // ---------------------------------------------------------------------------------------------------------------------- connecting
  private storeFor(provider: 'google' | 'folder'): SyncStore {
    if (provider === 'folder') {
      const path = this.meta('sync_folder');
      if (!path || !this.o.folder) throw new BadRequestError('Folder sync is not set up.');
      return this.o.folder(path);
    }
    if (!this.o.auth) throw new BadRequestError('Google sync is not available in this build.');
    const auth = this.o.auth;
    return new DriveStore((force) => auth.accessToken(force), this.o.fetchImpl);
  }

  /** Use a folder (for example one Dropbox or Syncthing keeps in step) as the shared place, and sync once to prove it works. */
  async connectFolder(path: string): Promise<SyncStatus> {
    if (!this.o.folder) throw new BadRequestError('Syncing through a folder is only available in the desktop app.');
    const trimmed = (path ?? '').trim();
    if (!trimmed) throw new BadRequestError('Choose a folder.');
    try { this.o.folder(trimmed).check(); } catch (e) { throw new BadRequestError((e as Error).message); }
    return this.connect('folder', () => this.setMeta('sync_folder', trimmed));
  }

  /** Sign in to Google (the person finishes in their browser or the system's sign-in) and sync once to prove it works. */
  async connectGoogle(): Promise<SyncStatus> {
    if (!this.o.auth?.available()) throw new BadRequestError('Google sign-in is not set up in this build.');
    try { await this.o.auth.signIn(); } catch (e) { throw new BadRequestError((e as Error).message || 'Signing in to Google did not finish.'); }
    this.setMeta('sync_signin', null);
    return this.connect('google', () => undefined);
  }

  private async connect(provider: 'google' | 'folder', prepare: () => void): Promise<SyncStatus> {
    const before = { provider: this.meta('sync_provider'), folder: this.meta('sync_folder') };
    prepare();
    this.setMeta('sync_provider', provider);
    this.setMeta('sync_error', null);
    const status = await this.syncNow();
    if (status.error) { // the first sync failed: don't leave a connection that doesn't work
      this.setMeta('sync_provider', before.provider);
      this.setMeta('sync_folder', before.folder);
      if (provider === 'google' && !before.provider) await this.o.auth?.signOut().catch(() => undefined);
      throw new BadRequestError(status.error);
    }
    this.armTimers();
    return status;
  }

  /** Stop syncing on this device. The data here and the shared copy are both left as they are. */
  async disconnect(): Promise<SyncStatus> {
    const provider = this.provider();
    this.disarmTimers();
    for (const k of ['sync_provider', 'sync_folder', 'sync_last_at', 'sync_last_pulled', 'sync_last_pushed', 'sync_error', 'sync_signin']) this.setMeta(k, null);
    if (provider === 'google') await this.o.auth?.signOut().catch(() => undefined);
    return this.status();
  }

  // -------------------------------------------------------------------------------------------------------------------------- syncing
  /** Sync now. Failures are recorded in the status (with a message a person can act on) rather than thrown. */
  syncNow(): Promise<SyncStatus> {
    if (this.running) return this.running;
    const provider = this.provider();
    if (!provider) return this.status();
    this.dirty = false;
    this.running = (async () => {
      try {
        const r = await runSync(this.o.db, this.storeFor(provider), this.device(), { now: this.o.now });
        this.setMeta('sync_last_at', r.at);
        this.setMeta('sync_last_pulled', String(r.pulled));
        this.setMeta('sync_last_pushed', r.pushed ? '1' : '0');
        this.setMeta('sync_error', null);
        this.setMeta('sync_signin', null);
      } catch (e) {
        if (e instanceof SyncAuthError) { this.setMeta('sync_signin', '1'); this.setMeta('sync_error', e.message); }
        else if (e instanceof SyncFormatError || e instanceof SyncConflict) this.setMeta('sync_error', e.message);
        else this.setMeta('sync_error', `Couldn't sync: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.running = null;
      }
      if (this.dirty) this.noteChange(); // something changed while it ran
      return this.status();
    })();
    return this.running;
  }

  /** A decks/collection/wishlist change was just made here: sync soon (changes made close together share one sync). */
  noteChange(): void {
    if (!this.provider()) return;
    if (this.running) { this.dirty = true; return; }
    if (this.debounce !== null) this.schedule.clear(this.debounce);
    this.debounce = this.schedule.set(() => { this.debounce = null; void this.syncNow(); }, this.o.debounceMs ?? 20_000);
  }

  /** Called when the app starts: if it is connected, sync now and keep syncing in the background. */
  start(): void {
    if (!this.provider()) return;
    void this.syncNow();
    this.armTimers();
  }

  stop(): void { this.disarmTimers(); if (this.debounce !== null) { this.schedule.clear(this.debounce); this.debounce = null; } }

  private armTimers(): void {
    if (this.interval !== null) return;
    const every = () => { this.interval = this.schedule.set(() => { void this.syncNow().finally(() => { if (this.interval !== null) every(); }); }, this.o.intervalMs ?? 10 * 60_000); };
    every();
  }
  private disarmTimers(): void { if (this.interval !== null) { this.schedule.clear(this.interval); this.interval = null; } }
}
