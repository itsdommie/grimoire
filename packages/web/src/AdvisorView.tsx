import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AdvisorMessage, AdvisorReply, AdvisorStatus } from '@grimoire/shared';
import { api } from './api';

export interface ChatItem { role: 'user' | 'assistant'; content: string; cards?: AdvisorReply['cards']; lookups?: number }

/** **bold** and bullet lists, as React elements: the model's text is never injected as HTML. */
function Rich({ text }: { text: string }): ReactNode {
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>));
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { const items = list; blocks.push(<ul key={blocks.length}>{items.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>); list = []; } };
  for (const line of text.split('\n')) {
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) { list.push(bullet[1]!); continue; }
    flush();
    if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line.replace(/^#+\s*/, ''))}</p>);
  }
  flush();
  return <>{blocks}</>;
}

function KeySetup({ status, onChange }: { status: AdvisorStatus; onChange: (s: AdvisorStatus) => void }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError(null);
    try { onChange(await api.advisorSetKey(key)); setKey(''); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="advisorsetup" aria-label="Set up the advisor">
      <h2>Advisor <span className="muted small">(optional)</span></h2>
      <p>Ask Claude about your decks: what to cut, what you're short on, what you already own that fits. It can only suggest cards it has looked up in your card database, so they are real and legal in the deck's format.</p>
      <p className="muted small">This is the one part of Grimoire that uses the internet for something other than card data. It needs your own Anthropic API key (<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">get one here</a>); Anthropic bills usage to your account. Your questions, and the cards and deck the advisor looks at to answer them, are sent to Anthropic. Nothing else is: not your collection as a whole, not your files.</p>
      {status.canStore ? (
        <form onSubmit={(e) => { e.preventDefault(); if (key.trim()) void save(); }} className="deckbar">
          <input type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-…" aria-label="Anthropic API key" value={key} onChange={(e) => setKey(e.target.value)} />
          <button className="primary" disabled={busy || !key.trim()}>Save key</button>
        </form>
      ) : (
        <p className="warning">This device has no keychain to protect a saved key, so Grimoire won't store one. Start Grimoire with the <code>ANTHROPIC_API_KEY</code> environment variable set instead.</p>
      )}
      {status.canStore && <p className="muted small">The key is encrypted with this device's secure storage (the operating system's keychain), stays on this device, and is never shown again.</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

const STARTERS_DECK = ['Review my deck and tell me the most important things to fix.', "What is my deck short on, and what do I already own that would fix it?", 'Suggest five cheap upgrades (under $2 each).'];
const STARTERS_NONE = ['Suggest a commander for a +1/+1 counters deck and explain why.', 'What are the best cheap ways to ramp in green?', 'Which cards of mine would make a good Boros aggro deck?'];

export function AdvisorView({ deck, chat, setChat, onOpenCard }: {
  deck: { id: number; name: string; format: string } | null;
  chat: ChatItem[];
  setChat: (update: (c: ChatItem[]) => ChatItem[]) => void;
  onOpenCard: (id: string) => void;
}) {
  const [status, setStatus] = useState<AdvisorStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { api.advisorStatus().then(setStatus).catch(() => setError("Couldn't reach the app's database.")); }, []);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [chat, waiting]);
  useEffect(() => () => abort.current?.abort(), []);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || waiting) return;
    const next: ChatItem[] = [...chat, { role: 'user', content }];
    setChat(() => next);
    setDraft(''); setError(null); setWaiting(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const messages: AdvisorMessage[] = next.map(({ role, content: c }) => ({ role, content: c }));
      const r = await api.advisorChat(messages, deck?.id, controller.signal);
      setChat((c) => [...c, { role: 'assistant', content: r.reply, cards: r.cards, lookups: r.lookups }]);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally { setWaiting(false); }
  };

  if (!status) return <p className="muted">{error ?? 'Loading…'}</p>;
  if (!status.configured) return <KeySetup status={status} onChange={setStatus} />;

  return (
    <section className="advisor" aria-label="Advisor">
      <div className="advisorbar">
        <span className="muted small">{deck ? <>Looking at <strong>{deck.name}</strong> ({deck.format})</> : 'No deck open: ask general questions, or open a deck to have it reviewed.'}</span>
        <span className="advisoractions">
          <select value={status.model} aria-label="Model" onChange={async (e) => { try { setStatus(await api.advisorSetModel(e.target.value)); } catch (err) { setError((err as Error).message); } }}>
            {status.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {chat.length > 0 && <button onClick={() => { abort.current?.abort(); setChat(() => []); setError(null); }}>New chat</button>}
          {status.source === 'stored' && <button className="danger" onClick={async () => { if (window.confirm('Remove your saved Anthropic API key from this device?')) setStatus(await api.advisorClearKey()); }}>Remove key</button>}
        </span>
      </div>

      <div className="chatlog" aria-live="polite">
        {chat.length === 0 && (
          <div className="starters">
            <p className="muted">Try:</p>
            {(deck ? STARTERS_DECK : STARTERS_NONE).map((s) => <button key={s} onClick={() => void send(s)}>{s}</button>)}
          </div>
        )}
        {chat.map((m, i) => (
          <div key={i} className={`chatmsg ${m.role}`}>
            <div className="chatwho muted small">{m.role === 'user' ? 'You' : 'Advisor'}{m.lookups ? ` · looked at ${m.lookups} ${m.lookups === 1 ? 'thing' : 'things'} in your card database` : ''}</div>
            {m.role === 'user' ? <p>{m.content}</p> : <Rich text={m.content} />}
            {m.cards && m.cards.length > 0 && (
              <ul className="chatcards" aria-label="Cards mentioned">
                {m.cards.map((c) => (
                  <li key={c.id}><button onClick={() => onOpenCard(c.id)} title={`Open ${c.name}`}>{c.imageUrl ? <img src={c.imageUrl} alt={c.name} loading="lazy" /> : c.name}</button></li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {waiting && <p className="muted chatmsg assistant" role="status">Thinking… it may look a few things up first.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div ref={end} />
      </div>

      <form className="chatinput" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
        <textarea rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask about your deck or a card…" aria-label="Message the advisor"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(draft); } }} />
        <button className="primary" disabled={waiting || !draft.trim()}>Send</button>
      </form>
      <p className="muted small">Answers come from Claude using only cards in your database; check anything important. Prices are rough guides.</p>
    </section>
  );
}
