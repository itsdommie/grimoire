import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { KeyStore } from './advisor.js';
import { GoogleOAuth, type CodeFlow } from './googleOAuth.js';
import { DRIVE_SCOPE, DriveStore, SyncAuthError } from './syncDrive.js';

// The shared sign-in with a stand-in for the browser part, the way the phone uses it: a fixed redirect address, and a code handed back.
const store = (canStore = true) => { const s = { value: null as string | null, canStore, get: () => s.value, set: async (v: string) => { s.value = v; }, clear: async () => { s.value = null; } }; return s as unknown as KeyStore & { value: string | null }; };
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;
const CLIENT = { clientId: 'web-client.apps.googleusercontent.com', clientSecret: 'shh' };
const REDIRECT = 'https://example.test/oauth-callback.html';

function fakeFlow(over: { code?: string; fail?: string } = {}) {
  const seen: Array<{ state: string; url: URL }> = [];
  const flow: CodeFlow = { getCode: async ({ state, buildUrl }) => { seen.push({ state, url: new URL(buildUrl(REDIRECT)) }); if (over.fail) throw new Error(over.fail); return { code: over.code ?? 'the-code', redirectUri: REDIRECT }; } };
  return { flow, seen };
}
function fakeGoogle(reply: (p: URLSearchParams) => { status?: number; body: object }) {
  const calls: Array<{ url: string; params: URLSearchParams }> = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => { const params = new URLSearchParams(String(init.body ?? '')); calls.push({ url: String(url), params }); if (String(url).endsWith('/revoke')) return new Response('', { status: 200 }); const r = reply(params); return Response.json(r.body, { status: r.status ?? 200 }); }) as typeof fetch;
  return { fetchImpl, calls, tokens: () => calls.filter((c) => c.url.endsWith('/token')) };
}
const grant = (over: Record<string, unknown> = {}) => ({ access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-1', scope: `openid email ${DRIVE_SCOPE}`, id_token: idToken('phone@example.com'), ...over });

describe('the shared Google sign-in, with a phone-style browser part', () => {
  it('asks the flow to take the person to Google, and exchanges the code it gets back for a lasting sign-in', async () => {
    const { flow, seen } = fakeFlow();
    const google = fakeGoogle(() => ({ body: grant() }));
    const s = store();
    const auth = new GoogleOAuth({ client: CLIENT, store: s, flow, fetchImpl: google.fetchImpl });
    expect(auth.available()).toBe(true);
    await auth.signIn();

    const { state, url } = seen[0]!;
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT); // whatever the flow says its redirect is
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('scope')).toBe(`openid email ${DRIVE_SCOPE}`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');

    const exchange = google.tokens()[0]!.params;
    expect(exchange.get('code')).toBe('the-code');
    expect(exchange.get('redirect_uri')).toBe(REDIRECT);
    expect(exchange.get('client_secret')).toBe('shh');
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));

    expect(await auth.account()).toBe('phone@example.com');
    expect(JSON.parse(s.value!)).toEqual({ refreshToken: 'refresh-1', email: 'phone@example.com' });
    expect(await auth.accessToken()).toBe('access-1');
  });

  it('reads an email with accented characters out of the ID token without Node-only helpers', async () => {
    const google = fakeGoogle(() => ({ body: grant({ id_token: idToken('zoë@example.com') }) }));
    const auth = new GoogleOAuth({ client: CLIENT, store: store(), flow: fakeFlow().flow, fetchImpl: google.fetchImpl });
    await auth.signIn();
    expect(await auth.account()).toBe('zoë@example.com');
  });

  it('uses a fresh state and challenge for every sign-in', async () => {
    const { flow, seen } = fakeFlow();
    const auth = new GoogleOAuth({ client: CLIENT, store: store(), flow, fetchImpl: fakeGoogle(() => ({ body: grant() })).fetchImpl });
    await auth.signIn(); await auth.signIn();
    expect(seen[0]!.state).not.toBe(seen[1]!.state);
    expect(seen[0]!.url.searchParams.get('code_challenge')).not.toBe(seen[1]!.url.searchParams.get('code_challenge'));
  });

  it('passes on the flow\'s own refusal (cancelled, timed out) and stores nothing', async () => {
    const s = store();
    const auth = new GoogleOAuth({ client: CLIENT, store: s, flow: fakeFlow({ fail: 'Signing in to Google was cancelled.' }).flow, fetchImpl: fakeGoogle(() => ({ body: grant() })).fetchImpl });
    await expect(auth.signIn()).rejects.toThrow(/cancelled/);
    expect(s.value).toBeNull();
  });

  it('refuses a sign-in without the Drive permission, or without a way to stay signed in', async () => {
    const noScope = store();
    await expect(new GoogleOAuth({ client: CLIENT, store: noScope, flow: fakeFlow().flow, fetchImpl: fakeGoogle(() => ({ body: grant({ scope: 'openid email' }) })).fetchImpl }).signIn()).rejects.toThrow(/leave that box ticked/);
    expect(noScope.value).toBeNull();
    await expect(new GoogleOAuth({ client: CLIENT, store: store(), flow: fakeFlow().flow, fetchImpl: fakeGoogle(() => ({ body: grant({ refresh_token: undefined }) })).fetchImpl }).signIn()).rejects.toThrow(/Third-party access/);
  });

  it('will not sign in without a keychain to keep it in, and is unavailable without the client id', async () => {
    const { flow, seen } = fakeFlow();
    await expect(new GoogleOAuth({ client: CLIENT, store: store(false), flow }).signIn()).rejects.toThrow(/No keychain/);
    expect(seen).toHaveLength(0); // the browser was never opened
    const none = new GoogleOAuth({ client: null, store: store(), flow });
    expect(none.available()).toBe(false);
    await expect(none.signIn()).rejects.toThrow(/not set up in this build/);
  });

  it('stays signed in through refreshes, treats a revoked sign-in as signed out, and signs out by revoking', async () => {
    const now = { t: 1_000_000 };
    let revoked = false;
    const google = fakeGoogle((p) => (p.get('grant_type') === 'refresh_token' ? (revoked ? { status: 400, body: { error: 'invalid_grant' } } : { body: { access_token: 'access-2', expires_in: 3600 } }) : { body: grant() }));
    const s = store();
    const auth = new GoogleOAuth({ client: CLIENT, store: s, flow: fakeFlow().flow, fetchImpl: google.fetchImpl, now: () => now.t });
    await auth.signIn();
    expect(await auth.accessToken()).toBe('access-1');
    now.t += 3_000_000 + 600_000; // within a minute of expiring
    expect(await auth.accessToken()).toBe('access-2');
    revoked = true;
    await expect(auth.accessToken(true)).rejects.toBeInstanceOf(SyncAuthError);
    expect(s.value).toBeNull();

    revoked = false;
    await auth.signIn();
    await auth.signOut();
    expect(s.value).toBeNull();
    expect(google.calls.find((c) => c.url.endsWith('/revoke'))!.params.get('token')).toBe('refresh-1');
  });

  it('waits for a store that saves asynchronously (the phone\'s Keystore) before it says it is signed in', async () => {
    let saved: string | null = null;
    const slow = { canStore: true, get: () => saved, set: async (v: string) => { await new Promise((r) => setTimeout(r, 20)); saved = v; }, clear: async () => { saved = null; } } as unknown as KeyStore;
    const auth = new GoogleOAuth({ client: CLIENT, store: slow, flow: fakeFlow().flow, fetchImpl: fakeGoogle(() => ({ body: grant() })).fetchImpl });
    await auth.signIn();
    expect(await auth.account()).toBe('phone@example.com');
  });

  it('calls the global fetch the way a browser insists on (not as a method of anything), for sign-in and for Drive', async () => {
    const real = globalThis.fetch;
    const seen: unknown[] = [];
    // A browser's fetch throws "Illegal invocation" unless `this` is the window or nothing; mimic that.
    globalThis.fetch = (function (this: unknown, input: string | URL | Request) {
      seen.push(this);
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      const url = String(input);
      return Promise.resolve(url.includes('/token') ? Response.json(grant()) : Response.json({ files: [] }));
    }) as typeof fetch;
    try {
      const auth = new GoogleOAuth({ client: CLIENT, store: store(), flow: fakeFlow().flow });
      await auth.signIn();
      await new DriveStore((force) => auth.accessToken(force)).read();
      expect(seen.length).toBeGreaterThanOrEqual(2);
    } finally { globalThis.fetch = real; }
  });
});
