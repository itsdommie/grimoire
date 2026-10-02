import { beforeAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { SearchError } from '@grimoire/shared';
import { openDb } from './db.js';
import { loadJsonl } from './ingest.js';
import { searchCards } from './cards.js';
import type { ScryfallCard } from './scryfall.js';

const base = { layout: 'normal', rarity: 'common', set: 'tst', scryfall_uri: 'https://scryfall.com/x' };
const std = { commander: 'legal', modern: 'legal' };
let n = 0;
const card = (c: Partial<ScryfallCard> & { name: string }): ScryfallCard => ({ ...base, oracle_id: `id-${n++}`, legalities: std, ...c });

const FIXTURE: ScryfallCard[] = [
  card({ name: 'Lightning Bolt', mana_cost: '{R}', cmc: 1, type_line: 'Instant', oracle_text: 'Lightning Bolt deals 3 damage to any target.', colors: ['R'], color_identity: ['R'], rarity: 'uncommon', legalities: { commander: 'legal', modern: 'legal', legacy: 'legal' } }),
  card({ name: 'Llanowar Elves', mana_cost: '{G}', cmc: 1, type_line: 'Creature — Elf Druid', oracle_text: '{T}: Add {G}.', colors: ['G'], color_identity: ['G'], produced_mana: ['G'], power: '1', toughness: '1' }),
  card({ name: 'Divination', mana_cost: '{2}{U}', cmc: 3, type_line: 'Sorcery', oracle_text: 'Draw two cards.', colors: ['U'], color_identity: ['U'] }),
  card({ name: 'Rhystic Study', mana_cost: '{2}{U}', cmc: 3, type_line: 'Enchantment', oracle_text: 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.', colors: ['U'], color_identity: ['U'], rarity: 'rare' }),
  card({ name: 'Gruul Charm', mana_cost: '{R}{G}', cmc: 2, type_line: 'Instant', oracle_text: 'Choose one — ...', colors: ['R', 'G'], color_identity: ['R', 'G'] }),
  card({ name: 'Sol Ring', mana_cost: '{1}', cmc: 1, type_line: 'Artifact', oracle_text: '{T}: Add {C}{C}.', colors: [], color_identity: [], produced_mana: [], rarity: 'uncommon' }),
  card({ name: 'Tarmogoyf', mana_cost: '{1}{G}', cmc: 2, type_line: 'Creature — Lhurgoyf', oracle_text: "Tarmogoyf's power is equal to...", colors: ['G'], color_identity: ['G'], power: '*', toughness: '1+*', legalities: { commander: 'legal', modern: 'banned' } }),
  card({ name: 'Atraxa, Praetors\' Voice', mana_cost: '{G}{W}{U}{B}', cmc: 4, type_line: 'Legendary Creature — Phyrexian Angel Horror', oracle_text: 'Flying, vigilance, deathtouch, lifelink', colors: ['W', 'U', 'B', 'G'], color_identity: ['W', 'U', 'B', 'G'], keywords: ['Flying', 'Vigilance'], rarity: 'mythic', power: '4', toughness: '4' }),
  card({ name: 'Delver of Secrets // Insectile Aberration', layout: 'transform', cmc: 1, type_line: 'Creature — Human Wizard // Creature — Human Insect', colors: undefined, color_identity: ['U'], card_faces: [{ mana_cost: '{U}', oracle_text: 'At the beginning of your upkeep, look at the top card of your library.', colors: ['U'], power: '1', toughness: '1' }, { mana_cost: '', oracle_text: 'Flying', colors: ['U'], power: '3', toughness: '2' }] }),
  card({ name: 'Token Goblin', layout: 'token', type_line: 'Token Creature — Goblin' }),
];

let db: Database.Database;
const names = (q: string) => searchCards(db, { query: q }).cards.map((c) => c.name);

beforeAll(async () => {
  db = openDb(':memory:');
  async function* lines() { for (const c of FIXTURE) yield JSON.stringify(c); }
  await loadJsonl(db, lines());
});

describe('ingest', () => {
  it('skips tokens', () => expect(names('goblin')).toEqual([]));
  it('merges face data for multi-faced cards', () => {
    const [d] = searchCards(db, { query: 'delver' }).cards;
    expect(d?.manaCost).toBe('{U}');
    expect(d?.colors).toBe(2);
    expect(d?.oracleText).toContain('Flying');
  });
});

describe('search', () => {
  it('matches bare words against names', () => expect(names('bolt')).toEqual(['Lightning Bolt']));
  it('exact names', () => expect(names('!"sol ring"')).toEqual(['Sol Ring']));
  it('type and colour', () => expect(names('t:creature c:g')).toEqual(["Atraxa, Praetors' Voice", 'Llanowar Elves', 'Tarmogoyf']));
  it('c: is "at least"; c= is exact', () => {
    expect(names('c:r')).toEqual(['Gruul Charm', 'Lightning Bolt']);
    expect(names('c=r')).toEqual(['Lightning Bolt']);
  });
  it('c<= is "at most" (includes colourless)', () => expect(names('c<=r')).toEqual(['Lightning Bolt', 'Sol Ring']));
  it('colourless and multicolour', () => {
    expect(names('c:c')).toEqual(['Sol Ring']);
    expect(names('c:m')).toEqual(['Atraxa, Praetors\' Voice', 'Gruul Charm']);
  });
  it('guild names and colour counts', () => {
    expect(names('c:gruul')).toEqual(['Gruul Charm']);
    expect(names('c=4')).toEqual(['Atraxa, Praetors\' Voice']);
  });
  it('id: is "within" the given identity', () => expect(names('id:rg')).toEqual(['Gruul Charm', 'Lightning Bolt', 'Llanowar Elves', 'Sol Ring', 'Tarmogoyf']));
  it('numeric comparisons', () => {
    expect(names('cmc<=1 t:artifact')).toEqual(['Sol Ring']);
    expect(names('pow>=4')).toEqual(['Atraxa, Praetors\' Voice']);
  });
  it('oracle text with quotes', () => expect(names('o:"draw a card"')).toEqual(['Rhystic Study']));
  it('negation, or, and parentheses', () => {
    expect(names('t:instant -c:g')).toEqual(['Lightning Bolt']);
    expect(names('(c:u or c:r) cmc=3')).toEqual(['Divination', 'Rhystic Study']);
  });
  it('mana cost shorthand', () => expect(names('m:rg')).toEqual(['Gruul Charm']));
  it('rarity', () => {
    expect(names('r:mythic')).toEqual(['Atraxa, Praetors\' Voice']);
    expect(names('r>=rare')).toEqual(['Atraxa, Praetors\' Voice', 'Rhystic Study']);
  });
  it('format legality', () => {
    expect(names('f:modern name:goyf')).toEqual([]);
    expect(names('banned:modern')).toEqual(['Tarmogoyf']);
    expect(names('f:legacy')).toEqual(['Lightning Bolt']);
  });
  it('keywords, produces, is:commander', () => {
    expect(names('kw:flying')).toEqual(['Atraxa, Praetors\' Voice']);
    expect(names('produces:g')).toEqual(['Llanowar Elves']);
    expect(names('is:commander')).toEqual(['Atraxa, Praetors\' Voice']);
  });
  it('empty query returns everything and paginates', () => {
    const r = searchCards(db, { query: '', limit: 3 });
    expect(r.total).toBe(9);
    expect(r.cards).toHaveLength(3);
  });
  it('treats LIKE wildcards literally', () => expect(names('o:"100%"')).toEqual([]));
  it('is not injectable', () => expect(() => names(`name:"'; DROP TABLE cards; --"`)).not.toThrow());
  it('rejects bad queries', () => {
    expect(() => names('bogus:1')).toThrow(SearchError);
    expect(() => names('c:xyz')).toThrow(SearchError);
    expect(() => names('(t:creature')).toThrow(SearchError);
    expect(() => names('o:"unterminated')).toThrow(SearchError);
    expect(() => names('cmc<=abc')).toThrow(SearchError);
  });
});
