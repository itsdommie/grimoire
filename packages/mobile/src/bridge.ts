import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { FromWorker, NativeRequest, NativeResult, ToWorker } from './protocol.ts';
import type { OcrResult, TextRecognizer } from '../../web/src/scanning.ts';
import { checkForAppUpdate } from './appUpdate.ts';

/**
 * Runs before the app. It starts the API worker and replaces `fetch` for `/api/...` URLs with a call into that worker, so the
 * unchanged web UI talks to the on-device database as if it were the desktop server. Everything else (card images) goes to the
 * network as usual.
 */
const worker = new Worker(new URL('./api.worker.js', document.currentScript instanceof HTMLScriptElement ? document.currentScript.src : location.href), { type: 'module' });
const pending = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>();
let nextId = 1;
let fatal: string | null = null;
let markReady!: () => void;
const ready = new Promise<void>((resolve) => { markReady = resolve; });

const send = (m: ToWorker) => worker.postMessage(m);
worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  if ('ready' in m) { markReady(); return; }
  if ('progress' in m) { splash.textContent = m.progress; return; }
  if ('reload' in m) { location.reload(); return; } // a card update was downloaded: the next start applies it
  if ('native' in m) { void doNative(m.native.id, m.native.request); return; }
  if ('fatal' in m) { fatal = m.fatal; markReady(); window.dispatchEvent(new CustomEvent('grimoire-fatal', { detail: m.fatal })); return; }
  const call = pending.get(m.id);
  if (!call) return;
  pending.delete(m.id);
  if ('error' in m) { call.reject(new Error(m.error)); return; }
  const { status, body, type, headers } = m.res;
  const asJson = type === undefined && body !== undefined;
  const h = new Headers(headers);
  if (asJson) h.set('Content-Type', 'application/json');
  else if (type) h.set('Content-Type', type);
  call.resolve(new Response(status === 204 || body === undefined ? null : asJson ? JSON.stringify(body) : String(body), { status, headers: h }));
};

// First launch copies the card database into the phone's storage, which takes a few seconds: say so instead of showing nothing.
const splash = document.createElement('div');
splash.setAttribute('role', 'status');
splash.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;background:#0e0c1c;color:#ede8f8;font:16px system-ui,sans-serif;z-index:99999';
splash.textContent = 'Setting up your card database… (first launch only)';
document.addEventListener('DOMContentLoaded', () => { if (!settled) document.body.appendChild(splash); });
let settled = false;
void ready.then(() => { settled = true; splash.remove(); });

/**
 * Downloads for the worker. GitHub's release downloads redirect to a CDN that sends no CORS headers, so a web page can't fetch them;
 * the native Filesystem plugin isn't subject to CORS and streams to disk. The worker then reads the file back through the app's own
 * local file URL. (Outside the app there is no native side; the worker fetches directly.)
 */
const secrets = registerPlugin<{ get(o: { name: string }): Promise<{ value: string | null }>; set(o: { name: string; value: string }): Promise<void>; clear(o: { name: string }): Promise<void> }>('SecretStore');

const externalLink = registerPlugin<{ open(o: { url: string }): Promise<void> }>('ExternalLink');
/** The address Google's answer comes back to (see AndroidManifest.xml): the app's own scheme. */
const APP_LINK = 'io.github.itsdommie.grimoire://oauth';

