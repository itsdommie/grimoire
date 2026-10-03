import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type NodeDb as Db } from './db.js';
import { loadJsonl } from './ingest.js';
import { createRouter } from './routes.js';
import { getCardByName } from './cards.js';
import { setOwned } from './collection.js';
import { getBanlist, listBanlistFormats } from './banlists.js';
import { sfCard } from './testutil.js';

const FIXTURE = [
  sfCard({ name: 'Mana Drain', type_line: 'Instant', legalities: { vintage: 'legal', legacy: 'legal', modern: 'not_legal' } }),
  sfCard({ name: 'Ancestral Recall', type_line: 'Instant', legalities: { vintage: 'restricted', legacy: 'banned', modern: 'not_legal', commander: 'banned' } }),
  sfCard({ name: 'Hullbreacher', type_line: 'Creature — Merfolk', legalities: { modern: 'banned', legacy: 'banned', commander: 'banned', vintage: 'legal' } }),
  sfCard({ name: 'Sol Ring', type_line: 'Artifact', legalities: { commander: 'legal', vintage: 'restricted', modern: 'not_legal' } }),
  sfCard({ name: 'Odd Card', type_line: 'Sorcery', legalities: { future: 'banned', modern: 'legal' } }), // a format with no page
];
let db: Db;
beforeEach(async () => {
  db = openDb(':memory:');
  await loadJsonl(db, (async function* () { for (const c of FIXTURE) yield JSON.stringify(c); })());
});

describe('banlists', () => {
  it('lists the formats that have something banned or restricted, with how many, in a fixed order', () => {
    expect(listBanlistFormats(db)).toEqual([
      { id: 'modern', label: 'Modern', banned: 1, restricted: 0 },
      { id: 'legacy', label: 'Legacy', banned: 2, restricted: 0 },
      { id: 'vintage', label: 'Vintage', banned: 0, restricted: 2 },
      { id: 'commander', label: 'Commander', banned: 2, restricted: 0 },
    ]); // (not "future", which nobody looks up)
  });

  it('gives a format\'s banned and restricted cards by name, with what you own', () => {
    setOwned(db, getCardByName(db, 'Hullbreacher')!.id, 2);
    const modern = getBanlist(db, 'modern')!;
    expect(modern.format).toEqual({ id: 'modern', label: 'Modern', banned: 1, restricted: 0 });
    expect(modern.banned.map((c) => [c.name, c.owned ?? 0])).toEqual([['Hullbreacher', 2]]);
    expect(modern.restricted).toEqual([]);

    const vintage = getBanlist(db, 'vintage')!;
    expect(vintage.banned).toEqual([]);
    expect(vintage.restricted.map((c) => c.name)).toEqual(['Ancestral Recall', 'Sol Ring']);
    expect(getBanlist(db, 'legacy')!.banned.map((c) => c.name)).toEqual(['Ancestral Recall', 'Hullbreacher']);
  });

  it('has no page for a format it does not offer, and the routes say so', async () => {
    expect(getBanlist(db, 'future')).toBeNull();
    expect(getBanlist(db, 'nonsense')).toBeNull();
    const r = createRouter({ db, data: {} as never, semantic: {} as never });
    expect(((await r({ method: 'GET', path: '/api/formats' })).body as { formats: unknown[] }).formats).toHaveLength(4);
    expect((await r({ method: 'GET', path: '/api/formats/modern/banlist' })).status).toBe(200);
    expect((await r({ method: 'GET', path: '/api/formats/future/banlist' })).status).toBe(404);
  });
});
