import type { Board, DeckDetail, DeckSummary, ExportStyle, ImportResult } from '@grimoire/shared';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  listDecks: () => request<DeckSummary[]>('GET', '/api/decks'),
  createDeck: (name: string) => request<DeckSummary>('POST', '/api/decks', { name }),
  getDeck: (id: number) => request<DeckDetail>('GET', `/api/decks/${id}`),
  renameDeck: (id: number, name: string) => request<DeckSummary>('PATCH', `/api/decks/${id}`, { name }),
  deleteDeck: (id: number) => request<void>('DELETE', `/api/decks/${id}`),
  setCard: (id: number, cardId: string, board: Board, qty: number) => request<DeckDetail>('PUT', `/api/decks/${id}/cards`, { cardId, board, qty }),
  importDeck: (text: string, opts: { name?: string; deckId?: number }) => request<ImportResult>('POST', '/api/decks/import', { text, ...opts }),
  exportText: async (id: number, style: ExportStyle) => (await fetch(`/api/decks/${id}/export?style=${style}`)).text(),
  exportUrl: (id: number, style: ExportStyle) => `/api/decks/${id}/export?style=${style}`,
};
