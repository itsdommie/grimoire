// Scryfall's set types, grouped the way a person thinks about sets.

export const SET_GROUPS = [
  { id: 'main', label: 'Main sets', kinds: ['core', 'expansion'] },
  { id: 'commander', label: 'Commander', kinds: ['commander'] },
  { id: 'reprint', label: 'Reprints & specials', kinds: ['masters', 'eternal', 'draft_innovation', 'from_the_vault', 'spellbook', 'premium_deck', 'duel_deck', 'arsenal', 'starter', 'box', 'treasure_chest', 'masterpiece'] },
  { id: 'other', label: 'Promos & other', kinds: ['promo', 'memorabilia', 'token', 'funny', 'minigame', 'vanguard', 'planechase', 'archenemy', 'alchemy'] },
] as const;
export type SetGroupId = (typeof SET_GROUPS)[number]['id'];

/** Which group a set type belongs to. A type this list doesn't know (Scryfall adds some) goes with the rest. */
export function setGroup(kind: string | null | undefined): SetGroupId | null {
  if (!kind) return null;
  return SET_GROUPS.find((g) => (g.kinds as readonly string[]).includes(kind))?.id ?? 'other';
}

/** Where Scryfall serves a set's symbol (black on transparent; the app inverts it on the dark theme). */
export const setIconUrl = (code: string): string => `https://svgs.scryfall.io/sets/${code.toLowerCase()}.svg`;
