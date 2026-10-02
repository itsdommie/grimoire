import type { Card } from './types.js';

export type Board = 'commander' | 'main' | 'sideboard';
export const BOARDS: readonly Board[] = ['commander', 'main', 'sideboard'];

export interface DeckEntry {
  card: Card;
  qty: number;
  board: Board;
}

export interface Issue {
  severity: 'error' | 'warning';
  code: 'commander-count' | 'commander-ineligible' | 'commander-pair' | 'deck-size' | 'singleton' | 'color-identity' | 'banned' | 'not-legal';
  message: string;
  cards?: string[];
}

export const COMMANDER_DECK_SIZE = 100;

// ------------------------------------------------------------ card helpers

/** Type line / text of the front face only (multi-faced cards are "Front // Back"). */
const frontTypeLine = (c: Card) => c.typeLine.split(' // ')[0] ?? c.typeLine;

export const isBasicLand = (c: Card) => /\bBasic\b.*\bLand\b/.test(frontTypeLine(c));

const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** How many copies a singleton deck may hold: 1 normally, Infinity for basics / "any number" cards, N for "up to N". */
export function copyLimit(c: Card): number {
  if (isBasicLand(c)) return Infinity;
  if (/A deck can have any number of cards named/i.test(c.oracleText)) return Infinity;
  const m = /A deck can have up to (\w+) cards named/i.exec(c.oracleText);
  if (m) return NUMBER_WORDS[m[1]!.toLowerCase()] ?? 1;
  return 1;
}

const hasLine = (c: Card, re: RegExp) => c.oracleText.split('\n').some((l) => re.test(l));

export function canBeCommander(c: Card): boolean {
  const t = frontTypeLine(c);
  if (/\bLegendary\b/.test(t) && /\bCreature\b/.test(t)) return true;
  if (/\bLegendary\b/.test(t) && /\b(Vehicle|Spacecraft)\b/.test(t) && c.power !== null) return true;
  return /can be your commander/i.test(c.oracleText);
}

const isBackground = (c: Card) => /\bBackground\b/.test(frontTypeLine(c));

