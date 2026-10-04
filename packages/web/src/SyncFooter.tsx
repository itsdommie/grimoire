import { useCallback, useEffect, useRef, useState } from 'react';
import type { SyncStatus } from '@grimoire/shared';
import { api } from './api';
import { useBack } from './backstack';

const ago = (iso: string | null, now = Date.now()) => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

/** Footer line for keeping decks, collection and wishlist the same on every device: its state, and a way to set it up or turn it off. */
export function SyncFooter({ onChanged, onError }: { onChanged: () => void | Promise<void>; onError: (m: string) => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [setup, setSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const seen = useRef<string | null | undefined>(undefined);
  const changed = useRef(onChanged);
  changed.current = onChanged; // (the app re-renders often: poll on a stable callback rather than restarting the polling each time)

  const apply = useCallback((s: SyncStatus) => {
    setStatus(s);
    // A sync that brought changes in (this one, or one running in the background): show them.
    if (seen.current !== undefined && s.lastAt !== seen.current && s.lastPulled > 0) void changed.current();
    seen.current = s.lastAt;
  }, []);

  useEffect(() => {
    let stop = false;
    const load = () => api.syncStatus().then((s) => { if (!stop) apply(s); }).catch(() => undefined);
    void load();
    const t = setInterval(load, 30_000);
    return () => { stop = true; clearInterval(t); };
  }, [apply]);

  if (!status?.available) return null;
  const run = async (fn: () => Promise<SyncStatus>) => {
    setBusy(true);
    try { apply(await fn()); } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };

  const where = status.provider === 'google' ? `Google${status.account ? ` (${status.account})` : ''}` : status.provider === 'folder' ? `the folder ${status.folderPath ?? ''}` : '';
  return (
    <span className="datafooter syncfooter">
      Sync between devices:{' '}
      {!status.provider && <><span>off</span>{' · '}<button className="linklike" onClick={() => setSetup(true)}>Set up…</button></>}
      {status.provider && (
        <>
          <span>{status.running || busy ? 'syncing…' : status.error ? 'not working' : `with ${where}, ${status.lastAt ? `last synced ${ago(status.lastAt)}` : 'not synced yet'}`}</span>
          {' · '}
          {status.needsSignIn
            ? <button className="linklike" disabled={busy} onClick={() => void run(api.syncGoogle)}>Sign in again</button>
            : <button className="linklike" disabled={busy || status.running} onClick={() => void run(api.syncRun)}>Sync now</button>}
          {' · '}
          <button className="linklike" disabled={busy} onClick={() => { if (window.confirm('Stop syncing on this device? Your decks and collection stay here and in the shared copy; they just stop being kept in step.')) void run(api.syncOff); }}>Turn off</button>
          {status.error && <span className="error" role="alert"> {status.error}</span>}
        </>
      )}
      {setup && <SyncSetupDialog status={status} onClose={() => setSetup(false)} onConnected={(s) => { apply(s); setSetup(false); void changed.current(); }} />}
    </span>
  );
}

function SyncSetupDialog({ status, onClose, onConnected }: { status: SyncStatus; onClose: () => void; onConnected: (s: SyncStatus) => void }) {
  useBack(true, onClose);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState<'google' | 'folder' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = async (which: 'google' | 'folder') => {
    setBusy(which); setError(null);
    try { onConnected(await (which === 'google' ? api.syncGoogle() : api.syncFolder(path))); } catch (e) { setError((e as Error).message); setBusy(null); }
  };
  return (
    <div className="modal" role="dialog" aria-label="Sync between devices" onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}>
      <div className="dialog">
        <h2>Sync between devices</h2>
        <p className="hint">Keeps your <strong>decks, collection and wishlist</strong> the same on every device that is set up this way. Changes made on one show up on the others within minutes. Nothing else is shared (not your Anthropic key, card data or settings), and you can turn it off at any time.</p>

        <h3>Google</h3>
        <p className="muted small">Sign in with Google and Brewhall keeps one small file in its own hidden storage in your Google Drive, which only Brewhall can open: it can't see or change your other Drive files. You can delete it from Google Drive's settings (Manage apps) whenever you like.</p>
        {status.googleSupported
          ? <p><button className="primary" disabled={busy !== null} onClick={() => void go('google')}>{busy === 'google' ? 'Finish signing in in your browser…' : 'Sign in with Google'}</button></p>
          : <p className="muted">Google sign-in isn't set up in this build yet.</p>}

        {status.folderSupported && (
          <>
            <h3>A shared folder</h3>
            <p className="muted small">Already use Dropbox, Syncthing, Nextcloud or similar? Choose a folder it keeps in step between your computers and Brewhall will keep its file there. No account needed.</p>
            <form onSubmit={(e) => { e.preventDefault(); if (path.trim()) void go('folder'); }}>
              <div className="deckbar">
                <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/you/Dropbox/Brewhall" aria-label="Folder path" spellCheck={false} />
                <button type="submit" disabled={busy !== null || !path.trim()}>{busy === 'folder' ? 'Connecting…' : 'Use this folder'}</button>
              </div>
            </form>
          </>
        )}

        {error && <p className="error" role="alert">{error}</p>}
        <p className="muted small">If you change the same card's count (or the same deck's name) on two devices before they sync, the later change wins. Different cards and different decks never clash.</p>
        <div className="deckbar end"><button onClick={onClose} disabled={busy !== null}>Cancel</button></div>
      </div>
    </div>
  );
}
