import { useCallback, useEffect, useRef, useState } from 'react';
import type { Card, DeckDetail, Finish, PrintingInfo } from '@grimoire/shared';
import { api } from './api';
import { ScanTracker, bottomLines, guideRect, pickCandidate, titleLines, type TextRecognizer } from './scanning';
import { useBack } from './backstack';

type Target = 'collection' | 'deck';

/** One line of the session: a card (and, for the collection, the printing and finish) and how many copies were scanned. */
interface Scanned { key: string; card: Card; target: Target; printing: PrintingInfo | null; finish: Finish; base: number; count: number }

/** A card whose printing the scanner couldn't tell: the person chooses, and the copy is added once they have. */
interface Choosing { card: Card; candidates: PrintingInfo[]; basis: string }

const FRAME_PAUSE_MS = 120;

/** Foil if asked for and the printing comes in foil (or etched); otherwise the first finish it does come in. */
const finishFor = (printing: PrintingInfo | null, foil: boolean): Finish => {
  if (!printing) return foil ? 'foil' : 'nonfoil';
  if (foil) return printing.finishes.includes('foil') ? 'foil' : printing.finishes.includes('etched') ? 'etched' : printing.finishes[0] ?? 'nonfoil';
  return printing.finishes.includes('nonfoil') ? 'nonfoil' : printing.finishes[0] ?? 'nonfoil';
};

const keyOf = (target: Target, card: Card, printing: PrintingInfo | null, finish: Finish) =>
  target === 'deck' ? `deck:${card.id}` : printing ? `collection:${printing.id}:${finish}` : `collection:${card.id}`;

const year = (p: PrintingInfo) => p.released?.slice(0, 4) ?? '';

/**
 * Full-screen card scanner. It shows the camera with a card-shaped outline, reads the title of whatever card is in the outline
 * and, once the same card is seen in a couple of frames, adds one copy to the collection or to the open deck. For the collection it
 * also reads the set code and collector number from the bottom of the card to record the exact printing, and asks which printing
 * it is when the card doesn't say (older cards print neither).
 */
