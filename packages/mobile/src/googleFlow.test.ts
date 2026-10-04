import { describe, expect, it } from 'vitest';
import { GoogleOAuth } from '../../server/src/googleOAuth.ts';
import { DRIVE_SCOPE } from '../../server/src/syncDrive.ts';
import type { KeyStore } from '../../server/src/advisor.ts';
import { ANDROID_REDIRECT, appLinkFlow } from './googleFlow.ts';
import type { NativeRequest, NativeResult } from './protocol.ts';

const LINK = 'io.github.itsdommie.grimoire://oauth';
/** The native side: remembers what it was asked and answers with a link (built from the state it was given, unless told otherwise). */
function fakeNative(answer: (r: Extract<NativeRequest, { op: 'browser-auth' }>) => NativeResult) {
  const asked: NativeRequest[] = [];
  return { asked, fn: async (r: NativeRequest): Promise<NativeResult> => { asked.push(r); return r.op === 'browser-auth' ? answer(r) : { ok: false, error: 'unsupported' }; } };
}
const flow = (n: ReturnType<typeof fakeNative>) => appLinkFlow(n.fn);
const args = (state: string) => ({ state, buildUrl: (redirect: string) => `https://accounts.google.com/auth?redirect_uri=${encodeURIComponent(redirect)}&state=${state}` });

describe('the phone\'s browser hand-off', () => {
  it('opens Google with the website\'s redirect page, waits for the link back and returns its code', async () => {
    const n = fakeNative((r) => ({ ok: true, text: `${LINK}?code=abc&state=${r.state}` }));
    expect(await flow(n).getCode(args('s1'))).toEqual({ code: 'abc', redirectUri: ANDROID_REDIRECT });
    expect(n.asked).toEqual([{ op: 'browser-auth', url: `https://accounts.google.com/auth?redirect_uri=${encodeURIComponent(ANDROID_REDIRECT)}&state=s1`, state: 's1' }]);
  });

  it('refuses a link carrying a different state (another app or page answering), and a malformed one', async () => {
    await expect(flow(fakeNative(() => ({ ok: true, text: `${LINK}?code=abc&state=other` }))).getCode(args('s1'))).rejects.toThrow(/did not come from this app/);
    await expect(flow(fakeNative(() => ({ ok: true, text: 'not a link' }))).getCode(args('s1'))).rejects.toThrow(/did not come back/);
    await expect(flow(fakeNative(() => ({ ok: true }))).getCode(args('s1'))).rejects.toThrow(/did not come back/);
  });

  it('says so when the person said no, or Google reported a problem', async () => {
    await expect(flow(fakeNative((r) => ({ ok: true, text: `${LINK}?error=access_denied&state=${r.state}` }))).getCode(args('s1'))).rejects.toThrow(/cancelled/);
    await expect(flow(fakeNative((r) => ({ ok: true, text: `${LINK}?error=server_error&state=${r.state}` }))).getCode(args('s1'))).rejects.toThrow(/failed \(server_error\)/);
    await expect(flow(fakeNative((r) => ({ ok: true, text: `${LINK}?state=${r.state}` }))).getCode(args('s1'))).rejects.toThrow(/Google sign-in failed/);
  });

  it('passes on the native side\'s own failure (no browser, took too long)', async () => {
    await expect(flow(fakeNative(() => ({ ok: false, error: 'No browser to open the sign-in in.' }))).getCode(args('s1'))).rejects.toThrow(/No browser/);
  });

  it('completes a whole sign-in through the shared core, with the code coming back by link', async () => {
    let stored: string | null = null;
    const store = { canStore: true, get: () => stored, set: async (v: string) => { stored = v; }, clear: async () => { stored = null; } } as unknown as KeyStore;
    const n = fakeNative((r) => ({ ok: true, text: `${LINK}?code=phone-code&state=${r.state}` }));
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push(`${String(url)} ${new URLSearchParams(String(init.body ?? '')).get('redirect_uri') ?? ''}`);
      return Response.json({ access_token: 'a', expires_in: 3600, refresh_token: 'r', scope: `openid email ${DRIVE_SCOPE}`, id_token: `x.${btoa(JSON.stringify({ email: 'me@example.com' }))}.y` });
    }) as typeof fetch;
    const auth = new GoogleOAuth({ client: { clientId: 'web-client', clientSecret: 's' }, store, flow: flow(n), fetchImpl });
    await auth.signIn();
    expect(await auth.account()).toBe('me@example.com');
    expect(calls).toEqual([`https://oauth2.googleapis.com/token ${ANDROID_REDIRECT}`]); // the same redirect address goes to Google when the code is exchanged
  });
});