/** Open the browser at `url` and wait for the link back into the app that carries `state` (links with another state are ignored). */
async function browserAuth(url: string, state: string): Promise<string> {
  let linked!: (link: string) => void;
  const back = new Promise<string>((resolve) => { linked = resolve; });
  // Listen first: the link can only come after the browser opens, but nothing may be missed.
  const listener = await App.addListener('appUrlOpen', (e) => {
    try { if (e.url.startsWith(APP_LINK) && new URL(e.url).searchParams.get('state') === state) linked(e.url); } catch { /* not a link we asked for */ }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const tooLong = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Signing in took too long, so it was cancelled. Try again.')), 5 * 60_000); });
    await externalLink.open({ url });
    return await Promise.race([back, tooLong]);
  } finally {
    clearTimeout(timer);
    await listener.remove();
  }
}

async function doNative(id: number, request: NativeRequest): Promise<void> {
  const reply = (result: NativeResult) => send({ nativeResult: { id, result } });
  try {
    if (request.op === 'secret-get') {
      const { value } = await secrets.get({ name: request.name });
      reply({ ok: true, ...(value ? { text: value } : {}) });
      return;
    }
    if (request.op === 'browser-auth') { reply({ ok: true, text: await browserAuth(request.url, request.state) }); return; }
    if (request.op === 'secret-set') { await secrets.set({ name: request.name, value: request.value }); reply({ ok: true }); return; }
    if (request.op === 'secret-clear') { await secrets.clear({ name: request.name }); reply({ ok: true }); return; }
    if (request.op === 'delete') {
      await Filesystem.deleteFile({ path: request.name, directory: Directory.Cache }).catch(() => {});
      reply({ ok: true });
      return;
    }
    const listener = await Filesystem.addListener('progress', (p) => { if (p.url === request.url) send({ nativeProgress: { id, received: p.bytes, total: p.contentLength } }); });
    try {
      await Filesystem.deleteFile({ path: request.name, directory: Directory.Cache }).catch(() => {});
      await Filesystem.downloadFile({ url: request.url, path: request.name, directory: Directory.Cache, progress: request.op === 'download' });
    } finally {
      await listener.remove();
    }
    if (request.op === 'text') {
      const file = await Filesystem.readFile({ path: request.name, directory: Directory.Cache, encoding: Encoding.UTF8 });
      await Filesystem.deleteFile({ path: request.name, directory: Directory.Cache }).catch(() => {});
      reply({ ok: true, text: String(file.data) });
    } else {
      const { uri } = await Filesystem.getUri({ path: request.name, directory: Directory.Cache });
      reply({ ok: true, url: Capacitor.convertFileSrc(uri) });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply({ ok: false, error: message, ...(/\b404\b/.test(message) ? { status: 404 } : {}) });
  }
}

/**
 * The hardware Back button. The app has no page history, so left alone it would leave the app from anywhere, even with a card, a dialog
 * or the scanner open. Instead the page is told (the web UI's back stack closes the topmost thing and cancels the event); the app only
 * leaves when nothing wanted it.
 */
if (Capacitor.isNativePlatform()) {
  void App.addListener('backButton', () => {
    const back = new CustomEvent('grimoire-back', { cancelable: true });
    window.dispatchEvent(back);
    if (!back.defaultPrevented) void App.exitApp();
  });
}

let dataBase: string | undefined;
try { dataBase = localStorage.getItem('grimoire.dataBase') ?? undefined; } catch { /* storage unavailable */ } // lets a test point updates at its own server
// Mobile data or a data saver: the app then only says an update is waiting instead of downloading it. (A test can force it either way.)
const connection = (navigator as unknown as { connection?: { type?: string; saveData?: boolean } }).connection;
let metered = !!connection && (connection.type === 'cellular' || connection.saveData === true);
try { const forced = localStorage.getItem('grimoire.metered'); if (forced !== null) metered = forced === '1'; } catch { /* storage unavailable */ }
let semanticBase: string | undefined, modelBase: string | undefined, advisorBase: string | undefined;
try { advisorBase = localStorage.getItem('grimoire.advisorBase') ?? undefined; } catch { /* storage unavailable */ }
try { semanticBase = localStorage.getItem('grimoire.semanticBase') ?? undefined; modelBase = localStorage.getItem('grimoire.modelBase') ?? undefined; } catch { /* storage unavailable */ }
send({ init: { dbUrl: new URL('grimoire.db', location.href).href, native: Capacitor.isNativePlatform(), dataBase, metered, semanticBase, modelBase, advisorBase } });

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
  await ready;
  if (fatal) throw new Error(fatal);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { query[k] = v; });
  return new Promise<Response>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, req: { method, path: url.pathname, query, body: typeof raw === 'string' && raw ? JSON.parse(raw) : undefined } });
  });
};

// The card scanner reads text with ML Kit through our own Capacitor plugin (TextRecognitionPlugin.java). The web UI only needs to
// know there is a recognizer, so it is offered on `window` and the UI shows the Scan button when it is there.
const mlkit = registerPlugin<{ recognize(options: { image: string }): Promise<OcrResult> }>('TextRecognition');
const textRecognition: TextRecognizer = { recognize: (image) => mlkit.recognize({ image }) };
// Only inside the app (a plain browser has no plugin), and never over a recognizer something else already provided (tests do).
// The app's own update check reads the version this build was made with, from the bundled.json that build.mjs writes.
const appUpdate = { check: async () => checkForAppUpdate(((await (await fetch(new URL('bundled.json', location.href))).json()) as { appVersion: string }).appVersion) };
if (Capacitor.isNativePlatform() && !window.grimoireNative) window.grimoireNative = { textRecognition, appUpdate };
