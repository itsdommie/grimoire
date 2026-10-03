import { useCallback, useEffect, useState } from 'react';
import type { Finish, PrintingInfo } from '@grimoire/shared';
import { api } from './api';
import { usd } from './CollectionView';

const FINISH_LABEL: Record<Finish, string> = { nonfoil: 'Normal', foil: 'Foil', etched: 'Etched' };
const SHOWN_AT_FIRST = 30;

/**
 * Every printing of a card, with how many of each you own. The "+" says "one of the copies I have is this printing": it uses up copies
 * that have no printing recorded before adding new ones, so a collection you imported without printings can be filled in by hand.
 */
export function PrintingsSection({ cardId, owned, onChanged }: { cardId: string; owned: number; onChanged: () => void }) {
  const [printings, setPrintings] = useState<PrintingInfo[] | null>(null);
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setPrintings((await api.printings(cardId)).printings); } catch { setPrintings([]); }
  }, [cardId]);
  useEffect(() => { setPrintings(null); setAll(false); setFilter(''); setError(null); void load(); }, [load]);

  const set = async (p: PrintingInfo, finish: Finish, qty: number) => {
    if (qty < 0) return;
    try {
      await api.setPrinting(p.id, finish, qty, true);
      setError(null);
      await load();
      onChanged();
    } catch (e) { setError((e as Error).message); }
  };

  if (!printings) return null;
  if (printings.length === 0) {
    return <section aria-label="Printings"><h3>Printings</h3><p className="muted small">Printing data isn’t downloaded yet. It comes with “Check for card updates” at the bottom of the page.</p></section>;
  }
  const recorded = printings.reduce((n, p) => n + p.owned.nonfoil + p.owned.foil + p.owned.etched, 0);
  const f = filter.trim().toLowerCase();
  const matching = printings.filter((p) => !f || p.setName.toLowerCase().includes(f) || p.set.includes(f) || (p.released ?? '').startsWith(f));
  // Printings you own come first, then newest.
  const ordered = [...matching].sort((a, b) => Number(b.owned.nonfoil + b.owned.foil + b.owned.etched > 0) - Number(a.owned.nonfoil + a.owned.foil + a.owned.etched > 0));
  const shown = all || f ? ordered : ordered.slice(0, SHOWN_AT_FIRST);

  return (
    <section aria-label="Printings">
      <h3>Printings <small>({printings.length})</small></h3>
      {owned > 0 && <p className="muted small">{recorded === 0 ? 'No printing recorded for your copies.' : recorded >= owned ? 'Every copy has its printing recorded.' : `${owned - recorded} of your ${owned} copies have no printing recorded.`} Use + on the one you have.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {printings.length > 8 && <input className="pfilter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by set or year" aria-label="Filter printings" spellCheck={false} />}
      <ul className="printings">
        {shown.map((p) => (
          <li key={p.id}>
            <img src={p.imageUrl} alt="" loading="lazy" />
            <div className="pinfo">
              <strong>{p.setName}</strong>
              <span className="muted small">#{p.collector} · {p.released?.slice(0, 4) ?? '?'}{p.usd ? ` · ${usd(p.usd)}` : ''}</span>
              {p.finishes.map((finish) => (
                <span className="stepper" role="group" aria-label={`${FINISH_LABEL[finish]} copies of ${p.setName} number ${p.collector}`} key={finish}>
                  <span className="muted small">{FINISH_LABEL[finish]}{finish === 'foil' && p.usdFoil ? ` ${usd(p.usdFoil)}` : ''}</span>
                  <button onClick={() => void set(p, finish, p.owned[finish] - 1)} aria-label={`One fewer ${FINISH_LABEL[finish].toLowerCase()} ${p.setName} ${p.collector}`}>−</button>
                  <span>{p.owned[finish]}</span>
                  <button onClick={() => void set(p, finish, p.owned[finish] + 1)} aria-label={`One more ${FINISH_LABEL[finish].toLowerCase()} ${p.setName} ${p.collector}`}>+</button>
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {!all && !f && ordered.length > SHOWN_AT_FIRST && <button className="linklike" onClick={() => setAll(true)}>Show all {ordered.length}</button>}
    </section>
  );
}
