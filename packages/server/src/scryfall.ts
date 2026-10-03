import { colorsToMask, type Card } from '@grimoire/shared';

/** The subset of a Scryfall card object we read. */
export interface ScryfallCard {
  oracle_id?: string;
  name: string;
  layout: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  colors?: string[];
  color_identity?: string[];
  produced_mana?: string[];
  keywords?: string[];
  power?: string;
  toughness?: string;
  loyalty?: string;
  rarity: string;
  set: string;
  digital?: boolean;
  edhrec_rank?: number;
  prices?: { usd?: string | null };
  image_uris?: { normal?: string };
  scryfall_uri: string;
  legalities?: Record<string, string>;
  card_faces?: Array<{
    mana_cost?: string;
    oracle_text?: string;
    colors?: string[];
    image_uris?: { normal?: string };
    power?: string;
    toughness?: string;
    loyalty?: string;
  }>;
}

/** Layouts that are not real, deck-legal cards. */
const SKIP_LAYOUTS = new Set(['token', 'double_faced_token', 'emblem', 'art_series', 'vanguard', 'scheme', 'planar', 'host']);

export const RARITY_ORDER: Record<string, number> = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4, bonus: 5 };

const popcount = (n: number) => { let c = 0; for (; n; n &= n - 1) c++; return c; };
const num = (s: string | undefined) => { const n = Number(s); return s !== undefined && s !== '' && Number.isFinite(n) ? n : null; };

/** Map a Scryfall oracle card to our Card shape, or null if it should not be stored. */
export function mapCard(raw: ScryfallCard): Card | null {
  if (!raw.oracle_id || SKIP_LAYOUTS.has(raw.layout)) return null;
  const faces = raw.card_faces ?? [];
  const joinFaces = (pick: (f: NonNullable<ScryfallCard['card_faces']>[number]) => string | undefined, sep: string) =>
    faces.map((f) => pick(f) ?? '').filter(Boolean).join(sep);

  const colorSet = raw.colors ?? faces.flatMap((f) => f.colors ?? []);
  const front = faces[0];
  return {
    id: raw.oracle_id,
    name: raw.name,
    manaCost: raw.mana_cost ?? joinFaces((f) => f.mana_cost, ' // '),
    cmc: raw.cmc ?? 0,
    typeLine: raw.type_line ?? '',
    oracleText: raw.oracle_text ?? joinFaces((f) => f.oracle_text, '\n//\n'),
    colors: colorsToMask(colorSet),
    colorIdentity: colorsToMask(raw.color_identity),
    producedMana: colorsToMask(raw.produced_mana),
    keywords: raw.keywords ?? [],
    power: raw.power ?? front?.power ?? null,
    toughness: raw.toughness ?? front?.toughness ?? null,
    loyalty: raw.loyalty ?? front?.loyalty ?? null,
    rarity: raw.rarity,
    setCode: raw.set,
    layout: raw.layout,
    edhrecRank: raw.edhrec_rank ?? null,
    usd: num(raw.prices?.usd ?? undefined),
    imageUrl: raw.image_uris?.normal ?? front?.image_uris?.normal ?? null,
    imageUrlBack: !raw.image_uris && faces[1]?.image_uris?.normal ? faces[1].image_uris.normal : null,
    scryfallUri: raw.scryfall_uri,
    legalities: raw.legalities ?? {},
  };
}

export { popcount, num };
