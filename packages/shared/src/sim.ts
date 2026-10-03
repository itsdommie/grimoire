import { B, G, R, U, W } from './colors.js';
import type { DeckEntry } from './deck.js';
import { parseManaCost } from './mana.js';
import { isLand, isSpellLand, tagRoles } from './roles.js';
import type { Card } from './types.js';

// A deliberately simple goldfish: one player, no opponents, no interaction. It measures how well a mana base and curve
// develop: land drops, colour availability, mana by turn and when the commander can first be cast. The bot's rules:
//   1. London mulligan, first one free (Commander). Keep 7 cards with 2-5 lands, smaller hands with 2-4 (or any at 4 cards).
//   2. Each turn: draw (not on turn 1 if on the play), play a land (preferring one that adds a colour the hand needs, and an
//      untapped one), then cast spells in this priority: commander if payable, else the cheapest ramp spell, else the
//      cheapest card-draw spell, repeating until nothing is castable.
// Modelled: lands (incl. enters-tapped), mana rocks/dorks (creatures are summoning sick), land-search ramp, draw-N spells,
// coloured/hybrid costs with exact payment. Not modelled: commander tax/recasts, other effects, X spells (X = 0).

const ANY = 31;

export interface SimCard {
  name: string;
  isLand: boolean;
  cmc: number;
  /** One mask per coloured/hybrid pip (the colours that can pay it). */
  pips: number[];
  /** Generic mana in the cost. */
  generic: number;
  // lands
  colors: number;
  tapped: boolean;
  // mana permanents
  mana?: { units: number; mask: number; sick: boolean; tapped: boolean };
  // ramp / draw spells
  fetch?: { toBattlefield: number; toHand: number };
  draw?: number;
}

export interface SimDeck { library: SimCard[]; commanders: SimCard[]; identity: number }

const WORD_NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };
const MASK: Record<string, number> = { W, U, B, R, G };

function costOf(card: Card): Pick<SimCard, 'pips' | 'generic' | 'cmc'> {
  const p = parseManaCost(card.manaCost);
  const pips: number[] = [];
  for (const [col, count] of Object.entries(p.pips)) for (let i = 0; i < count; i++) pips.push(MASK[col]!);
  for (const h of p.hybrid) pips.push(h.reduce((m, c) => m | MASK[c]!, 0));
  // Phyrexian pips are paid with life; they cost no mana here.
  return { pips, generic: p.generic + p.colorless, cmc: Math.round(card.cmc) };
}

const entersTapped = (t: string) => /enters (?:the battlefield )?tapped/.test(t) && !/unless|if you control|if you don't/.test(t.split(/enters (?:the battlefield )?tapped/)[0]! + (t.match(/enters (?:the battlefield )?tapped[^.]*\./)?.[0] ?? ''));

