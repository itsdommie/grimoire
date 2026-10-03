import { describe, expect, it } from 'vitest';
import { hypergeomAtLeast, hypergeomPmf } from './hypergeom.js';
import { payCost, simulate, toSimCard, toSimDeck, type SimCard, type SimDeck } from './sim.js';
import { B, G, R, U, W } from './colors.js';
import type { DeckEntry } from './deck.js';
import type { Card } from './types.js';

const land = (name: string, colors: number, tapped = false): SimCard => ({ name, isLand: true, cmc: 0, pips: [], generic: 0, colors, tapped });
const spell = (name: string, cmc: number, pips: number[] = [], extra: Partial<SimCard> = {}): SimCard => ({ name, isLand: false, cmc, pips, generic: cmc - pips.length, colors: 0, tapped: false, ...extra });
const copies = (c: SimCard, n: number) => Array.from({ length: n }, () => c);
const deckOf = (library: SimCard[], commanders: SimCard[] = []): SimDeck => ({ library, commanders, identity: 31 });
const fill = (cards: SimCard[], to = 99) => [...cards, ...copies(spell('Filler', 9, []), to - cards.length)]; // uncastable filler so it never affects mana

const N = 20_000;
/** 4-sigma binomial tolerance for a probability p measured over N games. */
const tol = (p: number) => 4 * Math.sqrt(Math.max(p * (1 - p), 0.0004) / N);

describe('payCost', () => {
  it('pays coloured pips from matching sources and generic from the rest', () => {
    expect(payCost([W], 1, [W, 0])).toHaveLength(2);
    expect(payCost([W, U], 0, [W | U, W])).not.toBeNull(); // dual must be saved for U
    expect(payCost([W, W], 0, [W | U, U])).toBeNull();
    expect(payCost([], 3, [W, U])).toBeNull();
    expect(payCost([R], 0, [0])).toBeNull(); // colourless can't pay a coloured pip
  });
  it('taps inflexible sources first, leaving flexible ones', () => {
    const used = payCost([], 1, [W | U | B | R | G, W])!;
    expect(used).toEqual([1]);
  });
  it('handles hybrid pips (any of the listed colours)', () => {
    expect(payCost([W | U], 0, [U])).not.toBeNull();
    expect(payCost([W | U], 0, [B])).toBeNull();
  });
});

describe('simulation vs exact hypergeometric probabilities (no mulligans)', () => {
  const lib = fill(copies(land('Plains', W), 37));
  const r = simulate(deckOf(lib), { games: N, turns: 8, seed: 42, mulligan: 'none' });

  it('opening-hand land distribution', () => {
    for (let k = 0; k <= 7; k++) {
      const p = hypergeomPmf(99, 37, 7, k);
      expect(Math.abs(r.opening.landsDist[k]! - p), `P(${k} lands)`).toBeLessThan(tol(p));
    }
    expect(r.opening.avgMulligans).toBe(0);
  });

  it('hitting every land drop through turn t (on the draw)', () => {
    for (let t = 1; t <= 8; t++) {
      const p = hypergeomAtLeast(99, 37, 7 + t, t);
      expect(Math.abs(r.perTurn[t - 1]!.landDrop - p), `turn ${t}`).toBeLessThan(tol(p));
    }
  });

  it('on the play there is one fewer card by each turn', () => {
    const play = simulate(deckOf(lib), { games: N, turns: 6, seed: 7, mulligan: 'none', onThePlay: true });
    for (let t = 1; t <= 6; t++) {
      const p = hypergeomAtLeast(99, 37, 6 + t, t);
      expect(Math.abs(play.perTurn[t - 1]!.landDrop - p), `turn ${t}`).toBeLessThan(tol(p));
    }
  });

  it('a mono-coloured commander is castable exactly when a source has been seen', () => {
    const cmdr = spell('Cmdr1', 1, [W]);
    const two = simulate(deckOf(fill([...copies(land('Plains', W), 20), ...copies(land('Swamp', B), 17)]), [cmdr]), { games: N, turns: 6, seed: 3, mulligan: 'none' });
    for (let t = 1; t <= 6; t++) {
      const p = hypergeomAtLeast(99, 20, 7 + t, 1);
      expect(Math.abs(two.perTurn[t - 1]!.commanderCast[0]! - p), `turn ${t}`).toBeLessThan(tol(p));
    }
  });

  it('a double-pip commander needs two sources of that colour (and two turns)', () => {
    const cmdr = spell('Cmdr2', 2, [W, W]);
    const res = simulate(deckOf(fill([...copies(land('Plains', W), 20), ...copies(land('Swamp', B), 17)]), [cmdr]), { games: N, turns: 6, seed: 5, mulligan: 'none' });
    expect(res.perTurn[0]!.commanderCast[0]).toBe(0);
    for (let t = 2; t <= 6; t++) {
      const p = hypergeomAtLeast(99, 20, 7 + t, 2);
      expect(Math.abs(res.perTurn[t - 1]!.commanderCast[0]! - p), `turn ${t}`).toBeLessThan(tol(p));
    }
  });
});

