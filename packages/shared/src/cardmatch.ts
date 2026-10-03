/**
 * Matching text read off a card (OCR from a camera frame) to card names. OCR is never exact: it drops accents and punctuation,
 * confuses letters (rn/m, l/I/1, 0/O), and tacks on junk where the mana cost is. So the text and the names are both reduced to
 * plain lowercase letters and digits, and compared by edit distance.
 */

/** Lowercase letters, digits and single spaces only: no accents, punctuation or symbols. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Edit distance between a and b, giving up (returning max + 1) once it is certain to exceed `max`. */
export function boundedDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

export interface NameEntry {
  /** What the user sees and the card is known by (the oracle id, or whatever the caller keys cards with). */
  id: string;
  /** A name the card goes by: its own, one face of a double-faced card, or an alias. */
  name: string;
}

export interface NameMatch {
  id: string;
  name: string;
  /** 0 to 1: 1 is an exact match after normalising. */
  score: number;
}

interface Indexed { id: string; name: string; key: string }

/** Names prepared for matching. Build once (it normalises every name), then call `match` per camera frame. */
export class NameIndex {
  private readonly entries: Indexed[];

  constructor(names: readonly NameEntry[]) {
    const seen = new Set<string>();
    this.entries = [];
    const add = (id: string, name: string, key: string) => {
      const dedupe = `${id}|${key}`;
      if (key && !seen.has(dedupe)) { seen.add(dedupe); this.entries.push({ id, name, key }); }
    };
    for (const { id, name } of names) {
      add(id, name, normalizeName(name));
      // A double-faced card is read off one face at a time ("Fire" for "Fire // Ice").
      if (name.includes('//')) for (const face of name.split('//')) add(id, name, normalizeName(face));
    }
  }

  get size(): number { return this.entries.length; }

  /** The best matches for OCR text, best first, at most one per card. */
  match(text: string, limit = 5, minScore = 0.6): NameMatch[] {
    const full = normalizeName(text);
    if (!full) return [];
    // Mana cost symbols and frame art come out as short junk tokens after the name; also try the text without them.
    const variants = new Set([full]);
    const tokens = full.split(' ');
    while (tokens.length > 1 && tokens[tokens.length - 1]!.length <= 2) { tokens.pop(); variants.add(tokens.join(' ')); }
    const best = new Map<string, NameMatch>();
    for (const e of this.entries) {
      let score = 0;
      for (const v of variants) {
        const longest = Math.max(v.length, e.key.length);
        const max = Math.floor(longest * (1 - minScore));
        const d = boundedDistance(v, e.key, max);
        if (d <= max) score = Math.max(score, 1 - d / longest);
      }
      if (score < minScore) continue;
      const cur = best.get(e.id);
      if (!cur || score > cur.score) best.set(e.id, { id: e.id, name: e.name, score });
    }
    return [...best.values()].sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name)).slice(0, limit);
  }
}
