import type { CodeFlow } from '../../server/src/googleOAuth.ts';
import type { NativeRequest, NativeResult } from './protocol.ts';

/**
 * Where Google sends the person after they agree: a small page on Grimoire's website that does nothing but hand the answer on to the app
 * (see site/oauth-callback.html). It must be listed as an authorised redirect address on the Google client.
 */
export const ANDROID_REDIRECT = 'https://itsdommie.github.io/grimoire/oauth-callback.html';

/**
 * The browser part of Google sign-in on the phone: the native side opens the person's browser and waits for the link that brings them back
 * into the app (it carries Google's answer, and only a link with this sign-in's `state` is accepted: another app can't answer for them).
 */
export function appLinkFlow(native: (request: NativeRequest) => Promise<NativeResult>, redirectUri = ANDROID_REDIRECT): CodeFlow {
  return {
    async getCode({ state, buildUrl }) {
      const r = await native({ op: 'browser-auth', url: buildUrl(redirectUri), state });
      if (!r.ok) throw new Error(r.error);
      let link: URL;
      try { link = new URL(r.text ?? ''); } catch { throw new Error('Google sign-in did not come back to the app properly. Try again.'); }
      if (link.searchParams.get('state') !== state) throw new Error('That sign-in did not come from this app. Try again.');
      const error = link.searchParams.get('error');
      const code = link.searchParams.get('code');
      if (error || !code) throw new Error(error === 'access_denied' ? 'Signing in to Google was cancelled.' : `Google sign-in failed${error ? ` (${error})` : ''}.`);
      return { code, redirectUri };
    },
  };
}
