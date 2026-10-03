import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { NodeDb } from './db.js';
import { DataManager } from './data.js';
import { SemanticIndex } from './semantic.js';
import { createRouter } from './routes.js';

export const TOKEN_HEADER = 'x-grimoire-token';
const TOKEN_PLACEHOLDER = '__GRIMOIRE_TOKEN__';

/** The UI only needs its own scripts/styles/API plus Scryfall card images (hotlinked). */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://cards.scryfall.io",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export interface ServerOptions {
  db: NodeDb;
  dataDir: string;
  /** Directory of the built web UI. When set, it is served at `/`. */
  webRoot?: string;
  /**
   * When set, every /api request must carry this token in the `x-grimoire-token` header and a loopback Host header.
   * It is injected into the served index.html, so only the app's own page can call the API (other websites
   * can't read it, and can't send the header cross-origin). Used by the desktop app.
   */
  token?: string;
  /** true/false, or a level and stream for file logging. */
  logger?: boolean | { level: string; stream: NodeJS.WritableStream };
  data?: DataManager;
  /** See DataManagerOptions.localFile / localRulings / localTags. */
  bulkFile?: string;
  rulingsFile?: string;
  tagsFile?: string;
  pricesFile?: string;
  rulesFile?: string;
  /** Semantic search index (defaults to one backed by the real model). Tests and the e2e server inject a fake embedder. */
  semantic?: SemanticIndex;
  /** Folder with ort.node.min.mjs and the .wasm files (shipped with the desktop app). */
  ortDir?: string;
}

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function buildServer(opts: ServerOptions) {
  const { db, dataDir, webRoot, token } = opts;
  const semantic = opts.semantic ?? new SemanticIndex({ db, dataDir, ortDir: opts.ortDir });
  const data = opts.data ?? new DataManager({ dataDir, db, localFile: opts.bulkFile, localRulings: opts.rulingsFile, localTags: opts.tagsFile, localPrices: opts.pricesFile, localRules: opts.rulesFile });
  // Collection CSVs and backups can be several MB (Fastify's default limit is 1 MB).
  const app = Fastify({ logger: opts.logger ?? process.env.NODE_ENV !== 'test', bodyLimit: 50 * 1024 * 1024 });

  if (!token) app.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });

  app.addHook('onRequest', async (req, reply) => {
    if (!token || !req.url.startsWith('/api/')) return;
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') return reply.code(403).send({ error: 'Forbidden' });
    const given = req.headers[TOKEN_HEADER];
    if (typeof given !== 'string' || !safeEqual(given, token)) return reply.code(401).send({ error: 'Unauthorized' });
  });

  // Every /api route lives in routes.ts so the Android app can share it; Fastify only adds HTTP around it.
  const router = createRouter({ db, data, semantic });
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/api/*',
    handler: async (req, reply) => {
      const res = await router({ method: req.method, path: req.url.split('?')[0]!, query: req.query as Record<string, string | undefined>, body: req.body });
      reply.code(res.status);
      for (const [k, v] of Object.entries(res.headers ?? {})) reply.header(k, v);
      if (res.type) reply.type(res.type);
      return reply.send(res.body);
    },
  });

  if (webRoot) {
    const indexHtml = readFileSync(resolve(webRoot, 'index.html'), 'utf8').replace(TOKEN_PLACEHOLDER, token ?? '');
    app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').header('Content-Security-Policy', CSP).send(indexHtml));
    app.register(fastifyStatic, { root: webRoot, index: false, wildcard: true });
  }

  return Object.assign(app, { data, semantic });
}
