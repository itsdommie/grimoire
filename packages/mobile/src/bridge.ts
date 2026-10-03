import type { FromWorker, ToWorker } from './protocol.ts';

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
splash.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;background:#12131a;color:#e6e6ef;font:16px system-ui,sans-serif;z-index:99999';
splash.textContent = 'Setting up your card database… (first launch only)';
document.addEventListener('DOMContentLoaded', () => { if (!settled) document.body.appendChild(splash); });
let settled = false;
void ready.then(() => { settled = true; splash.remove(); });

send({ init: { dbUrl: new URL('grimoire.db', location.href).href } });

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
