import Fastify from 'fastify';
import cors from '@fastify/cors';
import { SearchError } from '@grimoire/shared';
import { openDb } from './db.js';
import { getCardByName, searchCards, type Order } from './cards.js';

const ORDERS = new Set<Order>(['name', 'cmc', 'edhrec', 'usd']);

export function buildServer(db = openDb()) {
  const app = Fastify({ logger: true });
  app.register(cors, { origin: true });

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

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3001);
  buildServer().listen({ port, host: '127.0.0.1' }).catch((err) => { console.error(err); process.exit(1); });
}