/** Turn a card into the simulator's model. `identity` is the commander colour mask, used for "any colour" and fetch effects. */
export function toSimCard(card: Card, identity: number): SimCard {
  const text = card.oracleText.replace(/\([^)]*\)/g, '').toLowerCase();
  const base = { name: card.name, ...costOf(card), isLand: isLand(card), colors: 0, tapped: false };
  if (isLand(card)) {
    const fetch = card.producedMana === 0 && /search your library for [^.]*(?:land|plains|island|swamp|mountain|forest)/.test(text);
    const anyColor = /any color|any type/.test(text);
    return { ...base, cmc: 0, colors: fetch || anyColor ? (identity || ANY) : card.producedMana, tapped: fetch || entersTapped(text) };
  }
  const out: SimCard = { ...base };
  const roles = tagRoles(card);
  const permanent = !/\b(Instant|Sorcery)\b/.test(card.typeLine.split(' // ')[0] ?? '');
  const add = /\{t\}[^:.]*: add ((?:\{[^}]+\})+|one mana of any (?:one )?color|[^.]*any color)/.exec(text);
  if (permanent && add && roles.includes('ramp')) {
    const symbols = add[1]!.match(/\{[^}]+\}/g) ?? [];
    const colorful = symbols.length === 0 || /any/.test(add[1]!);
    const mask = colorful ? (identity || ANY) : symbols.reduce((m, s) => m | (MASK[s.replace(/[{}]/g, '').toUpperCase()] ?? 0), 0); // {C} stays colourless (0)
    out.mana = { units: colorful ? 1 : Math.min(symbols.length, 3), mask, sick: /\bCreature\b/.test(card.typeLine.split(' // ')[0] ?? ''), tapped: entersTapped(text) };
  }
  const search = /search your library for (up to )?(a|an|one|two|three|\d+)?[^.]*?(?:land|plains|island|swamp|mountain|forest)[^.]*?(?:onto the battlefield)/.exec(text);
  if (!permanent || search) {
    if (search && roles.includes('ramp')) {
      const n = WORD_NUM[search[2] ?? 'a'] ?? Number(search[2]) ?? 1;
      const toHand = /into your hand/.test(text) ? 1 : 0;
      out.fetch = { toBattlefield: Math.max(1, n - toHand), toHand };
    }
  }
  const draw = /^(?:.*[.:] ?)?(?:you )?draw (a|an|one|two|three|four|five|\d+) cards?/.exec(text.replace(/\n/g, ' '));
  if (draw && roles.includes('draw') && !out.fetch && !/whenever|if you|unless/.test(text.slice(0, text.indexOf('draw')))) out.draw = WORD_NUM[draw[1]!] ?? Number(draw[1]) ?? 1;
  return out;
}

export function toSimDeck(entries: readonly DeckEntry[]): SimDeck {
  const deck = entries.filter((e) => e.board !== 'sideboard');
  const commanders = deck.filter((e) => e.board === 'commander');
  const identity = commanders.reduce((m, e) => m | e.card.colorIdentity, 0);
  const library: SimCard[] = [];
  for (const { card, qty } of deck.filter((e) => e.board === 'main')) {
    // Modal lands (spell on the front) are played as lands only if they'd otherwise be stuck; keep them as spells for simplicity.
    const sc = toSimCard(card, identity);
    if (isSpellLand(card)) sc.isLand = false;
    for (let i = 0; i < qty; i++) library.push(sc);
  }
  return { library, commanders: commanders.flatMap(({ card, qty }) => Array.from({ length: qty }, () => toSimCard(card, identity))), identity };
}

// ----------------------------------------------------------------------- rng

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------- payment

const popcount = (n: number) => { let c = 0; for (; n; n &= n - 1) c++; return c; };

/**
 * Find mana units that pay a cost, or null. `units` are masks of what each mana unit can be (0 = colourless only).
 * Returns the indices used, preferring inflexible units so flexible ones stay available.
 */
export function payCost(pips: readonly number[], generic: number, units: readonly number[]): number[] | null {
  if (pips.length + generic > units.length) return null;
  const order = units.map((m, i) => i).sort((a, b) => popcount(units[a]!) - popcount(units[b]!));
  const sortedPips = [...pips].sort((a, b) => popcount(a) - popcount(b));
  const used = new Set<number>();
  const assign = (k: number): boolean => {
    if (k === sortedPips.length) return true;
    for (const i of order) {
      if (used.has(i) || (units[i]! & sortedPips[k]!) === 0) continue;
      used.add(i);
      if (assign(k + 1)) return true;
      used.delete(i);
    }
    return false;
  };
  if (!assign(0)) return null;
  let need = generic;
  for (const i of order) { if (need === 0) break; if (!used.has(i)) { used.add(i); need--; } }
  return need === 0 ? [...used] : null;
}

// ---------------------------------------------------------------- simulation

export interface SimOptions {
  games: number;
  /** Turns to simulate (default 10). */
  turns?: number;
  seed?: number;
  onThePlay?: boolean;
  /** 'standard': London mulligan with a free first mulligan. 'none': always keep the first seven (for exact-maths tests). */
  mulligan?: 'standard' | 'none';
  /** Commander gives a free first mulligan; 60-card formats don't. Default true. */
  freeMulligan?: boolean;
}

