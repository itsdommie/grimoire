export const W = 1;
export const U = 2;
export const B = 4;
export const R = 8;
export const G = 16;

const LETTER_BIT: Record<string, number> = { w: W, u: U, b: B, r: R, g: G };

export const GUILDS: Record<string, string> = {
  azorius: 'wu', dimir: 'ub', rakdos: 'br', gruul: 'rg', selesnya: 'gw',
  orzhov: 'wb', izzet: 'ur', golgari: 'bg', boros: 'rw', simic: 'gu',
  bant: 'gwu', esper: 'wub', grixis: 'ubr', jund: 'brg', naya: 'rgw',
  abzan: 'wbg', jeskai: 'urw', sultai: 'bgu', mardu: 'rwb', temur: 'gur',
};

/** Convert a string of colour letters ("rg", "WUBRG") to a bitmask. Returns null if any char is not a colour. */
export function lettersToMask(letters: string): number | null {
  let mask = 0;
  for (const ch of letters.toLowerCase()) {
    const bit = LETTER_BIT[ch];
    if (bit === undefined) return null;
    mask |= bit;
  }
  return mask;
}

/** Convert an array of Scryfall colour letters (["W","U"]) to a bitmask. */
export function colorsToMask(colors: readonly string[] | undefined | null): number {
  let mask = 0;
  for (const c of colors ?? []) mask |= LETTER_BIT[c.toLowerCase()] ?? 0;
  return mask;
}
