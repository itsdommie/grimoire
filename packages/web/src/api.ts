import type { Board, CardDetail, CollectionImportResult, RestoreResult, CollectionSummary, CommanderIdea, DataStatus, DeckDetail, DeckSummary, ExportStyle, ImportResult, MissingReport, SearchResponse } from '@grimoire/shared';

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
  updateData: (force = false) => request<DataStatus>('POST', '/api/data/update', { force }),
  /** Search errors (bad syntax) come back as a 400 with a SearchResponse body; surface them as data. */
  async search(params: { q: string; order: string; limit: number }, signal: AbortSignal, scope: 'all' | 'collection' = 'all'): Promise<SearchResponse> {
    try {
      const path = scope === 'collection' ? '/api/collection' : '/api/cards/search';
      return await request<SearchResponse>('GET', `${path}?${new URLSearchParams({ q: params.q, order: params.order, limit: String(params.limit) })}`, undefined, signal);
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
  cardDetail: (id: string) => request<CardDetail>('GET', `/api/cards/${encodeURIComponent(id)}/detail`),
  collectionSummary: () => request<CollectionSummary>('GET', '/api/collection/summary'),
  importCollection: (text: string, mode: 'merge' | 'replace') => request<CollectionImportResult>('POST', '/api/collection/import', { text, mode }),
  setOwned: (cardId: string, qty: number) => request<CollectionSummary>('PUT', '/api/collection/cards', { cardId, qty }),
  clearCollection: () => request<void>('DELETE', '/api/collection'),
  commanderIdeas: () => request<CommanderIdea[]>('GET', '/api/collection/commanders'),
  deckMissing: (id: number) => request<MissingReport>('GET', `/api/decks/${id}/missing`),
  listDecks: () => request<DeckSummary[]>('GET', '/api/decks'),
  createDeck: (name: string) => request<DeckSummary>('POST', '/api/decks', { name }),
  getDeck: (id: number) => request<DeckDetail>('GET', `/api/decks/${id}`),
  renameDeck: (id: number, name: string) => request<DeckSummary>('PATCH', `/api/decks/${id}`, { name }),
  deleteDeck: (id: number) => request<void>('DELETE', `/api/decks/${id}`),
  setCard: (id: number, cardId: string, board: Board, qty: number) => request<DeckDetail>('PUT', `/api/decks/${id}/cards`, { cardId, board, qty }),
  importDeck: (text: string, opts: { name?: string; deckId?: number }) => request<ImportResult>('POST', '/api/decks/import', { text, ...opts }),
  async exportText(id: number, style: ExportStyle): Promise<string> {
    const res = await fetch(`/api/decks/${id}/export?style=${style}`, { headers: authHeaders() });
    if (!res.ok) throw new ApiError('Export failed', res.status, null);
    return res.text();
  },
};
