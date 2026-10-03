import type { BanlistFormat, BanlistReport, SetDetail, SetSummary, WishlistReport, AdvisorMessage, AdvisorReply, AdvisorStatus, AddToCollectionResult, CardMatchCandidate, Finish, PrintingIdentification, PrintingInfo, Board, CardDetail, FormatId, RuleDetail, RulesSearchResult, RulesStatus, RulesToc, SemanticStatus, CollectionImportResult, RestoreResult, CollectionSummary, CommanderIdea, DataStatus, DeckDetail, DeckSummary, ExportStyle, ImportResult, MissingReport, SearchResponse } from '@grimoire/shared';

/** The desktop app injects a per-launch token into index.html; the dev server leaves the placeholder, meaning "no token". */
function readToken(): string | null {
  const content = document.querySelector('meta[name="grimoire-token"]')?.getAttribute('content');
  return content && content !== '__GRIMOIRE_TOKEN__' ? content : null;
}
const token = typeof document === 'undefined' ? null : readToken();
const authHeaders = (): Record<string, string> => (token ? { 'x-grimoire-token': token } : {});

export async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    signal,
    headers: { ...authHeaders(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  let data: unknown = {};
  try {
    data = await res.json();
  } catch (err) {
    // An aborted request must stay an abort: swallowing it here would hand callers an empty object as if it were a result.
    if (signal?.aborted || (err as Error).name === 'AbortError') throw err;
  }
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status, data);
  return data as T;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) { super(message); }
}

