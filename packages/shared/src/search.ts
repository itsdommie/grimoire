import { GUILDS, lettersToMask } from './colors.js';

export class SearchError extends Error {}

export type Op = ':' | '=' | '!=' | '<' | '<=' | '>' | '>=';

export type Node =
  | { type: 'and' | 'or'; children: Node[] }
  | { type: 'not'; child: Node }
  | { type: 'term'; key: string; op: Op; value: string }
  | { type: 'name'; value: string }
  | { type: 'exact'; value: string };

// ---------------------------------------------------------------- tokenizer

type Token =
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'minus' }
  | { t: 'or' }
  | { t: 'and' }
  | { t: 'word'; text: string; quoted: boolean; exact: boolean; key?: string; op?: Op };

const OPS: Op[] = ['<=', '>=', '!=', ':', '=', '<', '>'];

function readQuoted(src: string, start: number): [string, number] {
  // src[start] is the opening quote
  const quote = src[start]!;
  let out = '';
  let i = start + 1;
  while (i < src.length && src[i] !== quote) {
    if (src[i] === '\\' && i + 1 < src.length) i++;
    out += src[i];
    i++;
  }
  if (i >= src.length) throw new SearchError(`Unterminated quote: ${src.slice(start)}`);
  return [out, i + 1];
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(') { tokens.push({ t: 'lparen' }); i++; continue; }
    if (ch === ')') { tokens.push({ t: 'rparen' }); i++; continue; }
    if (ch === '-' && i + 1 < src.length && !/\s/.test(src[i + 1]!)) {
      tokens.push({ t: 'minus' }); i++; continue;
    }
    if (ch === '!' && (src[i + 1] === '"' || src[i + 1] === "'")) {
      const [text, next] = readQuoted(src, i + 1);
      tokens.push({ t: 'word', text, quoted: true, exact: true });
      i = next;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const [text, next] = readQuoted(src, i);
      tokens.push({ t: 'word', text, quoted: true, exact: false });
      i = next;
      continue;
    }
    // bare word, possibly key<op>value (value may be quoted)
    let j = i;
    let key: string | undefined;
    let op: Op | undefined;
    while (j < src.length && !/[\s()]/.test(src[j]!)) {
      if (key === undefined) {
        const found = OPS.find((o) => src.startsWith(o, j));
        if (found && j > i && /^[a-z]+$/i.test(src.slice(i, j))) {
          key = src.slice(i, j).toLowerCase();
          op = found;
          j += found.length;
          if (src[j] === '"' || src[j] === "'") {
            const [text, next] = readQuoted(src, j);
            tokens.push({ t: 'word', text, quoted: true, exact: false, key, op });
            i = next;
            key = undefined;
            j = -1;
            break;
          }
          continue;
        }
      }
      j++;
    }
    if (j === -1) continue; // quoted value token already pushed
    const text = key === undefined ? src.slice(i, j) : src.slice(i + key.length + op!.length, j);
    const lower = text.toLowerCase();
    if (key === undefined && lower === 'or') tokens.push({ t: 'or' });
    else if (key === undefined && lower === 'and') tokens.push({ t: 'and' });
    else tokens.push({ t: 'word', text, quoted: false, exact: false, key, op });
    i = j;
  }
  return tokens;
}

// ------------------------------------------------------------------- parser

export function parse(src: string): Node | null {
  const tokens = tokenize(src);
  if (tokens.length === 0) return null;
  let pos = 0;

  const peek = () => tokens[pos];

  function parseOr(): Node {
    const children = [parseAnd()];
    while (peek()?.t === 'or') {
      pos++;
      children.push(parseAnd());
    }
    return children.length === 1 ? children[0]! : { type: 'or', children };
  }

  function parseAnd(): Node {
    const children: Node[] = [];
    for (;;) {
      const tok = peek();
      if (!tok || tok.t === 'rparen' || tok.t === 'or') break;
      if (tok.t === 'and') { pos++; continue; }
      children.push(parseUnary());
    }
    if (children.length === 0) throw new SearchError('Expected a search term');
    return children.length === 1 ? children[0]! : { type: 'and', children };
  }

  function parseUnary(): Node {
    const tok = peek();
    if (!tok) throw new SearchError('Unexpected end of query');
    if (tok.t === 'minus') {
      pos++;
      return { type: 'not', child: parseUnary() };
    }
    if (tok.t === 'lparen') {
      pos++;
      const inner = parseOr();
      if (peek()?.t !== 'rparen') throw new SearchError('Missing closing parenthesis');
      pos++;
      return inner;
    }
    if (tok.t === 'word') {
      pos++;
      if (tok.key !== undefined) return { type: 'term', key: tok.key, op: tok.op!, value: tok.text };
      if (tok.exact) return { type: 'exact', value: tok.text };
      return { type: 'name', value: tok.text };
    }
    throw new SearchError(`Unexpected "${tok.t === 'rparen' ? ')' : tok.t}"`);
  }

  const node = parseOr();
  if (pos < tokens.length) throw new SearchError('Unbalanced parentheses');
  return node;
}

