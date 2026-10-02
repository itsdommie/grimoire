import type { Board, DataStatus, DeckDetail, DeckSummary, ExportStyle, ImportResult, SearchResponse } from '@grimoire/shared';

/** The desktop app injects a per-launch token into index.html; the dev server leaves the placeholder, meaning "no token". */
function readToken(): string | null {
  const content = document.querySelector('meta[name="grimoire-token"]')?.getAttribute('content');
  return content && content !== '__GRIMOIRE_TOKEN__' ? content : null;
}
const token = readToken();
const authHeaders = (): Record<string, string> => (token ? { 'x-grimoire-token': token } : {});

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    signal,
    headers: { ...authHeaders(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
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
  async search(params: { q: string; order: string; limit: number }, signal: AbortSignal): Promise<SearchResponse> {
    try {
      return await request<SearchResponse>('GET', `/api/cards/search?${new URLSearchParams({ q: params.q, order: params.order, limit: String(params.limit) })}`, undefined, signal);
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) return e.body as SearchResponse;
      throw e;
    }
  },
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
