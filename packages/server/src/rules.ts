import { firstRuleReference, type ParsedRules, type RuleDetail, type RuleHit, type RulesSearchResult, type RulesStatus, type RulesToc } from '@grimoire/shared';
import { transaction, type Db } from './db.js';

/** Replace the stored Comprehensive Rules with a freshly parsed copy. */
export function loadRules(db: Db, parsed: ParsedRules): void {
  transaction(db, () => {
    db.exec('DELETE FROM rule_sections; DELETE FROM rules; DELETE FROM glossary; DELETE FROM rules_fts; DELETE FROM glossary_fts;');
    const section = db.prepare('INSERT INTO rule_sections (num, title) VALUES (?, ?)');
    for (const s of parsed.sections) section.run(s.num, s.title);
    const rule = db.prepare('INSERT INTO rules (id, kind, section, parent, text, ord) VALUES (?, ?, ?, ?, ?, ?)');
    const ruleFts = db.prepare('INSERT INTO rules_fts (text, id) VALUES (?, ?)');
    for (const r of parsed.rules) { rule.run(r.id, r.kind, r.section, r.parent, r.text, r.ord); ruleFts.run(r.text, r.id); }
    const gloss = db.prepare('INSERT OR REPLACE INTO glossary (term, definition) VALUES (?, ?)');
    const glossFts = db.prepare('INSERT INTO glossary_fts (term, definition) VALUES (?, ?)');
    for (const g of parsed.glossary) { gloss.run(g.term, g.definition); glossFts.run(g.term, g.definition); }
  });
}

export function rulesStatus(db: Db): RulesStatus {
  const n = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  const effective = (db.prepare("SELECT value FROM meta WHERE key = 'rules_effective'").get() as { value: string } | undefined)?.value ?? null;
  const rules = n('rules');
  return { loaded: rules > 0, effective, rules, glossary: n('glossary') };
}

interface RuleRow { id: string; kind: RuleHit['kind']; section: number; section_title: string; text: string }
const HIT_SQL = 'SELECT r.id, r.kind, r.section, s.title AS section_title, r.text FROM rules r JOIN rule_sections s ON s.num = r.section';
const toHit = (r: RuleRow): RuleHit => ({ id: r.id, kind: r.kind, section: r.section, sectionTitle: r.section_title, text: r.text });

/** Words from free text as an FTS5 query: every word must appear, and the last may be a prefix ("tram" finds trample). */
export function ftsQuery(q: string): string | null {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}

const STOPWORDS = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'do', 'does', 'did', 'how', 'what', 'when', 'where', 'which', 'who', 'why', 'can', 'could', 'should', 'would', 'happens', 'happen', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'if', 'my', 'i', 'it', 'its', 'that', 'this', 'there', 'you', 'your']);

/** For questions in plain English: any of the meaningful words (stopwords dropped), ranked by relevance. */
export function ftsAnyQuery(q: string): string | null {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOPWORDS.has(w));
  if (words.length < 2) return null;
  return words.map((w) => `"${w}"`).join(' OR ');
}

const RULE_NUMBER = /^\s*(?:rules?\s+)?(\d{3}(?:\.\d+[a-z]?)?)\.?\s*$/i;

export function getRule(db: Db, id: string): RuleHit | null {
  const row = db.prepare(`${HIT_SQL} WHERE r.id = ?`).get(id) as unknown as RuleRow | undefined;
  return row ? toHit(row) : null;
}

export function searchRules(db: Db, q: string, limit = 40): RulesSearchResult {
  const empty: RulesSearchResult = { rules: [], glossary: [], exact: null };
  const number = RULE_NUMBER.exec(q)?.[1];
  const exact = number ? getRule(db, number.toLowerCase()) : null;
  if (exact) return { ...empty, exact }; // a rule number means that rule, not a text search for its digits
  const fts = ftsQuery(q);
  if (!fts) return empty;

  const glossary = new Map<string, { term: string; definition: string; rule: string | null }>();
  const addTerm = (term: string, definition: string) => { if (!glossary.has(term.toLowerCase())) glossary.set(term.toLowerCase(), { term, definition, rule: firstRuleReference(definition) }); };
  const direct = db.prepare('SELECT term, definition FROM glossary WHERE term = ?').get(q.trim()) as { term: string; definition: string } | undefined;
  if (direct) addTerm(direct.term, direct.definition);
  for (const g of db.prepare('SELECT term, definition FROM glossary_fts WHERE glossary_fts MATCH ? ORDER BY bm25(glossary_fts, 8.0, 1.0) LIMIT 6').all(fts) as unknown as Array<{ term: string; definition: string }>) addTerm(g.term, g.definition);

  const run = (match: string) => db.prepare(`${HIT_SQL} JOIN rules_fts f ON f.id = r.id WHERE rules_fts MATCH ? ORDER BY bm25(rules_fts) LIMIT ?`).all(match, limit) as unknown as RuleRow[];
  let rows = run(fts);
  if (rows.length < 3) { // too few rules contain every word: fall back to rules containing any of the meaningful ones
    const any = ftsAnyQuery(q);
    if (any) { const seen = new Set(rows.map((r) => r.id)); rows = [...rows, ...run(any).filter((r) => !seen.has(r.id))].slice(0, limit); }
  }
  return { rules: rows.map(toHit), glossary: [...glossary.values()].slice(0, 6), exact: null };
}

/** A rule with the chain of headings above it and the rules directly below it. */
export function getRuleDetail(db: Db, id: string): RuleDetail | null {
  const rule = getRule(db, id);
  if (!rule) return null;
  const ancestors: RuleHit[] = [];
  let parentId = (db.prepare('SELECT parent FROM rules WHERE id = ?').get(id) as { parent: string | null }).parent;
  while (parentId) {
    const p = getRule(db, parentId);
    if (!p) break;
    ancestors.unshift(p);
    parentId = (db.prepare('SELECT parent FROM rules WHERE id = ?').get(parentId) as { parent: string | null }).parent;
  }
  const children = (db.prepare(`${HIT_SQL} WHERE r.parent = ? ORDER BY r.ord`).all(id) as unknown as RuleRow[]).map(toHit);
  return { rule, ancestors, children };
}

export function rulesToc(db: Db): RulesToc {
  const sections = db.prepare('SELECT num, title FROM rule_sections ORDER BY num').all() as unknown as Array<{ num: number; title: string }>;
  const groups = db.prepare("SELECT id, text, section FROM rules WHERE kind = 'group' ORDER BY ord").all() as unknown as Array<{ id: string; text: string; section: number }>;
  return { sections: sections.map((s) => ({ ...s, groups: groups.filter((g) => g.section === s.num).map((g) => ({ id: g.id, title: g.text })) })) };
}

/** Glossary definitions for a card's keyword abilities (so card details can explain "Trample" without leaving the app). */
export function keywordInfo(db: Db, keywords: readonly string[]): Array<{ term: string; definition: string; rule: string | null }> {
  const stmt = db.prepare('SELECT term, definition FROM glossary WHERE term = ?');
  const seen = new Set<string>();
  const out: Array<{ term: string; definition: string; rule: string | null }> = [];
  for (const k of keywords) {
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const g = stmt.get(k) as { term: string; definition: string } | undefined;
    if (g) out.push({ term: g.term, definition: g.definition, rule: firstRuleReference(g.definition) });
  }
  return out;
}
