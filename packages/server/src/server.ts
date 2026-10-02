import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { SearchError, formatDeckList, type Board, type ExportStyle } from '@grimoire/shared';
import type { Db } from './db.js';
import { DataManager } from './data.js';
import { getCardByName, searchCards, type Order } from './cards.js';
import { BadRequestError, NotFoundError, createDeck, deleteDeck, getDeck, importDeck, listDecks, renameDeck, setCardQty } from './decks.js';

const ORDERS = new Set<Order>(['name', 'cmc', 'edhrec', 'usd']);
export const TOKEN_HEADER = 'x-grimoire-token';
const TOKEN_PLACEHOLDER = '__GRIMOIRE_TOKEN__';

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
  logger?: boolean;
  data?: DataManager;
  /** See DataManagerOptions.localFile. */
  bulkFile?: string;
}

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function buildServer(opts: ServerOptions) {
  const { db, dataDir, webRoot, token } = opts;
  const data = opts.data ?? new DataManager({ dataDir, db, localFile: opts.bulkFile });
  const app = Fastify({ logger: opts.logger ?? process.env.NODE_ENV !== 'test' });

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
  app.post<{ Body: { force?: boolean } | undefined }>('/api/data/update', async (req, reply) => {
    data.start({ force: req.body?.force });
    return reply.code(202).send(data.status());
  });

  // ----------------------------------------------------------------- cards
  app.get<{ Querystring: { q?: string; order?: string; limit?: string; offset?: string } }>('/api/cards/search', async (req, reply) => {
    const { q = '', order, limit, offset } = req.query;
    try {
      return searchCards(db, {
        query: q,
        order: ORDERS.has(order as Order) ? (order as Order) : 'name',
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
    } catch (err) {
      if (err instanceof SearchError) return reply.code(400).send({ total: 0, cards: [], error: err.message });
      throw err;
    }
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
  app.post<{ Body: { name?: string } }>('/api/decks', async (req, reply) => reply.code(201).send(createDeck(db, req.body?.name ?? 'New deck')));
  app.get<{ Params: { id: string } }>('/api/decks/:id', async (req) => getDeck(db, deckId(req.params.id)));
  app.patch<{ Params: { id: string }; Body: { name?: string } }>('/api/decks/:id', async (req) => renameDeck(db, deckId(req.params.id), req.body?.name ?? ''));
  app.delete<{ Params: { id: string } }>('/api/decks/:id', async (req, reply) => { deleteDeck(db, deckId(req.params.id)); return reply.code(204).send(); });
  app.put<{ Params: { id: string }; Body: { cardId: string; board: Board; qty: number } }>('/api/decks/:id/cards', async (req) => {
    const { cardId, board, qty } = req.body ?? ({} as never);
    return setCardQty(db, deckId(req.params.id), cardId, board, qty);
  });
  app.post<{ Body: { text?: string; name?: string; deckId?: number } }>('/api/decks/import', async (req, reply) => {
    const { text = '', name, deckId: target } = req.body ?? {};
    return reply.code(201).send(importDeck(db, text, { name, deckId: target }));
  });
  app.get<{ Params: { id: string }; Querystring: { style?: string } }>('/api/decks/:id/export', async (req, reply) => {
    const { deck, entries } = getDeck(db, deckId(req.params.id));
    const style: ExportStyle = req.query.style === 'plain' ? 'plain' : 'sectioned';
    return reply.type('text/plain; charset=utf-8').header('Content-Disposition', `attachment; filename="${deck.name.replace(/[^\w.-]+/g, '_')}.txt"`).send(formatDeckList(entries, style));
  });

  // ------------------------------------------------------------- static UI
  if (webRoot) {
    const indexHtml = readFileSync(resolve(webRoot, 'index.html'), 'utf8').replace(TOKEN_PLACEHOLDER, token ?? '');
    app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(indexHtml));
    app.register(fastifyStatic, { root: webRoot, index: false, wildcard: true });
  }

  return Object.assign(app, { data });
}
