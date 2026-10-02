import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { DATA_DIR, openDb } from './db.js';
import { mapCard, num, popcount, RARITY_ORDER, type ScryfallCard } from './scryfall.js';

// Scryfall asks for a descriptive User-Agent and an Accept header on every API request.
const HEADERS = {
  'User-Agent': 'Grimoire/0.1 (local MTG deck lab)',
  Accept: 'application/json;q=0.9,*/*;q=0.8',
};

interface BulkEntry { type: string; updated_at: string; jsonl_download_uri?: string; download_uri: string }

async function fetchManifest(): Promise<BulkEntry> {
  const res = await fetch('https://api.scryfall.com/bulk-data', { headers: HEADERS });
  if (!res.ok) throw new Error(`bulk-data manifest: HTTP ${res.status}`);
  const body = (await res.json()) as { data: BulkEntry[] };
  const entry = body.data.find((e) => e.type === 'oracle_cards');
  if (!entry) throw new Error('oracle_cards not found in bulk-data manifest');
  return entry;
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok || !res.body) throw new Error(`download ${url}: HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  renameSync(tmp, dest);
}

export async function loadJsonl(db: Database.Database, lines: AsyncIterable<string>): Promise<number> {
  const insertCard = db.prepare(`INSERT INTO cards (
    id, name, mana_cost, cmc, type_line, oracle_text, colors, colors_count, color_identity, identity_count,
    produced_mana, keywords, power, toughness, loyalty, power_n, toughness_n, loyalty_n, rarity, rarity_n,
    set_code, layout, digital, edhrec_rank, usd, image_url, scryfall_uri
  ) VALUES (
    @id, @name, @manaCost, @cmc, @typeLine, @oracleText, @colors, @colorsCount, @colorIdentity, @identityCount,
    @producedMana, @keywords, @power, @toughness, @loyalty, @powerN, @toughnessN, @loyaltyN, @rarity, @rarityN,
    @setCode, @layout, @digital, @edhrecRank, @usd, @imageUrl, @scryfallUri
  )`);
  const insertLegality = db.prepare('INSERT INTO legality (card_id, format, status) VALUES (?, ?, ?)');

  let count = 0;
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM legality; DELETE FROM cards;');
    for await (const line of lines) {
      if (!line.trim()) continue;
      const raw = JSON.parse(line) as ScryfallCard;
      const card = mapCard(raw);
      if (!card) continue;
      insertCard.run({
        ...card,
        keywords: card.keywords.join(' '),
        colorsCount: popcount(card.colors),
        identityCount: popcount(card.colorIdentity),
        powerN: num(card.power ?? undefined),
        toughnessN: num(card.toughness ?? undefined),
        loyaltyN: num(card.loyalty ?? undefined),
        rarityN: RARITY_ORDER[card.rarity] ?? 0,
        digital: raw.digital ? 1 : 0,
      });
      for (const [format, status] of Object.entries(card.legalities)) {
        if (status !== 'not_legal') insertLegality.run(card.id, format, status);
      }
      count++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return count;
}

async function main() {
  const db = openDb();
  const entry = await fetchManifest();
  const current = (db.prepare("SELECT value FROM meta WHERE key = 'bulk_updated_at'").get() as { value: string } | undefined)?.value;
  const force = process.argv.includes('--force');
  if (current === entry.updated_at && !force) {
    console.log(`Already up to date (${entry.updated_at}). Use --force to re-ingest.`);
    return;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const url = entry.jsonl_download_uri;
  if (!url) throw new Error('Manifest has no jsonl_download_uri');
  const file = resolve(DATA_DIR, `oracle-cards-${entry.updated_at.slice(0, 10)}.jsonl.gz`);
  if (!existsSync(file)) {
    console.log(`Downloading ${url}`);
    await download(url, file);
  }

  console.log('Ingesting…');
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  const count = await loadJsonl(db, lines);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('bulk_updated_at', ?)").run(entry.updated_at);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('card_count', ?)").run(String(count));
  db.exec('ANALYZE');
  console.log(`Stored ${count} cards (Scryfall bulk ${entry.updated_at}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
