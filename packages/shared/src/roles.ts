import type { Card } from './types.js';

export const ROLES = ['ramp', 'draw', 'removal', 'wipe', 'counter', 'tutor', 'recursion', 'protection', 'wincon'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  ramp: 'Ramp', draw: 'Card advantage', removal: 'Spot removal', wipe: 'Board wipes', counter: 'Counterspells',
  tutor: 'Tutors', recursion: 'Recursion', protection: 'Protection', wincon: 'Win conditions',
};

const frontType = (c: Card) => c.typeLine.split(' // ')[0] ?? c.typeLine;
export const isLand = (c: Card) => /\bLand\b/.test(frontType(c));
/** A spell on the front with a land on the back (modal double-faced land). */
export const isSpellLand = (c: Card) => !isLand(c) && / \/\/ .*\bLand\b/.test(c.typeLine);

/** Oracle text with reminder text removed and the card's own name replaced by "~", lower-cased. */
function normalise(c: Card): string {
  return c.oracleText
    .replace(/\([^)]*\)/g, '')
    .split(c.name).join('~')
    .split(c.name.split(',')[0]!).join('~')
    .toLowerCase();
}

/**
 * Heuristic role tagging from oracle text. It is deliberately simple and transparent (regexes, no hidden data),
 * so the UI lists which cards counted. A card can have several roles. Lands are only tagged when they're not
 * just lands (e.g. a land that draws), and never as ramp.
 */
