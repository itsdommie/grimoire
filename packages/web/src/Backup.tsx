import { useState } from 'react';
import type { RestoreResult, UserDataBackup } from '@grimoire/shared';
import { api } from './api';
import { useBack } from './backstack';

/** Footer actions: save all decks and the collection to a file, or bring them back from one. */
export function BackupControls({ onRestored, onError }: { onRestored: () => void | Promise<void>; onError: (m: string) => void }) {
  const [restoring, setRestoring] = useState(false);

  const download = async () => {
    try {
      const text = await api.backupText();
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `grimoire-backup-${new Date().toISOString().slice(0, 10)}.json` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { onError((e as Error).message); }
  };

  return (
    <span className="datafooter">
      Your decks and collection:{' '}
      <button className="linklike" onClick={download}>Back up to a file</button>
      {' · '}
      <button className="linklike" onClick={() => setRestoring(true)}>Restore from a file…</button>
      {restoring && <RestoreDialog onClose={() => setRestoring(false)} onRestored={onRestored} onError={onError} />}
    </span>
  );
}

function RestoreDialog({ onClose, onRestored, onError }: { onClose: () => void; onRestored: () => void | Promise<void>; onError: (m: string) => void }) {
  useBack(true, onClose);
  const [data, setData] = useState<UserDataBackup | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RestoreResult | null>(null);

  const choose = async (file: File) => {
    setData(null); setFileProblem(null);
    try {
      const parsed = JSON.parse(await file.text()) as UserDataBackup;
      if (parsed?.app !== 'grimoire' || !Array.isArray(parsed.decks) || !Array.isArray(parsed.collection)) throw new Error('not a backup');
      setData(parsed);
    } catch { setFileProblem("That doesn't look like a Grimoire backup file."); }
  };

  const submit = async () => {
    if (!data) return;
    setBusy(true);
    try { setResult(await api.restore(data, mode)); await onRestored(); } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };

  const copies = data?.collection.reduce((n, c) => n + c.qty, 0) ?? 0;
  return (
    <div className="modal" role="dialog" aria-label="Restore from backup" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="dialog">
        <h2>Restore from a backup</h2>
        {result ? (
          <>
            <p className="finding ok"><span className="ficon" aria-hidden>✓</span><span>Restored {result.decks} deck{result.decks === 1 ? '' : 's'} and {result.collectionCopies.toLocaleString()} collection cards{result.wishlist > 0 ? ` and ${result.wishlist.toLocaleString()} wishlist card${result.wishlist === 1 ? '' : 's'}` : ''}.</span></p>
            {result.unresolved.length > 0 && <div className="issues"><p className="warning">{result.unresolved.length} card(s) couldn't be found in the current card data:</p><ul>{result.unresolved.slice(0, 30).map((u) => <li key={u}>{u}</li>)}</ul></div>}
            <div className="deckbar end"><button className="primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <p className="hint">Choose a file made with "Back up to a file".</p>
            <div className="deckbar"><label className="btn filebtn">Choose file…<input type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && void choose(e.target.files[0])} /></label></div>
            {fileProblem && <p className="error" role="alert">{fileProblem}</p>}
            {data && (
              <>
                <p className="statline">The file has <strong>{data.decks.length}</strong> deck{data.decks.length === 1 ? '' : 's'} and <strong>{copies.toLocaleString()}</strong> collection cards{data.exportedAt ? ` (saved ${new Date(data.exportedAt).toLocaleDateString()})` : ''}.</p>
                <div className="deckbar">
                  <label><input type="radio" checked={mode === 'merge'} onChange={() => { setMode('merge'); setConfirmed(false); }} /> Add to what I have now</label>
                  <label><input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Replace everything</label>
                </div>
                {mode === 'replace' && (
                  <label className="finding warn"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> <span>I understand this deletes all my current decks and collection first.</span></label>
                )}
              </>
            )}
            <div className="deckbar end">
              <button onClick={onClose}>Cancel</button>
              <button className="primary" disabled={!data || busy || (mode === 'replace' && !confirmed)} onClick={submit}>Restore</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