export interface TurnStats {
  turn: number;
  avgLands: number;
  avgMana: number;
  /** Share of games with at least `turn` mana available this turn (before casting): "on curve". */
  onCurve: number;
  /** Share of games that have played a land every turn so far (lands on the battlefield >= turn). */
  landDrop: number;
  /** Share of games where something castable by mana count was stuck on colour this turn. */
  colorScrew: number;
  /** Share of games that have been colour-screwed on any turn up to this one. */
  colorScrewEver: number;
  /** Share of games where each commander has been cast by this turn. */
  commanderCast: number[];
}

export interface SimResult {
  games: number;
  turns: number;
  commanders: string[];
  opening: { landsDist: number[]; firstSevenKeepRate: number; avgMulligans: number; avgKeptLands: number };
  perTurn: TurnStats[];
  /** Median turn the first commander is cast (null if under half of games manage it within the turn limit). */
  commanderMedianTurn: Array<number | null>;
  /** Average turn on which 4, 5 and 6 mana first become available. */
  turnToMana: Record<number, { rate: number; avgTurn: number | null }>;
}

interface Perm { mask: number; units: number; ready: number; isLand: boolean }

export class Simulator {
  private readonly rng: () => number;
  private readonly turns: number;
  private games = 0;
  private landsDist = Array<number>(8).fill(0);
  private keepFirst = 0;
  private mullTotal = 0;
  private keptLandsTotal = 0;
  private lands: number[]; private mana: number[]; private onCurve: number[]; private landDrop: number[]; private screw: number[]; private screwEver: number[];
  private cast: number[][];
  private manaMilestone: Record<number, { reached: number; turnSum: number }> = { 4: { reached: 0, turnSum: 0 }, 5: { reached: 0, turnSum: 0 }, 6: { reached: 0, turnSum: 0 } };

  constructor(private readonly deck: SimDeck, private readonly opts: Omit<SimOptions, 'games'> = {}) {
    this.rng = mulberry32(opts.seed ?? 1);
    this.turns = opts.turns ?? 10;
    const z = () => Array<number>(this.turns + 1).fill(0);
    this.lands = z(); this.mana = z(); this.onCurve = z(); this.landDrop = z(); this.screw = z(); this.screwEver = z();
    this.cast = deck.commanders.map(() => z());
  }

  get gamesRun() { return this.games; }

  run(n: number): void { for (let i = 0; i < n; i++) this.playGame(); }

