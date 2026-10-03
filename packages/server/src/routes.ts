import { NameIndex, SearchError, formatDeckList, readPrintingHints, semanticPhrases, type Board, type DataStatus, type ExportStyle, type Finish, type FormatId, type SemanticStatus } from '@grimoire/shared';
import type { Db } from './schema.js';
import { NOT_SET_UP } from './messages.js';
import { getCardByName, getCardDetail, getCardsByIds, searchCards, type Order } from './cards.js';
import { exportUserData, restoreUserData } from './backup.js';
import { getRuleDetail, rulesStatus, rulesToc, searchRules } from './rules.js';
import { addDeckToCollection, clearCollection, collectionSummary, commanderIdeas, deckMissing, importCollection, setOwned, setOwnedPrinting } from './collection.js';
import { identifyPrinting, listPrintings } from './printings.js';
import { getSet, listSets, type SetFilter } from './sets.js';
import { suggestForDeck } from './suggestions.js';
import { getPriceReport, snapshotPrices, type PriceScope } from './pricewatch.js';
import { getBanlist, listBanlistFormats } from './banlists.js';
import { clearWishlist, getWishlist, setWanted, wishMissing } from './wishlist.js';
import { Advisor, AdvisorError, keyFromEnvironment, type AdvisorOptions } from './advisor.js';
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

/** What the routes need from the card-data downloader and the semantic index. The desktop server and the Android app each supply their own. */
export interface DataService {
  status(): DataStatus;
  start(opts?: { force?: boolean; prices?: boolean; refreshPrices?: boolean }): void;
}
export interface SemanticService {
  isReady(): boolean;
  ensureLoaded(): void;
  embedQuery(text: string): Promise<Float32Array>;
  rank(queryVector: Float32Array, ids: readonly string[]): Array<{ id: string; score: number }>;
  status(): SemanticStatus;
  start(): void;
  cancel(): void;
  remove(): void;
}

export interface RouterDeps {
  db: Db; data: DataService; semantic: SemanticService;
  /** The optional Claude advisor. Without it the advisor routes say it isn't configured. */
  advisor?: Omit<AdvisorOptions, 'db' | 'rankerFor'>;
}

const ORDERS = new Set<Order>(['name', 'cmc', 'edhrec', 'usd']);

interface Call { params: Record<string, string>; query: Record<string, string | undefined>; body: any }
type Handler = (c: Call) => unknown | Promise<unknown>;
interface Route { method: string; segments: string[]; handler: Handler }

class Reply {
  constructor(readonly res: ApiResponse) {}
}
const reply = (status: number, body?: unknown, extra: { type?: string; headers?: Record<string, string> } = {}) => new Reply({ status, body, ...extra });

const num = (raw: string | undefined) => (raw ? Number(raw) : undefined);

/**
 * Every name a card goes by (its own, the faces of a double-faced card, and its aliases), prepared for matching OCR text. Built on
 * first use and rebuilt when the card pool or the aliases change size, which is what a data update does.
 */
function nameIndexFor(db: Db, cache: { key: string; index: NameIndex } | null): { key: string; index: NameIndex } {
  // A fingerprint of the names, not just how many there are: an update can swap cards and keep the total.
  const fp = db.prepare(`SELECT (SELECT count(*) || ':' || sum(length(name)) || ':' || sum(unicode(name)) || ':' || sum(unicode(substr(name, -1))) FROM cards) AS c,
    (SELECT count(*) || ':' || COALESCE(sum(length(alias)), 0) || ':' || COALESCE(sum(unicode(alias)), 0) FROM card_aliases) AS a`).get() as { c: string; a: string };
  const key = `${fp.c}|${fp.a}`;
  if (cache?.key === key) return cache;
  const names = [
    ...(db.prepare('SELECT id, name FROM cards').all() as Array<{ id: string; name: string }>),
    ...(db.prepare('SELECT a.card_id AS id, a.alias AS name FROM card_aliases a JOIN cards c ON c.id = a.card_id').all() as Array<{ id: string; name: string }>),
  ];
  return { key, index: new NameIndex(names) };
}

