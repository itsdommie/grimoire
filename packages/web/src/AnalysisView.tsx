import { useMemo } from 'react';
import { ASSUMPTIONS, FORMATS, analyzeDeck, assumptionsFor, castProbability, type ColorAnalysis, type DeckEntry, type Finding, type FormatId, type ManaColor, type Status } from '@grimoire/shared';
import { BarList, ColumnChart } from './charts';
import { Icon } from './icons';

const COLOR_NAME: Record<ManaColor, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

/** Status is always icon + label, never colour alone. */
function StatusBadge({ status, labels }: { status: Status | null; labels?: Partial<Record<Status, string>> }) {
  if (!status) return <span className="badge-status muted">n/a</span>;
  const text = { short: 'Low', ok: 'OK', high: 'High', ...labels }[status];
  const icon = status === 'ok' ? '✓' : status === 'short' ? '▲' : '●';
  return <span className={`badge-status ${status}`}><span aria-hidden>{icon}</span> {text}</span>;
}

function FindingRow({ f }: { f: Finding }) {
  return (
    <li className={`finding ${f.severity}`}>
      <span className="ficon" aria-hidden><Icon name={f.severity === 'warn' ? 'alert' : f.severity === 'ok' ? 'check' : 'info'} size={16} /></span>
      <span><strong>{f.title}</strong><br /><span className="muted">{f.detail}</span></span>
    </li>
  );
}

function ColorRow({ c, math }: { c: ColorAnalysis; math: { deckSize: number; extraCards: number } }) {
  // Chance of casting the colour's strictest counted pattern on time with the sources the deck has now.
  const strict = c.patterns.filter((p) => p.needed === c.needed).at(-1);
  const chance = strict && c.landSources > 0 ? castProbability(Math.round(c.landSources), strict.pips, strict.mv, math) : null;
  return (
    <>
      <tr>
        <td><span className={`dot dot-${c.color}`} aria-hidden /> {COLOR_NAME[c.color]}</td>
        <td className="num">{Math.round(c.pips * 10) / 10}</td>
        <td className="num">{c.landSources}{c.otherSources > 0 && <span className="muted" title="Rocks and mana creatures that make this colour; not counted"> +{c.otherSources}</span>}</td>
        <td className="num">{c.needed ?? '–'}</td>
        <td><StatusBadge status={c.status} /></td>
      </tr>
      {strict && (
        <tr className="subrow"><td colSpan={5}>
          <details>
            <summary>{chance !== null ? `${Math.round(chance * 100)}% on time for ${'●'.repeat(strict.pips)} at mana value ${strict.mv}` : 'Requirements by card'}</summary>
            <table className="viz-table"><thead><tr><th>Pips</th><th>MV</th><th>Sources</th><th>Cards</th></tr></thead>
              <tbody>{c.patterns.map((p) => <tr key={`${p.pips}@${p.mv}`}><td>{'●'.repeat(p.pips)}</td><td>{p.mv}</td><td>{p.needed ?? 'impossible'}</td><td>{p.commander ? '★ ' : ''}{p.cards.join(', ')}</td></tr>)}</tbody></table>
          </details>
        </td></tr>
      )}
    </>
  );
}