export function tagRoles(card: Card): Role[] {
  const t = normalise(card);
  const type = frontType(card);
  const land = isLand(card);
  const permanentSpell = !land && !/\b(Instant|Sorcery)\b/.test(type);
  const roles = new Set<Role>();

  // Ramp: mana rocks/dorks, land fetch, extra land drops from hand, treasure makers.
  if (!land) {
    if (permanentSpell && /\badd (?:\{[^}]+\}|one mana|an amount|x mana|mana)/.test(t) && /(\{t\}|tap|sacrifice|whenever|at the beginning)/.test(t)) roles.add('ramp');
    if (/search your library for [^.]*?(?:land|forest|plains|island|swamp|mountain)s?(?: or [a-z]+)? cards?[^.]*?onto the battlefield/.test(t)) roles.add('ramp');
    if (/put (?:a|an|up to \w+) (?:basic )?land cards? (?:from your hand|onto the battlefield)/.test(t)) roles.add('ramp');
    if (/create (?:a|an|one|two|three|x|\w+) (?:tapped )?treasure/.test(t) && !/treasure token for each opponent/.test(t)) roles.add('ramp');
    if (/you may play (?:an )?additional lands?/.test(t)) roles.add('ramp');
  }

  // Card advantage: you (or each player) draw, or impulse-draw / dig into your hand.
  for (const m of t.matchAll(/\bdraws?\b/g)) {
    const idx = m.index ?? 0;
    const before = t.slice(Math.max(0, idx - 30), idx);
    const after = t.slice(idx, idx + 60);
    if (/(?:each opponent|target opponent|an opponent|that player|defending player|its controller|that creature's controller)\s+(?:may\s+)?$/.test(before)) continue; // opponent draws
    if (/(?:whenever|each time|if|when|unless)\s+(?:you|a player|each player|an opponent)\s+(?:would\s+|may\s+)?$/.test(before)) continue; // a trigger on drawing, not drawing
    if (/^draws?\s+(?:a card|an additional card|\d+ cards?|\w+ cards?|x cards?|that many cards?|cards?(?: equal| for each)|a number of cards|additional cards?)/.test(after)) { roles.add('draw'); break; }
  }
  if (/exile the top (?:\w+ )?cards? of your library[^.]*\. (?:until|you may)[^.]*(?:play|cast)/.test(t) || /you may (?:play|cast) (?:cards|that card|those cards|the exiled cards?) (?:exiled|from exile)/.test(t) || /exile the top card of your library\. until[^.]*you may play/.test(t)) roles.add('draw');
  if (/(?:reveal|look at) the top \w+ cards? of your library[\s\S]{0,220}?into your hand/.test(t)) roles.add('draw');

  // Spot removal.
  if (/(?:destroy|exile) (?:up to \w+ )?target (?!card|spell|player|opponent|land card|creature card|permanent card)(?:[a-z-]+ )*?(?:creature|artifact|enchantment|planeswalker|permanent|battle)/.test(t) && !/from (?:a|your|target player's) graveyard/.test(t.split(/destroy|exile/)[1] ?? '')) roles.add('removal');
  if (/deals? (?:x|\d+) damage to (?:target|any target|up to \w+ target|each of up to)/.test(t) && !/damage to target player or planeswalker/.test(t)) roles.add('removal');
  if (/damage divided as you choose among/.test(t) || /shuffles? (?:it|that [a-z]+|target [a-z ]+) into (?:its|their) (?:owner's )?library/.test(t)) roles.add('removal');
  if (/(?:destroy|exile) each (?:[a-z, ]*?)(?:creature|artifact|enchantment|permanent)s?/.test(t) && /(?:with|mana value|power|toughness)/.test(t) && !/each (?:opponent|player)'s/.test(t)) roles.add('wipe');
  if (/target creature gets -(?:x|\d+)\/-(?:x|\d+)|\bfights?\b|put (?:a|\w+) [^.]*\bcounters? on target creature[^.]*(?:-1\/-1)/.test(t)) roles.add('removal');
  if (/return target (?:nonland )?(?:permanent|creature)[^.]*to its owner's hand/.test(t) && /^(?:instant|sorcery)/i.test(type)) roles.add('removal');

  // Board wipes.
  if (/(?:destroy|exile) all (?:other )?(?:nonland |non-\w+ |noncreature )?(?:creatures|permanents|artifacts|enchantments|planeswalkers|lands)/.test(t)
    || /all creatures get -(?:x|\d+)\/-(?:x|\d+)/.test(t)
    || /deals? (?:x|\d+) damage to each (?:other )?(?:non-\w+ )?creature/.test(t)
    || /each (?:player|creature)[^.]*sacrifices? (?:all|each)[^.]*creatures?/.test(t)
    || /return all (?:nonland )?(?:creatures|permanents)[^.]*to their owners' hands/.test(t)) roles.add('wipe');

  // Interaction & utility.
  if (/counter (?:target|up to \w+ target|all)[^.]*?(?:spell|ability)/.test(t)) roles.add('counter');
  if (/search your library for (?!(?:up to \w+ |a |an |one |two |three )?(?:basic |snow )?(?:land|forest|plains|island|swamp|mountain)s?(?: or [a-z]+)?(?: cards?|,| or))/.test(t) && /(?:into your hand|on top of your library|reveal|put (?:it|that card|them)|onto the battlefield)/.test(t) && !roles.has('ramp')) roles.add('tutor');
  if (/(?:return|put) [^.]*?cards? [^.]*?from (?:a|your|target player's|an opponent's|any) graveyards? (?:to|onto|into) (?:your hand|the battlefield|their owner|play)/.test(t)
    || /return enchanted creature card to the battlefield/.test(t)
    || /return (?:target|up to \w+ target|another target|all) [^.]*?card[^.]*? to (?:your hand|the battlefield)/.test(t) && /graveyard/.test(t)) roles.add('recursion');
  if (/(?:gains?|have|has) (?:[a-z, ]+ and )?(?:hexproof|indestructible|shroud|protection from)|(?:phase out|phases out)|regenerate target/.test(t) && /(?:target|you control|other|equipped|enchanted)/.test(t)) roles.add('protection');

  // Win conditions: alternate wins, mass drain, overrun effects.
  if (/you win the game|target (?:player|opponent) loses the game|each opponent loses (?:x|[3-9]|\d{2,}|that much) life|each opponent loses life equal/.test(t)) roles.add('wincon');
  if (/creatures you control (?:gain [a-z ]+ and )?get \+(?:x|\d+)\/\+(?:x|\d+)/.test(t) && /until end of turn/.test(t) && /trample|double strike|can't be blocked|menace/.test(t)) roles.add('wincon');
  if (/extra combat phase|additional combat phase|double strike to each/.test(t) && !type.includes('Creature')) roles.add('wincon');

  return ROLES.filter((r) => roles.has(r));
}