export function createRouter({ db, data, semantic, advisor: advisorOptions }: RouterDeps): (req: ApiRequest) => Promise<ApiResponse> {
  const routes: Route[] = [];
  // The app has just started (and any card update waiting for it has been applied): note the prices as they are now.
  try { snapshotPrices(db); } catch { /* price history is a nicety: never stop the app starting */ }
  let names: { key: string; index: NameIndex } | null = null;
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
  /**
   * Which cards do these lines of text name? The card scanner sends what it read off the title of a card. Returns the best match per
   * card, best first, with the card itself (and how many are owned) so the scanner can show it.
   */
  on('POST', '/api/cards/match', ({ body }) => {
    const lines = Array.isArray(body?.lines) ? (body.lines as unknown[]).filter((l): l is string => typeof l === 'string').slice(0, 40) : [];
    const minScore = typeof body?.minScore === 'number' ? Math.min(Math.max(body.minScore, 0.5), 1) : 0.75;
    names = nameIndexFor(db, names);
    const best = new Map<string, { id: string; score: number; line: string }>();
    for (const line of lines) {
      for (const m of names.index.match(line, 5, minScore)) {
        const cur = best.get(m.id);
        if (!cur || m.score > cur.score) best.set(m.id, { id: m.id, score: m.score, line });
      }
    }
    const top = [...best.values()].sort((a, b) => b.score - a.score).slice(0, 5);
    const cards = getCardsByIds(db, top.map((t) => t.id));
    return { candidates: top.flatMap((t) => { const card = cards.get(t.id); return card ? [{ card, score: Math.round(t.score * 1000) / 1000, line: t.line }] : []; }) };
  });
  /** Every printing of a card, newest first, with how many of each you own. */
  on('GET', '/api/cards/:id/printings', ({ params }) => ({ printings: listPrintings(db, params.id!) }));
  /**
   * Which printing is this card? The scanner sends the lines it read from the bottom of the card; the answer is the printing when the
   * set code and number settle it, otherwise the printings it could be, so the person can choose.
   */
  on('POST', '/api/cards/identify', ({ body }) => {
    const cardId = typeof body?.cardId === 'string' ? body.cardId : '';
    if (!cardId) throw new BadRequestError('cardId is required');
    const lines = Array.isArray(body?.lines) ? (body.lines as unknown[]).filter((l): l is string => typeof l === 'string').slice(0, 40) : [];
    return identifyPrinting(db, cardId, readPrintingHints(lines));
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
  /** Set how many copies you own of one printing in one finish (the card's total moves with it). */
  on('PUT', '/api/collection/printings', ({ body }) => {
    const { printingId, finish, qty, claim } = (body ?? {}) as { printingId: string; finish: Finish; qty: number; claim?: boolean };
    setOwnedPrinting(db, printingId, finish, qty, { claim: claim === true });
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

  // ------------------------------------------------------------- price watch
  on('GET', '/api/prices', ({ query }) => {
    snapshotPrices(db);
    return getPriceReport(db, { days: num(query.days), scope: query.scope === 'collection' || query.scope === 'wishlist' ? (query.scope as PriceScope) : 'all' });
  });

  // --------------------------------------------------------------- banlists
  on('GET', '/api/formats', () => ({ formats: listBanlistFormats(db) }));
  on('GET', '/api/formats/:id/banlist', ({ params }) => getBanlist(db, params.id!) ?? reply(404, { error: 'No banlist for that format' }));

  // --------------------------------------------------------------- wishlist
  on('GET', '/api/wishlist', () => getWishlist(db));
  on('PUT', '/api/wishlist', ({ body }) => {
    const { cardId, want } = (body ?? {}) as { cardId: string; want: number };
    setWanted(db, cardId, want);
    return getWishlist(db);
  });
  on('DELETE', '/api/wishlist', () => { clearWishlist(db); return reply(204); });
  on('GET', '/api/decks/:id/suggestions', ({ params, query }) => suggestForDeck(db, deckId(params.id), { spare: query.spare === '1' }));
  on('POST', '/api/decks/:id/wishlist-missing', ({ params, body }) => wishMissing(db, deckId(params.id), { excludeOtherDecks: body?.spare === true }));

  // ------------------------------------------------------------------ sets
  on('GET', '/api/sets', ({ query }) => ({ sets: listSets(db, query.q ?? '') }));
  on('GET', '/api/sets/:code', ({ params, query }) => getSet(db, params.code!, {
    filter: query.filter === 'owned' || query.filter === 'missing' || query.filter === 'nofoil' ? (query.filter as SetFilter) : 'all', limit: num(query.limit), offset: num(query.offset),
  }) ?? reply(404, { error: 'No such set' }));

  // --------------------------------------------------------------- advisor
  const advisor = new Advisor({ ...(advisorOptions ?? { keys: keyFromEnvironment(null) }), db, rankerFor: semanticFor });
  on('GET', '/api/advisor/status', () => advisor.status());
  on('PUT', '/api/advisor/key', ({ body }) => advisor.setKey(body?.key));
  on('DELETE', '/api/advisor/key', () => advisor.clearKey());
  on('PUT', '/api/advisor/model', ({ body }) => advisor.setModel(body?.model));
  on('POST', '/api/advisor/chat', ({ body }) => advisor.chat(body?.messages, { deckId: Number.isInteger(body?.deck) ? body.deck : undefined }));

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
      if (err instanceof AdvisorError) return { status: err.status, body: { error: err.message } };
      // The card pool is being replaced by a writer connection; writes must wait for it.
      if (err instanceof Error && /database is locked|SQLITE_BUSY/i.test(err.message)) return { status: 503, body: { error: 'Card data is updating. Try again in a moment.' } };
      throw err;
    }
  };
}
