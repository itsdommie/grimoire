// Deck formats Grimoire can build and validate. Commander is a 100-card singleton format with a command zone; the others are
// 60-card constructed formats with a 15-card sideboard and up to four copies of a card.

export const FORMAT_IDS = ['commander', 'standard', 'pioneer', 'modern', 'legacy', 'vintage', 'pauper'] as const;
export type FormatId = (typeof FORMAT_IDS)[number];

export interface FormatRules {
  id: FormatId;
  name: string;
  /** Key in a card's `legalities` (Scryfall's name for the format). */
  legality: string;
  /** Uses a command zone (commanders are a separate board and set the allowed colours). */
  commander: boolean;
  /** Commander: exact size including the commander(s). Others: minimum size of the main deck. */
  deckSize: number;
  /** Sideboard limit (the Commander "sideboard" is just a maybeboard and isn't validated). */
  maxSideboard: number;
  /** Most copies of one card (basic lands and "any number" cards excepted). */
  copies: number;
}

export const FORMATS: Record<FormatId, FormatRules> = {
  commander: { id: 'commander', name: 'Commander', legality: 'commander', commander: true, deckSize: 100, maxSideboard: 0, copies: 1 },
  standard: { id: 'standard', name: 'Standard', legality: 'standard', commander: false, deckSize: 60, maxSideboard: 15, copies: 4 },
  pioneer: { id: 'pioneer', name: 'Pioneer', legality: 'pioneer', commander: false, deckSize: 60, maxSideboard: 15, copies: 4 },
  modern: { id: 'modern', name: 'Modern', legality: 'modern', commander: false, deckSize: 60, maxSideboard: 15, copies: 4 },
  legacy: { id: 'legacy', name: 'Legacy', legality: 'legacy', commander: false, deckSize: 60, maxSideboard: 15, copies: 4 },
  vintage: { id: 'vintage', name: 'Vintage', legality: 'vintage', commander: false, deckSize: 60, maxSideboard: 15, copies: 4 },
  pauper: { id: 'pauper', name: 'Pauper', legality: 'pauper', commander: false, deckSize: 60, maxSideboard: 15, copies: 4 },
};

export const isFormatId = (s: unknown): s is FormatId => typeof s === 'string' && (FORMAT_IDS as readonly string[]).includes(s);

/** Anything unrecognised (an old or hand-edited value) is treated as Commander, the original format. */
export const asFormat = (s: unknown): FormatId => (isFormatId(s) ? s : 'commander');