export function AnalysisView({ entries, format = 'commander' }: { entries: DeckEntry[]; format?: FormatId }) {
  const a = useMemo(() => analyzeDeck(entries, format), [entries, format]);
  const fa = assumptionsFor(format);
  const rules = FORMATS[format];
  if (a.libraryCards === 0) return <p className="empty">Add cards to see analysis.</p>;

  const curve = a.curve.buckets.map((v, i) => ({ label: i === 7 ? '7+' : String(i), value: v, detail: `${v} card${v === 1 ? '' : 's'} with mana value ${i === 7 ? '7 or more' : i}` }));
  const pipRows = (['W', 'U', 'B', 'R', 'G'] as ManaColor[]).filter((c) => a.pips[c] > 0).map((c) => ({
    label: <><span className={`dot dot-${c}`} aria-hidden /> {COLOR_NAME[c]}</>, text: COLOR_NAME[c], value: a.pips[c], detail: `${Math.round(a.pips[c])} ${COLOR_NAME[c].toLowerCase()} mana symbols`,
  }));

  return (
    <div className="analysis">
      <section aria-label="Findings">
        <h3>Findings</h3>
        <ul className="findings">{a.findings.map((f, i) => <FindingRow key={i} f={f} />)}</ul>
      </section>

      <section>
        <h3>Mana curve</h3>
        <ColumnChart title="Cards by mana value" subtitle={`${a.curve.nonland} spells, average ${a.curve.avgMv.toFixed(2)}`} data={curve} unit="Mana value" />
      </section>

      <section>
        <h3>Lands</h3>
        <p className="statline">
          <strong>{a.lands.count % 1 ? a.lands.count.toFixed(1) : a.lands.count}</strong> lands · suggested <strong>{a.lands.recommended}</strong> <StatusBadge status={a.lands.status} />
        </p>
        <p className="muted small">{fa.landFormula.a} + {fa.landFormula.b} × average mana value ({a.lands.avgMv.toFixed(2)}) − {fa.landFormula.c} × cheap ramp/draw ({a.lands.cheapRampDraw}). Spell-lands count as half.</p>
      </section>

      <section>
        <h3>Colours</h3>
        {pipRows.length > 0 && <BarList title="Mana symbols by colour" subtitle="hybrid split between its colours" rows={pipRows} />}
        <table className="data-table">
          <thead><tr><th>Colour</th><th className="num">Pips</th><th className="num">Land sources</th><th className="num">Suggested</th><th>Status</th></tr></thead>
          <tbody>{a.colors.map((c) => <ColorRow key={c.color} c={c} math={{ deckSize: fa.deckSize, extraCards: fa.extraCardsSeen }} />)}</tbody>
        </table>
        <p className="muted small">Suggested = sources needed to cast your colour-heavy cards on time (hypergeometric, 90–96% target). Fetch-style lands count for every colour in your commander's identity.</p>
      </section>

      <section>
        <h3>Roles</h3>
        <ul className="roles">
          {a.roles.map((r) => (
            <li key={r.role}>
              <details>
                <summary>
                  <span className="rlabel">{r.label}</span>
                  <span className="num">{r.count}</span>
                  <span className="muted small">{r.target ? `aim ${r.target.min}-${r.target.max}` : ''}</span>
                  {r.status && <StatusBadge status={r.status} />}
                </summary>
                {r.cards.length ? <p className="small">{r.cards.map((c) => (c.qty > 1 ? `${c.qty}× ${c.name}` : c.name)).join(', ')}</p> : <p className="muted small">None detected.</p>}
              </details>
            </li>
          ))}
        </ul>
        <p className="muted small">Roles are guessed from card text, so check the lists. A card can have several roles.{rules.commander ? '' : ' Typical-count advice (aim for 8-12 ramp pieces, and so on) is Commander-specific, so none is shown for this format.'}</p>
      </section>

      <details className="assumptions">
        <summary>How these numbers are calculated</summary>
        <ul className="small">
          <li>Colour sources use exact hypergeometric probabilities: enough sources that P(at least k sources among the cards seen by the turn you want to cast the spell) reaches (89 + mana value)%, i.e. 90% for a one-drop up to 96%.</li>
          {rules.commander
            ? <li>Cards seen = 7 + turn + {ASSUMPTIONS.extraCardsSeen}. The extra {ASSUMPTIONS.extraCardsSeen} is a calibration for Commander (free mulligan, slower multiplayer turns): without it the maths asks for 24 sources for a single pip, far more than Commander decks run. With it, one-pip and two-pip requirements land within one source of the two Commander values I could verify for Frank Karsten's 99-card table (19 and 30). This is an estimate in his style, <em>not</em> his published table.</li>
            : <li>Cards seen = 7 + turn (as if on the draw; one fewer on the play), from a {fa.deckSize}-card library, with no extra cards assumed. Single-pip requirements land at 13 to 14 sources, matching Karsten's published 60-card figures to within one source. This is an estimate in his style, not his published table.</li>}
          <li>The land formula is the one widely reported for Karsten's 99-card Commander result.</li>
          <li>Only lands count as sources. Hybrid and Phyrexian pips are left out of source requirements.</li>
        </ul>
      </details>
    </div>
  );
}