export function Scanner({ recognizer, deck, onClose, onError }: {
  recognizer: TextRecognizer; deck: DeckDetail | null; onClose: () => void; onError: (message: string) => void;
}) {
  useBack(true, onClose, 2); // (the printing picker, when open, registers after this and so is closed first)
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [target, setTarget] = useState<Target>('collection');
  const [foil, setFoil] = useState(false);
  const [session, setSession] = useState<Scanned[]>([]);
  const [status, setStatus] = useState('Starting the camera…');
  const [flash, setFlash] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [aspect, setAspect] = useState(9 / 16);
  const [attempt, setAttempt] = useState(0);
  const [choosing, setChoosing] = useState<Choosing | null>(null);

  // The loop reads these without restarting when they change.
  const live = useRef({ target, deck, session, foil, choosing });
  live.current = { target, deck, session, foil, choosing };
  const tracker = useRef(new ScanTracker());
  const recentBottoms = useRef<string[][]>([]); // the last few frames' bottom lines: one frame may misread what another got right

  /** Add (+1) or take back (-1) one copy of a card, as a particular printing and finish when one is known. */
  const change = useCallback(async (card: Card, printing: PrintingInfo | null, finish: Finish, delta: 1 | -1) => {
    const { target, deck, session } = live.current;
    if (target === 'deck' && !deck) { onError('Open a deck first, then scan into it.'); return; }
    const key = keyOf(target, card, printing, finish);
    const entry = session.find((s) => s.key === key);
    const base = entry?.base ?? (target === 'deck'
      ? deck!.entries.find((e) => e.card.id === card.id && e.board === 'main')?.qty ?? 0
      : printing ? printing.owned[finish] : card.owned ?? 0);
    const count = (entry?.count ?? 0) + delta;
    if (count < 0) return;
    try {
      if (target === 'deck') await api.setCard(deck!.deck.id, card.id, 'main', base + count);
      else if (printing) await api.setPrinting(printing.id, finish, base + count);
      else await api.setOwned(card.id, base + count);
      setSession((list) => {
        const rest = list.filter((s) => s.key !== key);
        return count === 0 ? rest : [{ key, card, target, printing: entry?.printing ?? printing, finish, base, count }, ...rest];
      });
    } catch (e) { onError((e as Error).message); }
  }, [onError]);

  useEffect(() => { tracker.current.reset(); }, [target]);

  /** A card was recognised: work out which printing it is and add it, or ask. */
  const accepted = useCallback(async (card: Card) => {
    const { target, foil } = live.current;
    if (target === 'deck') { await change(card, null, 'nonfoil', 1); return; }
    let ident = await api.identifyPrinting(card.id, recentBottoms.current[recentBottoms.current.length - 1] ?? []);
    // The newest frame may have misread the corner; an earlier one might have got it.
    for (let i = recentBottoms.current.length - 2; i >= 0 && !ident.printing; i--) {
      const earlier = await api.identifyPrinting(card.id, recentBottoms.current[i]!);
      if (earlier.printing) ident = earlier;
    }
    if (ident.printing) { await change(card, ident.printing, finishFor(ident.printing, foil), 1); return; }
    if (ident.candidates.length === 0) { await change(card, null, finishFor(null, foil), 1); return; } // no printings data yet: just the card
    setChoosing({ card, candidates: ident.candidates, basis: ident.basis });
  }, [change]);

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
          if (live.current.choosing) { await sleep(200); continue; } // waiting for a printing to be picked
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
            recentBottoms.current = [...recentBottoms.current, bottomLines(ocr)].slice(-3);
            const lines = titleLines(ocr);
            const pick = lines.length ? pickCandidate((await api.matchCards(lines)).candidates) : null;
            const found = tracker.current.push(pick?.card.id ?? null);
            if (found && pick) {
              await accepted(pick.card);
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
  }, [recognizer, accepted, attempt]);

  const choose = async (printing: PrintingInfo | null) => {
    const pending = choosing;
    if (!pending) return;
    setChoosing(null);
    await change(pending.card, printing, finishFor(printing, live.current.foil), 1);
    setFlash(pending.card.name);
    setTimeout(() => setFlash((f) => (f === pending.card.name ? null : f)), 1200);
  };

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
        {target === 'collection' && (
          <label className="scanfoil" title="Record the copies you scan as foil (when that printing comes in foil)">
            <input type="checkbox" checked={foil} onChange={(e) => setFoil(e.target.checked)} /> Foil
          </label>
        )}
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
            {(s.printing?.imageUrl ?? s.card.imageUrl) && <img src={s.printing?.imageUrl ?? s.card.imageUrl ?? ''} alt="" loading="lazy" />}
            <span className="scanname">
              {s.card.name}
              <small>
                {s.target === 'deck' ? 'deck' : s.printing ? `${s.printing.setName} · #${s.printing.collector}${s.finish === 'nonfoil' ? '' : ` · ${s.finish}`}` : s.finish === 'nonfoil' ? 'collection · printing not recorded' : `collection · ${s.finish} · printing not recorded`}
              </small>
            </span>
            <span className="stepper" role="group" aria-label={`Copies of ${s.card.name} scanned`}>
              <button onClick={() => void change(s.card, s.printing, s.finish, -1)} aria-label={`Take back one ${s.card.name}`}>−</button>
              <span>{s.count}</span>
              <button onClick={() => void change(s.card, s.printing, s.finish, 1)} aria-label={`Add another ${s.card.name}`}>+</button>
            </span>
          </li>
        ))}
      </ul>

      {choosing && <PrintingPicker choosing={choosing} onChoose={(p) => void choose(p)} onDismiss={() => setChoosing(null)} />}
    </div>
  );
}

/** Which printing is it? Older cards don't print a set code or number, so the scanner asks, narrowing the list when it can. */
function PrintingPicker({ choosing, onChoose, onDismiss }: { choosing: Choosing; onChoose: (printing: PrintingInfo | null) => void; onDismiss: () => void }) {
  useBack(true, onDismiss, 3); // Back drops the question without adding the card; show it again to scan it
  const [filter, setFilter] = useState('');
  const f = filter.trim().toLowerCase();
  const shown = choosing.candidates.filter((p) => !f || p.setName.toLowerCase().includes(f) || p.set.includes(f) || year(p).includes(f));
  const narrowed = choosing.basis === 'year' || choosing.basis === 'set';
  return (
    <div className="scanpick" role="dialog" aria-label={`Which printing of ${choosing.card.name}?`}>
      <h2>Which printing of {choosing.card.name}?</h2>
      <p className="muted small">{narrowed ? 'The card narrowed it down to these.' : 'This card doesn’t say which printing it is.'} Pick the one you’re holding.</p>
      {choosing.candidates.length > 6 && <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by set or year" aria-label="Filter printings" spellCheck={false} />}
      <ul>
        {shown.length === 0 && <li className="empty">No printing matches that.</li>}
        {shown.map((p) => (
          <li key={p.id}>
            <button onClick={() => onChoose(p)} aria-label={`${p.setName}, number ${p.collector}, ${year(p)}`}>
              <img src={p.imageUrl} alt="" loading="lazy" />
              <span><strong>{p.setName}</strong><small>#{p.collector} · {year(p)}{p.owned.nonfoil + p.owned.foil + p.owned.etched > 0 ? ' · you own this one' : ''}</small></span>
            </button>
          </li>
        ))}
      </ul>
      <button onClick={() => onChoose(null)}>Not sure: add it without a printing</button>
    </div>
  );
}