// ----------------------------------------------------------------- compiler

export interface Compiled {
  where: string;
  params: Array<string | number>;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const contains = (col: string, value: string, params: Compiled['params']) => {
  params.push(`%${likeEscape(value.toLowerCase())}%`);
  return `lower(${col}) LIKE ? ESCAPE '\\'`;
};

const SQL_OP: Record<Op, string> = { ':': '=', '=': '=', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };

const RARITY: Record<string, number> = { common: 0, c: 0, uncommon: 1, u: 1, rare: 2, r: 2, mythic: 3, m: 3, special: 4, s: 4, bonus: 5, b: 5 };

const NUMERIC: Record<string, string> = {
  cmc: 'cmc', mv: 'cmc', manavalue: 'cmc',
  pow: 'power_n', power: 'power_n',
  tou: 'toughness_n', toughness: 'toughness_n',
  loy: 'loyalty_n', loyalty: 'loyalty_n',
  usd: 'COALESCE(usd_min, usd)', edhrec: 'edhrec_rank',
};

/** Parse a colour query value into { mask } or { count } */
function colourValue(raw: string): { mask: number; count?: undefined } | { count: number; mask?: undefined } {
  const v = raw.toLowerCase();
  if (/^\d+$/.test(v)) return { count: Number(v) };
  if (v === 'c' || v === 'colorless' || v === 'colourless') return { mask: 0 };
  const guild = GUILDS[v];
  const mask = lettersToMask(guild ?? v);
  if (mask === null) throw new SearchError(`Unknown colour "${raw}"`);
  return { mask };
}

function colourClause(col: string, countCol: string, op: Op, raw: string, params: Compiled['params'], colonIsSubset: boolean): string {
  const v = raw.toLowerCase();
  if (v === 'm' || v === 'multicolor' || v === 'multicolour') {
    return op === '!=' ? `${countCol} < 2` : `${countCol} >= 2`;
  }
  const cv = colourValue(raw);
  if (cv.count !== undefined) {
    params.push(cv.count);
    return `${countCol} ${SQL_OP[op]} ?`;
  }
  const q = cv.mask;
  const effective: Op = op === ':' ? (colonIsSubset ? '<=' : '>=') : op;
  if (q === 0 && (effective === '>=' || effective === '=')) return `${col} = 0`;
  switch (effective) {
    case '>=': params.push(q, q); return `(${col} & ?) = ?`;
    case '<=': params.push(q, q); return `(${col} | ?) = ?`;
    case '=': params.push(q); return `${col} = ?`;
    case '!=': params.push(q); return `${col} != ?`;
    case '>': params.push(q, q, q); return `((${col} & ?) = ? AND ${col} != ?)`;
    case '<': params.push(q, q, q); return `((${col} | ?) = ? AND ${col} != ?)`;
    default: throw new SearchError(`Operator ${op} not supported for colours`);
  }
}

function compileTerm(key: string, op: Op, value: string, params: Compiled['params']): string {
  if (value === '') throw new SearchError(`"${key}${op}" needs a value`);
  const numCol = NUMERIC[key];
  if (numCol) {
    const n = Number(value);
    if (Number.isNaN(n)) throw new SearchError(`"${key}" expects a number, got "${value}"`);
    params.push(n);
    return `${numCol} ${SQL_OP[op]} ?`;
  }
  if (key === 'about' || key === 'meaning' || key === 'sem') return '1=1'; // ranked by the server's semantic index, not filtered by SQL
  if (key === 'otag' || key === 'function' || key === 'oracletag') {
    // Scryfall's community "Oracle Tags", including every descendant tag (otag:removal also matches otag:removal-destroy).
    const slug = value.toLowerCase();
    params.push(slug, slug);
    return `EXISTS (SELECT 1 FROM card_tags ct WHERE ct.card_id = cards.id AND ct.tag IN (WITH RECURSIVE d(slug) AS (SELECT COALESCE((SELECT slug FROM tag_aliases WHERE alias = ?), ?) UNION SELECT e.child FROM tag_edges e JOIN d ON e.parent = d.slug) SELECT slug FROM d))`;
  }
  if (key === 'owned') {
    const n = Number(value);
    if (!Number.isInteger(n)) throw new SearchError(`"owned" expects a whole number, got "${value}"`);
    params.push(n);
    return `COALESCE((SELECT qty FROM collection WHERE collection.card_id = cards.id), 0) ${SQL_OP[op]} ?`;
  }
  switch (key) {
    case 'n': case 'name': return contains('name', value, params);
    case 'o': case 'oracle': case 'text': return contains('oracle_text', value, params);
    case 't': case 'type': return contains('type_line', value, params);
    case 'kw': case 'keyword': return contains('keywords', value, params);
    case 'm': case 'mana': {
      const norm = value.includes('{') ? value : value.replace(/[a-z0-9]+/gi, (m) => (/^\d+$/.test(m) ? `{${m}}` : [...m].map((c) => `{${c.toUpperCase()}}`).join('')));
      return contains('mana_cost', norm, params);
    }
    case 'c': case 'color': case 'colour': return colourClause('colors', 'colors_count', op, value, params, false);
    case 'id': case 'identity': case 'ci': return colourClause('color_identity', 'identity_count', op, value, params, true);
    case 'commander': return colourClause('color_identity', 'identity_count', '<=', value, params, true);
    case 'produces': {
      const mask = lettersToMask(value);
      if (mask === null) throw new SearchError(`Unknown colour "${value}"`);
      params.push(mask, mask);
      return `(produced_mana & ?) = ?`;
    }
    case 'r': case 'rarity': {
      const n = RARITY[value.toLowerCase()];
      if (n === undefined) throw new SearchError(`Unknown rarity "${value}"`);
      params.push(n);
      return `rarity_n ${SQL_OP[op]} ?`;
    }
    case 's': case 'set': case 'e': case 'edition':
      params.push(value.toLowerCase());
      return `set_code = ?`;
    case 'f': case 'format': case 'legal':
      params.push(value.toLowerCase());
      return `EXISTS (SELECT 1 FROM legality l WHERE l.card_id = cards.id AND l.format = ? AND l.status IN ('legal','restricted'))`;
    case 'banned':
      params.push(value.toLowerCase());
      return `EXISTS (SELECT 1 FROM legality l WHERE l.card_id = cards.id AND l.format = ? AND l.status = 'banned')`;
    case 'restricted':
      params.push(value.toLowerCase());
      return `EXISTS (SELECT 1 FROM legality l WHERE l.card_id = cards.id AND l.format = ? AND l.status = 'restricted')`;
    case 'is': return compileIs(value.toLowerCase());
    default: throw new SearchError(`Unknown search keyword "${key}"`);
  }
}

function compileIs(value: string): string {
  switch (value) {
    case 'commander':
      return `(type_line LIKE '%Legendary%Creature%' OR lower(oracle_text) LIKE '%can be your commander%')`;
    case 'permanent': return `(type_line NOT LIKE '%Instant%' AND type_line NOT LIKE '%Sorcery%')`;
    case 'spell': return `type_line NOT LIKE '%Land%'`;
    case 'historic': return `(type_line LIKE '%Legendary%' OR type_line LIKE '%Artifact%' OR type_line LIKE '%Saga%')`;
    case 'multicolor': case 'multicolour': return `colors_count >= 2`;
    case 'colorless': case 'colourless': return `colors = 0`;
    case 'digital': return `digital = 1`;
    default: throw new SearchError(`Unknown "is:" value "${value}"`);
  }
}

function compileNode(node: Node, params: Compiled['params']): string {
  switch (node.type) {
    case 'and': return `(${node.children.map((c) => compileNode(c, params)).join(' AND ')})`;
    case 'or': return `(${node.children.map((c) => compileNode(c, params)).join(' OR ')})`;
    case 'not': return `NOT (${compileNode(node.child, params)})`;
    case 'name': return contains('name', node.value, params);
    case 'exact': params.push(node.value.toLowerCase()); return `lower(name) = ?`;
    case 'term': return compileTerm(node.key, node.op, node.value, params);
  }
}

/** Compile a Scryfall-style query to a SQL WHERE fragment over the `cards` table. */
export function compileQuery(src: string): Compiled {
  const ast = parse(src);
  if (!ast) return { where: '1=1', params: [] };
  const params: Compiled['params'] = [];
  return { where: compileNode(ast, params), params };
}

/** Every key:value term in a query (used by the server to validate things the compiler can't check, such as tag names). */
export function termsOf(src: string): Array<{ key: string; op: Op; value: string }> {
  const out: Array<{ key: string; op: Op; value: string }> = [];
  const walk = (n: Node | null) => {
    if (!n) return;
    if (n.type === 'term') out.push({ key: n.key, op: n.op, value: n.value });
    else if (n.type === 'not') walk(n.child);
    else if (n.type === 'and' || n.type === 'or') n.children.forEach(walk);
  };
  walk(parse(src));
  return out;
}

/** `about:"..."` phrases for semantic search, with whether each sits under a negation. */
export function semanticPhrases(src: string): Array<{ text: string; negated: boolean }> {
  const out: Array<{ text: string; negated: boolean }> = [];
  const walk = (n: Node | null, negated: boolean) => {
    if (!n) return;
    if (n.type === 'term') { if (n.key === 'about' || n.key === 'meaning' || n.key === 'sem') out.push({ text: n.value, negated }); }
    else if (n.type === 'not') walk(n.child, !negated);
    else if (n.type === 'and' || n.type === 'or') n.children.forEach((c) => walk(c, negated));
  };
  walk(parse(src), false);
  return out;
}
