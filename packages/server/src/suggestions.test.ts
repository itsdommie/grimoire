import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type NodeDb as Db } from './db.js';
import { loadJsonl } from './ingest.js';
import { createRouter } from './routes.js';
import { getCardByName } from './cards.js';
import { setOwned } from './collection.js';
import { createDeck, setCardQty } from './decks.js';
import { suggestForDeck } from './suggestions.js';
import { sfCard } from './testutil.js';

const G = { colors: ['G'], color_identity: ['G'] };
const FIXTURE = [
  sfCard({ name: 'Green Cmdr', type_line: 'Legendary Creature — Elf', ...G }),
  sfCard({ name: 'Sol Ring', type_line: 'Artifact', oracle_text: '{T}: Add {C}{C}.', edhrec_rank: 1 }),
  sfCard({ name: 'Cultivate', type_line: 'Sorcery', oracle_text: 'Search your library for up to two basic land cards, put one onto the battlefield tapped and the other into your hand, then shuffle.', ...G, edhrec_rank: 5 }),
  sfCard({ name: 'Rampant Growth', type_line: 'Sorcery', oracle_text: 'Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.', ...G, edhrec_rank: 40 }),
  sfCard({ name: 'Swords to Plowshares', type_line: 'Instant', oracle_text: 'Exile target creature. Its controller gains life equal to its power.', colors: ['W'], color_identity: ['W'] }), // off-colour
  sfCard({ name: 'Beast Within', type_line: 'Instant', oracle_text: 'Destroy target permanent. Its controller creates a 3/3 green Beast creature token.', ...G }),
  sfCard({ name: 'Banned Ramp', type_line: 'Artifact', oracle_text: '{T}: Add {C}{C}{C}.', legalities: { commander: 'banned' } }),
  sfCard({ name: 'Unowned Ramp', type_line: 'Artifact', oracle_text: '{T}: Add {C}.' }),
  sfCard({ name: 'Forest', type_line: 'Basic Land — Forest', ...G, legalities: { commander: 'legal', modern: 'legal' } }),
  sfCard({ name: 'Llanowar Elves', type_line: 'Creature — Elf Druid', oracle_text: '{T}: Add {G}.', mana_cost: '{G}', cmc: 1, ...G, legalities: { commander: 'legal', modern: 'legal' } }),
  sfCard({ name: 'Elvish Mystic', type_line: 'Creature — Elf Druid', oracle_text: '{T}: Add {G}.', mana_cost: '{G}', cmc: 1, ...G, legalities: { commander: 'legal', modern: 'legal' } }),
  sfCard({ name: 'Lightning Bolt', type_line: 'Instant', oracle_text: 'Lightning Bolt deals 3 damage to any target.', colors: ['R'], color_identity: ['R'], legalities: { commander: 'legal', modern: 'legal' } }),
];
let db: Db;
const id = (name: string) => getCardByName(db, name)!.id;
const names = (s: ReturnType<typeof suggestForDeck>, role: string) => s.roles.find((r) => r.role === role)?.cards.map((c) => c.name);

function commanderDeck(): number {
  const d = createDeck(db, 'Elves', 'commander');
  setCardQty(db, d.id, id('Green Cmdr'), 'commander', 1);
  return d.id;
}
beforeEach(async () => {
  db = openDb(':memory:');
  await loadJsonl(db, (async function* () { for (const c of FIXTURE) yield JSON.stringify(c); })());
  for (const n of ['Sol Ring', 'Cultivate', 'Rampant Growth', 'Swords to Plowshares', 'Beast Within', 'Banned Ramp', 'Forest', 'Llanowar Elves', 'Elvish Mystic', 'Lightning Bolt']) setOwned(db, id(n), 1);
});

