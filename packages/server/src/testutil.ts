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
