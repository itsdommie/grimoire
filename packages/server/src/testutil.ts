import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import type { ScryfallCard } from './scryfall.js';

export const tmpDir = () => mkdtempSync(join(tmpdir(), 'grimoire-test-'));

let n = 0;
export const sfCard = (c: Partial<ScryfallCard> & { name: string }): ScryfallCard => ({
  layout: 'normal', rarity: 'common', set: 'tst', scryfall_uri: 'https://scryfall.com/x', legalities: { commander: 'legal' }, oracle_id: `oid-${n++}`, ...c,
});

export const toJsonl = (cards: ScryfallCard[]) => cards.map((c) => JSON.stringify(c)).join('\n') + '\n';

export function writeBulk(dir: string, name: string, cards: ScryfallCard[]): string {
  const file = join(dir, name);
  writeFileSync(file, name.endsWith('.gz') ? gzipSync(toJsonl(cards)) : toJsonl(cards));
  return file;
}

const NB = String.fromCharCode(0xa0);
/** A miniature Comprehensive Rules file in Wizards' format (contents, body, glossary, credits). */
export const SAMPLE_RULES_TEXT = [
  'Magic: The Gathering Comprehensive Rules', NB, 'These rules are effective as of September 25, 2026.', NB,
  'Contents', NB, '1. Game Concepts', '100. General', NB, '7. Additional Rules', '702. Keyword Abilities', NB, 'Glossary', NB, 'Credits', NB,
  '1. Game Concepts', NB, '100. General', NB,
  '100.1. These Magic rules apply to any Magic game with two or more players.', NB,
  '100.1a A two-player game is a game that begins with only two players.', NB,
  '7. Additional Rules', NB, '702. Keyword Abilities', NB, '702.19. Trample', NB,
  '702.19a Trample is a static ability that modifies combat damage. (See rule 510, “Combat Damage Step.”)', NB,
  '702.19b The controller of an attacking creature with trample first assigns damage to the creature(s) blocking it.', NB,
  '702.9. Flying', NB, '702.9a Flying is an evasion ability.', NB,
  'Glossary', NB,
  'Flying', 'A keyword ability that restricts blocking. See rule 702.9, “Flying.”', NB,
  'Trample', 'A keyword ability that modifies how combat damage is assigned. See rule 702.19, “Trample.”', NB,
  'Credits', NB, 'Magic: The Gathering Original Game Design: Richard Garfield', NB,
].join('\n');

export const RULES_PAGE_HTML = '<a href="https://media.wizards.com/2026/downloads/MagicCompRules 20260925.txt">TXT</a> <a href="https://media.wizards.com/2026/downloads/MagicCompRules 20260925.pdf">PDF</a>';

/** Answer the requests the rules update makes (Wizards' rules page and the .txt), or null for any other URL. */
export function rulesResponse(url: string): Response | null {
  if (url.includes('magic.wizards.com/en/rules')) return new Response(RULES_PAGE_HTML);
  if (url.includes('media.wizards.com') && url.endsWith('.txt')) return new Response(SAMPLE_RULES_TEXT);
  return null;
}
