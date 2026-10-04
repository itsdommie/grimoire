import { useEffect, useState } from 'react';

type Update = { version: string; url: string; page: string };

const DISMISSED = 'grimoire.appUpdateDismissed';
const read = (): string | null => { try { return localStorage.getItem(DISMISSED); } catch { return null; } };

/**
 * "A newer Grimoire is out." Only the Android app has a way to check (it isn't on a store, so it looks at the project's releases
 * itself). Dismissing it hides that version; the next version shows it again.
 */
export function AppUpdateBanner({ check }: { check: () => Promise<Update | null> }) {
  const [update, setUpdate] = useState<Update | null>(null);
  useEffect(() => {
    let stop = false;
    check().then((u) => { if (!stop && u && u.version !== read()) setUpdate(u); }).catch(() => { /* offline or rate limited: say nothing */ });
    return () => { stop = true; };
  }, [check]);
  if (!update) return null;
  return (
    <div className="appupdate" role="status">
      <span><strong>Grimoire {update.version}</strong> is available.</span>
      <a className="btn" href={update.url} target="_blank" rel="noreferrer">Download</a>
      {update.page && <a href={update.page} target="_blank" rel="noreferrer">What's new</a>}
      <button onClick={() => { try { localStorage.setItem(DISMISSED, update.version); } catch { /* ignore */ } setUpdate(null); }} aria-label="Dismiss">×</button>
    </div>
  );
}
