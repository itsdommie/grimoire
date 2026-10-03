import { useEffect, useRef, useState } from 'react';
import type { SemanticStatus } from '@grimoire/shared';
import { api } from './api';

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

export function useSemanticStatus() {
  const [status, setStatus] = useState<SemanticStatus | null>(null);
  const working = status?.state === 'downloading' || status?.state === 'building';

  useEffect(() => {
    let stop = false;
    const tick = async () => { try { const s = await api.semanticStatus(); if (!stop) setStatus(s); } catch { /* server unreachable: the rest of the app says so */ } };
    void tick();
    const id = setInterval(tick, working ? 1000 : 10_000);
    return () => { stop = true; clearInterval(id); };
  }, [working]);

  // When card data changed since the index was built, bring it up to date once in the background.
  const autoUpdated = useRef(false);
  useEffect(() => {
    if (status?.state === 'ready' && status.pending > 0 && !autoUpdated.current) { autoUpdated.current = true; void api.semanticEnable().then(setStatus).catch(() => {}); }
  }, [status]);

  const run = (fn: () => Promise<SemanticStatus | void>) => async () => { try { const r = await fn(); setStatus(r ?? (await api.semanticStatus())); } catch { /* ignore */ } };
  return { status, enable: run(api.semanticEnable), cancel: run(api.semanticCancel), remove: run(api.semanticRemove) };
}

/** Footer control for the optional "search by meaning" feature. */
export function SemanticFooter({ status, onEnable, onCancel, onRemove }: { status: SemanticStatus | null; onEnable: () => void; onCancel: () => void; onRemove: () => void }) {
  const [explain, setExplain] = useState(false);
  if (!status) return null;
  const p = status.progress;

  let body;
  if (status.state === 'downloading' || status.state === 'building') {
    const value = p?.phase === 'downloading' ? p.received : p?.done;
    const max = p?.phase === 'downloading' ? p.total : p?.of;
    body = (
      <>
        <progress value={value ?? 0} max={max || 1} aria-label="Semantic search setup progress" />
        {' '}{p?.phase === 'downloading' ? `Downloading ${p.what === 'index' ? 'the card index' : 'the language model'}… ${mb(p.received ?? 0)} of ${mb(p.total ?? 0)}` : `Indexing cards… ${(p?.done ?? 0).toLocaleString()} of ${(p?.of ?? 0).toLocaleString()}`}
        {' · '}<button className="linklike" onClick={onCancel}>Cancel</button>
        <span className="muted"> You can keep using Grimoire meanwhile.</span>
      </>
    );
  } else if (status.state === 'ready') {
    body = (
      <>
        Ready · {status.indexed.toLocaleString()} cards indexed. Try <code>about:"punish opponents for drawing"</code>
        {status.pending > 0 && <span className="muted"> ({status.pending.toLocaleString()} newer cards are being added)</span>}
        {' · '}<button className="linklike" onClick={onRemove}>Turn off and delete</button>
      </>
    );
  } else {
    body = (
      <>
        {status.state === 'error' && <span className="error">{status.error} </span>}
        {status.indexed > 0 && <span className="muted">{status.indexed.toLocaleString()} of {status.total.toLocaleString()} cards indexed so far. </span>}
        <button className="linklike" onClick={onEnable}>{status.state === 'error' || status.indexed > 0 ? 'Try again' : 'Set up…'}</button>
        {' · '}<button className="linklike" onClick={() => setExplain((v) => !v)} aria-expanded={explain}>What is this?</button>
        {explain && (
          <span className="muted"> Search by meaning (e.g. <code>about:"make treasure when creatures die"</code>) uses a small language model that runs on this computer. Setup downloads it once (about 34 MB, verified) plus a ready-made card index (about 12 MB), then adds anything that's newer; without the index it would take several minutes. Nothing you type leaves your computer.</span>
        )}
      </>
    );
  }
  return <span className="datafooter">Semantic search: {body}</span>;
}
