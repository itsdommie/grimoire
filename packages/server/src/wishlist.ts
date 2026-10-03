import type { WishlistItem, WishlistReport } from '@grimoire/shared';
import { getCardsByIds } from './cards.js';
import { transaction, type Db } from './schema.js';
import { BadRequestError } from './decks.js';
import { deckMissing } from './collection.js';

// The cards you want. A wish is "I want N copies in total", so it fills itself in as you collect copies: what is still to find is N less
// what you own, and a wish you have met stays listed (at the bottom) until you take it off.

const MAX_WANT = 9999;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function getWishlist(db: Db): WishlistReport {
  const rows = db.prepare('SELECT card_id, want FROM wishlist').all() as unknown as Array<{ card_id: string; want: number }>;
  const cards = getCardsByIds(db, rows.map((r) => r.card_id));
  const items: WishlistItem[] = [];
  let totalUsd = 0, unpriced = 0, open = 0;
  for (const { card_id, want } of rows) {
    const card = cards.get(card_id);
    if (!card) continue; // a card the data no longer has
    const owned = card.owned ?? 0;
    const need = Math.max(0, want - owned);
    const price = card.usdMin ?? card.usd;
    const costUsd = need === 0 || price === null || price === undefined ? null : round2(price * need);
    if (need > 0) { open++; if (costUsd === null) unpriced++; else totalUsd += costUsd; }
    items.push({ card, want, owned, need, costUsd });
  }
  items.sort((a, b) => Number(b.need > 0) - Number(a.need > 0) || (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.card.name.localeCompare(b.card.name));
  return { items, open, totalUsd: round2(totalUsd), unpriced };
}

/** Set how many copies of a card you want in total; 0 takes it off the list. */
export function setWanted(db: Db, cardId: string, want: number): void {
  if (!Number.isInteger(want) || want < 0 || want > MAX_WANT) throw new BadRequestError(`want must be a whole number from 0 to ${MAX_WANT}`);
  if (want === 0) { db.prepare('DELETE FROM wishlist WHERE card_id = ?').run(cardId); return; }
  if (getCardsByIds(db, [cardId]).size === 0) throw new BadRequestError('Unknown card');
  db.prepare("INSERT INTO wishlist (card_id, want) VALUES (?, ?) ON CONFLICT (card_id) DO UPDATE SET want = excluded.want, updated_at = datetime('now')").run(cardId, want);
}

/** Put every card a deck is short of on the wishlist (wanting at least enough copies to finish it). Never lowers an existing wish. */
export function wishMissing(db: Db, deckId: number, opts: { excludeOtherDecks?: boolean } = {}): { added: number } {
  const report = deckMissing(db, deckId, opts);
  let added = 0;
  transaction(db, () => {
    const cur = db.prepare('SELECT want FROM wishlist WHERE card_id = ?');
    const put = db.prepare("INSERT INTO wishlist (card_id, want) VALUES (?, ?) ON CONFLICT (card_id) DO UPDATE SET want = excluded.want, updated_at = datetime('now')");
    for (const m of report.missing) {
      // Total copies wanted: what you own now (copies in other decks included) plus what this deck is short of.
      const target = Math.min(MAX_WANT, (m.card.owned ?? 0) + m.missing);
      const have = (cur.get(m.card.id) as unknown as { want: number } | undefined)?.want ?? 0;
      if (target > have) { put.run(m.card.id, target); added++; }
    }
  });
  return { added };
}

export function clearWishlist(db: Db): void { db.exec('DELETE FROM wishlist'); }
