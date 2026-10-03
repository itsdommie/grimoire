import { describe, expect, it } from 'vitest';
import { analyzeDeck, castProbability, sourcesNeeded } from './analysis.js';
import { parseManaCost } from './mana.js';
import { hypergeomAtLeast, hypergeomPmf, minSources } from './hypergeom.js';
import { tagRoles } from './roles.js';
import { B, G, R, U, W } from './colors.js';
import type { DeckEntry } from './deck.js';
import type { Card } from './types.js';

let n = 0;
const c = (name: string, o: Partial<Card> = {}): Card => ({
  id: `id-${n++}`, name, manaCost: '', cmc: 0, typeLine: 'Instant', oracleText: '', colors: 0, colorIdentity: 0, producedMana: 0,
  keywords: [], power: null, toughness: null, loyalty: null, rarity: 'common', setCode: 'tst', layout: 'normal', edhrecRank: null,
  usd: null, imageUrl: null, scryfallUri: '', legalities: { commander: 'legal' }, ...o,
});
const e = (card: Card, qty = 1, board: DeckEntry['board'] = 'main'): DeckEntry => ({ card, qty, board });

// ---- independent exact reference using BigInt binomials
const choose = (a: number, b: number): bigint => { if (b < 0 || b > a) return 0n; let r = 1n; for (let i = 1; i <= b; i++) r = (r * BigInt(a - b + i)) / BigInt(i); return r; };
const exactAtLeast = (N: number, K: number, d: number, k: number) => {
  let num = 0n;
  for (let i = k; i <= Math.min(K, d); i++) num += choose(K, i) * choose(N - K, d - i);
  return Number((num * 1_000_000_000n) / choose(N, d)) / 1e9;
};

describe('hypergeometric maths', () => {
  it('matches exact BigInt arithmetic', () => {
    for (const [N, K, d, k] of [[99, 37, 7, 1], [99, 37, 7, 3], [99, 20, 11, 2], [60, 24, 9, 4], [99, 8, 12, 1], [99, 30, 15, 5]] as const) {
      expect(hypergeomAtLeast(N, K, d, k)).toBeCloseTo(exactAtLeast(N, K, d, k), 8);
    }
  });
  it('pmf sums to 1 and edge cases hold', () => {
    let sum = 0;
    for (let k = 0; k <= 7; k++) sum += hypergeomPmf(99, 37, 7, k);
    expect(sum).toBeCloseTo(1, 10);
    expect(hypergeomAtLeast(99, 37, 7, 0)).toBe(1);
    expect(hypergeomAtLeast(99, 0, 7, 1)).toBe(0);
    expect(hypergeomAtLeast(99, 99, 7, 7)).toBe(1);
  });
  it('opening hand: 37 lands in 99 gives ~81.4% for at least 2 lands in 7 and ~96.7% for at least 1', () => {
    expect(hypergeomAtLeast(99, 37, 7, 2)).toBeCloseTo(exactAtLeast(99, 37, 7, 2), 8);
    expect(hypergeomAtLeast(99, 37, 7, 2)).toBeCloseTo(0.814, 2);
    expect(hypergeomAtLeast(99, 37, 7, 1)).toBeCloseTo(exactAtLeast(99, 37, 7, 1), 8);
    expect(hypergeomAtLeast(99, 37, 7, 1)).toBeCloseTo(0.967, 3);
  });
  it('minSources is the smallest K reaching the target', () => {
    const K = minSources(99, 11, 2, 0.93)!;
    expect(hypergeomAtLeast(99, K, 11, 2)).toBeGreaterThanOrEqual(0.93);
    expect(hypergeomAtLeast(99, K - 1, 11, 2)).toBeLessThan(0.93);
    expect(minSources(10, 1, 3, 0.9)).toBeNull();
  });
});

describe('source requirements', () => {
  it('stays within one source of the two Commander values reported for Karsten (19 and 30)', () => {
    expect(Math.abs(sourcesNeeded(1, 1)! - 19)).toBeLessThanOrEqual(1);
    expect(Math.abs(sourcesNeeded(2, 2)! - 30)).toBeLessThanOrEqual(1);
  });
  it('is monotonic: more pips need more sources, later turns need fewer', () => {
    expect(sourcesNeeded(2, 4)!).toBeGreaterThan(sourcesNeeded(1, 4)!);
    expect(sourcesNeeded(1, 6)!).toBeLessThan(sourcesNeeded(1, 1)!);
    expect(sourcesNeeded(3, 3)!).toBeGreaterThan(sourcesNeeded(2, 3)!);
  });
  it('castProbability agrees with the requirement', () => {
    const need = sourcesNeeded(2, 3)!;
    expect(castProbability(need, 2, 3)).toBeGreaterThanOrEqual(0.92);
    expect(castProbability(need - 1, 2, 3)).toBeLessThan(0.92);
  });
});

