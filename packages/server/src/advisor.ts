import { analyzeDeck, type AdvisorMessage, type AdvisorReply, type AdvisorStatus, type Card, type DeckDetail, type FormatId } from '@grimoire/shared';
import { getCardByName, searchCards, type Order, type SemanticRanker } from './cards.js';
import { getDeck } from './decks.js';
import type { Db } from './schema.js';

// The optional Claude advisor. A chat panel whose model can only reach Grimoire's own card database through a few tools, so every card it
// suggests is a real one, checked for legality against the format. It needs the user's own Anthropic API key, which lives in a KeyStore
// (the desktop app's is the operating system's keychain) and goes nowhere except to api.anthropic.com, in a header. Nothing else about
// the user is sent: only the conversation, and what the tools return.

export const ADVISOR_MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (balanced)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (most capable, costs more)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fastest, cheapest)' },
];
export const DEFAULT_ADVISOR_MODEL = ADVISOR_MODELS[0]!.id;
export const ANTHROPIC_URL = 'https://api.anthropic.com';

export interface KeyStore {
  get(): string | null;
  /** (A phone keeps its key in a native store, which is asynchronous; get() reads a copy held in memory.) */
  set(key: string): void | Promise<void>;
  clear(): void | Promise<void>;
  /** Whether set() can keep a key between runs. */
  readonly canStore: boolean;
}
/** A key from the environment, then the store. The store is what the user's own "Save key" fills. */
export function keyFromEnvironment(store: KeyStore | null, env: Record<string, string | undefined> = {}): KeyStore & { source(): 'stored' | 'environment' | null } {
  const fromEnv = () => env.ANTHROPIC_API_KEY?.trim() || null;
  return {
    canStore: !!store?.canStore,
    get: () => store?.get() ?? fromEnv(),
    set: (k) => { if (!store?.canStore) throw new AdvisorError(409, 'This copy of Grimoire has nowhere safe to keep a key. Set the ANTHROPIC_API_KEY environment variable instead.'); return store.set(k); },
    clear: () => store?.clear(),
    source: () => (store?.get() ? 'stored' : fromEnv() ? 'environment' : null),
  };
}

export class AdvisorError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface AdvisorOptions {
  db: Db;
  keys: KeyStore & { source?(): 'stored' | 'environment' | null };
  fetch?: typeof fetch;
  baseUrl?: string;
  /** A page (the Android app) calls Anthropic directly, which the API only allows with an explicit header. */
  directBrowserAccess?: boolean;
  /** Ranking for `about:"…"` searches; throws when semantic search isn't set up. */
  rankerFor?: (query: string) => Promise<SemanticRanker | undefined>;
  maxRounds?: number;
}

const MAX_MESSAGES = 24;
const MAX_CHARS = 8000;

const LETTERS = ['W', 'U', 'B', 'R', 'G'];
const letters = (mask: number) => LETTERS.filter((_, i) => mask & (1 << i)).join('') || 'C';

const SYSTEM = `You are the deck advisor inside Grimoire, a Magic: The Gathering deck builder. The person talking to you is building or tuning decks.

How you work:
- Your only source of cards is the Grimoire card database, reached through your tools. Never suggest a card you have not seen in a tool result in this conversation, and never state a card's text, cost or legality from memory: look it up.
- Respect the deck's format (Commander by default) and colour identity. Use f:<format> in searches so illegal cards never come up, and id<=<colours> to stay inside a commander's colours.
- When a deck is open, call get_deck first to see it, its problems and its analysis, then search for fixes. The person's collection is searchable too: owned:>=1 finds cards they have, and spare:>=1 finds copies not already in another deck. Prefer owned cards when they ask what they can build or afford.
- Be concrete and brief: a short answer with specific card names, each with one reason. Put card names in **bold**. Say plainly when you can't find something good rather than padding.
- Prices are rough guides from Scryfall's data, not quotes.`;

const SEARCH_HELP = `Search the card database with Scryfall-style syntax. Terms combine with spaces (and), "or", "-" (not) and parentheses. Examples: t:creature c:rg cmc<=3 o:"draw a card"; f:commander id<=wubg is:commander; otag:ramp c:g cmc<=3; kw:flying r:mythic; owned:>=1; spare:>=1; usd<2. Fields: c: colours, id: colour identity, t: type line, o: oracle text, cmc, pow/tou, r: rarity, f: format legality, kw: keyword, otag: community function tag (ramp, removal, sweeper, draw, ...), is:, owned:, spare:, usd. about:"a short description of what it does" ranks by meaning when semantic search has been set up (otherwise it returns an error saying so; then use o: and otag: instead). Results come back best-first by the chosen order.`;

