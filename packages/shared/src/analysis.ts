import { COMMANDER_DECK_SIZE, type DeckEntry } from './deck.js';
import { hypergeomAtLeast, minSources } from './hypergeom.js';
import { MANA_COLORS, parseManaCost, type ManaColor } from './mana.js';
import { isLand, isSpellLand, tagRoles, ROLES, ROLE_LABEL, type Role } from './roles.js';
import type { Card } from './types.js';

// ------------------------------------------------------------- assumptions

/**
 * Every number the analysis rests on, in one place so the UI can show it.
 *
 * Colour sources use exact hypergeometric probabilities (the method Frank Karsten popularised): the deck needs enough
 * sources that P(at least k sources among the cards seen by the turn you want to cast the spell) reaches a target that
 * slides with mana value, (89 + MV)%, from 90% for a one-drop to 96% for a seven-drop. Cards seen = 7 + turn (you draw on
 * turn 1 in multiplayer) + EXTRA_CARDS_SEEN.
 *
 * EXTRA_CARDS_SEEN is NOT from Karsten's article (which I couldn't access): with 0 the maths asks for 24 sources for a
 * one-drop pip and 37 for a double pip on turn 2, far more than Commander decks run. Two Commander values reported for his
 * 99-card table (19 and 30 sources) are matched to within one source by assuming ~2 extra cards, standing in for the free
 * Commander mulligan and slower multiplayer turns. Treat the output as a calibrated estimate, not his published table.
 */
export const ASSUMPTIONS = {
  deckSize: COMMANDER_DECK_SIZE - 1, // library size with a single commander
  extraCardsSeen: 2,
  targetBase: 0.89, // + 0.01 * mana value, capped at 0.96
  /** Land count: lands = a + b * avg MV (non-land) - c * (cheap ramp/draw), the formula widely reported for Karsten's 99-card Commander result. */
  landFormula: { a: 31.42, b: 3.13, c: 0.28 },
  cheapMv: 2,
} as const;

/** Rules of thumb for a typical Commander deck (not hard rules; the "you're short on X" report compares against these). */
export const ROLE_TARGETS: Partial<Record<Role, { min: number; max: number; note: string }>> = {
  ramp: { min: 8, max: 12, note: 'Most decks want 8-12 ramp pieces.' },
  draw: { min: 8, max: 12, note: 'Most decks want 8-12 sources of card advantage.' },
  removal: { min: 5, max: 10, note: 'Aim for 5-10 pieces of spot removal.' },
  wipe: { min: 1, max: 4, note: 'Usually 1-3 board wipes (fewer for creature-heavy decks).' },
};

// ----------------------------------------------------------------- results

export type Status = 'short' | 'ok' | 'high';

export interface RoleSummary { role: Role; label: string; count: number; cards: Array<{ name: string; qty: number }>; target?: { min: number; max: number }; status?: Status }

export interface SourcePattern {
  /** e.g. "CC" for two pips of this colour */
  pips: number;
  /** Mana value the pips appear at (the turn you want to cast it on). */
  mv: number;
  cards: string[];
  /** Sources needed in a 99-card library; null = not reachable even with every card a source. */
  needed: number | null;
  /** The pattern is the commander's. */
  commander: boolean;
}

export interface ColorAnalysis {
  color: ManaColor;
  pips: number; // total weighted pips in the deck (hybrid split between options)
  cards: number; // cards with at least one pip of this colour (by qty)
  /** Lands that tap for this colour (spell-lands count half; fetch-style lands count for every identity colour). */
  landSources: number;
  /** Non-land cards that produce this colour (rocks, dorks); shown but not counted in landSources. */
  otherSources: number;
  patterns: SourcePattern[];
  /** Sources recommended: the strictest pattern shared by 2+ cards or the commander. */
  needed: number | null;
  status: Status | null;
  /** Cards whose pip pattern is stricter than the recommendation (hard to cast on time). */
  outliers: string[];
}

export interface Finding { severity: 'warn' | 'info' | 'ok'; title: string; detail: string }

export interface DeckAnalysis {
  /** Cards counted: main deck + commander, ignoring the sideboard. */
  libraryCards: number;
  complete: boolean;
  lands: { count: number; recommended: number; avgMv: number; cheapRampDraw: number; status: Status | null };
  curve: { buckets: number[]; avgMv: number; nonland: number };
  pips: Record<ManaColor, number>;
  colors: ColorAnalysis[];
  roles: RoleSummary[];
  findings: Finding[];
}

// ------------------------------------------------------------------ helpers

const front = (c: Card) => c.typeLine.split(' // ')[0] ?? c.typeLine;
const bit = (color: ManaColor) => ({ W: 1, U: 2, B: 4, R: 8, G: 16 })[color];

const targetFor = (mv: number) => Math.min(0.96, ASSUMPTIONS.targetBase + 0.01 * Math.max(1, mv));

