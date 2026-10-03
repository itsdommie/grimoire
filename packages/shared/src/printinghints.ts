/**
 * What a card says about which printing it is, read from the bottom of the card by OCR. Cards from 2015 on print the set code and the
 * collector number ("SNC • EN" over "150/281 C"); older ones print only a copyright year; the oldest nothing useful.
 * OCR is untidy: the copyright sign comes out as an O, zeros as O, and the lines run together.
 */
export interface PrintingHints {
  /** Lowercase set code, e.g. "snc". */
  set?: string;
  /** The collector number's digits with leading zeros dropped, e.g. "150". */
  number?: string;
  /** Copyright year, e.g. 1994. */
  year?: number;
}

/** "0150" and "150" are the same collector number; so are "21★" and "21a" in their digits. */
export const collectorDigits = (s: string): string => (/\d+/.exec(s)?.[0] ?? '').replace(/^0+(?=\d)/, '');

const digitsOf = (s: string) => s.toUpperCase().replace(/[OQD]/g, '0').replace(/[IL|]/g, '1');

/**
 * A set line looks like "SNC • EN > ARTIST" or "KHM EN ARTIST": a code of 3-5 capitals or digits, then the language. OCR sometimes
 * runs them together ("MSCEN >ARTIST"), so the separator is optional before "EN". Set codes are printed in capitals, so the match is
 * case-sensitive: it will not take a word of flavour text for one.
 */
function setCode(line: string): string | null {
  const t = line.replace(/^[^A-Za-z0-9]+/, '');
  const m = /^([A-Z0-9]{3,5}?)\s*[•·.*>:\-–]\s*[A-Z]{2}\b/.exec(t) ?? /^([A-Z0-9]{3,5}?)\s*EN\b/.exec(t);
  return m ? m[1]!.toLowerCase() : null;
}

/** The collector number from a line like "150/281 C", "O59/285 U" (a copyright sign read as O), "R O004" or "C 0744". */
function collectorNumber(line: string): string | null {
  const t = line.toUpperCase().trim();
  const fraction = /([0-9OQDIL|]{1,4})\s*\/\s*[0-9OQDIL|]{2,4}/.exec(t);
  if (fraction) return collectorDigits(digitsOf(fraction[1]!)) || null;
  // Modern cards pad to four digits ("0744"), usually after a rarity letter that may be glued on ("CO024").
  const padded = /^(?:[CURMSTLB]\s*)?([0O][0-9O]{2,3})\b/.exec(t);
  return padded ? collectorDigits(digitsOf(padded[1]!)) || null : null;
}

export function readPrintingHints(lines: readonly string[]): PrintingHints {
  const hints: PrintingHints = {};
  const clean = lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

  const setAt = clean.findIndex((l) => setCode(l));
  if (setAt >= 0) {
    hints.set = setCode(clean[setAt]!)!;
    // The number sits on the line above the set; if not, any line at the bottom will do.
    const number = (setAt > 0 ? collectorNumber(clean[setAt - 1]!) : null) ?? clean.map(collectorNumber).find((n) => n);
    if (number) hints.number = number;
  } else {
    const number = clean.map((l) => (/\d\s*\/\s*\d/.test(l) ? collectorNumber(l) : null)).find((n) => n);
    if (number) hints.number = number;
  }

  // Older cards: "© 1994 Wizards of the Coast", often mangled ("D1994", "Di996 Vizards").
  for (const l of clean) {
    if (!/wizards|vizards|©|\bC\d{4}|\bO\d{4}|\bD\d{4}/i.test(l)) continue;
    const y = /(?<!\d)(199\d|20[0-2]\d)(?!\d)/.exec(l.replace(/[Iil]996/g, '1996'));
    if (y) { hints.year = Number(y[1]); break; }
  }
  return hints;
}
