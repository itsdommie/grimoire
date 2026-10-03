import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { firstRuleReference, parseComprehensiveRules, splitRuleReferences } from './rules.js';

const LS = String.fromCharCode(0x2028); // starts a numbered sense inside a glossary definition
const NB = String.fromCharCode(0xa0); // Wizards uses non-breaking spaces for "blank" lines
const SAMPLE = [
  'Magic: The Gathering Comprehensive Rules', NB, 'These rules are effective as of September 25, 2026.', NB,
  'Contents', NB, '1. Game Concepts', '100. General', NB, '7. Additional Rules', '702. Keyword Abilities', NB, 'Glossary', NB, 'Credits', NB,
  '1. Game Concepts', NB, '100. General', NB,
  '100.1. These Magic rules apply to any Magic game with two or more players.', NB,
  '100.1a A two-player game is a game that begins with only two players.', NB,
  'Example: A multiplayer game is not a two-player game.', NB,
  '7. Additional Rules', NB, '702. Keyword Abilities', NB, '702.19. Trample', NB,
  '702.19a Trample is a static ability that modifies combat damage. (See rule 510, “Combat Damage Step.”)', NB,
  '702.19b The controller of an attacking creature with trample first assigns damage to blockers.', 'This line wraps onto a second line.', NB,
  'Glossary', NB, 'Ability', '1. Text on an object that explains what it does.' + LS + '2. An activated or triggered ability on the stack.', NB,
  'Trample', 'A keyword ability that modifies how combat damage is assigned. See rule 702.19, “Trample.”', NB,
  'Credits', NB, 'Magic: The Gathering Original Game Design: Richard Garfield', NB,
].join('\n');

describe('parseComprehensiveRules', () => {
  const r = parseComprehensiveRules(SAMPLE);
  it('reads the effective date', () => expect(r.effective).toBe('September 25, 2026'));
  it('skips the table of contents and reads sections from the real body', () => {
    expect(r.sections).toEqual([{ num: 1, title: 'Game Concepts' }, { num: 7, title: 'Additional Rules' }]);
  });
  it('builds the group > rule > subrule hierarchy', () => {
    expect(r.rules.map((x) => [x.id, x.kind, x.parent, x.section])).toEqual([
      ['100', 'group', null, 1], ['100.1', 'rule', '100', 1], ['100.1a', 'subrule', '100.1', 1],
      ['702', 'group', null, 7], ['702.19', 'rule', '702', 7], ['702.19a', 'subrule', '702.19', 7], ['702.19b', 'subrule', '702.19', 7],
    ]);
    expect(r.rules.map((x) => x.ord)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  it('attaches examples and wrapped continuation lines to the rule above', () => {
    expect(r.rules.find((x) => x.id === '100.1a')!.text).toBe('A two-player game is a game that begins with only two players.\nExample: A multiplayer game is not a two-player game.');
    expect(r.rules.find((x) => x.id === '702.19b')!.text).toContain('\nThis line wraps onto a second line.');
    expect(r.rules.find((x) => x.id === '702.19')!.text).toBe('Trample'); // a rule that is just a heading
  });
  it('reads the glossary, splitting numbered senses onto their own lines', () => {
    expect(r.glossary.map((g) => g.term)).toEqual(['Ability', 'Trample']);
    expect(r.glossary[0]!.definition).toBe('1. Text on an object that explains what it does.\n2. An activated or triggered ability on the stack.');
  });
  it('rejects text that is not the rules', () => {
    expect(() => parseComprehensiveRules('hello\nworld')).toThrow(/Comprehensive Rules/);
  });
});

describe('references', () => {
  it('finds the first rule number mentioned', () => {
    expect(firstRuleReference('A keyword ability. See rule 702.19, “Trample.”')).toBe('702.19');
    expect(firstRuleReference('See rules 704.5k and 704.5m')).toBe('704.5k');
    expect(firstRuleReference('No reference here')).toBeNull();
  });
  it('splits text into plain parts and rule links', () => {
    expect(splitRuleReferences('See rule 702.19b and rule 510, then rules 704.5k.')).toEqual([
      { text: 'See rule ' }, { text: '702.19b', rule: '702.19b' }, { text: ' and rule ' }, { text: '510', rule: '510' }, { text: ', then rules ' }, { text: '704.5k', rule: '704.5k' }, { text: '.' },
    ]);
    expect(splitRuleReferences('nothing')).toEqual([{ text: 'nothing' }]);
  });
});

// The real file, once the app has downloaded it into the dev data folder (npm run ingest).
const dataDir = process.env.GRIMOIRE_DATA_DIR ?? resolve(__dirname, '../../../data');
const bulk = join(dataDir, 'bulk');
const realFile = existsSync(bulk) ? readdirSync(bulk).find((f) => f.startsWith('comprehensive-rules-')) : undefined;
describe.skipIf(!realFile)('the real Comprehensive Rules', () => {
  const real = () => parseComprehensiveRules(readFileSync(join(bulk, realFile!), 'utf8'));
  it('parses completely: sections, thousands of rules, hundreds of glossary terms', () => {
    const r = real();
    expect(r.effective).toMatch(/\d{4}$/);
    expect(r.sections.length).toBe(9);
    expect(r.rules.length).toBeGreaterThan(2500);
    expect(r.glossary.length).toBeGreaterThan(500);
  });
  it('has the well-known rules with their text', () => {
    const r = real();
    const get = (id: string) => r.rules.find((x) => x.id === id);
    expect(get('702.19')).toMatchObject({ kind: 'rule', text: 'Trample' });
    expect(get('702.19b')!.text).toMatch(/trample first assigns damage/i);
    expect(get('704.5a')!.text).toMatch(/0 or less life/);
    expect(get('903.4')!.text).toMatch(/color identity/i);
    expect(r.glossary.find((g) => g.term === 'Trample')!.definition).toMatch(/702\.19/);
  });
  it('every rule and subrule has a real parent, and the ids are unique', () => {
    const r = real();
    const ids = new Set(r.rules.map((x) => x.id));
    expect(ids.size).toBe(r.rules.length);
    for (const x of r.rules) if (x.parent) expect(ids.has(x.parent), `${x.id} -> ${x.parent}`).toBe(true);
  });
});
