import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { KeyStore } from './advisor.js';
import { GoogleAuth, type GoogleAuthOptions } from './googleAuth.js';
import { DRIVE_SCOPE, SyncAuthError } from './syncDrive.js';

const memoryStore = (canStore = true): KeyStore & { value: string | null } => {
  const s = { value: null as string | null, canStore, get: () => s.value, set: (v: string) => { s.value = v; }, clear: () => { s.value = null; } };
  return s as unknown as KeyStore & { value: string | null };
};
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`;
const CLIENT = { clientId: 'client-123.apps.googleusercontent.com', clientSecret: 'shh' };

/** Google's token endpoint, as far as sign-in can tell. Records what it was asked. */
function fakeGoogle(reply: (params: URLSearchParams) => { status?: number; body: object } | Promise<{ status?: number; body: object }>) {
  const calls: Array<{ url: string; params: URLSearchParams }> = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const params = new URLSearchParams(String(init.body ?? ''));
    calls.push({ url: String(url), params });
    if (String(url).endsWith('/revoke')) return new Response('', { status: 200 });
    const r = await reply(params);
    return Response.json(r.body, { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls, tokenCalls: () => calls.filter((c) => c.url.endsWith('/token')) };
}

const goodGrant = (over: Record<string, unknown> = {}) => ({ access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-1', scope: `openid email ${DRIVE_SCOPE}`, id_token: idToken('person@example.com'), ...over });

/** The person's browser: follows the sign-in address and lets the redirect through (or not). */
function browser(act: (authUrl: URL) => Promise<void> | void) { const seen: URL[] = []; return { seen, openUrl: async (u: string) => { const url = new URL(u); seen.push(url); await Promise.resolve(); setTimeout(() => void act(url), 0); } }; }
const approve = (extra: Record<string, string> = {}, wrongStateFirst = false) => async (u: URL) => {
  const redirect = u.searchParams.get('redirect_uri')!;
  if (wrongStateFirst) await fetch(`${redirect}?code=forged&state=not-the-state`);
  const q = new URLSearchParams({ code: 'auth-code', state: u.searchParams.get('state')!, ...extra });
  await fetch(`${redirect}?${q}`);
};

const make = (over: Partial<GoogleAuthOptions> & { google?: ReturnType<typeof fakeGoogle>; store?: ReturnType<typeof memoryStore> } = {}) => {
  const store = over.store ?? memoryStore();
  const google = over.google ?? fakeGoogle(() => ({ body: goodGrant() }));
  const b = browser(approve());
  const auth = new GoogleAuth({ client: CLIENT, store, openUrl: b.openUrl, fetchImpl: google.fetchImpl, ...over });
  return { auth, store, google, browser: b };
};

describe('signing in', () => {
  it('sends the person to Google with only the permissions it needs, and keeps the sign-in safely', async () => {
    const { auth, store, google, browser: b } = make();
    expect(auth.available()).toBe(true);
    expect(await auth.account()).toBeNull();
    await auth.signIn();

    const url = b.seen[0]!;
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(CLIENT.clientId);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(`openid email ${DRIVE_SCOPE}`); // nothing about the person's own Drive files
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    // The code is exchanged with the matching PKCE verifier, so only this app can use it.
    const exchange = google.tokenCalls()[0]!.params;
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code')).toBe('auth-code');
    expect(exchange.get('client_id')).toBe(CLIENT.clientId);
    expect(exchange.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'));
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));

    expect(await auth.account()).toBe('person@example.com');
    expect(JSON.parse(store.value!)).toEqual({ refreshToken: 'refresh-1', email: 'person@example.com' });
    expect(await auth.accessToken()).toBe('access-1'); // fresh from signing in: no second trip to Google
    expect(google.tokenCalls()).toHaveLength(1);
  });

  it('ignores a request that does not carry this sign-in\'s state and keeps waiting for the real one', async () => {
    const google = fakeGoogle(() => ({ body: goodGrant() }));
    const b = browser(approve({}, true));
    const auth = new GoogleAuth({ client: CLIENT, store: memoryStore(), openUrl: b.openUrl, fetchImpl: google.fetchImpl });
    await auth.signIn();
    expect(google.tokenCalls()).toHaveLength(1);
    expect(google.tokenCalls()[0]!.params.get('code')).toBe('auth-code'); // never the forged one
  });

  it('says the sign-in was cancelled when the person declines, and stores nothing', async () => {
    const store = memoryStore();
    const b = browser(async (u) => { await fetch(`${u.searchParams.get('redirect_uri')}?error=access_denied&state=${u.searchParams.get('state')}`); });
    const auth = new GoogleAuth({ client: CLIENT, store, openUrl: b.openUrl, fetchImpl: fakeGoogle(() => ({ body: goodGrant() })).fetchImpl });
    await expect(auth.signIn()).rejects.toThrow(/cancelled/);
    expect(store.value).toBeNull();
  });

  it('refuses a sign-in where the person unticked the Drive permission, with the way out, and stores nothing', async () => {
    const { auth, store } = make({ google: fakeGoogle(() => ({ body: goodGrant({ scope: 'openid email' }) })) });
    await expect(auth.signIn()).rejects.toThrow(/leave that box ticked/);
    expect(store.value).toBeNull();
  });

  it('explains it when Google does not hand over a way to stay signed in', async () => {
    const { auth, store } = make({ google: fakeGoogle(() => ({ body: goodGrant({ refresh_token: undefined }) })) });
    await expect(auth.signIn()).rejects.toThrow(/Third-party access/);
    expect(store.value).toBeNull();
  });

  it('reports Google refusing the code, and a network failure, in plain words', async () => {
    await expect(make({ google: fakeGoogle(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request' } })) }).auth.signIn()).rejects.toThrow(/didn't complete the sign-in: Bad Request/);
    const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(make({ fetchImpl: offline }).auth.signIn()).rejects.toThrow(/Couldn't reach Google/);
  });

  it('will not sign in where there is no keychain to keep it in, and opens no browser', async () => {
    const b = browser(approve());
    const auth = new GoogleAuth({ client: CLIENT, store: memoryStore(false), openUrl: b.openUrl, fetchImpl: fakeGoogle(() => ({ body: goodGrant() })).fetchImpl });
    await expect(auth.signIn()).rejects.toThrow(/No keychain is available/);
    expect(b.seen).toHaveLength(0);
  });

  it('is unavailable without the app\'s Google client id', async () => {
    const auth = new GoogleAuth({ client: null, store: memoryStore(), openUrl: () => undefined });
    expect(auth.available()).toBe(false);
    await expect(auth.signIn()).rejects.toThrow(/not set up in this build/);
    expect(new GoogleAuth({ client: { clientId: '' }, store: memoryStore(), openUrl: () => undefined }).available()).toBe(false);
  });

  it('gives up if the person never finishes, and if the browser cannot be opened', async () => {
    const slow = new GoogleAuth({ client: CLIENT, store: memoryStore(), openUrl: () => undefined, timeoutMs: 60 });
    await expect(slow.signIn()).rejects.toThrow(/took too long/);
    const broken = new GoogleAuth({ client: CLIENT, store: memoryStore(), openUrl: async () => { throw new Error('no browser'); } });
    await expect(broken.signIn()).rejects.toThrow(/Couldn't open your browser: no browser/);
  });
});

describe('staying signed in', () => {
  const signedIn = async (now: { t: number }, google = fakeGoogle((p) => ({ body: p.get('grant_type') === 'refresh_token' ? { access_token: `access-${google.tokenCalls().length}`, expires_in: 3600 } : goodGrant() }))) => {
    const { auth, store } = make({ google, now: () => now.t });
    await auth.signIn();
    return { auth, store, google };
  };

  it('reuses the access token until shortly before it expires, then refreshes it with the saved sign-in', async () => {
    const now = { t: 1_000_000 };
    const { auth, google } = await signedIn(now);
    expect(await auth.accessToken()).toBe('access-1');
    now.t += 3_000_000; // 50 minutes later: still fine
    expect(await auth.accessToken()).toBe('access-1');
    now.t += 600_000; // within a minute of expiring: refresh
    const fresh = await auth.accessToken();
    expect(fresh).not.toBe('access-1');
    const refresh = google.tokenCalls().at(-1)!.params;
    expect(refresh.get('grant_type')).toBe('refresh_token');
    expect(refresh.get('refresh_token')).toBe('refresh-1');
  });

  it('refreshes on demand, and several callers at once share one refresh', async () => {
    const now = { t: 1 };
    const { auth, google } = await signedIn(now);
    const before = google.tokenCalls().length;
    const [a, b, c] = await Promise.all([auth.accessToken(true), auth.accessToken(true), auth.accessToken(true)]);
    expect(new Set([a, b, c]).size).toBe(1);
    expect(google.tokenCalls().length).toBe(before + 1);
  });

  it('remembers the sign-in across restarts (same keychain), without asking Google until a token is needed', async () => {
    const now = { t: 1 };
    const { store } = await signedIn(now);
    const google2 = fakeGoogle(() => ({ body: { access_token: 'later', expires_in: 3600 } }));
    const restarted = new GoogleAuth({ client: CLIENT, store, openUrl: () => undefined, fetchImpl: google2.fetchImpl });
    expect(await restarted.account()).toBe('person@example.com');
    expect(google2.calls).toHaveLength(0);
    expect(await restarted.accessToken()).toBe('later');
  });

  it('treats a revoked sign-in as signed out: forgets it and asks the person to sign in again', async () => {
    const google = fakeGoogle((p) => (p.get('grant_type') === 'refresh_token' ? { status: 400, body: { error: 'invalid_grant' } } : { body: goodGrant() }));
    const now = { t: 1 };
    const { auth, store } = await signedIn(now, google);
    await expect(auth.accessToken(true)).rejects.toBeInstanceOf(SyncAuthError);
    expect(store.value).toBeNull();
    expect(await auth.account()).toBeNull();
    await expect(auth.accessToken()).rejects.toThrow(/Sign in to Google/);
  });

  it('keeps the sign-in through a Google outage or a lost connection', async () => {
    let down = false;
    const google = fakeGoogle((p) => (p.get('grant_type') === 'refresh_token' && down ? { status: 503, body: {} } : { body: goodGrant() }));
    const now = { t: 1 };
    const { auth, store } = await signedIn(now, google);
    down = true;
    await expect(auth.accessToken(true)).rejects.toThrow(/HTTP 503/);
    expect(store.value).not.toBeNull(); // a hiccup is not a sign-out
  });
});

describe('signing out', () => {
  it('tells Google to revoke the sign-in, and forgets it here even if that fails', async () => {
    const { auth, store, google } = make();
    await auth.signIn();
    await auth.signOut();
    expect(store.value).toBeNull();
    expect(await auth.account()).toBeNull();
    const revoke = google.calls.find((c) => c.url.endsWith('/revoke'))!;
    expect(revoke.params.get('token')).toBe('refresh-1');

    const failing = fakeGoogle(() => ({ body: goodGrant() }));
    const flaky = { ...failing, fetchImpl: (async (u: string | URL | Request, i?: RequestInit) => (String(u).endsWith('/revoke') ? Promise.reject(new Error('offline')) : failing.fetchImpl(u, i))) as typeof fetch };
    const second = make({ google: flaky });
    await second.auth.signIn();
    await expect(second.auth.signOut()).resolves.toBeUndefined();
    expect(second.store.value).toBeNull();
  });

  it('is fine when nobody was signed in', async () => {
    const { auth, google } = make();
    await expect(auth.signOut()).resolves.toBeUndefined();
    expect(google.calls).toHaveLength(0);
  });
});
