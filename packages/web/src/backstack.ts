import { useEffect, useRef } from 'react';

/**
 * What the Android Back button should do. Every overlay (a dialog, the scanner) registers while it is open, and Back closes the
 * topmost one. With nothing open, the app's own screens register at a lower priority (deck -> browse, other views -> Cards). When
 * nothing is registered the event is left alone, and the app leaves. (The app has no page history, so the browser's own Back would
 * otherwise exit from anywhere.)
 */
interface Entry { fn: () => void; priority: number; seq: number }

const entries = new Set<Entry>();
let seq = 0;

/** Run the topmost handler, if there is one. Returns whether something handled it. */
export function handleBack(): boolean {
  let top: Entry | undefined;
  for (const e of entries) if (!top || e.priority > top.priority || (e.priority === top.priority && e.seq > top.seq)) top = e;
  if (!top) return false;
  top.fn();
  return true;
}

/** While `active`, Back calls `fn`. Overlays use the default priority; a screen the person could simply leave uses 1. */
export function useBack(active: boolean, fn: () => void, priority = 2): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!active) return;
    const entry: Entry = { fn: () => latest.current(), priority, seq: ++seq };
    entries.add(entry);
    return () => { entries.delete(entry); };
  }, [active, priority]);
}

// The Android app turns the hardware Back button into this event; cancelling it says "I dealt with it".
if (typeof window !== 'undefined') window.addEventListener('grimoire-back', (e) => { if (handleBack()) e.preventDefault(); });