  private shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
    return a;
  }

  private keepable(hand: SimCard[], size: number): boolean {
    const l = hand.filter((c) => c.isLand).length;
    if (size >= 7) return l >= 2 && l <= 5;
    if (size >= 5) return l >= 2 && l <= 4;
    return true;
  }

  /** Choose cards to put on the bottom after a mulligan: excess lands first, otherwise the most expensive spells. */
  private bottom(hand: SimCard[], count: number): SimCard[] {
    const bottomed: SimCard[] = [];
    for (let i = 0; i < count; i++) {
      const lands = hand.filter((c) => c.isLand);
      let idx: number;
      if (lands.length > 3) idx = hand.indexOf(lands[lands.length - 1]!);
      else {
        let best = -1, bestCmc = -1;
        hand.forEach((c, k) => { if (!c.isLand && c.cmc > bestCmc) { best = k; bestCmc = c.cmc; } });
        idx = best >= 0 ? best : hand.length - 1;
      }
      bottomed.push(...hand.splice(idx, 1));
    }
    return bottomed;
  }

  private playGame(): void {
    const { deck } = this;
    let library = this.shuffle([...deck.library]);
    let hand = library.splice(0, 7);
    this.landsDist[Math.min(hand.filter((c) => c.isLand).length, 7)]!++;
    let mulligans = 0;
    const firstKept = this.opts.mulligan === 'none' || this.keepable(hand, 7);
    if (firstKept) this.keepFirst++;
    if (this.opts.mulligan !== 'none') {
      const free = this.opts.freeMulligan !== false;
      const kept = (m: number) => 7 - (free ? Math.max(0, m - 1) : m); // cards in hand after m mulligans
      while (!this.keepable(hand, kept(mulligans)) && mulligans < 4) {
        mulligans++;
        library = this.shuffle([...library, ...hand]);
        hand = library.splice(0, 7);
        const toBottom = 7 - kept(mulligans); // London mulligan: draw seven, bottom the difference
        library.push(...this.bottom(hand, toBottom));
      }
    }
    this.mullTotal += mulligans;
    this.keptLandsTotal += hand.filter((c) => c.isLand).length;

    const board: Perm[] = [];
    const castTurn = deck.commanders.map(() => 0);
    let everScrewed = false;
    const milestones = new Set<number>();

    for (let t = 1; t <= this.turns; t++) {
      if (t > 1 || !this.opts.onThePlay) { const c = library.shift(); if (c) hand.push(c); }

      // Land drop.
      const needed = this.neededColors(hand, board, castTurn);
      const landIdx = this.pickLand(hand, needed);
      if (landIdx >= 0) {
        const land = hand.splice(landIdx, 1)[0]!;
        board.push({ mask: land.colors, units: 1, ready: land.tapped ? t + 1 : t, isLand: true });
      }

      const units = (): number[] => board.filter((p) => p.ready <= t).flatMap((p) => Array<number>(p.units).fill(p.mask));
      let avail = units();
      this.mana[t]! += avail.length;
      if (avail.length >= t) this.onCurve[t]!++;
      for (const m of [4, 5, 6]) if (avail.length >= m && !milestones.has(m)) { milestones.add(m); this.manaMilestone[m]!.reached++; this.manaMilestone[m]!.turnSum += t; }

      // Colour screw check: something affordable by mana count but not by colour.
      const candidates = [...hand.filter((c) => !c.isLand), ...deck.commanders.filter((_, i) => !castTurn[i])];
      const screwed = candidates.some((c) => c.pips.length + c.generic <= avail.length && c.pips.length + c.generic > 0 && payCost(c.pips, c.generic, avail) === null);
      if (screwed) { this.screw[t]!++; everScrewed = true; }
      if (everScrewed) this.screwEver[t]!++;

      // Spells.
      for (let guard = 0; guard < 30; guard++) {
        const spend = (c: SimCard): boolean => {
          const paid = payCost(c.pips, c.generic, avail);
          if (!paid) return false;
          const keep = new Set(paid);
          avail = avail.filter((_, i) => !keep.has(i));
          return true;
        };
        let acted = false;
        for (let i = 0; i < deck.commanders.length && !acted; i++) {
          if (castTurn[i]) continue;
          if (spend(deck.commanders[i]!)) { castTurn[i] = t; acted = true; }
        }
        if (acted) continue;
        const byCost = (a: SimCard, b: SimCard) => a.cmc - b.cmc;
        const ramp = hand.filter((c) => (c.mana || c.fetch) && !c.isLand).sort(byCost).find((c) => payCost(c.pips, c.generic, avail) !== null);
        if (ramp && spend(ramp)) {
          hand.splice(hand.indexOf(ramp), 1);
          if (ramp.mana) {
            board.push({ mask: ramp.mana.mask, units: ramp.mana.units, ready: ramp.mana.sick || ramp.mana.tapped ? t + 1 : t, isLand: false });
            if (!ramp.mana.sick && !ramp.mana.tapped) avail.push(...Array<number>(ramp.mana.units).fill(ramp.mana.mask));
          }
          if (ramp.fetch) this.fetchLands(ramp.fetch, library, hand, board, t, needed);
          continue;
        }
        const drawer = hand.filter((c) => c.draw && !c.isLand).sort(byCost).find((c) => payCost(c.pips, c.generic, avail) !== null);
        if (drawer && spend(drawer)) {
          hand.splice(hand.indexOf(drawer), 1);
          hand.push(...library.splice(0, drawer.draw!));
          continue;
        }
        break;
      }

      const landCount = board.filter((p) => p.isLand).length;
      this.lands[t]! += landCount;
      if (landCount >= t) this.landDrop[t]!++;
      deck.commanders.forEach((_, i) => { if (castTurn[i] && castTurn[i]! <= t) this.cast[i]![t]!++; });
    }
    this.games++;
  }

  /**
   * Colours the hand (and uncast commanders) still lack sources for: a colour counts as needed while the most single-colour
   * pips any one card asks for exceeds the permanents on the battlefield that can make it. So a {W}{W} card keeps wanting Plains
   * until two are out. Hybrid pips are ignored here.
   */
  private neededColors(hand: SimCard[], board: Perm[], castTurn: number[]): number {
    const cards = [...hand.filter((x) => !x.isLand), ...this.deck.commanders.filter((_, i) => !castTurn[i])];
    let need = 0;
    for (const bit of [W, U, B, R, G]) {
      const want = Math.max(0, ...cards.map((c) => c.pips.filter((m) => m === bit).length));
      const have = board.filter((p) => p.mask & bit).length;
      if (want > have) need |= bit;
    }
    // Hybrid-only demands: if nothing on the battlefield can pay any of the colours of a hybrid pip, want one of them.
    let haveAny = 0;
    for (const p of board) haveAny |= p.mask;
    for (const c of cards) for (const m of c.pips) if (popcount(m) > 1 && (m & haveAny) === 0) need |= m;
    return need;
  }

  private pickLand(hand: SimCard[], needed: number): number {
    let best = -1, bestScore = -1;
    hand.forEach((c, i) => {
      if (!c.isLand) return;
      let score = popcount(c.colors & needed) * 3 + (c.tapped ? 0 : 1) + popcount(c.colors) * 0.1;
      if (c.colors === 0) score -= 0.5;
      if (score > bestScore) { best = i; bestScore = score; }
    });
    return best;
  }

  private fetchLands(f: { toBattlefield: number; toHand: number }, library: SimCard[], hand: SimCard[], board: Perm[], t: number, needed: number): void {
    const take = (): SimCard | undefined => {
      let idx = -1, bestScore = -1;
      library.forEach((c, i) => { if (!c.isLand) return; const s = popcount(c.colors & needed) * 3 + popcount(c.colors) * 0.1; if (s > bestScore) { idx = i; bestScore = s; } });
      return idx >= 0 ? library.splice(idx, 1)[0] : undefined;
    };
    for (let i = 0; i < f.toBattlefield; i++) { const l = take(); if (l) board.push({ mask: l.colors, units: 1, ready: t + 1, isLand: true }); }
    for (let i = 0; i < f.toHand; i++) { const l = take(); if (l) hand.push(l); }
  }

  result(): SimResult {
    const g = Math.max(1, this.games);
    const perTurn: TurnStats[] = [];
    for (let t = 1; t <= this.turns; t++) {
      perTurn.push({
        turn: t, avgLands: this.lands[t]! / g, avgMana: this.mana[t]! / g, onCurve: this.onCurve[t]! / g, landDrop: this.landDrop[t]! / g,
        colorScrew: this.screw[t]! / g, colorScrewEver: this.screwEver[t]! / g, commanderCast: this.cast.map((c) => c[t]! / g),
      });
    }
    const median = (i: number): number | null => { for (let t = 1; t <= this.turns; t++) if (this.cast[i]![t]! / g >= 0.5) return t; return null; };
    const turnToMana: SimResult['turnToMana'] = {};
    for (const m of [4, 5, 6]) { const r = this.manaMilestone[m]!; turnToMana[m] = { rate: r.reached / g, avgTurn: r.reached ? r.turnSum / r.reached : null }; }
    return {
      games: this.games, turns: this.turns, commanders: this.deck.commanders.map((c) => c.name),
      opening: { landsDist: this.landsDist.map((x) => x / g), firstSevenKeepRate: this.keepFirst / g, avgMulligans: this.mullTotal / g, avgKeptLands: this.keptLandsTotal / g },
      perTurn, commanderMedianTurn: this.deck.commanders.map((_, i) => median(i)), turnToMana,
    };
  }
}

export function simulate(deck: SimDeck, opts: SimOptions): SimResult {
  const sim = new Simulator(deck, opts);
  sim.run(opts.games);
  return sim.result();
}
