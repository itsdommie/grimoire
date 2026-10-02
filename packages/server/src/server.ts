import Fastify from 'fastify';
import cors from '@fastify/cors';
import { SearchError, formatDeckList, type Board, type ExportStyle } from '@grimoire/shared';
import { openDb } from './db.js';
import { getCardByName, searchCards, type Order } from './cards.js';
import { BadRequestError, NotFoundError, createDeck, deleteDeck, getDeck, importDeck, listDecks, renameDeck, setCardQty } from './decks.js';

const ORDERS = new Set<Order>(['name', 'cmc', 'edhrec', 'usd']);

export function buildServer(db = openDb()) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  app.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof BadRequestError) return reply.code(400).send({ error: err.message });
    reply.send(err);
  });

  app.get('/api/health', async () => {
    const meta = Object.fromEntries((db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>).map((m) => [m.key, m.value]));
    return { ok: true, ...meta };
  });

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

  // ------------------------------------------------------------------ decks
  // ------------------------------------------------------------------ decks
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

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3001);
  buildServer().listen({ port, host: '127.0.0.1' }).catch((err) => { console.error(err); process.exit(1); });
}