describe('mulligans', () => {
  it('first-seven keep rate equals P(2-5 lands in 7)', () => {
    const res = simulate(deckOf(fill(copies(land('Plains', W), 37))), { games: N, turns: 3, seed: 11 });
    let p = 0;
    for (let k = 2; k <= 5; k++) p += hypergeomPmf(99, 37, 7, k);
    expect(Math.abs(res.opening.firstSevenKeepRate - p)).toBeLessThan(tol(p));
    expect(res.opening.avgMulligans).toBeGreaterThan(0);
    expect(res.opening.avgKeptLands).toBeGreaterThan(2);
    expect(res.opening.avgKeptLands).toBeLessThan(4.5);
  });
  it('mulligans improve land-drop consistency', () => {
    const lib = fill(copies(land('Plains', W), 37));
    const without = simulate(deckOf(lib), { games: 5000, turns: 4, seed: 9, mulligan: 'none' });
    const withM = simulate(deckOf(lib), { games: 5000, turns: 4, seed: 9 });
    expect(withM.perTurn[2]!.landDrop).toBeGreaterThan(without.perTurn[2]!.landDrop);
  });
});

describe('mana development rules', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const d = deckOf(fill(copies(land('Plains', W), 37)));
    expect(simulate(d, { games: 500, seed: 5 })).toEqual(simulate(d, { games: 500, seed: 5 }));
    expect(simulate(d, { games: 500, seed: 6 })).not.toEqual(simulate(d, { games: 500, seed: 5 }));
  });

  it('enters-tapped lands cannot be used the turn they arrive', () => {
    const res = simulate(deckOf(copies(land('Tapland', W, true), 99), [spell('C', 1, [W])]), { games: 300, turns: 3, seed: 1, mulligan: 'none' });
    expect(res.perTurn[0]!.commanderCast[0]).toBe(0);
    expect(res.perTurn[1]!.commanderCast[0]).toBe(1);
  });

  it('an all-land library hits every drop and casts a 4-drop on turn 4', () => {
    const res = simulate(deckOf(copies(land('Plains', W), 99), [spell('Four', 4, [W])]), { games: 200, turns: 5, seed: 1, mulligan: 'none' });
    expect(res.perTurn.map((t) => t.landDrop)).toEqual([1, 1, 1, 1, 1]);
    expect(res.perTurn.map((t) => t.onCurve)).toEqual([1, 1, 1, 1, 1]);
    expect(res.perTurn.map((t) => t.commanderCast[0])).toEqual([0, 0, 0, 1, 1]);
    expect(res.commanderMedianTurn).toEqual([4]);
  });

  it('summoning-sick mana creatures only produce from the next turn; artifacts produce immediately', () => {
    const mk = (sick: boolean) => deckOf([...copies(land('Plains', W), 60), ...copies(spell('Rock', 1, [], { mana: { units: 2, mask: 0, sick, tapped: false } }), 39)], [spell('Two', 2, [])]);
    const dork = simulate(mk(true), { games: 4000, turns: 3, seed: 2, mulligan: 'none' });
    const rock = simulate(mk(false), { games: 4000, turns: 3, seed: 2, mulligan: 'none' });
    // Turn 1: one land pays for the rock; only an immediately-usable rock leaves mana for the commander.
    expect(dork.perTurn[0]!.commanderCast[0]).toBe(0);
    expect(rock.perTurn[0]!.commanderCast[0]).toBeGreaterThan(0.5);
  });

  it('ramp speeds up the commander; land-search ramp adds lands beyond one per turn', () => {
    const lands = copies(land('Plains', W), 36);
    const vanilla = deckOf(fill([...lands, ...copies(spell('Bear', 2, [W]), 10)]), [spell('Big', 6, [W])]);
    const ramp = deckOf(fill([...lands, ...copies(spell('Rock', 2, [W], { mana: { units: 2, mask: 0, sick: false, tapped: false } }), 10)]), [spell('Big', 6, [W])]);
    const fetch = deckOf(fill([...lands, ...copies(spell('Growth', 2, [W], { fetch: { toBattlefield: 1, toHand: 0 } }), 10)]), [spell('Big', 6, [W])]);
    const a = simulate(vanilla, { games: 4000, turns: 8, seed: 3 }), b = simulate(ramp, { games: 4000, turns: 8, seed: 3 }), c = simulate(fetch, { games: 4000, turns: 8, seed: 3 });
    expect(b.perTurn[5]!.commanderCast[0]!).toBeGreaterThan(a.perTurn[5]!.commanderCast[0]!);
    expect(b.perTurn[4]!.avgMana).toBeGreaterThan(a.perTurn[4]!.avgMana);
    expect(c.perTurn[5]!.avgLands).toBeGreaterThan(a.perTurn[5]!.avgLands);
  });

  it('draw spells pull cards from the library', () => {
    const lands = copies(land('Plains', W), 36);
    const base = deckOf(fill([...lands, ...copies(spell('Bear', 2, [W]), 10)]));
    const draw = deckOf(fill([...lands, ...copies(spell('Divination', 2, [W], { draw: 2 }), 10)]));
    const a = simulate(base, { games: 3000, turns: 6, seed: 4, mulligan: 'none' }), d = simulate(draw, { games: 3000, turns: 6, seed: 4, mulligan: 'none' });
    expect(d.perTurn[5]!.avgLands).toBeGreaterThan(a.perTurn[5]!.avgLands);
  });

  it('flags colour screw only when mana count suffices but colours do not', () => {
    const screwed = simulate(deckOf(fill([...copies(land('Island', U), 40), ...copies(spell('W1', 1, [W]), 40)]), [spell('Cw', 2, [W, W])]), { games: 2000, turns: 4, seed: 8, mulligan: 'none' });
    expect(screwed.perTurn[2]!.colorScrew).toBeGreaterThan(0.95);
    const fine = simulate(deckOf(fill([...copies(land('Plains', W), 40), ...copies(spell('W1', 1, [W]), 40)]), [spell('Cw', 2, [W, W])]), { games: 2000, turns: 4, seed: 8, mulligan: 'none' });
    expect(fine.perTurn[3]!.colorScrew).toBe(0);
    expect(fine.perTurn[3]!.colorScrewEver).toBe(0);
  });

  it('supports two commanders independently', () => {
    const res = simulate(deckOf(copies(land('Plains', W), 99), [spell('A', 2, [W]), spell('B', 4, [W])]), { games: 100, turns: 5, seed: 1, mulligan: 'none' });
    expect(res.commanders).toEqual(['A', 'B']);
    expect(res.commanderMedianTurn).toEqual([2, 4]);
  });
});

