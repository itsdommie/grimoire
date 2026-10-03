import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { splitRuleReferences, type RuleDetail, type RuleHit, type RulesSearchResult, type RulesStatus, type RulesToc } from '@grimoire/shared';
import { api } from './api';

/** Highlight the searched words in a piece of text (plain text only: nothing is ever injected as HTML). */
function Highlight({ text, query }: { text: string; query: string }) {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1);
  if (words.length === 0) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return <>{text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>))}</>;
}

/** Rule text with "rule 702.19b" turned into links. */
function RuleText({ text, onOpen }: { text: string; onOpen: (id: string) => void }): ReactNode {
  return text.split('\n').map((line, li) => (
    <p key={li} className={line.startsWith('Example:') ? 'ruleexample' : undefined}>
      {splitRuleReferences(line).map((part, i) => (part.rule
        ? <button key={i} className="linklike" onClick={() => onOpen(part.rule!)}>{part.text}</button>
        : <Fragment key={i}>{part.text}</Fragment>))}
    </p>
  ));
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/** Browse and search the Comprehensive Rules (downloaded from Wizards with the card data). */
export function RulesView({ openRule, onRuleOpened }: { openRule: string | null; onRuleOpened: () => void }) {
  const [status, setStatus] = useState<RulesStatus | null>(null);
  const [toc, setToc] = useState<RulesToc | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RulesSearchResult | null>(null);
  const [detail, setDetail] = useState<RuleDetail | null>(null);
  const [missing, setMissing] = useState<string | null>(null);

  useEffect(() => { api.rulesStatus().then(setStatus).catch(() => setStatus({ loaded: false, effective: null, rules: 0, glossary: 0 })); api.rulesToc().then(setToc).catch(() => {}); }, []);

  const open = async (id: string) => {
    setMissing(null);
    try { setDetail(await api.rule(id)); window.scrollTo?.({ top: 0 }); } catch { setDetail(null); setMissing(id); }
  };
  useEffect(() => { if (openRule) { void open(openRule); onRuleOpened(); } }, [openRule]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!query.trim()) { setResults(null); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => { api.rulesSearch(query, ctrl.signal).then((r) => { if (!ctrl.signal.aborted) { setResults(r); setDetail(null); setMissing(null); } }).catch(() => {}); }, 120);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query]);

  if (status && !status.loaded) {
    return <div className="rules"><p className="empty">The Comprehensive Rules haven't been downloaded yet. They come with the card data: use "Check for card updates" at the bottom of the page (needs an internet connection).</p></div>;
  }

  const hit = (h: RuleHit) => (
    <li key={h.id}>
      <button className="rulehit" onClick={() => void open(h.id)}>
        <span className="ruleid">{h.id}</span>
        <span className="rulebody"><span className="muted small">{h.sectionTitle}</span><br /><Highlight text={truncate(h.text.split('\n')[0]!, 240)} query={query} /></span>
      </button>
    </li>
  );

  return (
    <div className="rules">
      <div className="rulesbar">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the rules: trample, 702.19, or a question like “what happens when a creature dies”" aria-label="Search the rules" spellCheck={false} autoFocus />
      </div>

      {missing && <p className="error" role="alert">There is no rule {missing}.</p>}

      {detail && (
        <article className="rulepage" aria-label={`Rule ${detail.rule.id}`}>
          <nav className="crumbs" aria-label="Where this rule sits">
            <button className="linklike" onClick={() => { setDetail(null); }}>All rules</button>
            {detail.ancestors.map((a) => <Fragment key={a.id}> › <button className="linklike" onClick={() => void open(a.id)}>{a.id} {truncate(a.text.split('\n')[0]!, 40)}</button></Fragment>)}
          </nav>
          <h2><span className="ruleid">{detail.rule.id}</span> {detail.rule.kind === 'group' ? detail.rule.text : ''}</h2>
          {detail.rule.kind !== 'group' && <div className="ruletext"><RuleText text={detail.rule.text} onOpen={(id) => void open(id)} /></div>}
          {detail.children.length > 0 && (
            <ul className="rulechildren">
              {detail.children.map((c) => (
                <li key={c.id}>
                  <button className="ruleid linklike" onClick={() => void open(c.id)} aria-label={`Open rule ${c.id}`}>{c.id}</button>
                  <div className="ruletext"><RuleText text={c.text} onOpen={(id) => void open(id)} /></div>
                </li>
              ))}
            </ul>
          )}
        </article>
      )}

      {!detail && results && (
        <section aria-label="Search results">
          {results.exact && <ul className="rulehits">{hit(results.exact)}</ul>}
          {results.glossary.length > 0 && (
            <>
              <h3>Glossary</h3>
              <ul className="glossary">
                {results.glossary.map((g) => (
                  <li key={g.term}>
                    <strong><Highlight text={g.term} query={query} /></strong>
                    <p>{truncate(g.definition.replace(/\n/g, ' '), 320)}{g.rule && <> <button className="linklike" onClick={() => void open(g.rule!)}>Read rule {g.rule}</button></>}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
          {results.rules.length > 0 && <><h3>Rules</h3><ul className="rulehits">{results.rules.map(hit)}</ul></>}
          {!results.exact && results.rules.length === 0 && results.glossary.length === 0 && <p className="empty">Nothing matches “{query}”. Try fewer or simpler words, or a rule number like 702.19.</p>}
        </section>
      )}

      {!detail && !results && toc && (
        <section aria-label="Contents">
          <h3>Contents</h3>
          <ul className="toc">
            {toc.sections.map((s) => (
              <li key={s.num}>
                <details>
                  <summary><span className="ruleid">{s.num}</span> {s.title}</summary>
                  <ul>{s.groups.map((g) => <li key={g.id}><button className="linklike" onClick={() => void open(g.id)}><span className="ruleid">{g.id}</span> {g.title}</button></li>)}</ul>
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="muted small rulesnote">
        Magic: The Gathering Comprehensive Rules{status?.effective ? `, effective ${status.effective}` : ''}, © Wizards of the Coast, downloaded from magic.wizards.com. This is a reading aid, not a judge's ruling.
      </p>
    </div>
  );
}
