import { SearchError, formatDeckList, semanticPhrases, type Board, type ExportStyle, type FormatId } from '@grimoire/shared';
import type { Db } from './db.js';
import type { DataManager } from './data.js';
import type { SemanticIndex } from './semantic.js';
import { NOT_SET_UP } from './messages.js';
import { getCardByName, getCardDetail, searchCards, type Order } from './cards.js';
import { exportUserData, restoreUserData } from './backup.js';
import { getRuleDetail, rulesStatus, rulesToc, searchRules } from './rules.js';
import { addDeckToCollection, clearCollection, collectionSummary, commanderIdeas, deckMissing, importCollection, setOwned } from './collection.js';
import { BadRequestError, NotFoundError, createDeck, deleteDeck, getDeck, importDeck, listDecks, setCardQty, updateDeck } from './decks.js';

/**
 * The app's API as plain functions of (method, path, query, body). Fastify serves it for the desktop app and the Android app calls
 * it in-process, so both platforms share every route, status code and error message. Nothing here may use a Node-only module.
 */
export interface ApiRequest {
  method: string;
  /** Path without the query string, e.g. `/api/decks/3`. */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  /** Serialised as JSON unless `type` is set, in which case it is a string sent as is. */
  body?: unknown;
  type?: string;
  headers?: Record<string, string>;
}

/** What the routes need from the card-data downloader and the semantic index (the Android app supplies its own). */
export type DataService = Pick<DataManager, 'status' | 'start'>;
export type SemanticService = Pick<SemanticIndex, 'isReady' | 'ensureLoaded' | 'embedQuery' | 'rank' | 'status' | 'start' | 'cancel' | 'remove'>;

export interface RouterDeps { db: Db; data: DataService; semantic: SemanticService }

const ORDERS = new Set<Order>(['name', 'cmc', 'edhrec', 'usd']);

interface Call { params: Record<string, string>; query: Record<string, string | undefined>; body: any }
type Handler = (c: Call) => unknown | Promise<unknown>;
interface Route { method: string; segments: string[]; handler: Handler }

class Reply {
  constructor(readonly res: ApiResponse) {}
}
const reply = (status: number, body?: unknown, extra: { type?: string; headers?: Record<string, string> } = {}) => new Reply({ status, body, ...extra });

const num = (raw: string | undefined) => (raw ? Number(raw) : undefined);

