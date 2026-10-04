import type { KeyStore } from './advisor.js';
import type { SyncAuth } from './syncController.js';
import { DRIVE_SCOPE, SyncAuthError } from './syncDrive.js';

// Signing in to Google for sync, the way Google asks apps without a server to do it: send the person to Google in their own browser (never an
// embedded one), let them sign in and agree there, and get a one-time code back. PKCE and a random `state` make sure the answer belongs to this
// sign-in and cannot be replayed or forged. Only the "drive.appdata" permission is requested (Grimoire's own hidden storage in Drive; none of
// the person's other files), plus their email just to show which account it is.
//
// This part is the same everywhere (it uses only web-standard APIs, so the phone's background worker runs it too). The one thing that differs
// is how the person gets to the browser and how the code comes back: that is a `CodeFlow`, supplied by the desktop app (a one-off address on
// this computer) and by the Android app (the browser hands back to the app through a link).

export interface GoogleClient { clientId: string; /** Google issues one for these apps; it is not confidential. */ clientSecret?: string }

/** The browser part of signing in. */
export interface CodeFlow {
  /**
   * Send the person to the address `buildUrl(redirectUri)` returns, and resolve with the code Google sends back to `redirectUri`. The flow
   * must ignore anything that doesn't carry `state` (so another page or app can't answer for the person), and reject if the person says no
   * or never finishes.
   */
  getCode(args: { state: string; buildUrl: (redirectUri: string) => string }): Promise<{ code: string; redirectUri: string }>;
}

export interface GoogleOAuthOptions {
  client: GoogleClient | null;
  /** Where the refresh token lives, protected by the operating system's keychain. */
  store: KeyStore;
  flow: CodeFlow;
  fetchImpl?: typeof fetch;
  now?: () => number;
  endpoints?: { auth: string; token: string; revoke: string };
}

export const GOOGLE_ENDPOINTS = { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', revoke: 'https://oauth2.googleapis.com/revoke' };

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = (bytes: number) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256url = async (text: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));

interface Saved { refreshToken: string; email: string }
interface TokenResponse { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; id_token?: string; error?: string; error_description?: string }

export class GoogleOAuth implements SyncAuth {
  private access: { token: string; expires: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly ep: NonNullable<GoogleOAuthOptions['endpoints']>;
  constructor(private readonly o: GoogleOAuthOptions) { this.ep = o.endpoints ?? GOOGLE_ENDPOINTS; }

  // Called as a method, a bare `fetch` gets this object as `this`, which browsers and workers reject ("Illegal invocation"; Node does not mind).
  private get fetch(): typeof fetch { return this.o.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)); }
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
    const verifier = randomToken(48);
    const state = randomToken(16);
    const challenge = await sha256url(verifier);
    const { code, redirectUri } = await this.o.flow.getCode({
      state,
      buildUrl: (redirect) => `${this.ep.auth}?${new URLSearchParams({
        client_id: this.o.client!.clientId, redirect_uri: redirect, response_type: 'code', scope: `openid email ${DRIVE_SCOPE}`,
        code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
      })}`,
    });
    const t = await this.tokenCall({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
    if (!t.ok || !t.body.access_token) throw new Error(`Google didn't complete the sign-in${t.body.error_description ? `: ${t.body.error_description}` : ''}.`);
    // Google lets people untick individual permissions on the consent screen: without this one there is nowhere to keep the file.
    if (!(t.body.scope ?? '').split(' ').includes(DRIVE_SCOPE)) throw new Error('Grimoire needs permission to keep its sync file in its own storage in your Google Drive. Sign in again and leave that box ticked.');
    if (!t.body.refresh_token) throw new Error("Google didn't allow Grimoire to stay signed in. Remove Grimoire under Google Account > Security > Third-party access, then sign in again.");
    await this.o.store.set(JSON.stringify({ refreshToken: t.body.refresh_token, email: emailFrom(t.body.id_token) } satisfies Saved));
    this.access = { token: t.body.access_token, expires: this.now() + (t.body.expires_in ?? 3600) * 1000 };
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
      if (t.body.error === 'invalid_grant' || t.status === 401) { this.access = null; await this.o.store.clear(); throw new SyncAuthError('Google has signed this device out. Sign in again to keep syncing.'); }
      throw new Error(`Couldn't refresh the Google sign-in (HTTP ${t.status}).`);
    }
    this.access = { token: t.body.access_token, expires: this.now() + (t.body.expires_in ?? 3600) * 1000 };
    return this.access.token;
  }

  async signOut(): Promise<void> {
    const saved = this.saved();
    this.access = null;
    await this.o.store.clear();
    if (saved) await this.fetch(this.ep.revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: saved.refreshToken }) }).catch(() => undefined); // best effort: it is forgotten here either way
  }
}

/** The email in Google's ID token, for showing which account it is (read as received over TLS: it is a label, not proof of anything). */
function emailFrom(idToken: string | undefined): string {
  try {
    const payload = idToken!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
    const email = (JSON.parse(json) as { email?: unknown }).email;
    if (typeof email === 'string' && email.length < 200) return email;
  } catch { /* no usable email */ }
  return 'your Google account';
}
