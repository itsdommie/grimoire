import { describe, expect, it } from 'vitest';
import { analyzeDeck, assumptionsFor, sourcesNeeded } from './analysis.js';
import { validateDeck, type DeckEntry, type Issue } from './deck.js';
import { FORMATS, FORMAT_IDS, asFormat, isFormatId } from './formats.js';
import { hypergeomAtLeast } from './hypergeom.js';
import { simulate, type SimCard, type SimDeck } from './sim.js';
import { W } from './colors.js';
import type { Card } from './types.js';

let n = 0;
const c = (name: string, o: Partial<Card> = {}): Card => ({
  id: `id-${n++}`, name, manaCost: '', cmc: 0, typeLine: 'Instant', oracleText: '', colors: 0, colorIdentity: 0, producedMana: 0,
  keywords: [], power: null, toughness: null, loyalty: null, rarity: 'common', setCode: 'tst', layout: 'normal', edhrecRank: null,
  usd: null, imageUrl: null, scryfallUri: '', legalities: { standard: 'legal', modern: 'legal', vintage: 'legal', pauper: 'legal', commander: 'legal' }, ...o,
});
const e = (card: Card, qty = 1, board: DeckEntry['board'] = 'main'): DeckEntry => ({ card, qty, board });
const codes = (issues: Issue[]) => issues.map((i) => `${i.severity}:${i.code}`);
const forest = c('Forest', { typeLine: 'Basic Land — Forest', colorIdentity: 16 });
const bolt = c('Lightning Bolt', { legalities: { modern: 'legal', standard: 'banned', vintage: 'legal', pauper: 'legal' } });

describe('format definitions', () => {
  it('lists every format with sensible limits', () => {
    expect(FORMAT_IDS).toHaveLength(7);
    for (const id of FORMAT_IDS) expect(FORMATS[id].id).toBe(id);
    expect(FORMATS.commander).toMatchObject({ deckSize: 100, copies: 1, commander: true });
    expect(FORMATS.modern).toMatchObject({ deckSize: 60, maxSideboard: 15, copies: 4, commander: false });
  });
  it('treats unknown values as Commander', () => {
    expect(isFormatId('modern')).toBe(true);
    expect(isFormatId('nope')).toBe(false);
    expect(asFormat('nope')).toBe('commander');
    expect(asFormat(undefined)).toBe('commander');
  });
});

describe('validateDeck for 60-card formats', () => {
  it('a 60-card main with 15 sideboard cards and 4-ofs is clean', () => {
    const playset = c('Playset');
    const issues = validateDeck([e(forest, 24), e(playset, 4), e(c('Filler'), 4), ...Array.from({ length: 7 }, (_, i) => e(c(`Spell ${i}`), 4)), e(c('Side A'), 4, 'sideboard'), e(c('Side B'), 4, 'sideboard'), e(c('Side C'), 4, 'sideboard'), e(c('Side D'), 3, 'sideboard')], 'modern');
    expect(issues).toEqual([]);
  });
  it('is incomplete (a warning) below 60 cards, with no upper limit', () => {
    expect(codes(validateDeck([e(forest, 40)], 'standard'))).toEqual(['warning:deck-size']);
    expect(validateDeck([e(forest, 80)], 'standard')).toEqual([]);
  });
  it('caps copies at four across main and sideboard together, except basics', () => {
    const issues = validateDeck([e(forest, 60), e(bolt, 3), e(bolt, 2, 'sideboard')], 'modern');
    expect(issues.find((i) => i.code === 'copies')?.message).toContain('Lightning Bolt ×5');
    expect(validateDeck([e(forest, 60), e(bolt, 4)], 'modern')).toEqual([]);
  });
  it('honours "any number" and "up to N" cards', () => {
    const rats = c('Relentless Rats', { oracleText: 'A deck can have any number of cards named Relentless Rats.' });
    const dwarves = c('Seven Dwarves', { oracleText: 'A deck can have up to seven cards named Seven Dwarves.' });
    expect(validateDeck([e(forest, 40), e(rats, 20)], 'modern')).toEqual([]);
    expect(codes(validateDeck([e(forest, 50), e(dwarves, 8)], 'modern'))).toContain('error:copies');
    expect(validateDeck([e(forest, 53), e(dwarves, 7)], 'modern')).toEqual([]);
  });
  it('limits the sideboard to 15', () => {
    const issues = validateDeck([e(forest, 60), e(c('S'), 16, 'sideboard')], 'modern');
    expect(issues.find((i) => i.code === 'sideboard-size')?.message).toContain('1 card over the 15');
  });
  it('checks legality per format: banned, and not legal', () => {
    const issues = validateDeck([e(forest, 56), e(bolt, 4), e(c('Pioneer Only', { legalities: { pioneer: 'legal' } }), 1, 'sideboard')], 'standard');
    expect(issues.find((i) => i.code === 'banned')?.message).toBe('Banned in Standard: Lightning Bolt.');
    expect(issues.find((i) => i.code === 'not-legal')?.message).toBe('Not legal in Standard: Pioneer Only.');
    expect(validateDeck([e(forest, 56), e(bolt, 4)], 'modern')).toEqual([]);
  });
  it('Vintage: restricted cards are limited to one copy', () => {
    const lotus = c('Black Lotus', { legalities: { vintage: 'restricted' } });
    expect(validateDeck([e(forest, 59), e(lotus, 1)], 'vintage')).toEqual([]);
    const bad = validateDeck([e(forest, 58), e(lotus, 2)], 'vintage');
    expect(bad.find((i) => i.code === 'copies')?.message).toContain('Black Lotus ×2 (restricted: 1 allowed)');
  });
  it('a commander board in a 60-card format is flagged, and Commander still validates as before', () => {
    const cmdr = c('Cmdr', { typeLine: 'Legendary Creature — Elf', colorIdentity: 16 });
    expect(codes(validateDeck([e(forest, 59), e(cmdr, 1, 'commander')], 'modern'))).toContain('error:wrong-zone');
    expect(codes(validateDeck([e(cmdr, 1, 'commander'), e(forest, 99)], 'commander'))).toEqual([]);
    expect(validateDeck([e(forest, 5)])).toEqual(validateDeck([e(forest, 5)], 'commander')); // default is Commander
  });
});