export function createRouter({ db, data, semantic }: RouterDeps): (req: ApiRequest) => Promise<ApiResponse> {
  const routes: Route[] = [];
  const on = (method: string, pattern: string, handler: Handler) => routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });

  const deckId = (raw: string | undefined) => {
    const id = Number(raw);
    if (!Number.isInteger(id)) throw new BadRequestError('Invalid deck id');
    return id;
  };

  /** For `about:"…"` queries: embed the phrase (the index must be set up) so searchCards can rank by it. */
  const semanticFor = async (q: string) => {
    const phrase = semanticPhrases(q)[0];
    if (!phrase) return undefined;
    if (!semantic.isReady()) { semantic.ensureLoaded(); if (!semantic.isReady()) throw new SearchError(NOT_SET_UP); }
    const vector = await semantic.embedQuery(phrase.text);
    return { rank: (ids: readonly string[]) => semantic.rank(vector, ids) };
  };

  /** Search errors (bad syntax) are a 400 carrying an empty SearchResponse, so the UI can show the message in place. */
  const runSearch = async (query: string, q: string, c: Call, extra: { excludeDeck?: number } = {}) => {
    try {
      return await searchCards(db, {
        query, ...extra,
        order: ORDERS.has(c.query.order as Order) ? (c.query.order as Order) : 'name',
        limit: num(c.query.limit),
        offset: num(c.query.offset),
        semantic: await semanticFor(q),
      });
    } catch (err) {
      if (err instanceof SearchError) return reply(400, { total: 0, cards: [], error: err.message });
      throw err;
    }
  };

  // ------------------------------------------------------------------ data
  on('GET', '/api/health', () => ({ ok: true }));
  on('GET', '/api/data/status', () => data.status());
  /** Turn cheapest-printing prices on (downloads ~79 MB) or off. */
  on('POST', '/api/data/prices', ({ body }) => { data.start({ prices: body?.enabled !== false, refreshPrices: body?.refresh === true }); return reply(202, data.status()); });
  on('POST', '/api/data/update', ({ body }) => { data.start({ force: body?.force }); return reply(202, data.status()); });

  // ----------------------------------------------------------------- cards
  on('GET', '/api/cards/search', (c) => {
    const { q = '', deck } = c.query;
    return runSearch(q, q, c, { excludeDeck: deck !== undefined && Number.isInteger(Number(deck)) ? Number(deck) : undefined });
  });
  on('GET', '/api/cards/:id/detail', ({ params }) => getCardDetail(db, params.id!) ?? reply(404, { error: 'Card not found' }));
  on('GET', '/api/cards/by-name/:name', ({ params }) => getCardByName(db, params.name!) ?? reply(404, { error: 'Card not found' }));

  // ----------------------------------------------------------------- decks
  on('GET', '/api/decks', () => listDecks(db));
  on('POST', '/api/decks', ({ body }) => reply(201, createDeck(db, body?.name ?? 'New deck', (body?.format ?? 'commander') as FormatId)));
  on('POST', '/api/decks/import', ({ body }) => {
    const { text = '', name, deckId: target, format, addToCollection } = body ?? {};
    const imported = importDeck(db, text, { name, deckId: target, format });
    // A separate step after the import: the deck exists either way, and only ever adds to the collection.
    const collection = addToCollection === true ? addDeckToCollection(db, imported.deck.id) : undefined;
    return reply(201, { ...imported, ...(collection ? { addedToCollection: collection } : {}) });
  });
  on('GET', '/api/decks/:id', ({ params }) => getDeck(db, deckId(params.id)));
  on('PATCH', '/api/decks/:id', ({ params, body }) => updateDeck(db, deckId(params.id), { name: body?.name, format: body?.format }));
  on('DELETE', '/api/decks/:id', ({ params }) => { deleteDeck(db, deckId(params.id)); return reply(204); });
  on('PUT', '/api/decks/:id/cards', ({ params, body }) => {
    const { cardId, board, qty, move } = (body ?? {}) as { cardId: string; board: Board; qty: number; move?: boolean };
    return setCardQty(db, deckId(params.id), cardId, board, qty, { move: move === true });
  });
  on('POST', '/api/decks/:id/add-to-collection', ({ params }) => addDeckToCollection(db, deckId(params.id)));
  on('GET', '/api/decks/:id/export', ({ params, query }) => {
    const { deck, entries } = getDeck(db, deckId(params.id));
    const style: ExportStyle = query.style === 'plain' ? 'plain' : 'sectioned';
    return reply(200, formatDeckList(entries, style), { type: 'text/plain; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="${deck.name.replace(/[^\w.-]+/g, '_')}.txt"` } });
  });
  on('GET', '/api/decks/:id/missing', ({ params, query }) => deckMissing(db, deckId(params.id), { excludeOtherDecks: query.spare === '1' }));

  // ------------------------------------------------------------ collection
  on('GET', '/api/collection/summary', () => collectionSummary(db));
  on('GET', '/api/collection', (c) => { const q = c.query.q ?? ''; return runSearch(`${q} owned>0`, q, c); });
  on('POST', '/api/collection/import', ({ body }) => reply(201, importCollection(db, body?.text ?? '', body?.mode === 'replace' ? 'replace' : 'merge')));
  on('PUT', '/api/collection/cards', ({ body }) => {
    const { cardId, qty } = (body ?? {}) as { cardId: string; qty: number };
    setOwned(db, cardId, qty);
    return collectionSummary(db);
  });
  on('DELETE', '/api/collection', () => { clearCollection(db); return reply(204); });
  on('GET', '/api/collection/commanders', ({ query }) => commanderIdeas(db, 24, query.spare === '1'));

  // ----------------------------------------------------------------- rules
  on('GET', '/api/rules/status', () => rulesStatus(db));
  on('GET', '/api/rules/toc', () => rulesToc(db));
  on('GET', '/api/rules/search', ({ query }) => searchRules(db, query.q ?? '', Math.min(Math.max(Number(query.limit) || 40, 1), 100)));
  on('GET', '/api/rules/rule/:id', ({ params }) => getRuleDetail(db, params.id!.toLowerCase()) ?? reply(404, { error: 'No such rule' }));

  // -------------------------------------------------------------- semantic
  on('GET', '/api/semantic/status', () => semantic.status());
  on('POST', '/api/semantic/enable', () => { semantic.start(); return reply(202, semantic.status()); });
  on('POST', '/api/semantic/cancel', () => { semantic.cancel(); return semantic.status(); });
  on('DELETE', '/api/semantic', () => { semantic.remove(); return reply(204); });

  // ----------------------------------------------------------------- backup
  on('GET', '/api/backup', () => {
    const stamp = new Date().toISOString().slice(0, 10);
    return reply(200, JSON.stringify(exportUserData(db), null, 1), { type: 'application/json; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="grimoire-backup-${stamp}.json"` } });
  });
  on('POST', '/api/backup/restore', ({ body }) => reply(201, restoreUserData(db, body?.data, body?.mode === 'replace' ? 'replace' : 'merge')));

  const find = (method: string, path: string): { route: Route; params: Record<string, string> } | null => {
    const parts = path.split('/').filter(Boolean);
    for (const route of routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      route.segments.forEach((seg, i) => {
        if (seg.startsWith(':')) { try { params[seg.slice(1)] = decodeURIComponent(parts[i]!); } catch { ok = false; } } else if (seg !== parts[i]) ok = false;
      });
      if (ok) return { route, params };
    }
    return null;
  };

  return async (req) => {
    const hit = find(req.method.toUpperCase(), req.path);
    if (!hit) return { status: 404, body: { error: 'Not found' } };
    try {
      const out = await hit.route.handler({ params: hit.params, query: req.query ?? {}, body: req.body });
      return out instanceof Reply ? out.res : { status: 200, body: out };
    } catch (err) {
      if (err instanceof NotFoundError) return { status: 404, body: { error: err.message } };
      if (err instanceof BadRequestError) return { status: 400, body: { error: err.message } };
      // The card pool is being replaced by a writer connection; writes must wait for it.
      if (err instanceof Error && /database is locked|SQLITE_BUSY/i.test(err.message)) return { status: 503, body: { error: 'Card data is updating. Try again in a moment.' } };
      throw err;
    }
  };
}
