import { SCHEMA_VERSION, transaction, type Db } from './schema.js';

/**
 * Card data as a swappable unit, for the Android app, where the card tables share one database file with the user's decks and
 * collection. CI publishes a compact database holding only the card tables; the app downloads it, attaches it next to its own and
 * replaces the card tables from it in one transaction. Decks and collection records are never touched (they don't depend on it:
 * they name cards by oracle id and printings by Scryfall id).
 */

/** Everything that is card data. Anything not listed (decks, deck_cards, collection, collection_prints, wishlist, embeddings) belongs to the user. */
export const CARD_DATA_TABLES = ['cards', 'legality', 'rulings', 'tags', 'tag_edges', 'tag_aliases', 'card_tags', 'rule_sections', 'rules', 'glossary', 'card_aliases', 'sets', 'printings'] as const;

/** Full-text tables, rebuilt row by row (their columns, in order). */
const FTS_TABLES: Array<{ table: string; columns: string[] }> = [
  { table: 'rules_fts', columns: ['text', 'id'] },
  { table: 'glossary_fts', columns: ['term', 'definition'] },
];

/** The bookkeeping that describes the card data, copied along with it. Other meta rows (the user's settings) stay. */
export const CARD_DATA_META = ['bulk_updated_at', 'card_count', 'data_version', 'rulings_updated_at', 'tags_updated_at', 'rules_url', 'names_version', 'names_checked_at', 'printings_version', 'printings_checked_at'] as const;

/** Published next to the file so the app can decide whether to download it. */
export interface CardDataManifest {
  /** The Scryfall bulk-data version the card data is from (what `meta.bulk_updated_at` holds once applied). */
  version: string;
  /** Shape of the card data (DATA_VERSION in the downloader) and of the database (SCHEMA_VERSION): an older app can't use a newer one. */
  dataVersion: number;
  schema: number;
  cards: number;
  /** The gzipped database's name and size in bytes. */
  file: string;
  size: number;
}

export const CARD_DATA_MANIFEST = 'card-data.json';
export const CARD_DATA_FILE = 'card-data.db.gz';

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

function columnsOf(db: Db, schema: 'main' | 'fresh', table: string): string[] | null {
  const rows = db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name: string }>;
  return rows.length ? rows.map((r) => r.name) : null;
}

/**
 * Replace this database's card data with the card tables of the database at `freshPath`. All or nothing: if anything goes wrong the
 * old data is still there. Refuses a file that is from a newer schema than this app understands, or that has implausibly few cards
 * (a damaged download must never empty the card pool).
 */
export function applyCardData(db: Db, freshPath: string, opts: { minCards?: number } = {}): { cards: number; tables: string[] } {
  const minCards = opts.minCards ?? 1000;
  db.exec(`ATTACH DATABASE ${quote(freshPath)} AS fresh`);
  try {
    const freshSchema = (db.prepare('PRAGMA fresh.user_version').get() as { user_version: number }).user_version;
    if (freshSchema > SCHEMA_VERSION) throw new Error('This card data needs a newer version of Grimoire.');
    if (!columnsOf(db, 'fresh', 'cards')) throw new Error("That file isn't card data.");
    const cards = (db.prepare('SELECT count(*) AS n FROM fresh.cards').get() as { n: number }).n;
    if (cards < minCards) throw new Error(`That card data looks damaged (${cards} cards).`);

    const copied: string[] = [];
    transaction(db, () => {
      for (const table of CARD_DATA_TABLES) {
        const have = columnsOf(db, 'main', table);
        const fresh = columnsOf(db, 'fresh', table);
        if (!have || !fresh) continue; // a table this side or that doesn't know: leave it as it is
        // Columns are matched by name, not position: a database upgraded in place has newer columns after the older ones.
        const cols = have.filter((c) => fresh.includes(c)).map((c) => `"${c}"`).join(', ');
        db.exec(`DELETE FROM main."${table}"; INSERT INTO main."${table}" (${cols}) SELECT ${cols} FROM fresh."${table}";`);
        copied.push(table);
      }
      for (const { table, columns } of FTS_TABLES) {
        if (!columnsOf(db, 'main', table) || !columnsOf(db, 'fresh', table)) continue;
        const cols = columns.map((c) => `"${c}"`).join(', ');
        db.exec(`DELETE FROM main."${table}"; INSERT INTO main."${table}" (${cols}) SELECT ${cols} FROM fresh."${table}";`);
        copied.push(table);
      }
      const put = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
      for (const key of CARD_DATA_META) {
        const row = db.prepare('SELECT value FROM fresh.meta WHERE key = ?').get(key) as { value: string } | undefined;
        if (row) put.run(key, row.value);
      }
    });
    return { cards, tables: copied };
  } finally {
    db.exec('DETACH DATABASE fresh');
  }
}
