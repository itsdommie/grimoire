import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { SearchError, formatDeckList, semanticPhrases, type Board, type ExportStyle, type FormatId } from '@grimoire/shared';
import type { Db } from './db.js';
import { DataManager } from './data.js';
import { NOT_SET_UP, SemanticIndex } from './semantic.js';
import { getCardByName, getCardDetail, searchCards, type Order } from './cards.js';
import { exportUserData, restoreUserData } from './backup.js';
import { getRuleDetail, rulesStatus, rulesToc, searchRules } from './rules.js';
import { addDeckToCollection, clearCollection, collectionSummary, commanderIdeas, deckMissing, importCollection, setOwned } from './collection.js';
import { BadRequestError, NotFoundError, createDeck, deleteDeck, getDeck, importDeck, listDecks, setCardQty, updateDeck } from './decks.js';

const ORDERS = new Set<Order>(['name', 'cmc', 'edhrec', 'usd']);
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
  db: Db;
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

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof BadRequestError) return reply.code(400).send({ error: err.message });
    // The card pool is being replaced by a writer connection; writes must wait for it.
    if (/database is locked|SQLITE_BUSY/i.test(err.message)) return reply.code(503).send({ error: 'Card data is updating. Try again in a moment.' });
    reply.send(err);
  });

  // ------------------------------------------------------------------ data
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/data/status', async () => data.status());
  /** Turn cheapest-printing prices on (downloads ~79 MB) or off. */
  app.post<{ Body: { enabled?: boolean; refresh?: boolean } }>('/api/data/prices', async (req, reply) => {
    data.start({ prices: req.body?.enabled !== false, refreshPrices: req.body?.refresh === true });
    return reply.code(202).send(data.status());
  });
  app.post<{ Body: { force?: boolean } | undefined }>('/api/data/update', async (req, reply) => {
    data.start({ force: req.body?.force });
    return reply.code(202).send(data.status());
  });

  // ----------------------------------------------------------------- cards
  /** For `about:"…"` queries: embed the phrase (the index must be set up) so searchCards can rank by it. */
  const semanticFor = async (q: string) => {
    const phrase = semanticPhrases(q)[0];
    if (!phrase) return undefined;
    if (!semantic.isReady()) { semantic.ensureLoaded(); if (!semantic.isReady()) throw new SearchError(NOT_SET_UP); }
    const vector = await semantic.embedQuery(phrase.text);
    return { rank: (ids: readonly string[]) => semantic.rank(vector, ids) };
  };

  app.get<{ Querystring: { q?: string; order?: string; limit?: string; offset?: string; deck?: string } }>('/api/cards/search', async (req, reply) => {
    const { q = '', order, limit, offset, deck } = req.query;
    try {
      return searchCards(db, {
        query: q,
        excludeDeck: deck !== undefined && Number.isInteger(Number(deck)) ? Number(deck) : undefined,
        order: ORDERS.has(order as Order) ? (order as Order) : 'name',
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
        semantic: await semanticFor(q),
      });
    } catch (err) {
      if (err instanceof SearchError) return reply.code(400).send({ total: 0, cards: [], error: err.message });
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/api/cards/:id/detail', async (req, reply) => {
    const detail = getCardDetail(db, req.params.id);
    return detail ?? reply.code(404).send({ error: 'Card not found' });
  });

  app.get<{ Params: { name: string } }>('/api/cards/by-name/:name', async (req, reply) => {
    const card = getCardByName(db, req.params.name);
    return card ?? reply.code(404).send({ error: 'Card not found' });
  });

  // ----------------------------------------------------------------- decks
  const deckId = (raw: string) => {
    const id = Number(raw);
    if (!Number.isInteger(id)) throw new BadRequestError('Invalid deck id');
    return id;
  };

  app.get('/api/decks', async () => listDecks(db));
  app.post<{ Body: { name?: string; format?: string } }>('/api/decks', async (req, reply) => reply.code(201).send(createDeck(db, req.body?.name ?? 'New deck', (req.body?.format ?? 'commander') as FormatId)));
  app.get<{ Params: { id: string } }>('/api/decks/:id', async (req) => getDeck(db, deckId(req.params.id)));
  app.patch<{ Params: { id: string }; Body: { name?: string; format?: string } }>('/api/decks/:id', async (req) => updateDeck(db, deckId(req.params.id), { name: req.body?.name, format: req.body?.format }));
  app.delete<{ Params: { id: string } }>('/api/decks/:id', async (req, reply) => { deleteDeck(db, deckId(req.params.id)); return reply.code(204).send(); });
  app.put<{ Params: { id: string }; Body: { cardId: string; board: Board; qty: number; move?: boolean } }>('/api/decks/:id/cards', async (req) => {
    const { cardId, board, qty, move } = req.body ?? ({} as never);
    return setCardQty(db, deckId(req.params.id), cardId, board, qty, { move: move === true });
  });
  app.post<{ Body: { text?: string; name?: string; deckId?: number; format?: string; addToCollection?: boolean } }>('/api/decks/import', async (req, reply) => {
    const { text = '', name, deckId: target, format, addToCollection } = req.body ?? {};
    const imported = importDeck(db, text, { name, deckId: target, format });
    // A separate step after the import: the deck exists either way, and only ever adds to the collection.
    const collection = addToCollection === true ? addDeckToCollection(db, imported.deck.id) : undefined;
    return reply.code(201).send({ ...imported, ...(collection ? { addedToCollection: collection } : {}) });
  });
  app.post<{ Params: { id: string } }>('/api/decks/:id/add-to-collection', async (req) => addDeckToCollection(db, deckId(req.params.id)));
  app.get<{ Params: { id: string }; Querystring: { style?: string } }>('/api/decks/:id/export', async (req, reply) => {
    const { deck, entries } = getDeck(db, deckId(req.params.id));
    const style: ExportStyle = req.query.style === 'plain' ? 'plain' : 'sectioned';
    return reply.type('text/plain; charset=utf-8').header('Content-Disposition', `attachment; filename="${deck.name.replace(/[^\w.-]+/g, '_')}.txt"`).send(formatDeckList(entries, style));
  });

  // ------------------------------------------------------------ collection
  app.get('/api/collection/summary', async () => collectionSummary(db));
  app.get<{ Querystring: { q?: string; order?: string; limit?: string; offset?: string } }>('/api/collection', async (req, reply) => {
    const { q = '', order, limit, offset } = req.query;
    try {
      return searchCards(db, { query: `${q} owned>0`, order: ORDERS.has(order as Order) ? (order as Order) : 'name', limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined, semantic: await semanticFor(q) });
    } catch (err) {
      if (err instanceof SearchError) return reply.code(400).send({ total: 0, cards: [], error: err.message });
      throw err;
    }
  });
  app.post<{ Body: { text?: string; mode?: string } }>('/api/collection/import', async (req, reply) => {
    const { text = '', mode } = req.body ?? {};
    return reply.code(201).send(importCollection(db, text, mode === 'replace' ? 'replace' : 'merge'));
  });
  app.put<{ Body: { cardId: string; qty: number } }>('/api/collection/cards', async (req) => {
    const { cardId, qty } = req.body ?? ({} as never);
    setOwned(db, cardId, qty);
    return collectionSummary(db);
  });
  app.delete('/api/collection', async (_req, reply) => { clearCollection(db); return reply.code(204).send(); });
  app.get<{ Querystring: { spare?: string } }>('/api/collection/commanders', async (req) => commanderIdeas(db, 24, req.query.spare === '1'));
  app.get<{ Params: { id: string }; Querystring: { spare?: string } }>('/api/decks/:id/missing', async (req) => deckMissing(db, deckId(req.params.id), { excludeOtherDecks: req.query.spare === '1' }));

  // ----------------------------------------------------------------- rules
  app.get('/api/rules/status', async () => rulesStatus(db));
  app.get('/api/rules/toc', async () => rulesToc(db));
  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/rules/search', async (req) => searchRules(db, req.query.q ?? '', Math.min(Math.max(Number(req.query.limit) || 40, 1), 100)));
  app.get<{ Params: { id: string } }>('/api/rules/rule/:id', async (req, reply) => getRuleDetail(db, req.params.id.toLowerCase()) ?? reply.code(404).send({ error: 'No such rule' }));

  // -------------------------------------------------------------- semantic
  app.get('/api/semantic/status', async () => semantic.status());
  app.post('/api/semantic/enable', async (_req, reply) => { semantic.start(); return reply.code(202).send(semantic.status()); });
  app.post('/api/semantic/cancel', async () => { semantic.cancel(); return semantic.status(); });
  app.delete('/api/semantic', async (_req, reply) => { semantic.remove(); return reply.code(204).send(); });

  // ----------------------------------------------------------------- backup
  app.get('/api/backup', async (_req, reply) => {
    const stamp = new Date().toISOString().slice(0, 10);
    return reply.type('application/json; charset=utf-8').header('Content-Disposition', `attachment; filename="grimoire-backup-${stamp}.json"`).send(JSON.stringify(exportUserData(db), null, 1));
  });
  app.post<{ Body: { data?: unknown; mode?: string } }>('/api/backup/restore', async (req, reply) => {
    return reply.code(201).send(restoreUserData(db, req.body?.data, req.body?.mode === 'replace' ? 'replace' : 'merge'));
  });

  // ------------------------------------------------------------- static UI
  if (webRoot) {
    const indexHtml = readFileSync(resolve(webRoot, 'index.html'), 'utf8').replace(TOKEN_PLACEHOLDER, token ?? '');
    app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').header('Content-Security-Policy', CSP).send(indexHtml));
    app.register(fastifyStatic, { root: webRoot, index: false, wildcard: true });
  }

  return Object.assign(app, { data, semantic });
}
