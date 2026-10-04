import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { KeyStore } from './advisor.js';
import type { SyncAuth } from './syncController.js';
import { DRIVE_SCOPE, SyncAuthError } from './syncDrive.js';

// Signing in to Google from the desktop app, the way Google asks installed apps to do it: open the person's own browser (never an embedded
// one), let them sign in and agree there, and receive Google's answer on a one-off address on this computer. PKCE and a random `state`
// make sure the answer belongs to this sign-in and cannot be replayed or forged by another page. Only the "drive.appdata" permission is
// requested (Grimoire's own hidden storage in Drive; none of the person's other files), plus their email just to show which account.

export interface GoogleClient { clientId: string; /** Google issues one for desktop apps; it is not confidential. */ clientSecret?: string }

export interface GoogleAuthOptions {
  client: GoogleClient | null;
  /** Where the refresh token lives, encrypted by the operating system's keychain. */
  store: KeyStore;
  /** Open this address in the person's browser. */
  openUrl: (url: string) => Promise<void> | void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long to wait for the person to finish signing in. */
  timeoutMs?: number;
  endpoints?: { auth: string; token: string; revoke: string };
}

const ENDPOINTS = { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', revoke: 'https://oauth2.googleapis.com/revoke' };
const b64url = (b: Buffer) => b.toString('base64url');
const PAGE = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>Grimoire</title><body style="font:16px system-ui;max-width:32em;margin:15vh auto;padding:0 1em;text-align:center"><h1>${title}</h1><p>${body}</p></body>`;

interface Saved { refreshToken: string; email: string }
interface TokenResponse { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; id_token?: string; error?: string; error_description?: string }

export class GoogleAuth implements SyncAuth {
  private access: { token: string; expires: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly ep: NonNullable<GoogleAuthOptions['endpoints']>;
  constructor(private readonly o: GoogleAuthOptions) { this.ep = o.endpoints ?? ENDPOINTS; }

  private get fetch() { return this.o.fetchImpl ?? fetch; }
  private now() { return (this.o.now ?? Date.now)(); }
  available(): boolean { return !!this.o.client?.clientId; }

  private saved(): Saved | null {
    const raw = this.o.store.get();
    if (!raw) return null;
    try { const s = JSON.parse(raw) as Saved; return typeof s.refreshToken === 'string' && s.refreshToken ? s : null; } catch { return null; }
  }
  async account(): Promise<string | null> { return this.saved()?.email ?? null; }

  private async tokenCall(params: Record<string, string>): Promise<{ ok: boolean; status: number; body: TokenResponse }> {
    const c = this.o.client!;
    const body = new URLSearchParams({ client_id: c.clientId, ...(c.clientSecret ? { client_secret: c.clientSecret } : {}), ...params });
    let res: Response;
    try { res = await this.fetch(this.ep.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }); }
    catch { throw new Error("Couldn't reach Google. Check your connection and try again."); }
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as TokenResponse };
  }

  async signIn(): Promise<void> {
    if (!this.available()) throw new Error('Google sign-in is not set up in this build.');
    if (!this.o.store.canStore) throw new Error('No keychain is available to protect your Google sign-in, so Grimoire will not store it. Install and unlock a keyring (such as GNOME Keyring or KeePassXC), then try again.');
    const verifier = b64url(randomBytes(48));
    const state = b64url(randomBytes(16));
    const { code, redirectUri } = await this.waitForCode(state, b64url(createHash('sha256').update(verifier).digest()));
    const t = await this.tokenCall({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
    if (!t.ok || !t.body.access_token) throw new Error(`Google didn't complete the sign-in${t.body.error_description ? `: ${t.body.error_description}` : ''}.`);
    // Google lets people untick individual permissions on the consent screen: without this one there is nowhere to keep the file.
    if (!(t.body.scope ?? '').split(' ').includes(DRIVE_SCOPE)) throw new Error('Grimoire needs permission to keep its sync file in its own storage in your Google Drive. Sign in again and leave that box ticked.');
    if (!t.body.refresh_token) throw new Error("Google didn't allow Grimoire to stay signed in. Remove Grimoire under Google Account > Security > Third-party access, then sign in again.");
    this.o.store.set(JSON.stringify({ refreshToken: t.body.refresh_token, email: emailFrom(t.body.id_token) } satisfies Saved));
    this.access = { token: t.body.access_token, expires: this.now() + (t.body.expires_in ?? 3600) * 1000 };
  }

  /** Open the browser, and wait for Google to send the person back to a one-off address on this computer. */
  private waitForCode(state: string, challenge: string): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      let server: Server | null = null;
      const timer = setTimeout(() => finish(new Error('Signing in took too long, so it was cancelled. Try again.')), this.o.timeoutMs ?? 5 * 60_000);
      let redirectUri = '';
      const finish = (err: Error | null, code?: string) => {
        clearTimeout(timer);
        const s = server; server = null;
        if (s) { s.close(); s.closeAllConnections?.(); }
        if (err) reject(err); else resolve({ code: code!, redirectUri });
      };
      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
        const reply = (status: number, html: string) => res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
        if (url.searchParams.get('state') !== state) { reply(400, PAGE('That did not work', 'This sign-in link did not come from Grimoire. You can close this tab.')); return; } // not ours: keep waiting for the real one
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        if (error || !code) { reply(200, PAGE('Not signed in', 'You can close this tab and go back to Grimoire.')); finish(new Error(error === 'access_denied' ? 'Signing in to Google was cancelled.' : `Google sign-in failed${error ? ` (${error})` : ''}.`)); return; }
        reply(200, PAGE('You are signed in', 'You can close this tab and go back to Grimoire.'));
        finish(null, code);
      });
      server.on('error', (e) => finish(new Error(`Couldn't start the sign-in: ${e.message}`)));
      server.listen(0, '127.0.0.1', () => {
        redirectUri = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/callback`;
        const q = new URLSearchParams({
          client_id: this.o.client!.clientId, redirect_uri: redirectUri, response_type: 'code', scope: `openid email ${DRIVE_SCOPE}`,
          code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
        });
        Promise.resolve(this.o.openUrl(`${this.ep.auth}?${q}`)).catch((e: unknown) => finish(new Error(`Couldn't open your browser: ${e instanceof Error ? e.message : String(e)}`)));
      });
    });
  }

  async accessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.access && this.access.expires - 60_000 > this.now()) return this.access.token;
    // Several callers at once share one refresh.
    this.refreshing ??= this.refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const saved = this.saved();
    if (!saved) throw new SyncAuthError('Sign in to Google to sync.');
    const t = await this.tokenCall({ grant_type: 'refresh_token', refresh_token: saved.refreshToken });
    if (!t.ok || !t.body.access_token) {
      if (t.body.error === 'invalid_grant' || t.status === 401) { this.access = null; this.o.store.clear(); throw new SyncAuthError('Google has signed this device out. Sign in again to keep syncing.'); }
      throw new Error(`Couldn't refresh the Google sign-in (HTTP ${t.status}).`);
    }
    this.access = { token: t.body.access_token, expires: this.now() + (t.body.expires_in ?? 3600) * 1000 };
    return this.access.token;
  }

  async signOut(): Promise<void> {
    const saved = this.saved();
    this.access = null;
    this.o.store.clear();
    if (saved) await this.fetch(this.ep.revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: saved.refreshToken }) }).catch(() => undefined); // best effort: it is forgotten here either way
  }
}

/** The email in Google's ID token, for showing which account it is (read as received over TLS: it is a label, not proof of anything). */
function emailFrom(idToken: string | undefined): string {
  try { const email = (JSON.parse(Buffer.from(idToken!.split('.')[1]!, 'base64url').toString()) as { email?: unknown }).email; if (typeof email === 'string' && email.length < 200) return email; } catch { /* no usable email */ }
  return 'your Google account';
}
