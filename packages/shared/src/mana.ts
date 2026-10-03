export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G';
export const MANA_COLORS: readonly ManaColor[] = ['W', 'U', 'B', 'R', 'G'];

export interface ParsedCost {
  /** Mana value of the cost as printed (X counts as 0). */
  cmc: number;
  /** Coloured pips that can only be paid with that colour. */
  pips: Record<ManaColor, number>;
  /** Hybrid pips: each entry lists the colours that can pay it (generic alternatives such as {2/W} are dropped). */
  hybrid: ManaColor[][];
  /** Phyrexian pips can be paid with 2 life instead; they're counted here, not in `pips`. */
  phyrexian: ManaColor[];
  colorless: number; // {C}
  generic: number;
  hasX: boolean;
}

const isColor = (s: string): s is ManaColor => s === 'W' || s === 'U' || s === 'B' || s === 'R' || s === 'G';

/** Parse a Scryfall mana cost like "{2}{W/U}{G}{X}". For multi-faced cards ("A // B") only the front face is read. */
export function parseManaCost(cost: string): ParsedCost {
  const front = cost.split(' // ')[0] ?? '';
  const out: ParsedCost = { cmc: 0, pips: { W: 0, U: 0, B: 0, R: 0, G: 0 }, hybrid: [], phyrexian: [], colorless: 0, generic: 0, hasX: false };
  for (const [, raw] of front.matchAll(/\{([^}]+)\}/g)) {
    const sym = raw!.toUpperCase();
    if (/^\d+$/.test(sym)) { out.generic += Number(sym); out.cmc += Number(sym); continue; }
    if (sym === 'X' || sym === 'Y' || sym === 'Z') { out.hasX = true; continue; }
    if (sym === 'C') { out.colorless++; out.cmc++; continue; }
    if (sym === 'S') { out.generic++; out.cmc++; continue; } // snow
    if (isColor(sym)) { out.pips[sym]++; out.cmc++; continue; }
    const parts = sym.split('/');
    if (parts.includes('P')) { // {W/P}, {G/U/P}
      out.phyrexian.push(...parts.filter(isColor));
      out.cmc++;
      continue;
    }
    if (parts[0] === '2') { // {2/W}: pay 2 generic or one W
      const c = parts[1];
      if (c && isColor(c)) { out.hybrid.push([c]); out.cmc += 2; }
      continue;
    }
    const colors = parts.filter(isColor);
    if (colors.length) { out.hybrid.push(colors); out.cmc++; }
  }
  return out;
}
