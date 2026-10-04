import { SyncConflict, type SyncStore } from './sync.js';

// Google Drive's hidden per-app storage ("appDataFolder") as the place the sync file lives. Only this app can see it (the person's own
// Drive files are out of reach, which is why the one permission asked for is "drive.appdata"), it doesn't count against what they see in
// Drive, and they can clear it from Drive's settings. Platform-neutral: plain `fetch`, so the phone uses it too.

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'grimoire-sync.json';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

/** Google refused the token (expired or revoked): the person has to sign in again. */
export class SyncAuthError extends Error {}

export class DriveStore implements SyncStore {
  /** `token(true)` must return a freshly refreshed access token (used once after a 401). */
  constructor(private readonly token: (forceRefresh?: boolean) => Promise<string>, private readonly fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)) {} // not the bare `fetch`: called as a method it would get this object as `this`, which browsers reject

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${await this.token(attempt > 0)}` } });
      if (res.status === 401 && attempt === 0) continue; // an expired token: refresh once and go again
      if (res.status === 401) throw new SyncAuthError('Google has signed this device out. Sign in again to keep syncing.');
      if (res.status === 403) {
        const body = await res.text().catch(() => '');
        if (/insufficientPermissions|insufficient authentication scopes/i.test(body)) throw new SyncAuthError('Grimoire was not allowed to use its storage in your Google Drive. Sign in again and allow it.');
        throw new Error(`Google Drive refused the request (${/quota|rate/i.test(body) ? 'too many requests, try again shortly' : 'HTTP 403'}).`);
      }
      if (!res.ok) throw new Error(`Google Drive error (HTTP ${res.status}).`);
      return res;
    }
  }

  /** The sync file (the oldest, if two devices created one at the same moment), or null. */
  private async find(): Promise<{ id: string; version: string } | null> {
    const q = encodeURIComponent(`name = '${FILE_NAME}' and trashed = false`);
    const res = await this.call(`${API}?spaces=appDataFolder&q=${q}&orderBy=createdTime&pageSize=1&fields=files(id,version)`);
    const file = ((await res.json()) as { files?: Array<{ id: string; version: string }> }).files?.[0];
    return file ?? null;
  }

  async read() {
    const file = await this.find();
    if (!file) return null;
    const res = await this.call(`${API}/${encodeURIComponent(file.id)}?alt=media`);
    return { text: await res.text(), version: file.version };
  }

  async write(text: string, expect: string | null): Promise<string> {
    const current = await this.find();
    if ((current?.version ?? null) !== expect) throw new SyncConflict('The sync file changed while syncing.');
    if (current) {
      const res = await this.call(`${UPLOAD}/${encodeURIComponent(current.id)}?uploadType=media&fields=version`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text });
      return ((await res.json()) as { version: string }).version;
    }
    const boundary = `grimoire-${Math.random().toString(36).slice(2)}`;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' })}\r\n`
      + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
    const res = await this.call(`${UPLOAD}?uploadType=multipart&fields=id,version`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    return ((await res.json()) as { version: string }).version;
  }
}