describe('toSimCard / toSimDeck', () => {
  let n = 0;
  const card = (name: string, o: Partial<Card>): Card => ({
    id: `i${n++}`, name, manaCost: '', cmc: 0, typeLine: 'Instant', oracleText: '', colors: 0, colorIdentity: 0, producedMana: 0, keywords: [],
    power: null, toughness: null, loyalty: null, rarity: 'common', setCode: 't', layout: 'normal', edhrecRank: null, usd: null, imageUrl: null, scryfallUri: '', legalities: {}, ...o,
  });
  const WUBRG = 31;

  it('mana rocks and dorks', () => {
    const ring = toSimCard(card('Sol Ring', { typeLine: 'Artifact', manaCost: '{1}', cmc: 1, oracleText: '{T}: Add {C}{C}.' }), WUBRG);
    expect(ring.mana).toEqual({ units: 2, mask: 0, sick: false, tapped: false });
    const elves = toSimCard(card('Llanowar Elves', { typeLine: 'Creature — Elf Druid', manaCost: '{G}', cmc: 1, oracleText: '{T}: Add {G}.' }), WUBRG);
    expect(elves.mana).toEqual({ units: 1, mask: G, sick: true, tapped: false });
    const signet = toSimCard(card('Arcane Signet', { typeLine: 'Artifact', manaCost: '{2}', cmc: 2, oracleText: "{T}: Add one mana of any color in your commander's color identity." }), W | U);
    expect(signet.mana).toMatchObject({ units: 1, mask: W | U });
    const tappedRock = toSimCard(card('Tapped Rock', { typeLine: 'Artifact', manaCost: '{2}', cmc: 2, oracleText: 'This artifact enters tapped.\n{T}: Add {R}.' }), WUBRG);
    expect(tappedRock.mana?.tapped).toBe(true);
  });

  it('land-search ramp and draw spells', () => {
    const cultivate = toSimCard(card('Cultivate', { typeLine: 'Sorcery', manaCost: '{2}{G}', cmc: 3, oracleText: 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.' }), G);
    expect(cultivate.fetch).toEqual({ toBattlefield: 1, toHand: 1 });
    const rg = toSimCard(card('Rampant Growth', { typeLine: 'Sorcery', manaCost: '{1}{G}', cmc: 2, oracleText: 'Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.' }), G);
    expect(rg.fetch).toEqual({ toBattlefield: 1, toHand: 0 });
    const ev = toSimCard(card('Explosive Vegetation', { typeLine: 'Sorcery', manaCost: '{3}{G}', cmc: 4, oracleText: 'Search your library for up to two basic land cards, put them onto the battlefield tapped, then shuffle.' }), G);
    expect(ev.fetch).toEqual({ toBattlefield: 2, toHand: 0 });
    const div = toSimCard(card('Divination', { typeLine: 'Sorcery', manaCost: '{2}{U}', cmc: 3, oracleText: 'Draw two cards.' }), U);
    expect(div.draw).toBe(2);
    expect(div.pips).toEqual([U]);
    expect(div.generic).toBe(2);
    const bears = toSimCard(card('Bears', { typeLine: 'Creature — Bear', manaCost: '{1}{G}', cmc: 2 }), G);
    expect(bears.mana).toBeUndefined();
    expect(bears.fetch).toBeUndefined();
    expect(bears.draw).toBeUndefined();
  });

  it('lands: basics, duals, tapped, any-colour and fetch-style', () => {
    expect(toSimCard(card('Plains', { typeLine: 'Basic Land — Plains', producedMana: W, oracleText: '({T}: Add {W}.)' }), WUBRG)).toMatchObject({ isLand: true, colors: W, tapped: false });
    expect(toSimCard(card('Guildgate', { typeLine: 'Land — Gate', producedMana: W | U, oracleText: 'Azorius Guildgate enters tapped.\n{T}: Add {W} or {U}.' }), WUBRG)).toMatchObject({ colors: W | U, tapped: true });
    expect(toSimCard(card('Command Tower', { typeLine: 'Land', oracleText: "{T}: Add one mana of any color in your commander's color identity." }), W | G)).toMatchObject({ colors: W | G, tapped: false });
    expect(toSimCard(card('Evolving Wilds', { typeLine: 'Land', oracleText: '{T}, Sacrifice Evolving Wilds: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.' }), U | B)).toMatchObject({ colors: U | B, tapped: true });
    // Check-lands that only sometimes enter tapped are treated as untapped (optimistic).
    expect(toSimCard(card('Glacial Fortress', { typeLine: 'Land', producedMana: W | U, oracleText: 'Glacial Fortress enters tapped unless you control a Plains or an Island.\n{T}: Add {W} or {U}.' }), WUBRG).tapped).toBe(false);
  });

  it('costs: hybrid becomes a multi-colour pip; phyrexian is free of mana', () => {
    const h = toSimCard(card('Hybrid', { typeLine: 'Creature', manaCost: '{1}{W/U}{B/P}', cmc: 3 }), WUBRG);
    expect(h.pips).toEqual([W | U]);
    expect(h.generic).toBe(1);
  });

  it('toSimDeck expands quantities, separates commanders, drops the sideboard and derives identity', () => {
    const cmdr = card('Cmdr', { typeLine: 'Legendary Creature', manaCost: '{2}{W}{U}', cmc: 4, colorIdentity: W | U });
    const plains = card('Plains', { typeLine: 'Basic Land — Plains', producedMana: W });
    const side = card('Side', {});
    const entries: DeckEntry[] = [{ card: cmdr, qty: 1, board: 'commander' }, { card: plains, qty: 5, board: 'main' }, { card: side, qty: 3, board: 'sideboard' }];
    const d = toSimDeck(entries);
    expect(d.library).toHaveLength(5);
    expect(d.commanders.map((c) => c.name)).toEqual(['Cmdr']);
    expect(d.identity).toBe(W | U);
  });
});
