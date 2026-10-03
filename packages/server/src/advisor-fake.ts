import type { KeyStore } from './advisor.js';

// A stand-in for api.anthropic.com for the end-to-end tests (GRIMOIRE_FAKE_ADVISOR=1): no network, no key, deterministic. It behaves
// like the real API in the ways that matter: it asks for a database lookup first, then answers using what the lookup returned,
// and it rejects a key containing "invalid".

export function fakeAnthropic(): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    if ((headers['x-api-key'] ?? '').includes('invalid')) return new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 });
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string | Array<{ type: string; content?: string }> }> };
    const last = body.messages.at(-1)!;
    const reply = (content: unknown[], stop: string) => new Response(JSON.stringify({ stop_reason: stop, content }), { status: 200 });
    if (typeof last.content === 'string') {
      if (/slow/i.test(last.content)) await new Promise((r) => setTimeout(r, 800));
      return /deck/i.test(last.content)
        ? reply([{ type: 'tool_use', id: 'tu_deck', name: 'get_deck', input: {} }], 'tool_use')
        : reply([{ type: 'tool_use', id: 'tu_search', name: 'search_cards', input: { query: 't:artifact cmc<=1 f:commander', limit: 5, order: 'edhrec' } }], 'tool_use');
    }
    const result = String(last.content[0]?.content ?? '');
    if (/No deck is open/.test(result)) return reply([{ type: 'text', text: 'You have no deck open, so open one and ask again.' }], 'end_turn');
    if (/"problems"/.test(result)) return reply([{ type: 'text', text: 'I looked at your deck.\n- Add **Sol Ring** for fast mana.\n- Consider **Counterspell**.' }], 'end_turn');
    return reply([{ type: 'text', text: 'Good cheap options:\n- **Sol Ring**: two mana for one.\n- **Mana Crypt** is not a card I looked up.' }], 'end_turn');
  }) as unknown as typeof fetch;
}

export function memoryKeyStore(): KeyStore {
  let key: string | null = null;
  return { canStore: true, get: () => key, set: (k) => { key = k; }, clear: () => { key = null; } };
}
