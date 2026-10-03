import { analyzeDeck, copiesInDecksSql, FORMATS, isLand, tagRoles, ROLES, ROLE_LABEL, type Card, type DeckSuggestions, type RoleSuggestions } from '@grimoire/shared';
import { getCardsByIds } from './cards.js';
import { getDeck } from './decks.js';
import type { Db } from './schema.js';

// "Fill the gaps": cards you already own that would suit a deck, grouped by what they do, roles the deck is short on first. It uses only
// what the app already knows: your collection, the format's legality, the deck's colours and the role tagging the analysis uses.

/** The most cards offered for one role: enough to choose from, few enough to read. */
const PER_ROLE = 10;

/**
 * Owned cards that are legal in the deck's format, inside its colours and not already in it (basic and other lands are left out: this is
 * about spells). With `spare`, only copies that no other deck is using count, so suggesting a card never breaks another deck apart.
 * In Commander and Brawl the colours are the commander's colour identity; in other formats they are the colours the deck already uses.
 */
export function suggestForDeck(db: Db, deckId: number, opts: { spare?: boolean; perRole?: number } = {}): DeckSuggestions {
  const { deck, entries } = getDeck(db, deckId);
  const rules = FORMATS[deck.format];
  const analysis = analyzeDeck(entries, deck.format);
  const perRole = Math.min(Math.max(opts.perRole ?? PER_ROLE, 1), 50);

  const spells = entries.filter((e) => e.board !== 'sideboard' && !isLand(e.card));
  const commanders = entries.filter((e) => e.board === 'commander');
  // What the deck is built around: its commander's identity, or (in a 60-card deck) the colours of what is already in it.
  const sources = rules.commander ? commanders : spells;
  const base: DeckSuggestions = { needsMore: sources.length === 0, pool: 0, roles: [] };
  if (base.needsMore) return base;
  const identity = sources.reduce((m, e) => m | e.card.colorIdentity, 0);

  const params: Array<string | number> = [deck.format, identity];
  const spareSql = opts.spare ? ` AND col.qty > ${copiesInDecksSql('cards.id', params, deckId)}` : '';
  params.push(deckId);
  const ids = (db.prepare(`SELECT cards.id AS id FROM collection col JOIN cards ON cards.id = col.card_id
      JOIN legality l ON l.card_id = cards.id AND l.format = ? AND l.status IN ('legal', 'restricted')
      WHERE (cards.color_identity & ?) = cards.color_identity AND cards.type_line NOT LIKE '%Land%'${spareSql}
        AND cards.id NOT IN (SELECT card_id FROM deck_cards WHERE deck_id = ?)`).all(...params) as unknown as Array<{ id: string }>).map((r) => r.id);
  const pool = [...getCardsByIds(db, ids).values()];

  const byRole = new Map<string, Card[]>();
  for (const card of pool) for (const role of tagRoles(card)) byRole.set(role, [...(byRole.get(role) ?? []), card]);
  // Popular cards first (lower EDHREC rank), then cheaper, then by name.
  const rank = (a: Card, b: Card) => (a.edhrecRank ?? Infinity) - (b.edhrecRank ?? Infinity) || a.cmc - b.cmc || a.name.localeCompare(b.name);

  const roles: RoleSuggestions[] = ROLES.flatMap((role) => {
    const cards = byRole.get(role);
    if (!cards?.length) return [];
    const summary = analysis.roles.find((r) => r.role === role);
    return [{ role, label: ROLE_LABEL[role], inDeck: summary?.count ?? 0, ...(summary?.target ? { target: summary.target } : {}), ...(summary?.status ? { status: summary.status } : {}), total: cards.length, cards: cards.sort(rank).slice(0, perRole) }];
  });
  // Roles the deck is short on come first, then the rest in the usual order.
  roles.sort((a, b) => Number(b.status === 'short') - Number(a.status === 'short'));
  return { needsMore: false, pool: pool.length, roles };
}