describe('suggestions from your collection', () => {
  it('offers owned cards that are legal and inside the commander\'s colours, by role, most popular first', () => {
    const s = suggestForDeck(db, commanderDeck());
    expect(s.needsMore).toBe(false);
    expect(names(s, 'ramp')).toEqual(['Sol Ring', 'Cultivate', 'Rampant Growth', 'Elvish Mystic', 'Llanowar Elves']); // popularity first; the unranked ones by mana value then name
    expect(names(s, 'removal')).toEqual(['Beast Within']);
    const all = s.roles.flatMap((r) => r.cards.map((c) => c.name));
    expect(all).not.toContain('Swords to Plowshares'); // white, outside a green commander's identity
    expect(all).not.toContain('Lightning Bolt'); // red
    expect(all).not.toContain('Banned Ramp'); // banned in Commander
    expect(all).not.toContain('Unowned Ramp'); // not owned
    expect(all).not.toContain('Forest'); // lands are not spells
    expect(s.pool).toBe(6); // Sol Ring, Cultivate, Rampant Growth, Beast Within, Llanowar Elves, Elvish Mystic
  });

  it('leaves out what the deck already has, and says how many the deck has of each role', () => {
    const d = commanderDeck();
    setCardQty(db, d, id('Sol Ring'), 'main', 1);
    const s = suggestForDeck(db, d);
    expect(names(s, 'ramp')).toEqual(['Cultivate', 'Rampant Growth', 'Elvish Mystic', 'Llanowar Elves']);
    expect(s.roles.find((r) => r.role === 'ramp')).toMatchObject({ inDeck: 1, total: 4, status: 'short', target: { min: 8, max: 12 } });
  });

  it('puts the roles the deck is short on first', () => {
    const d = commanderDeck();
    const s = suggestForDeck(db, d);
    expect(s.roles.map((r) => r.status)).not.toContain('ok');
    expect(s.roles[0]!.status).toBe('short');
    expect(s.roles.map((r) => r.role)).toEqual(['ramp', 'removal']); // both short in an empty deck, in the usual order
  });

  it('asks for a commander first, and for some spells first in a 60-card deck', () => {
    const none = createDeck(db, 'No commander', 'commander');
    expect(suggestForDeck(db, none.id)).toEqual({ needsMore: true, pool: 0, roles: [] });
    const modern = createDeck(db, 'Empty', 'modern');
    expect(suggestForDeck(db, modern.id).needsMore).toBe(true);
  });

  it('takes a 60-card deck\'s colours from what is in it, and its legality from the format', () => {
    const d = createDeck(db, 'Mono green', 'modern');
    setCardQty(db, d.id, id('Llanowar Elves'), 'main', 4);
    const s = suggestForDeck(db, d.id);
    expect(names(s, 'ramp')).toEqual(['Elvish Mystic']); // green, legal in Modern, and not yet in the deck
    expect(s.roles.flatMap((r) => r.cards.map((c) => c.name))).not.toContain('Lightning Bolt'); // legal in Modern but red
    expect(s.roles.flatMap((r) => r.cards.map((c) => c.name))).not.toContain('Sol Ring'); // not legal in Modern in this fixture
    setCardQty(db, d.id, id('Lightning Bolt'), 'main', 4); // now the deck is red and green
    expect(suggestForDeck(db, d.id).pool).toBe(1);
  });

  it('with spare copies only, skips cards another deck is using (but not this deck\'s own)', () => {
    const d = commanderDeck();
    const other = createDeck(db, 'Other', 'commander');
    setCardQty(db, other.id, id('Cultivate'), 'main', 1);
    expect(names(suggestForDeck(db, d), 'ramp')).toContain('Cultivate');
    expect(names(suggestForDeck(db, d, { spare: true }), 'ramp')).not.toContain('Cultivate');
    setOwned(db, id('Cultivate'), 2); // a second copy is spare
    expect(names(suggestForDeck(db, d, { spare: true }), 'ramp')).toContain('Cultivate');
  });

  it('limits each role to the best few', () => {
    const s = suggestForDeck(db, commanderDeck(), { perRole: 2 });
    expect(names(s, 'ramp')).toEqual(['Sol Ring', 'Cultivate']);
    expect(s.roles.find((r) => r.role === 'ramp')!.total).toBe(5);
  });

  it('is on the deck routes', async () => {
    const d = commanderDeck();
    const r = createRouter({ db, data: {} as never, semantic: {} as never });
    const res = await r({ method: 'GET', path: `/api/decks/${d}/suggestions`, query: { spare: '1' } });
    expect(res.status).toBe(200);
    expect((res.body as { roles: unknown[] }).roles.length).toBeGreaterThan(0);
  });
});
