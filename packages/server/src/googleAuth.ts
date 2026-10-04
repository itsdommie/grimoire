import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { KeyStore } from './advisor.js';
import { GoogleOAuth, type CodeFlow, type GoogleClient } from './googleOAuth.js';

// Signing in to Google from the desktop app: the shared sign-in (googleOAuth.ts) with its browser part done the way Google asks installed
// apps to do it: open the person's own browser, and receive Google's answer on a one-off address on this computer.

export type { GoogleClient } from './googleOAuth.js';

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

const PAGE = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>Grimoire</title><body style="font:16px system-ui;max-width:32em;margin:15vh auto;padding:0 1em;text-align:center"><h1>${title}</h1><p>${body}</p></body>`;

/** Browser part for a computer: a listener on 127.0.0.1 at a random port receives Google's redirect. */
export function loopbackFlow(openUrl: GoogleAuthOptions['openUrl'], timeoutMs = 5 * 60_000): CodeFlow {
  return {
    getCode: ({ state, buildUrl }) => new Promise((resolve, reject) => {
      let server: Server | null = null;
      let redirectUri = '';
      const timer = setTimeout(() => finish(new Error('Signing in took too long, so it was cancelled. Try again.')), timeoutMs);
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
        Promise.resolve(openUrl(buildUrl(redirectUri))).catch((e: unknown) => finish(new Error(`Couldn't open your browser: ${e instanceof Error ? e.message : String(e)}`)));
      });
    }),
  };
}

/** The desktop app's Google sign-in. */
export class GoogleAuth extends GoogleOAuth {
  constructor(o: GoogleAuthOptions) {
    super({ client: o.client, store: o.store, flow: loopbackFlow(o.openUrl, o.timeoutMs), fetchImpl: o.fetchImpl, now: o.now, endpoints: o.endpoints });
  }
}
