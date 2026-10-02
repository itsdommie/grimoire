import { describe, expect, it } from 'vitest';
import { formatDeckList, parseDeckList, validateCommander, validPair, copyLimit, canBeCommander, type DeckEntry } from './deck.js';
import { W, U, B, R, G } from './colors.js';
import type { Card } from './types.js';

let n = 0;
const c = (name: string, o: Partial<Card> = {}): Card => ({
  id: `id-${n++}`, name, manaCost: '', cmc: 0, typeLine: 'Instant', oracleText: '', colors: 0, colorIdentity: 0, producedMana: 0,
  keywords: [], power: null, toughness: null, loyalty: null, rarity: 'common', setCode: 'tst', layout: 'normal', edhrecRank: null,
  usd: null, imageUrl: null, scryfallUri: '', legalities: { commander: 'legal' }, ...o,
});
const e = (card: Card, board: DeckEntry['board'] = 'main', qty = 1): DeckEntry => ({ card, qty, board });

const atraxa = c("Atraxa, Praetors' Voice", { typeLine: 'Legendary Creature — Phyrexian Angel Horror', colorIdentity: W | U | B | G });
const codes = (entries: DeckEntry[]) => validateCommander(entries).map((i) => `${i.severity}:${i.code}`);

describe('copyLimit / canBeCommander', () => {
  it('basics and any-number cards are unlimited', () => {
    expect(copyLimit(c('Forest', { typeLine: 'Basic Land — Forest' }))).toBe(Infinity);
    expect(copyLimit(c('Snow-Covered Forest', { typeLine: 'Basic Snow Land — Forest' }))).toBe(Infinity);
    expect(copyLimit(c('Relentless Rats', { oracleText: 'A deck can have any number of cards named Relentless Rats.' }))).toBe(Infinity);
  });
  it('"up to N" cards', () => expect(copyLimit(c('Seven Dwarves', { oracleText: 'A deck can have up to seven cards named Seven Dwarves.' }))).toBe(7));
  it('everything else is a singleton', () => expect(copyLimit(c('Sol Ring', { typeLine: 'Artifact' }))).toBe(1));
  it('commander eligibility', () => {
    expect(canBeCommander(atraxa)).toBe(true);
    expect(canBeCommander(c('Bolt'))).toBe(false);
    expect(canBeCommander(c('Teferi', { typeLine: 'Legendary Planeswalker — Teferi', oracleText: 'Teferi can be your commander.' }))).toBe(true);
    expect(canBeCommander(c('Jace // Jace', { typeLine: 'Legendary Creature — Human // Legendary Planeswalker — Jace' }))).toBe(true);
    expect(canBeCommander(c('Back Face Only', { typeLine: 'Land // Legendary Creature — Spirit' }))).toBe(false);
    expect(canBeCommander(c('Esika Chariot', { typeLine: 'Legendary Artifact — Vehicle', power: '4' }))).toBe(true);
    expect(canBeCommander(c('Elevator', { typeLine: 'Legendary Artifact — Spacecraft' }))).toBe(false);
  });
});

describe('validPair', () => {
  const leg = 'Legendary Creature — Human';
  it('plain Partner', () => {
    const a = c('A', { typeLine: leg, oracleText: 'Partner (You can have two commanders if both have partner.)' });
    const b = c('B', { typeLine: leg, oracleText: 'Partner' });
    expect(validPair(a, b)).toBe(true);
    expect(validPair(a, atraxa)).toBe(false);
  });
  it('Partner with requires the named card', () => {
    const pir = c('Pir', { typeLine: leg, oracleText: 'Partner with Toothy (When this enters...)' });
    const toothy = c('Toothy', { typeLine: leg, oracleText: 'Partner with Pir (When this enters...)' });
    const plain = c('Plain', { typeLine: leg, oracleText: 'Partner' });
    expect(validPair(pir, toothy)).toBe(true);
    expect(validPair(pir, plain)).toBe(false);
  });
  it('Partner variants must match', () => {
    const a = c('A', { typeLine: leg, oracleText: 'Partner—Survivors' });
    expect(validPair(a, c('B', { typeLine: leg, oracleText: 'Partner—Survivors' }))).toBe(true);
    expect(validPair(a, c('C', { typeLine: leg, oracleText: 'Partner—Father & Son' }))).toBe(false);
    expect(validPair(a, c('D', { typeLine: leg, oracleText: 'Partner' }))).toBe(false);
  });
  it('Background and Doctor\'s companion', () => {
    const bgCmdr = c('Wilson', { typeLine: leg, oracleText: 'Choose a Background' });
    expect(validPair(bgCmdr, c('Raised by Giants', { typeLine: 'Legendary Enchantment — Background' }))).toBe(true);
    expect(validPair(bgCmdr, atraxa)).toBe(false);
    const comp = c('Donna', { typeLine: leg, oracleText: "Doctor's companion" });
    expect(validPair(comp, c('Ten', { typeLine: 'Legendary Creature — Time Lord Doctor' }))).toBe(true);
  });
});