function partnerVariant(c: Card): string | null {
  for (const line of c.oracleText.split('\n')) {
    const m = /^Partner(?:\s*—\s*(.+?))?(?:\s*\(.*)?$/.exec(line.trim());
    if (m) return m[1] ?? '';
  }
  return null;
}

const partnersWith = (a: Card, b: Card) => {
  const m = /^Partner with ([^(\n]+?)\s*(?:\(|$)/m.exec(a.oracleText);
  return !!m && m[1]!.trim() === b.name;
};

/** Whether two cards may share the command zone. */
export function validPair(a: Card, b: Card): boolean {
  if (partnersWith(a, b) && partnersWith(b, a)) return true;
  const va = partnerVariant(a), vb = partnerVariant(b);
  if (va !== null && va === vb) return true;
  if (hasLine(a, /^Friends forever/) && hasLine(b, /^Friends forever/)) return true;
  const bg = (x: Card, y: Card) => hasLine(x, /^Choose a Background/) && isBackground(y);
  if (bg(a, b) || bg(b, a)) return true;
  const doctor = (x: Card, y: Card) => hasLine(x, /^Doctor's companion/) && /\bTime Lord Doctor\b/.test(frontTypeLine(y));
  return doctor(a, b) || doctor(b, a);
}

// -------------------------------------------------------------- validation

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Validate a Commander deck. Sideboard cards are ignored. */
export function validateCommander(entries: readonly DeckEntry[]): Issue[] {
  const issues: Issue[] = [];
  const commanders = entries.filter((e) => e.board === 'commander');
  const deck = entries.filter((e) => e.board !== 'sideboard');
  const commanderCards = commanders.flatMap((e) => Array<Card>(e.qty).fill(e.card));

  // Commander zone
  if (commanderCards.length === 0) {
    issues.push({ severity: 'warning', code: 'commander-count', message: 'No commander chosen.' });
  } else if (commanderCards.length > 2) {
    issues.push({ severity: 'error', code: 'commander-count', message: `A deck has at most 2 commanders (found ${commanderCards.length}).` });
  } else {
    const [a, b] = commanderCards as [Card, Card | undefined];
    const ineligible = commanderCards.filter((c) => !canBeCommander(c) && !(commanderCards.length === 2 && isBackground(c)));
    if (ineligible.length) {
      issues.push({ severity: 'error', code: 'commander-ineligible', message: `${ineligible.map((c) => c.name).join(', ')} can't be your commander.`, cards: ineligible.map((c) => c.name) });
    } else if (b && !validPair(a, b)) {
      issues.push({ severity: 'error', code: 'commander-pair', message: `${a.name} and ${b.name} can't be commanders together (needs Partner, Friends forever, Background or Doctor's companion).`, cards: [a.name, b.name] });
    }
  }

  // Size
  const total = deck.reduce((n, e) => n + e.qty, 0);
  if (total > COMMANDER_DECK_SIZE) {
    issues.push({ severity: 'error', code: 'deck-size', message: `Deck has ${total} cards, ${plural(total - COMMANDER_DECK_SIZE, 'card')} over the ${COMMANDER_DECK_SIZE} allowed.` });
  } else if (total < COMMANDER_DECK_SIZE) {
    issues.push({ severity: 'warning', code: 'deck-size', message: `Deck has ${total} cards, needs ${plural(COMMANDER_DECK_SIZE - total, 'more card')}.` });
  }

  // Singleton (copies are summed across the commander zone and main deck)
  const counts = new Map<string, { card: Card; qty: number }>();
  for (const e of deck) {
    const cur = counts.get(e.card.id);
    if (cur) cur.qty += e.qty; else counts.set(e.card.id, { card: e.card, qty: e.qty });
  }
  const dupes = [...counts.values()].filter(({ card, qty }) => qty > copyLimit(card));
  if (dupes.length) {
    issues.push({ severity: 'error', code: 'singleton', message: `Singleton violated: ${dupes.map(({ card, qty }) => `${card.name} ×${qty}`).join(', ')}.`, cards: dupes.map((d) => d.card.name) });
  }

  // Colour identity (only meaningful once a commander is set)
  if (commanderCards.length > 0) {
    const allowed = commanderCards.reduce((m, c) => m | c.colorIdentity, 0);
    const outside = deck.filter((e) => e.board !== 'commander' && (e.card.colorIdentity & ~allowed) !== 0).map((e) => e.card.name);
    if (outside.length) {
      issues.push({ severity: 'error', code: 'color-identity', message: `Outside the commander's colour identity: ${outside.join(', ')}.`, cards: outside });
    }
  }

  // Format legality
  const banned: string[] = [], illegal: string[] = [];
  for (const { card } of counts.values()) {
    const status = card.legalities.commander;
    if (status === 'legal') continue;
    (status === 'banned' ? banned : illegal).push(card.name);
  }
  if (banned.length) issues.push({ severity: 'error', code: 'banned', message: `Banned in Commander: ${banned.join(', ')}.`, cards: banned });
  if (illegal.length) issues.push({ severity: 'error', code: 'not-legal', message: `Not legal in Commander: ${illegal.join(', ')}.`, cards: illegal });

  return issues;
}

// ------------------------------------------------------- list import/export

export interface ParsedLine {
  qty: number;
  name: string;
  board: Board;
  set?: string;
  collector?: string;
}

const HEADERS: Record<string, Board> = {
  commander: 'commander', commanders: 'commander',
  deck: 'main', main: 'main', mainboard: 'main',
  sideboard: 'sideboard', side: 'sideboard', maybeboard: 'sideboard', maybe: 'sideboard', considering: 'sideboard', companion: 'sideboard',
};

/**
 * Parse a pasted deck list: plain text ("1 Sol Ring", "1x Sol Ring"), Moxfield
 * ("1 Sol Ring (CMM) 400 *F*") and Archidekt ("1x Sol Ring (cmm) 400 [Ramp] ^Foil^") exports,
 * with optional section headers (Commander / Deck / Sideboard …) and "SB:" prefixes.
 */
export function parseDeckList(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  let board: Board = 'main';
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;

    const header = /^(?:\/\/\s*)?([a-z ]+?)(?:\s*\(\d+\))?\s*:?$/i.exec(line);
    const headerBoard = header ? HEADERS[header[1]!.toLowerCase().trim()] : undefined;
    if (headerBoard) { board = headerBoard; continue; }
    if (line.startsWith('//') || line.startsWith('#')) continue;

    let lineBoard = board;
    const sb = /^SB:\s*(.*)$/i.exec(line);
    if (sb) { lineBoard = 'sideboard'; line = sb[1]!; }

    const m = /^(\d+)\s*x?\s+(.+)$/i.exec(line);
    const qty = m ? Number(m[1]) : 1;
    let name = (m ? m[2]! : line).trim();

    // Strip trailing decorations: *F*, ^Tag^, #tag, [Category], (SET) 123
    let set: string | undefined, collector: string | undefined;
    for (let prev = ''; prev !== name; ) {
      prev = name;
      name = name.replace(/\s+\*[A-Za-z]+\*$/, '').replace(/\s+\^[^^]*\^$/, '').replace(/\s+#\S+$/, '').replace(/\s+\[[^\]]*\]$/, '').trim();
      const printing = /^(.*?)\s+\(([A-Za-z0-9]{2,6})\)(?:\s+(\S+))?$/.exec(name);
      if (printing) { name = printing[1]!.trim(); set = printing[2]!.toLowerCase(); collector = printing[3]; }
    }
    if (!name || qty < 1) continue;
    out.push({ qty, name, board: lineBoard, ...(set ? { set, collector } : {}) });
  }
  return out;
}

export type ExportStyle = 'sectioned' | 'plain';

/** Render a deck as text. `sectioned` adds Commander / Deck / Sideboard headers; `plain` is just "1 Name" lines. */
export function formatDeckList(entries: readonly DeckEntry[], style: ExportStyle = 'sectioned'): string {
  const sections: Array<[string, Board]> = [['Commander', 'commander'], ['Deck', 'main'], ['Sideboard', 'sideboard']];
  const blocks: string[] = [];
  for (const [title, board] of sections) {
    const lines = entries
      .filter((e) => e.board === board)
      .sort((a, b) => a.card.name.localeCompare(b.card.name))
      .map((e) => `${e.qty} ${e.card.name}`);
    if (!lines.length) continue;
    blocks.push(style === 'sectioned' ? [title, ...lines].join('\n') : lines.join('\n'));
  }
  return blocks.join(style === 'sectioned' ? '\n\n' : '\n') + '\n';
}
