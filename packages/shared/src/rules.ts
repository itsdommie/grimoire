// Parser for Wizards' Comprehensive Rules plain-text file: numbered sections, rule groups, rules and lettered subrules, then a glossary.

export interface RuleSection { num: number; title: string }

export interface RuleEntry {
  /** "702", "702.19" or "702.19b". */
  id: string;
  kind: 'group' | 'rule' | 'subrule';
  /** Section number (the first digit of the id). */
  section: number;
  /** The group a rule belongs to, or the rule a subrule belongs to; null for a group. */
  parent: string | null;
  /** The rule's text; examples are appended on their own lines. */
  text: string;
  /** Position in the document, for ordering. */
  ord: number;
}

export interface GlossaryEntry { term: string; definition: string }

export interface ParsedRules {
  /** e.g. "September 25, 2026". */
  effective: string | null;
  sections: RuleSection[];
  rules: RuleEntry[];
  glossary: GlossaryEntry[];
}

const NBSP = new RegExp(String.fromCharCode(0xa0), 'g');
const LINE_SEP = new RegExp(String.fromCharCode(0x2028), 'g'); // Wizards puts this inside glossary definitions to start a numbered sense on a new line

/** Pull the first rule number mentioned in a text, e.g. "See rule 702.19, “Trample.”" -> "702.19". */
export function firstRuleReference(text: string): string | null {
  return /\brules?\s+(\d{3}(?:\.\d+[a-z]?)?)/i.exec(text)?.[1] ?? null;
}

export function parseComprehensiveRules(raw: string): ParsedRules {
  const lines = raw.replace(/^﻿/, '').replace(/\r/g, '').split('\n').map((l) => l.replace(NBSP, ' ').trim());
  const effective = /effective as of (.+?)\.?$/m.exec(raw.replace(NBSP, ' '))?.[1]?.trim() ?? null;

  // The document opens with a table of contents that lists the same headings; the real body starts after its "Credits" entry.
  const tocEnd = lines.indexOf('Credits');
  const lastGlossary = lines.lastIndexOf('Glossary');
  const lastCredits = lines.lastIndexOf('Credits');
  if (tocEnd < 0 || lastGlossary <= tocEnd || lastCredits <= lastGlossary) throw new Error("This doesn't look like the Comprehensive Rules (no glossary found).");
  const bodyStart = lines.findIndex((l, i) => i > tocEnd && /^\d\. \S/.test(l));
  if (bodyStart < 0) throw new Error('No rules sections found.');

  const sections: RuleSection[] = [];
  const rules: RuleEntry[] = [];
  let last: RuleEntry | undefined;
  let section = 0;
  for (let i = bodyStart; i < lastGlossary; i++) {
    const line = lines[i]!;
    if (!line) continue;
    let m: RegExpExecArray | null;
    if ((m = /^(\d)\. (.+)$/.exec(line))) { section = Number(m[1]); sections.push({ num: section, title: m[2]! }); last = undefined; continue; }
    if ((m = /^(\d{3})\. (.+)$/.exec(line))) { last = { id: m[1]!, kind: 'group', section, parent: null, text: m[2]!, ord: rules.length }; rules.push(last); continue; }
    if ((m = /^(\d{3}\.\d+)\.? (.*)$/.exec(line))) { last = { id: m[1]!, kind: 'rule', section, parent: m[1]!.split('.')[0]!, text: m[2]!, ord: rules.length }; rules.push(last); continue; }
    if ((m = /^(\d{3}\.\d+[a-z]) (.*)$/.exec(line))) { last = { id: m[1]!, kind: 'subrule', section, parent: m[1]!.replace(/[a-z]$/, ''), text: m[2]!, ord: rules.length }; rules.push(last); continue; }
    if (last) last.text += `\n${line}`; // "Example: ..." and any wrapped continuation belong to the rule above
  }

  const glossary: GlossaryEntry[] = [];
  let block: string[] = [];
  const flush = () => {
    if (block.length >= 2) glossary.push({ term: block[0]!, definition: block.slice(1).join('\n').replace(LINE_SEP, '\n') });
    block = [];
  };
  for (let i = lastGlossary + 1; i < lastCredits; i++) {
    const line = lines[i]!;
    if (!line) flush(); else block.push(line);
  }
  flush();

  return { effective, sections, rules, glossary };
}

/** Split text into plain pieces and rule references ("rule 702.19b", "rules 704.5k"), so a UI can turn the references into links. */
export function splitRuleReferences(text: string): Array<{ text: string; rule?: string }> {
  const out: Array<{ text: string; rule?: string }> = [];
  let last = 0;
  for (const m of text.matchAll(/\b(rules?\s+)(\d{3}(?:\.\d+[a-z]?)?)/gi)) {
    const start = m.index! + m[1]!.length;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: m[2]!, rule: m[2]! });
    last = start + m[2]!.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