const TOOLS = [
  {
    name: 'search_cards',
    description: SEARCH_HELP,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search, e.g. f:commander id<=gw otag:ramp cmc<=3' },
        limit: { type: 'integer', description: 'How many cards to return (default 15, at most 30)' },
        order: { type: 'string', enum: ['name', 'cmc', 'edhrec', 'usd'], description: 'edhrec = by popularity in Commander decks (most played first)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_card',
    description: 'Everything about one card by its exact name: full rules text, cost, colour identity, legality in every format, price and how many copies the person owns.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'get_deck',
    description: "The deck the person has open: its format, every card by board with quantities, the rule problems found (size, copies, colour identity, banned cards) and the analysis (mana curve, lands, colour sources, roles such as ramp/draw/removal with whether each is short or fine). Fails if no deck is open.",
    input_schema: { type: 'object', properties: {} },
  },
];

type Block = { type: string; [k: string]: unknown };
interface ApiMessage { role: 'user' | 'assistant'; content: string | Block[] }
interface ApiResponse { content: Block[]; stop_reason: string }

const trimText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class Advisor {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly o: AdvisorOptions) { this.fetchImpl = o.fetch ?? ((...a) => fetch(...a)); }

  private meta(key: string): string | null {
    return (this.o.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  status(): AdvisorStatus {
    const source = this.o.keys.source ? this.o.keys.source() : this.o.keys.get() ? 'stored' : null;
    const saved = this.meta('advisor_model');
    return { configured: !!this.o.keys.get(), source, canStore: this.o.keys.canStore, model: ADVISOR_MODELS.some((m) => m.id === saved) ? saved! : DEFAULT_ADVISOR_MODEL, models: ADVISOR_MODELS };
  }

  async setKey(key: unknown): Promise<AdvisorStatus> {
    const k = typeof key === 'string' ? key.trim() : '';
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) throw new AdvisorError(400, "That doesn't look like an Anthropic API key (they start with sk-ant-).");
    await this.o.keys.set(k);
    return this.status();
  }

  async clearKey(): Promise<AdvisorStatus> { await this.o.keys.clear(); return this.status(); }

  setModel(id: unknown): AdvisorStatus {
    if (!ADVISOR_MODELS.some((m) => m.id === id)) throw new AdvisorError(400, 'Unknown model');
    this.o.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('advisor_model', id as string);
    return this.status();
  }

  // ----------------------------------------------------------------- tools

  private cardLine(card: Card, format: string) {
    return {
      name: card.name, cost: card.manaCost, type: card.typeLine, text: trimText(card.oracleText.replace(/\s*\n\s*/g, ' / '), 420),
      cmc: card.cmc, identity: letters(card.colorIdentity), [`legal_in_${format}`]: card.legalities[format] ?? 'not_legal',
      ...(card.power !== null ? { pt: `${card.power}/${card.toughness}` } : {}), ...(card.owned ? { owned: card.owned, spare: Math.max(0, card.owned - (card.inDecks ?? 0)) } : {}),
      ...(card.usd !== null ? { usd: card.usd } : {}), ...(card.edhrecRank !== null ? { edhrec_rank: card.edhrecRank } : {}),
    };
  }

  private async runTool(name: string, input: Record<string, unknown>, ctx: { deckId?: number; seen: Map<string, Card>; format: string }): Promise<unknown> {
    if (name === 'search_cards') {
      const query = typeof input.query === 'string' ? input.query : '';
      const limit = Math.min(Math.max(Number(input.limit) || 15, 1), 30);
      const order = (['name', 'cmc', 'edhrec', 'usd'] as const).includes(input.order as Order) ? (input.order as Order) : 'edhrec';
      const found = searchCards(this.o.db, { query, limit, order, excludeDeck: ctx.deckId, semantic: await this.o.rankerFor?.(query) });
      for (const c of found.cards) ctx.seen.set(c.name.toLowerCase(), c);
      return { total: found.total, shown: found.cards.length, cards: found.cards.map((c) => this.cardLine(c, ctx.format)) };
    }
    if (name === 'get_card') {
      const card = getCardByName(this.o.db, String(input.name ?? ''));
      if (!card) return { error: `No card is named "${String(input.name ?? '')}". Search for it instead.` };
      ctx.seen.set(card.name.toLowerCase(), card);
      return { ...this.cardLine(card, ctx.format), text: card.oracleText, legalities: card.legalities, keywords: card.keywords };
    }
    if (name === 'get_deck') {
      if (ctx.deckId === undefined) return { error: 'No deck is open. Ask the person to open or create one, or work from what they tell you.' };
      const d: DeckDetail = getDeck(this.o.db, ctx.deckId);
      for (const e of d.entries) ctx.seen.set(e.card.name.toLowerCase(), e.card);
      const a = analyzeDeck(d.entries, d.deck.format);
      const board = (b: string) => d.entries.filter((e) => e.board === b).map((e) => `${e.qty} ${e.card.name}`);
      return {
        name: d.deck.name, format: d.deck.format, commander: board('commander'), main: board('main'), sideboard: board('sideboard'),
        problems: d.issues.map((i) => `${i.severity}: ${i.message}`),
        analysis: {
          lands: a.lands, curve: { buckets_by_mv: a.curve.buckets, avg_mv: a.curve.avgMv, nonland_cards: a.curve.nonland }, pips: a.pips,
          roles: a.roles.map((r) => ({ role: r.label, count: r.count, ...(r.target ? { target: `${r.target.min}-${r.target.max}` } : {}), ...(r.status ? { status: r.status } : {}) })),
          findings: a.findings.map((f) => `${f.severity}: ${f.title}. ${f.detail}`),
        },
      };
    }
    return { error: `Unknown tool ${name}` };
  }

  // ------------------------------------------------------------------ chat

  private async call(key: string, model: string, messages: ApiMessage[]): Promise<ApiResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.o.baseUrl ?? ANTHROPIC_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01',
          ...(this.o.directBrowserAccess ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
        },
        body: JSON.stringify({ model, max_tokens: 3000, system: SYSTEM, tools: TOOLS, messages }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new AdvisorError(502, "Couldn't reach Anthropic. Check your internet connection and try again.");
    }
    if (!res.ok) {
      let detail = '';
      try { detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? ''; } catch { /* no body */ }
      if (res.status === 401 || res.status === 403) throw new AdvisorError(401, 'Anthropic rejected the API key. Check that it is correct and still active (you can remove the saved key and add it again).');
      if (res.status === 429) throw new AdvisorError(429, 'Anthropic says you are sending too many requests (or out of credit). Wait a moment and try again.');
      if (res.status === 529 || res.status >= 500) throw new AdvisorError(502, 'Anthropic is overloaded or unavailable right now. Try again in a minute.');
      throw new AdvisorError(502, `Anthropic returned an error (${res.status})${detail ? `: ${detail}` : ''}.`);
    }
    return (await res.json()) as ApiResponse;
  }

  async chat(messages: unknown, opts: { deckId?: number } = {}): Promise<AdvisorReply> {
    const key = this.o.keys.get();
    if (!key) throw new AdvisorError(409, 'The advisor needs your Anthropic API key. Add it in the Advisor tab.');
    if (!Array.isArray(messages) || messages.length === 0) throw new AdvisorError(400, 'Nothing to answer.');
    const history = (messages as AdvisorMessage[]).slice(-MAX_MESSAGES);
    while (history[0]?.role === 'assistant') history.shift(); // cutting a long chat must not leave it starting mid-answer
    if (history.length === 0) throw new AdvisorError(400, 'A conversation starts and ends with the person.');
    if (history.some((m) => (m?.role !== 'user' && m?.role !== 'assistant') || typeof m.content !== 'string' || m.content.length > MAX_CHARS)) throw new AdvisorError(400, 'Messages must be text of at most 8,000 characters.');
    if (history[0]!.role !== 'user' || history.at(-1)!.role !== 'user') throw new AdvisorError(400, 'A conversation starts and ends with the person.');

    let format: FormatId | string = 'commander';
    if (opts.deckId !== undefined) { try { format = getDeck(this.o.db, opts.deckId).deck.format; } catch { opts = {}; } }
    const model = this.status().model;
    const convo: ApiMessage[] = history.map((m) => ({ role: m.role, content: m.content }));
    const ctx = { deckId: opts.deckId, seen: new Map<string, Card>(), format };
    let lookups = 0;

    for (let round = 0; round < (this.o.maxRounds ?? 8); round++) {
      const out = await this.call(key, model, convo);
      if (out.stop_reason !== 'tool_use') {
        const text = out.content.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n').trim();
        const lower = text.toLowerCase();
        const mentioned = [...ctx.seen.values()].filter((c) => lower.includes(c.name.toLowerCase())).slice(0, 12);
        return { reply: text || 'I could not come up with an answer to that.', cards: mentioned.map((c) => ({ id: c.id, name: c.name, imageUrl: c.imageUrl })), lookups };
      }
      convo.push({ role: 'assistant', content: out.content });
      const results: Block[] = [];
      for (const block of out.content.filter((b) => b.type === 'tool_use')) {
        lookups++;
        try {
          const result = await this.runTool(String(block.name), (block.input ?? {}) as Record<string, unknown>, ctx);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        } catch (err) {
          // A bad search or a missing index is information for the model, not a failure of the chat: it can fix its query or go another way.
          results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: err instanceof Error ? err.message : String(err) });
        }
      }
      convo.push({ role: 'user', content: results });
    }
    throw new AdvisorError(502, 'That took too many lookups to answer. Try a more specific question.');
  }
}

