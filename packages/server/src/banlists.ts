import type { BanlistFormat, BanlistReport } from '@grimoire/shared';
import { getCardsByIds } from './cards.js';
import type { Db } from './schema.js';

// What is banned or restricted where. It reads the legality Scryfall gives each card, so it is as current as the card data.

/** The formats worth a banlist page, with the names people use. Scryfall has others (future, duel, tlr...) that nobody looks up. */
const LABELS: Record<string, string> = {
  standard: 'Standard', pioneer: 'Pioneer', modern: 'Modern', legacy: 'Legacy', vintage: 'Vintage', pauper: 'Pauper',
  commander: 'Commander', brawl: 'Brawl', historic: 'Historic', timeless: 'Timeless', oathbreaker: 'Oathbreaker',
  premodern: 'Premodern', oldschool: 'Old School', paupercommander: 'Pauper Commander', duel: 'Duel Commander',
};

export const BANLIST_FORMATS = Object.keys(LABELS);

/** Each format that has something banned or restricted, in the order above, with how many of each. */
export function listBanlistFormats(db: Db): BanlistFormat[] {
  const rows = db.prepare("SELECT format, sum(status = 'banned') AS banned, sum(status = 'restricted') AS restricted FROM legality WHERE status IN ('banned', 'restricted') GROUP BY format").all() as unknown as Array<{ format: string; banned: number; restricted: number }>;
  const by = new Map(rows.map((r) => [r.format, r]));
  return BANLIST_FORMATS.flatMap((id) => { const r = by.get(id); return r ? [{ id, label: LABELS[id]!, banned: r.banned, restricted: r.restricted }] : []; });
}

/** One format's banned and restricted cards (with how many of each you own), or null for a format that has no page. */
export function getBanlist(db: Db, format: string): BanlistReport | null {
  if (!(format in LABELS)) return null;
  const ids = (status: string) => (db.prepare('SELECT card_id FROM legality WHERE format = ? AND status = ?').all(format, status) as unknown as Array<{ card_id: string }>).map((r) => r.card_id);
  const load = (list: string[]) => {
    const cards = getCardsByIds(db, list);
    return list.flatMap((id) => { const c = cards.get(id); return c ? [c] : []; }).sort((a, b) => a.name.localeCompare(b.name));
  };
  const banned = load(ids('banned')), restricted = load(ids('restricted'));
  return { format: { id: format, label: LABELS[format]!, banned: banned.length, restricted: restricted.length }, banned, restricted };
}