describe('validateCommander', () => {
  it('warns without a commander and when short', () => {
    expect(codes([e(c('Sol Ring'))])).toEqual(['warning:commander-count', 'warning:deck-size']);
  });
  it('a clean 100-card deck has no issues', () => {
    const forest = c('Forest', { typeLine: 'Basic Land — Forest', colorIdentity: G });
    expect(validateCommander([e(atraxa, 'commander'), e(forest, 'main', 99)])).toEqual([]);
  });
  it('flags >100 cards', () => {
    expect(codes([e(atraxa, 'commander'), e(c('Forest', { typeLine: 'Basic Land — Forest' }), 'main', 99), e(c('Extra'))])).toContain('error:deck-size');
  });
  it('flags singleton violations but not basics', () => {
    const bolt = c('Bolt');
    const issues = validateCommander([e(atraxa, 'commander'), e(bolt, 'main', 2), e(c('Island', { typeLine: 'Basic Land — Island' }), 'main', 30)]);
    expect(issues.find((i) => i.code === 'singleton')?.cards).toEqual(['Bolt']);
  });
  it('counts a commander also in the main deck as a duplicate (via board move it cannot happen, but imports can)', () => {
    expect(codes([e(atraxa, 'commander'), e(atraxa, 'main')])).toContain('error:singleton');
  });
  it('flags colour identity violations', () => {
    const fireball = c('Fireball', { colorIdentity: R });
    const issues = validateCommander([e(atraxa, 'commander'), e(fireball)]);
    expect(issues.find((i) => i.code === 'color-identity')?.cards).toEqual(['Fireball']);
  });
  it('skips colour identity when there is no commander', () => {
    expect(codes([e(c('Fireball', { colorIdentity: R }))])).not.toContain('error:color-identity');
  });
  it('flags banned and non-legal cards separately; ignores the sideboard', () => {
    const issues = validateCommander([
      e(atraxa, 'commander'),
      e(c('Sway of the Stars', { legalities: { commander: 'banned' } })),
      e(c('Unfinity Thing', { legalities: {} })),
      e(c('Banned But Benched', { legalities: { commander: 'banned' } }), 'sideboard'),
    ]);
    expect(issues.find((i) => i.code === 'banned')?.cards).toEqual(['Sway of the Stars']);
    expect(issues.find((i) => i.code === 'not-legal')?.cards).toEqual(['Unfinity Thing']);
  });
  it('rejects ineligible commanders and bad pairs', () => {
    expect(codes([e(c('Bolt'), 'commander')])).toContain('error:commander-ineligible');
    expect(codes([e(atraxa, 'commander'), e(c('Other', { typeLine: 'Legendary Creature — Elf' }), 'commander')])).toContain('error:commander-pair');
  });
  it('colour identity is the union across two commanders', () => {
    const a = c('A', { typeLine: 'Legendary Creature — Elf', oracleText: 'Partner', colorIdentity: R });
    const b = c('B', { typeLine: 'Legendary Creature — Elf', oracleText: 'Partner', colorIdentity: G });
    const issues = validateCommander([e(a, 'commander'), e(b, 'commander'), e(c('Gruul Charm', { colorIdentity: R | G })), e(c('Counterspell', { colorIdentity: U }))]);
    expect(issues.find((i) => i.code === 'color-identity')?.cards).toEqual(['Counterspell']);
  });
});

describe('parseDeckList', () => {
  it('parses plain lists, quantities with and without x, and bare names', () => {
    expect(parseDeckList('1 Sol Ring\n4x Island\nCounterspell')).toEqual([
      { qty: 1, name: 'Sol Ring', board: 'main' },
      { qty: 4, name: 'Island', board: 'main' },
      { qty: 1, name: 'Counterspell', board: 'main' },
    ]);
  });
  it('strips Moxfield and Archidekt decorations', () => {
    const lines = parseDeckList("1 Sol Ring (CMM) 400 *F*\n1x Arcane Signet (cmm) 297 [Ramp,Mana{top}] ^Foil^\n1 Cultivate #ramp\n1 Rhystic Study (PCY)");
    expect(lines.map((l) => l.name)).toEqual(['Sol Ring', 'Arcane Signet', 'Cultivate', 'Rhystic Study']);
    expect(lines[0]).toMatchObject({ set: 'cmm', collector: '400' });
    expect(lines[3]).toMatchObject({ set: 'pcy' });
  });
  it('honours section headers and SB: prefixes', () => {
    const lines = parseDeckList('Commander\n1 Atraxa, Praetors\' Voice\n\nDeck (2)\n1 Sol Ring\nSideboard\n1 Bolt\nSB: 1 Shock');
    expect(lines.map((l) => [l.name, l.board])).toEqual([["Atraxa, Praetors' Voice", 'commander'], ['Sol Ring', 'main'], ['Bolt', 'sideboard'], ['Shock', 'sideboard']]);
  });
  it('ignores comments and blank lines, keeps CRLF safe', () => {
    expect(parseDeckList('// my deck\r\n\r\n1 Sol Ring\r\n')).toHaveLength(1);
  });
  it('keeps names that contain commas, slashes and apostrophes', () => {
    expect(parseDeckList("1 Fire // Ice\n1 Jace, Vryn's Prodigy").map((l) => l.name)).toEqual(['Fire // Ice', "Jace, Vryn's Prodigy"]);
  });
});

describe('formatDeckList', () => {
  const entries = [e(c('Sol Ring')), e(atraxa, 'commander'), e(c('Bolt'), 'sideboard'), e(c('Island'), 'main', 3)];
  it('sectioned', () => expect(formatDeckList(entries)).toBe("Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n3 Island\n1 Sol Ring\n\nSideboard\n1 Bolt\n"));
  it('plain', () => expect(formatDeckList(entries, 'plain')).toBe("1 Atraxa, Praetors' Voice\n3 Island\n1 Sol Ring\n1 Bolt\n"));
  it('round-trips through the parser', () => {
    const parsed = parseDeckList(formatDeckList(entries));
    expect(parsed.map((l) => `${l.qty} ${l.name} ${l.board}`)).toEqual(["1 Atraxa, Praetors' Voice commander", '3 Island main', '1 Sol Ring main', '1 Bolt sideboard']);
  });
});