describe('analysis for 60-card formats', () => {
  it('uses the 60-card land formula and library size', () => {
    expect(assumptionsFor('modern')).toEqual({ deckSize: 60, extraCardsSeen: 0, landFormula: { a: 19.59, b: 1.9, c: 0.28 } });
    expect(assumptionsFor('commander').deckSize).toBe(99);
    const spell = c('Two-drop', { manaCost: '{1}{W}', cmc: 2, typeLine: 'Creature', colors: W });
    const plains = c('Plains', { typeLine: 'Basic Land — Plains', producedMana: W, colorIdentity: W });
    const a = analyzeDeck([e(plains, 24), e(spell, 36)], 'modern');
    expect(a.complete).toBe(true);
    expect(a.format).toBe('modern');
    expect(a.lands.recommended).toBe(Math.round(19.59 + 1.9 * 2));
    expect(a.lands.count).toBe(24);
    expect(a.math).toEqual({ deckSize: 60, extraCardsSeen: 0 });
  });
  it('colour-source requirements follow the exact 60-card hypergeometric maths', () => {
    // One coloured pip on turn 2 (MV 2) at 91%: P(>=1 source in 9 cards of 60).
    const need = sourcesNeeded(1, 2, { deckSize: 60, extraCards: 0 })!;
    expect(hypergeomAtLeast(60, need, 9, 1)).toBeGreaterThanOrEqual(0.91);
    expect(hypergeomAtLeast(60, need - 1, 9, 1)).toBeLessThan(0.91);
    expect(need).toBeGreaterThanOrEqual(13); // Karsten's 60-card single-pip figure is 13-14
    expect(need).toBeLessThanOrEqual(14);
  });
  it('gives no Commander role targets and says how many cards are missing', () => {
    const a = analyzeDeck([e(forest, 20)], 'modern');
    expect(a.roles.every((r) => r.target === undefined)).toBe(true);
    expect(a.findings.some((f) => f.title === 'Deck is incomplete' && f.detail.includes('of 60'))).toBe(true);
    expect(a.findings.some((f) => /win condition/.test(f.title))).toBe(false);
  });
});

describe('simulation of 60-card decks', () => {
  const land = (): SimCard => ({ name: 'Plains', isLand: true, cmc: 0, pips: [], generic: 0, colors: W, tapped: false });
  const filler = (): SimCard => ({ name: 'Filler', isLand: false, cmc: 9, pips: [], generic: 9, colors: 0, tapped: false });
  const deck = (lands: number): SimDeck => ({ library: [...Array.from({ length: lands }, land), ...Array.from({ length: 60 - lands }, filler)], commanders: [], identity: 31 });
  const N = 20_000;
  const tol = (p: number) => 4 * Math.sqrt(Math.max(p * (1 - p), 0.0004) / N);

  it('land drops on the play match the exact hypergeometric probabilities for a 60-card library', () => {
    const r = simulate(deck(24), { games: N, turns: 6, seed: 21, mulligan: 'none', onThePlay: true });
    for (let t = 1; t <= 6; t++) {
      const p = hypergeomAtLeast(60, 24, 6 + t, t);
      expect(Math.abs(r.perTurn[t - 1]!.landDrop - p), `turn ${t}`).toBeLessThan(tol(p));
    }
  });
  it('without a free mulligan, mulligans cost cards and happen at least as often as with one', () => {
    const free = simulate(deck(24), { games: 8000, turns: 4, seed: 5 });
    const paid = simulate(deck(24), { games: 8000, turns: 4, seed: 5, freeMulligan: false });
    expect(paid.opening.firstSevenKeepRate).toBeCloseTo(free.opening.firstSevenKeepRate, 2); // same first hands
    expect(paid.opening.avgMulligans).toBeGreaterThanOrEqual(free.opening.avgMulligans - 0.001);
    // A smaller kept hand means fewer lands by turn 3 on average, so land drops are no better.
    expect(paid.perTurn[2]!.landDrop).toBeLessThanOrEqual(free.perTurn[2]!.landDrop + 0.01);
  });
});
