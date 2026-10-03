import { useCallback, useEffect, useRef, useState } from 'react';
import type { Card, DeckDetail } from '@grimoire/shared';
import { api } from './api';
import { ScanTracker, guideRect, pickCandidate, titleLines, type TextRecognizer } from './scanner';

type Target = 'collection' | 'deck';

/** What one scanned card has done this session, so it can be shown, counted and taken back. */
interface Scanned { key: string; card: Card; target: Target; base: number; count: number }

const FRAME_PAUSE_MS = 120;

/**
 * Full-screen card scanner. It shows the camera with a card-shaped outline, reads the title of whatever card is in the outline
 * and, once the same card is seen in a couple of frames, adds one copy to the collection or to the open deck.
 */
export function Scanner({ recognizer, deck, onClose, onError }: {
  recognizer: TextRecognizer; deck: DeckDetail | null; onClose: () => void; onError: (message: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [target, setTarget] = useState<Target>('collection');
  const [session, setSession] = useState<Scanned[]>([]);
  const [status, setStatus] = useState('Starting the camera…');
  const [flash, setFlash] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [aspect, setAspect] = useState(9 / 16);
  const [attempt, setAttempt] = useState(0);

  // The loop reads these without restarting when they change.
  const live = useRef({ target, deck, session });
  live.current = { target, deck, session };
  const tracker = useRef(new ScanTracker());

  const apply = useCallback(async (card: Card, target: Target, next: number) => {
    if (target === 'collection') await api.setOwned(card.id, next);
    else {
      const d = live.current.deck;
      if (!d) throw new Error('Open a deck first');
      await api.setCard(d.deck.id, card.id, 'main', next);
    }
  }, []);

  /** Add one copy (or take one back, with delta -1) of a card for the current target. */
  const change = useCallback(async (card: Card, delta: 1 | -1) => {
    const { target, deck, session } = live.current;
    if (target === 'deck' && !deck) { onError('Open a deck first, then scan into it.'); return; }
    const key = `${target}:${card.id}`;
    const entry = session.find((s) => s.key === key);
    const base = entry?.base ?? (target === 'collection' ? card.owned ?? 0 : deck!.entries.find((e) => e.card.id === card.id && e.board === 'main')?.qty ?? 0);
    const count = (entry?.count ?? 0) + delta;
    if (count < 0) return;
    try {
      await apply(card, target, base + count);
      setSession((list) => {
        const rest = list.filter((s) => s.key !== key);
        return count === 0 ? rest : [{ key, card, target, base, count }, ...rest];
      });
    } catch (e) { onError((e as Error).message); }
  }, [apply, onError]);

  useEffect(() => { tracker.current.reset(); }, [target]);

  // Camera and recognition loop.
  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    setCameraError(null);
    setStatus('Starting the camera…');

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const run = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e) {
        const name = (e as DOMException).name;
        setCameraError(name === 'NotAllowedError' ? 'Camera access was denied. Allow it for Grimoire in your phone’s settings, then try again.' : name === 'NotFoundError' ? 'No camera was found.' : `The camera could not be started (${(e as Error).message}).`);
        return;
      }
      const el = video.current;
      if (stopped || !el) { stream.getTracks().forEach((t) => t.stop()); return; }
      el.srcObject = stream;
      await el.play().catch(() => {});
      setStatus('Fit the card inside the outline');

      while (!stopped) {
        try {
          if (el.readyState >= 2 && el.videoWidth > 0) {
            const g = guideRect(el.videoWidth, el.videoHeight);
            setAspect(el.videoWidth / el.videoHeight);
            const sx = g.x * el.videoWidth, sy = g.y * el.videoHeight, sw = g.w * el.videoWidth, sh = g.h * el.videoHeight;
            const scale = Math.min(1, 720 / sw); // plenty to read a title, and keeps each frame small
            const c = (canvas.current ??= document.createElement('canvas'));
            c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
            c.getContext('2d')!.drawImage(el, sx, sy, sw, sh, 0, 0, c.width, c.height);
            const image = c.toDataURL('image/jpeg', 0.75).split(',')[1]!;
            const ocr = await recognizer.recognize(image);
            if (stopped) break;
            const lines = titleLines(ocr);
            const pick = lines.length ? pickCandidate((await api.matchCards(lines)).candidates) : null;
            const accepted = tracker.current.push(pick?.card.id ?? null);
            if (accepted && pick) {
              await change(pick.card, 1);
              setFlash(pick.card.name);
              setStatus(`Added ${pick.card.name}`);
              navigator.vibrate?.(40);
              setTimeout(() => setFlash((f) => (f === pick.card.name ? null : f)), 1200);
            } else if (!pick) setStatus('Fit the card inside the outline');
          }
        } catch (e) {
          setStatus(`Couldn’t read that frame: ${(e as Error).message}`);
          await sleep(500);
        }
        await sleep(FRAME_PAUSE_MS);
      }
    };
    void run();
    return () => { stopped = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [recognizer, change, attempt]);

  const total = session.reduce((n, s) => n + s.count, 0);
  const g = guideRect(aspect * 1000, 1000);
  const targetName = target === 'collection' ? 'your collection' : deck ? `“${deck.deck.name}”` : 'a deck';

  return (
    <div className="scanner" role="dialog" aria-label="Scan cards">
      <div className="scanbar">
        <button onClick={onClose} aria-label="Close scanner">✕</button>
        <div className="scantarget" role="group" aria-label="Where scanned cards go">
          <button className={target === 'collection' ? 'active' : ''} aria-pressed={target === 'collection'} onClick={() => setTarget('collection')}>Collection</button>
          <button className={target === 'deck' ? 'active' : ''} aria-pressed={target === 'deck'} disabled={!deck} onClick={() => setTarget('deck')} title={deck ? `Add to “${deck.deck.name}”` : 'Open a deck first'}>Deck</button>
        </div>
        <button className="primary" onClick={onClose}>Done{total ? ` (${total})` : ''}</button>
      </div>

      <div className="scanview" style={{ '--aspect': String(aspect) } as React.CSSProperties}>
        <video ref={video} playsInline muted aria-label="Camera" />
        <div className="scanguide" style={{ left: `${g.x * 100}%`, top: `${g.y * 100}%`, width: `${g.w * 100}%`, height: `${g.h * 100}%` }} />
        {flash && <div className="scanflash" role="status">✓ {flash}</div>}
        {cameraError && (
          <div className="scanerror" role="alert">
            <p>{cameraError}</p>
            <button className="primary" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
          </div>
        )}
      </div>

      <p className="scanstatus" role="status" aria-live="polite">{cameraError ? '' : `${status} · adding to ${targetName}`}</p>

      <ul className="scanlist" aria-label="Scanned this session">
        {session.length === 0 && <li className="empty">Nothing scanned yet.</li>}
        {session.map((s) => (
          <li key={s.key}>
            {s.card.imageUrl && <img src={s.card.imageUrl} alt="" loading="lazy" />}
            <span className="scanname">{s.card.name}<small>{s.target === 'collection' ? 'collection' : 'deck'}</small></span>
            <span className="stepper" role="group" aria-label={`Copies of ${s.card.name} scanned`}>
              <button onClick={() => void change(s.card, -1)} aria-label={`Take back one ${s.card.name}`}>−</button>
              <span>{s.count}</span>
              <button onClick={() => void change(s.card, 1)} aria-label={`Add another ${s.card.name}`}>+</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
