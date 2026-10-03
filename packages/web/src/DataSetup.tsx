import { useEffect, useRef, useState } from 'react';
import type { DataStatus } from '@grimoire/shared';
import { api } from './api';

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

const ITEM_LABEL = { cards: 'card data', rulings: 'rulings', tags: 'function tags' } as const;

export function describeProgress(p: NonNullable<DataStatus['progress']>): string {
  const what = ITEM_LABEL[p.item ?? 'cards'];
  if (p.phase === 'checking') return 'Contacting Scryfall…';
  if (p.phase === 'downloading') return p.total ? `Downloading ${what}… ${mb(p.received ?? 0)} of ${mb(p.total)}` : `Downloading ${what}… ${mb(p.received ?? 0)}`;
  return p.item && p.item !== 'cards' ? `Importing ${what}…` : `Importing cards… ${(p.cards ?? 0).toLocaleString()}`;
}

/** Polls /api/data/status; faster while an update is running. */
export function useDataStatus() {
  const [status, setStatus] = useState<DataStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const updating = status?.state === 'updating';

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try { const s = await api.dataStatus(); if (!stop) { setStatus(s); setUnreachable(false); } } catch { if (!stop) setUnreachable(true); }
    };
    tick();
    const id = setInterval(tick, updating ? 500 : 5000);
    return () => { stop = true; clearInterval(id); };
  }, [updating]);

  // An app update can bring new data (e.g. rulings, tags): refresh it once, in the background, without the user asking.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (status?.state === 'ready' && status.outdated && !autoStarted.current) { autoStarted.current = true; void api.updateData().then(setStatus).catch(() => {}); }
  }, [status]);

  const start = async (force = false) => { try { setStatus(await api.updateData(force)); } catch { setUnreachable(true); } };
  return { status, unreachable, start };
}

/** Full-screen first-run screen: nothing works until the card pool has been downloaded. */
export function DataSetup({ status, unreachable, onStart }: { status: DataStatus | null; unreachable: boolean; onStart: () => void }) {
  const updating = status?.state === 'updating';
  const p = status?.progress;
  const pct = p?.phase === 'downloading' && p.total ? Math.min(100, ((p.received ?? 0) / p.total) * 100) : undefined;
  return (
    <div className="setup" role="main">
      <h1>Grimoire</h1>
      <p className="lead">A local-first Magic: The Gathering deck lab.</p>
      <p>
        To get started, Grimoire needs the card database (about 25&nbsp;MB, from <a href="https://scryfall.com" target="_blank" rel="noreferrer">Scryfall</a>).
        It's downloaded once and stored on this computer, so searching and deck building work offline afterwards.
      </p>
      {unreachable && <p className="error">Can't reach Grimoire's local service. Try restarting the app.</p>}
      {status?.state === 'error' && <p className="error" role="alert">Download failed: {status.error}</p>}
      {updating && p ? (
        <div aria-live="polite">
          <progress value={pct} max={100} />
          <p className="hint">{describeProgress(p)}</p>
        </div>
      ) : (
        <button className="primary big" disabled={!status} onClick={onStart}>{status?.state === 'error' ? 'Try again' : 'Download card data'}</button>
      )}
    </div>
  );
}

/** Small footer control: when the card data was last refreshed, and a way to refresh it. */
export function DataFooter({ status, onUpdate }: { status: DataStatus; onUpdate: () => void }) {
  const updating = status.state === 'updating';
  const date = status.bulkUpdatedAt && !status.bulkUpdatedAt.startsWith('local:') ? new Date(status.bulkUpdatedAt).toLocaleDateString() : null;
  return (
    <span className="datafooter">
      {status.cardCount.toLocaleString()} cards{date ? ` · data from ${date}` : ''}
      {' · '}
      {updating && status.progress ? describeProgress(status.progress) : (
        <>
          <button className="linklike" onClick={onUpdate}>Check for card updates</button>
          {status.upToDate && ' (up to date)'}
          {status.state === 'error' && <span className="error"> Update failed: {status.error}</span>}
          {status.warning && <span className="muted"> {status.warning}.</span>}
        </>
      )}
    </span>
  );
}
