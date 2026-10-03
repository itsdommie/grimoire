import { parseDeckList } from './deck.js';

/** RFC 4180-style CSV parser: quoted fields, escaped quotes (""), embedded newlines, CRLF, and a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((f) => f !== '')) rows.push(row); }
  return rows;
}

export interface CollectionRow {
  name: string;
  qty: number;
  set?: string;
  collector?: string;
}

export type CollectionFormat = 'manabox' | 'moxfield' | 'archidekt' | 'deckbox' | 'csv' | 'text';

export interface ParsedCollection {
  format: CollectionFormat;
  rows: CollectionRow[];
  /** Lines/rows that couldn't be read (e.g. a non-numeric quantity). */
  skipped: string[];
}

const NAME_HEADERS = ['name', 'card name', 'card', 'cardname'];
const QTY_HEADERS = ['quantity', 'count', 'qty', 'amount', 'reg qty', 'total qty'];
const SET_HEADERS = ['set code', 'set', 'edition code', 'edition', 'set name'];
const COLLECTOR_HEADERS = ['collector number', 'collector #', 'card number', 'number'];

const norm = (s: string) => s.trim().toLowerCase();
const findCol = (header: string[], names: string[]) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };

function detectFormat(header: string[]): CollectionFormat {
  const h = new Set(header);
  if (h.has('manabox id')) return 'manabox';
  if (h.has('quantity') && (h.has('scryfall oracle id') || h.has('edition code') || h.has('finish') || h.has('modifier'))) return 'archidekt';
  // Moxfield and Deckbox both have "Tradelist Count", so tell them apart by their other columns.
  if (h.has('card number') || h.has('textless') || h.has('signed')) return 'deckbox';
  if (h.has('last modified') || h.has('tags') || h.has('proxy') || h.has('tradelist count')) return 'moxfield';
  return 'csv';
}

/**
 * Read a collection export. Understands CSVs from ManaBox, Moxfield, Archidekt and Deckbox (and any CSV with a name and a
 * quantity column), and falls back to plain "4 Sol Ring" lists. Quantities for the same card are not merged here.
 */
export function parseCollection(text: string): ParsedCollection {
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const looksCsv = firstLine.includes(',') && NAME_HEADERS.some((n) => firstLine.toLowerCase().split(',').map((c) => c.replace(/"/g, '').trim()).includes(n));
  if (!looksCsv) {
    // Plain text: "4 Sol Ring", "Sol Ring", MTGO-style, with set/collector decorations stripped.
    return { format: 'text', rows: parseDeckList(text).map((l) => ({ name: l.name, qty: l.qty, set: l.set, collector: l.collector })), skipped: [] };
  }

  const table = parseCsv(text);
  const header = table[0]!.map(norm);
  const nameCol = findCol(header, NAME_HEADERS);
  const qtyCol = findCol(header, QTY_HEADERS);
  const setCol = findCol(header, SET_HEADERS);
  const colCol = findCol(header, COLLECTOR_HEADERS);
  const rows: CollectionRow[] = [];
  const skipped: string[] = [];
  for (const r of table.slice(1)) {
    const name = (r[nameCol] ?? '').trim();
    if (!name) continue;
    const rawQty = qtyCol >= 0 ? (r[qtyCol] ?? '').trim() : '1';
    const qty = rawQty === '' ? 1 : Number(rawQty);
    if (!Number.isInteger(qty) || qty < 1) { skipped.push(`${name} (quantity "${rawQty}")`); continue; }
    rows.push({ name, qty, ...(setCol >= 0 && r[setCol] ? { set: r[setCol]!.trim().toLowerCase() } : {}), ...(colCol >= 0 && r[colCol] ? { collector: r[colCol]!.trim() } : {}) });
  }
  return { format: detectFormat(header), rows, skipped };
}