/** Sources needed to cast a spell with `pips` of one colour at mana value `mv`. */
export function sourcesNeeded(pips: number, mv: number, opts: { deckSize?: number; extraCards?: number } = {}): number | null {
  const turn = Math.max(1, mv, pips);
  const seen = 7 + turn + (opts.extraCards ?? ASSUMPTIONS.extraCardsSeen);
  return minSources(opts.deckSize ?? ASSUMPTIONS.deckSize, seen, pips, targetFor(mv));
}

/** P(at least `pips` sources by the turn) for a deck with `sources` of that colour. Exposed for the UI/tests. */
export function castProbability(sources: number, pips: number, mv: number, opts: { deckSize?: number; extraCards?: number } = {}): number {
  const turn = Math.max(1, mv, pips);
  return hypergeomAtLeast(opts.deckSize ?? ASSUMPTIONS.deckSize, sources, 7 + turn + (opts.extraCards ?? ASSUMPTIONS.extraCardsSeen), pips);
}

const isFetchLand = (c: Card) => isLand(c) && c.producedMana === 0 && /search your library for [^.]*(?:land|plains|island|swamp|mountain|forest)/i.test(c.oracleText);

// ----------------------------------------------------------------- analysis

export function analyzeDeck(entries: readonly DeckEntry[]): DeckAnalysis {
  const deck = entries.filter((e) => e.board !== 'sideboard');
  const commanders = deck.filter((e) => e.board === 'commander');
  const library = deck.filter((e) => e.board === 'main');
  const libraryCards = library.reduce((n, e) => n + e.qty, 0);
  const identity = commanders.reduce((m, e) => m | e.card.colorIdentity, 0);
  const complete = libraryCards + commanders.reduce((n, e) => n + e.qty, 0) >= COMMANDER_DECK_SIZE;

  // ---- curve (non-land, library only; commander is in the command zone)
  const buckets = Array<number>(8).fill(0);
  let nonland = 0, mvSum = 0, cheapRampDraw = 0;
  for (const { card, qty } of library) {
    if (isLand(card)) continue;
    const mv = Math.round(card.cmc);
    buckets[Math.min(mv, 7)]! += qty;
    nonland += qty;
    mvSum += card.cmc * qty;
  }
  const avgMv = nonland ? mvSum / nonland : 0;

  // ---- roles
  const roleCards = new Map<Role, Array<{ name: string; qty: number }>>(ROLES.map((r) => [r, []]));
  for (const { card, qty } of library) {
    const roles = tagRoles(card);
    for (const r of roles) roleCards.get(r)!.push({ name: card.name, qty });
    if (!isLand(card) && card.cmc <= ASSUMPTIONS.cheapMv && (roles.includes('ramp') || roles.includes('draw'))) cheapRampDraw += qty;
  }
  const roles: RoleSummary[] = ROLES.map((role) => {
    const cards = roleCards.get(role)!.sort((a, b) => a.name.localeCompare(b.name));
    const count = cards.reduce((n, c) => n + c.qty, 0);
    const t = ROLE_TARGETS[role];
    return { role, label: ROLE_LABEL[role], count, cards, ...(t ? { target: { min: t.min, max: t.max }, status: (count < t.min ? 'short' : count > t.max ? 'high' : 'ok') as Status } : {}) };
  });

  // ---- lands
  const landCount = library.reduce((n, { card, qty }) => n + (isLand(card) ? qty : isSpellLand(card) ? qty * 0.5 : 0), 0);
  const { a, b, c } = ASSUMPTIONS.landFormula;
  const recommended = Math.round(a + b * avgMv - c * cheapRampDraw);
  const landStatus: Status | null = !complete ? null : landCount < recommended - 1 ? 'short' : landCount > recommended + 2 ? 'high' : 'ok';

  // ---- pips and colour sources
  const pips: Record<ManaColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const cardsWith: Record<ManaColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const patternMap = new Map<ManaColor, Map<string, SourcePattern>>(MANA_COLORS.map((col) => [col, new Map()]));
  for (const { card, qty, board } of deck) {
    if (isLand(card)) continue;
    const cost = parseManaCost(card.manaCost);
    for (const col of MANA_COLORS) {
      const fixed = cost.pips[col];
      const share = cost.hybrid.filter((h) => h.includes(col)).reduce((n, h) => n + 1 / h.length, 0) + cost.phyrexian.filter((p) => p === col).length;
      pips[col] += (fixed + share) * qty;
      if (fixed + share > 0) cardsWith[col] += qty;
      if (fixed < 1) continue;
      const mv = Math.max(1, Math.round(card.cmc));
      const key = `${fixed}@${mv}`;
      const map = patternMap.get(col)!;
      const cur = map.get(key) ?? { pips: fixed, mv, cards: [], needed: sourcesNeeded(fixed, mv), commander: false };
      cur.cards.push(card.name);
      if (board === 'commander') cur.commander = true;
      map.set(key, cur);
    }
  }

  const colors: ColorAnalysis[] = [];
  for (const color of MANA_COLORS) {
    const patterns = [...patternMap.get(color)!.values()].sort((x, y) => x.mv - y.mv || x.pips - y.pips);
    if (patterns.length === 0 && !(identity & bit(color))) continue;

    let landSources = 0, otherSources = 0;
    for (const { card, qty } of library) {
      if (isLand(card)) { if (card.producedMana & bit(color) || (isFetchLand(card) && identity & bit(color))) landSources += qty; }
      else if (isSpellLand(card)) { if (card.producedMana & bit(color)) landSources += 0.5 * qty; }
      else if (card.producedMana & bit(color) && tagRoles(card).includes('ramp')) otherSources += qty;
    }

    // Recommendation: the strictest pattern that 2+ cards share or that the commander has; a lone hard-to-cast
    // card is reported as an outlier instead of dictating the whole mana base.
    const counted = patterns.filter((p) => p.cards.length >= 2 || p.commander);
    const pool = counted.length ? counted : patterns;
    let needed: number | null = null;
    for (const p of pool) {
      if (p.needed === null) continue;
      needed = needed === null ? p.needed : Math.max(needed, p.needed);
    }
    const outliers = patterns.filter((p) => !pool.includes(p) && (p.needed === null || (needed !== null && p.needed > needed))).flatMap((p) => p.cards);
    const status: Status | null = needed === null || !complete ? null : landSources < needed - 2 ? 'short' : landSources > needed + 6 ? 'high' : 'ok';
    colors.push({ color, pips: pips[color], cards: cardsWith[color], landSources, otherSources, patterns, needed, status, outliers });
  }

  // ---- findings
  const findings: Finding[] = [];
  if (!complete) findings.push({ severity: 'info', title: 'Deck is incomplete', detail: `${libraryCards + commanders.reduce((n, e) => n + e.qty, 0)} of ${COMMANDER_DECK_SIZE} cards, so land and source checks are held back until it's full.` });
  if (landStatus === 'short') findings.push({ severity: 'warn', title: `You're short on lands: ${fmt(landCount)} (suggested ${recommended})`, detail: `Based on average mana value ${avgMv.toFixed(2)} and ${cheapRampDraw} cheap ramp/draw spells.` });
  if (landStatus === 'high') findings.push({ severity: 'info', title: `Land count is high: ${fmt(landCount)} (suggested ${recommended})`, detail: 'Fine for decks that want to flood out or run land-based engines; otherwise consider more spells.' });
  for (const r of roles) {
    if (!r.target) continue;
    if (r.status === 'short') findings.push({ severity: 'warn', title: `You're short on ${r.label.toLowerCase()}: ${r.count} (aim for ${r.target.min}-${r.target.max})`, detail: ROLE_TARGETS[r.role]!.note });
    else if (r.status === 'high') findings.push({ severity: 'info', title: `Lots of ${r.label.toLowerCase()}: ${r.count} (usual range ${r.target.min}-${r.target.max})`, detail: ROLE_TARGETS[r.role]!.note });
  }
  const wins = roles.find((r) => r.role === 'wincon')!;
  if (wins.count === 0 && libraryCards > 0) findings.push({ severity: 'info', title: 'No explicit win condition detected', detail: 'The tagger only recognises alternate wins, mass drain and overrun effects; combat-based plans won\'t show up here.' });
  for (const col of colors) {
    if (col.status === 'short') findings.push({ severity: 'warn', title: `${col.color} sources are low: ${fmt(col.landSources)} (suggested ${col.needed})`, detail: `Needed to cast your ${col.color} cards on time; ${col.otherSources} non-land ${col.color} producers don't count towards this.` });
  }
  const hard = colors.filter((col) => col.outliers.length > 0);
  if (hard.length) findings.push({ severity: 'info', title: 'Hard-to-cast cards', detail: hard.map((col) => `${col.outliers.join(', ')} (${col.color})`).join('; ') + ': these ask for more coloured sources than the rest of your deck, so expect to cast them later.' });
  if (nonland > 0 && avgMv > 3.5) findings.push({ severity: 'info', title: `Top-heavy curve (average mana value ${avgMv.toFixed(2)})`, detail: 'Expect to need extra ramp and lands.' });
  if (findings.every((f) => f.severity !== 'warn') && libraryCards > 0 && complete) findings.push({ severity: 'ok', title: 'No obvious problems found', detail: 'Lands, colour sources and key roles are within the usual ranges.' });

  return { libraryCards, complete, lands: { count: landCount, recommended, avgMv, cheapRampDraw, status: landStatus }, curve: { buckets, avgMv, nonland }, pips, colors, roles, findings };
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
