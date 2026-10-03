import { transaction, type Db } from './schema.js';
import snapshot from './card-names.json';

/**
 * Cards that are printed under another name (Universes Beyond: "Avengers Monitoring Station" is Herald's Horn). Scryfall's Oracle
 * Cards file carries one printing per card, so most of these names only exist in its per-printing file. They are kept in
 * `card_aliases` (alias → oracle id) so a deck or collection import, and search, can find the card by either name.
 */
export type AliasPair = [alias: string, oracleId: string];

/** The part of a Scryfall printing that names it. */
export interface NamedPrinting {
  oracle_id?: string;
  name?: string;
  flavor_name?: string;
  layout?: string;
  card_faces?: Array<{ flavor_name?: string }>;
}

const SKIP_LAYOUTS = new Set(['token', 'double_faced_token', 'emblem', 'art_series', 'vanguard', 'scheme', 'planar', 'host']);

/** Alternate names of one printing: its flavor name, and each face's, when they differ from the card's own name. */
export function aliasesOf(p: NamedPrinting): AliasPair[] {
  if (!p.oracle_id || (p.layout && SKIP_LAYOUTS.has(p.layout))) return [];
  const own = (p.name ?? '').toLowerCase();
  const out: AliasPair[] = [];
  for (const name of [p.flavor_name, ...(p.card_faces ?? []).map((f) => f.flavor_name)]) {
    const alias = name?.trim();
    if (alias && alias.toLowerCase() !== own) out.push([alias, p.oracle_id]);
  }
  return out;
}

/** Stream a per-printing JSONL file (Scryfall's Default Cards) into the distinct alias pairs it contains. */
export async function collectAliases(lines: AsyncIterable<string>): Promise<AliasPair[]> {
  const byAlias = new Map<string, AliasPair>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    for (const pair of aliasesOf(JSON.parse(line) as NamedPrinting)) if (!byAlias.has(pair[0].toLowerCase())) byAlias.set(pair[0].toLowerCase(), pair);
  }
  return [...byAlias.values()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Replace the aliases. Pairs for cards we don't have are kept: they take effect if the card arrives later, and resolving joins on cards. */
export function loadAliases(db: Db, pairs: readonly AliasPair[]): number {
  const insert = db.prepare('INSERT OR IGNORE INTO card_aliases (alias, card_id) VALUES (?, ?)');
  transaction(db, () => {
    db.exec('DELETE FROM card_aliases');
    for (const [alias, id] of pairs) insert.run(alias, id);
  });
  return pairs.length;
}

/** The file published by CI and bundled with the app: `{ version, names: [[alias, oracleId], …] }`. */
export interface NamesFile { version: string; names: AliasPair[] }

export function parseNamesFile(text: string): NamesFile {
  const data = JSON.parse(text) as Partial<NamesFile>;
  if (typeof data.version !== 'string' || !Array.isArray(data.names)) throw new Error("that isn't a card names file");
  return { version: data.version, names: data.names.filter((p): p is AliasPair => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string') };
}

export const BUNDLED_NAMES: NamesFile = snapshot as NamesFile;

/**
 * Give a database the names that ship with the app, if it has none yet (a fresh install, or one upgraded from before they existed),
 * so imports work offline and straight away. A newer list downloaded later replaces them.
 */
export function seedAliases(db: Db): void {
  if (db.prepare('SELECT 1 FROM card_aliases LIMIT 1').get()) return;
  loadAliases(db, BUNDLED_NAMES.names);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('names_version', ?)").run(`bundled:${BUNDLED_NAMES.version}`);
}