describe('parseManaCost', () => {
  it('reads generic, coloured, X, colourless and snow', () => {
    expect(parseManaCost('{2}{W}{W}')).toMatchObject({ cmc: 4, generic: 2, pips: { W: 2 } });
    expect(parseManaCost('{X}{R}')).toMatchObject({ cmc: 1, hasX: true, pips: { R: 1 } });
    expect(parseManaCost('{C}{S}')).toMatchObject({ cmc: 2, colorless: 1, generic: 1 });
  });
  it('reads hybrid, 2-hybrid and phyrexian pips separately', () => {
    const p = parseManaCost('{W/U}{2/B}{G/P}');
    expect(p.hybrid).toEqual([['W', 'U'], ['B']]);
    expect(p.phyrexian).toEqual(['G']);
    expect(p.cmc).toBe(1 + 2 + 1);
    expect(p.pips).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0 });
  });
  it('uses the front face of multi-faced costs and handles empty', () => {
    expect(parseManaCost('{1}{U} // {2}{R}').cmc).toBe(2);
    expect(parseManaCost('').cmc).toBe(0);
  });
});

describe('tagRoles', () => {
  const tag = (name: string, text: string, type = 'Instant', cmc = 2) => tagRoles(c(name, { oracleText: text, typeLine: type, cmc }));
  it('ramp: rocks, dorks, fetch spells, treasure; not rituals or lands', () => {
    expect(tag('Sol Ring', '{T}: Add {C}{C}.', 'Artifact')).toContain('ramp');
    expect(tag('Elves', '{T}: Add {G}.', 'Creature — Elf')).toContain('ramp');
    expect(tag('Cultivate', 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.', 'Sorcery')).toContain('ramp');
    expect(tag('Farseek', 'Search your library for a Plains, Island, Swamp, or Mountain card, put it onto the battlefield tapped, then shuffle.', 'Sorcery')).toContain('ramp');
    expect(tag('Dark Ritual', 'Add {B}{B}{B}.')).not.toContain('ramp');
    expect(tag('Command Tower', '{T}: Add one mana of any color in your commander\'s color identity.', 'Land')).not.toContain('ramp');
  });
  it('draw: you draw, but not opponents, triggers, or reminder text', () => {
    expect(tag('Divination', 'Draw two cards.', 'Sorcery')).toContain('draw');
    expect(tag('Rhystic', 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.', 'Enchantment')).toContain('draw');
    expect(tag('Sign', 'Target player draws two cards and loses 2 life.', 'Sorcery')).toContain('draw');
    expect(tag('Cycler', 'Cycling {2} ({2}, Discard this card: Draw a card.)', 'Instant')).not.toContain('draw');
    expect(tag('Punisher', 'Target opponent draws a card.')).not.toContain('draw');
    expect(tag('Sheoldred', 'Whenever you draw a card, you gain 2 life. Whenever an opponent draws a card, they lose 2 life.', 'Creature')).not.toContain('draw');
  });
  it('removal vs wipes vs counters', () => {
    expect(tag('Swords', 'Exile target creature. Its controller gains life equal to its power.')).toContain('removal');
    expect(tag('Bolt', 'Lightning Bolt deals 3 damage to any target.')).toContain('removal');
    expect(tag('Wrath', 'Destroy all creatures. They can\'t be regenerated.', 'Sorcery')).toEqual(['wipe']);
    expect(tag('Blasphemous', 'Blasphemous Act deals 13 damage to each creature.', 'Sorcery')).toContain('wipe');
    expect(tag('Counterspell', 'Counter target spell.')).toEqual(['counter']);
    expect(tag('Cleanse', 'Exile target card from a graveyard.')).not.toContain('removal');
  });
  it('tutors, recursion, protection, win conditions', () => {
    expect(tag('Demonic Tutor', 'Search your library for a card, put that card into your hand, then shuffle.', 'Sorcery')).toContain('tutor');
    expect(tag('Regrowth', 'Return target card from your graveyard to your hand.', 'Sorcery')).toContain('recursion');
    expect(tag('Boots', 'Equipped creature has hexproof and haste.', 'Artifact — Equipment')).toContain('protection');
    expect(tag('Oracle', 'If X is greater than or equal to the number of cards in your library, you win the game.', 'Creature')).toContain('wincon');
    expect(tag('Cruel Celebrant', 'Whenever this or another creature or planeswalker you control dies, each opponent loses 1 life and you gain 1 life.', 'Creature')).not.toContain('wincon');
  });
  it('plain creatures get no roles', () => expect(tag('Bears', '', 'Creature — Bear')).toEqual([]));
});

describe('analyzeDeck', () => {
  const cmdr = c('Cmdr', { typeLine: 'Legendary Creature', manaCost: '{2}{W}{U}', cmc: 4, colorIdentity: W | U, colors: W | U });
  const plains = c('Plains', { typeLine: 'Basic Land — Plains', producedMana: W, colorIdentity: W });
  const island = c('Island', { typeLine: 'Basic Land — Island', producedMana: U, colorIdentity: U });
  const dual = c('Dual', { typeLine: 'Land', producedMana: W | U, colorIdentity: W | U });
  const evolving = c('Evolving Wilds', { typeLine: 'Land', oracleText: '{T}, Sacrifice: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.' });
  const mdfc = c('Spell//Land', { typeLine: 'Sorcery // Land', manaCost: '{1}{W}', cmc: 2, producedMana: W });

  it('builds the curve, average MV, pips and land sources', () => {
    const bear = c('Bear', { manaCost: '{1}{W}', cmc: 2, typeLine: 'Creature' });
    const big = c('Big', { manaCost: '{4}{U}{U}', cmc: 6, typeLine: 'Creature' });
    const huge = c('Huge', { manaCost: '{9}{W}', cmc: 10, typeLine: 'Creature' });
    const a = analyzeDeck([e(cmdr, 1, 'commander'), e(bear, 2), e(big), e(huge), e(plains, 10), e(island, 5), e(dual, 3), e(evolving)]);
    expect(a.curve.buckets).toEqual([0, 0, 2, 0, 0, 0, 1, 1]); // 10 mana value lands in the 7+ bucket
    expect(a.curve.nonland).toBe(4);
    expect(a.curve.avgMv).toBeCloseTo((2 + 2 + 6 + 10) / 4);
    expect(a.pips.W).toBe(2 + 1 + 1); // bears x2, huge, commander
    expect(a.pips.U).toBe(2 + 1);
    const w = a.colors.find((x) => x.color === 'W')!;
    expect(w.landSources).toBe(10 + 3 + 1); // plains + duals + fetch-style land (counts for each identity colour)
    expect(a.colors.find((x) => x.color === 'U')!.landSources).toBe(5 + 3 + 1);
    expect(a.complete).toBe(false);
    expect(a.lands.status).toBeNull();
  });

  it('counts hybrid and phyrexian pips fractionally / as pips but excludes them from source patterns', () => {
    const hyb = c('Hybrid', { manaCost: '{W/U}{W/U}', cmc: 2, typeLine: 'Creature' });
    const phy = c('Phy', { manaCost: '{1}{W/P}', cmc: 2, typeLine: 'Artifact' });
    const a = analyzeDeck([e(hyb), e(phy)]);
    expect(a.pips.W).toBeCloseTo(1 + 1);
    expect(a.pips.U).toBeCloseTo(1);
    expect(a.colors.find((x) => x.color === 'W')?.patterns ?? []).toHaveLength(0);
  });

  it('counts spell-lands as half a land and uses the Karsten land formula', () => {
    const spell = c('Spell', { manaCost: '{2}', cmc: 2, typeLine: 'Artifact', oracleText: '{T}: Add {C}.' });
    const a = analyzeDeck([e(cmdr, 1, 'commander'), e(plains, 36), e(mdfc, 2), e(spell, 61)]);
    expect(a.complete).toBe(true);
    expect(a.lands.count).toBe(37);
    // all non-lands are cheap ramp (cmc 2): lands = 31.42 + 3.13*2 - 0.28*61
    expect(a.lands.cheapRampDraw).toBe(61 + 2 * 0); // mdfc isn't ramp/draw
    expect(a.lands.recommended).toBe(Math.round(31.42 + 3.13 * a.curve.avgMv - 0.28 * a.lands.cheapRampDraw));
  });

  it('flags short roles with the "you\'re short on X" wording and ok decks cleanly', () => {
    const a = analyzeDeck([e(cmdr, 1, 'commander'), e(c('Sol Ring', { typeLine: 'Artifact', oracleText: '{T}: Add {C}{C}.', cmc: 1, manaCost: '{1}' }), 3)]);
    const ramp = a.roles.find((r) => r.role === 'ramp')!;
    expect(ramp).toMatchObject({ count: 3, status: 'short', target: { min: 8, max: 12 } });
    expect(a.findings.some((f) => f.severity === 'warn' && /short on ramp: 3 \(aim for 8-12\)/.test(f.title))).toBe(true);
  });

  it('puts a lone hard-to-cast card in outliers instead of inflating the recommendation', () => {
    const cheap = [c('A', { manaCost: '{1}{W}', cmc: 2 }), c('B', { manaCost: '{1}{W}', cmc: 2 })];
    const hard = c('Hard', { manaCost: '{W}{W}{W}', cmc: 3 });
    const a = analyzeDeck([e(cmdr, 1, 'commander'), ...cheap.map((x) => e(x)), e(hard)]);
    const w = a.colors.find((x) => x.color === 'W')!;
    expect(w.outliers).toEqual(['Hard']);
    expect(w.needed).toBe(Math.max(...w.patterns.filter((p) => p.cards.length >= 2 || p.commander).map((p) => p.needed!)));
  });

  it('ignores the sideboard', () => {
    const a = analyzeDeck([e(plains, 5, 'sideboard')]);
    expect(a.libraryCards).toBe(0);
    expect(a.lands.count).toBe(0);
  });
});