export const api = {
  dataStatus: () => request<DataStatus>('GET', '/api/data/status'),
  setPrices: (enabled: boolean, refresh = false) => request<DataStatus>('POST', '/api/data/prices', { enabled, refresh }),
  updateData: (force = false) => request<DataStatus>('POST', '/api/data/update', { force }),
  /** Search errors (bad syntax) come back as a 400 with a SearchResponse body; surface them as data. */
  async search(params: { q: string; order: string; limit: number; deck?: number }, signal: AbortSignal, scope: 'all' | 'collection' = 'all'): Promise<SearchResponse> {
    try {
      const path = scope === 'collection' ? '/api/collection' : '/api/cards/search';
      return await request<SearchResponse>('GET', `${path}?${new URLSearchParams({ q: params.q, order: params.order, limit: String(params.limit), ...(params.deck !== undefined && scope === 'all' ? { deck: String(params.deck) } : {}) })}`, undefined, signal);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) return e.body as SearchResponse;
      throw e;
    }
  },
  async backupText(): Promise<string> {
    const res = await fetch('/api/backup', { headers: authHeaders() });
    if (!res.ok) throw new ApiError('Backup failed', res.status, null);
    return res.text();
  },
  restore: (data: unknown, mode: 'merge' | 'replace') => request<RestoreResult>('POST', '/api/backup/restore', { data, mode }),
  sets: (q = '') => request<{ sets: SetSummary[] }>('GET', `/api/sets?q=${encodeURIComponent(q)}`),
  set: (code: string, filter: 'all' | 'owned' | 'missing' | 'nofoil', limit: number, offset = 0, signal?: AbortSignal) => request<SetDetail>('GET', `/api/sets/${encodeURIComponent(code)}?filter=${filter}&limit=${limit}&offset=${offset}`, undefined, signal),
  advisorStatus: () => request<AdvisorStatus>('GET', '/api/advisor/status'),
  advisorSetKey: (key: string) => request<AdvisorStatus>('PUT', '/api/advisor/key', { key }),
  advisorClearKey: () => request<AdvisorStatus>('DELETE', '/api/advisor/key'),
  advisorSetModel: (model: string) => request<AdvisorStatus>('PUT', '/api/advisor/model', { model }),
  advisorChat: (messages: AdvisorMessage[], deck?: number, signal?: AbortSignal) => request<AdvisorReply>('POST', '/api/advisor/chat', { messages, deck }, signal),
  semanticStatus: () => request<SemanticStatus>('GET', '/api/semantic/status'),
  semanticEnable: () => request<SemanticStatus>('POST', '/api/semantic/enable'),
  semanticCancel: () => request<SemanticStatus>('POST', '/api/semantic/cancel'),
  semanticRemove: () => request<void>('DELETE', '/api/semantic'),
  rulesStatus: () => request<RulesStatus>('GET', '/api/rules/status'),
  rulesToc: () => request<RulesToc>('GET', '/api/rules/toc'),
  rulesSearch: (q: string, signal?: AbortSignal) => request<RulesSearchResult>('GET', `/api/rules/search?${new URLSearchParams({ q })}`, undefined, signal),
  rule: (id: string) => request<RuleDetail>('GET', `/api/rules/rule/${encodeURIComponent(id)}`),
  cardDetail: (id: string) => request<CardDetail>('GET', `/api/cards/${encodeURIComponent(id)}/detail`),
  /** Which cards do these lines of text name? (The scanner sends the title it read off a card.) */
  matchCards: (lines: string[]) => request<{ candidates: CardMatchCandidate[] }>('POST', '/api/cards/match', { lines }),
  /** Every printing of a card, newest first, with how many of each you own. */
  printings: (cardId: string) => request<{ printings: PrintingInfo[] }>('GET', `/api/cards/${encodeURIComponent(cardId)}/printings`),
  /** Which printing is this card, from the lines read off its bottom edge? */
  identifyPrinting: (cardId: string, lines: string[]) => request<PrintingIdentification>('POST', '/api/cards/identify', { cardId, lines }),
  /** Set how many of one printing and finish you own. `claim` uses up copies with no recorded printing before adding new ones. */
  banlistFormats: () => request<{ formats: BanlistFormat[] }>('GET', '/api/formats'),
  banlist: (format: string, signal?: AbortSignal) => request<BanlistReport>('GET', `/api/formats/${encodeURIComponent(format)}/banlist`, undefined, signal),
  wishlist: (signal?: AbortSignal) => request<WishlistReport>('GET', '/api/wishlist', undefined, signal),
  /** How many copies of a card you want in total; 0 takes it off. */
  setWanted: (cardId: string, want: number) => request<WishlistReport>('PUT', '/api/wishlist', { cardId, want }),
  clearWishlist: () => request<void>('DELETE', '/api/wishlist'),
  wishlistMissing: (deckId: number, spare = false) => request<{ added: number }>('POST', `/api/decks/${deckId}/wishlist-missing`, { spare }),
  setPrinting: (printingId: string, finish: Finish, qty: number, claim = false) => request<CollectionSummary>('PUT', '/api/collection/printings', { printingId, finish, qty, claim }),
  collectionSummary: () => request<CollectionSummary>('GET', '/api/collection/summary'),
  importCollection: (text: string, mode: 'merge' | 'replace') => request<CollectionImportResult>('POST', '/api/collection/import', { text, mode }),
  setOwned: (cardId: string, qty: number) => request<CollectionSummary>('PUT', '/api/collection/cards', { cardId, qty }),
  clearCollection: () => request<void>('DELETE', '/api/collection'),
  commanderIdeas: (spare = false) => request<CommanderIdea[]>('GET', `/api/collection/commanders${spare ? '?spare=1' : ''}`),
  deckMissing: (id: number, spare = false) => request<MissingReport>('GET', `/api/decks/${id}/missing${spare ? '?spare=1' : ''}`),
  addDeckToCollection: (id: number) => request<AddToCollectionResult>('POST', `/api/decks/${id}/add-to-collection`),
  listDecks: () => request<DeckSummary[]>('GET', '/api/decks'),
  createDeck: (name: string, format?: FormatId) => request<DeckSummary>('POST', '/api/decks', { name, format }),
  getDeck: (id: number) => request<DeckDetail>('GET', `/api/decks/${id}`),
  renameDeck: (id: number, name: string) => request<DeckSummary>('PATCH', `/api/decks/${id}`, { name }),
  updateDeck: (id: number, changes: { name?: string; format?: FormatId }) => request<DeckSummary>('PATCH', `/api/decks/${id}`, changes),
  deleteDeck: (id: number) => request<void>('DELETE', `/api/decks/${id}`),
  /** `move` relocates the card (removing it from other boards) instead of adding a stack on this one. */
  setCard: (id: number, cardId: string, board: Board, qty: number, move = false) => request<DeckDetail>('PUT', `/api/decks/${id}/cards`, { cardId, board, qty, move }),
  importDeck: (text: string, opts: { name?: string; deckId?: number; format?: FormatId; addToCollection?: boolean }) => request<ImportResult>('POST', '/api/decks/import', { text, ...opts }),
  async exportText(id: number, style: ExportStyle): Promise<string> {
    const res = await fetch(`/api/decks/${id}/export?style=${style}`, { headers: authHeaders() });
    if (!res.ok) throw new ApiError('Export failed', res.status, null);
    return res.text();
  },
};
