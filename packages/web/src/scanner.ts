import type { CardMatchCandidate } from '@grimoire/shared';

/** One line of text found in a camera frame, with its box in pixels of that frame. */
export interface OcrLine { text: string; left: number; top: number; width: number; height: number }
export interface OcrResult { width: number; height: number; lines: OcrLine[] }

/** Reads text from an image (base64 JPEG). The Android app supplies one, backed by ML Kit; other platforms have none. */
export interface TextRecognizer { recognize(imageBase64: string): Promise<OcrResult> }

declare global {
  interface Window { grimoireNative?: { textRecognition?: TextRecognizer } }
}

/** A Magic card is 63 x 88 mm. */
export const CARD_ASPECT = 63 / 88;

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Where the on-screen card outline sits, as fractions of the camera frame (centred). The scanner crops the frame to it before
 * reading, so a card inside the outline fills the image and its title is always in the top band.
 */
export function guideRect(frameW: number, frameH: number): Rect {
  let h = 0.8;
  let w = (h * frameH * CARD_ASPECT) / frameW;
  if (w > 0.9) { w = 0.9; h = (w * frameW) / (CARD_ASPECT * frameH); }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/**
 * The lines of a card-sized image that could be its name: those whose middle is in the top band, where the title bar is.
 * Reading the whole card would also match rules text that happens to be a card name ("Flash", "Darkness").
 */
export function titleLines(result: OcrResult, band = 0.2): string[] {
  return result.lines
    .filter((l) => l.top + l.height / 2 < result.height * band && l.height > result.height * 0.012 && l.text.trim().length >= 2)
    .sort((a, b) => a.top - b.top)
    .map((l) => l.text);
}

/**
 * The lines from the bottom of a card-sized image, where the set code, collector number and copyright year are printed. They say which
 * printing it is, so they are sent along once the name is known.
 */
export function bottomLines(result: OcrResult, from = 0.86): string[] {
  return result.lines
    .filter((l) => l.top + l.height / 2 > result.height * from && l.text.trim().length >= 2)
    .sort((a, b) => a.top - b.top || a.left - b.left)
    .map((l) => l.text);
}

/** The match to act on, if there is a convincing one. */
export function pickCandidate(candidates: readonly CardMatchCandidate[], minScore = 0.85): CardMatchCandidate | null {
  const top = candidates[0];
  return top && top.score >= minScore ? top : null;
}

/**
 * Decides when a camera frame has really found a card. A frame names a card (or nothing); a card is accepted once it has been seen
 * in `confirm` of the last `window` frames, which stops a flicker of a misread from adding the wrong card. After that it is
 * locked: the same card in front of the camera isn't added again until the camera has seen no card for `clear` frames in a row
 * (it was taken away), or a different card is accepted.
 */
export class ScanTracker {
  private recent: Array<string | null> = [];
  private locked: string | null = null;
  private empty = 0;

  constructor(private readonly opts: { confirm: number; window: number; clear: number } = { confirm: 2, window: 3, clear: 2 }) {}

  /** Feed the card a frame named (or null). Returns its id when it should be added. */
  push(id: string | null): string | null {
    if (this.locked !== null) {
      if (id === this.locked) { this.empty = 0; return null; }
      if (id === null) { if (++this.empty >= this.opts.clear) { this.locked = null; this.recent = []; } return null; }
      this.locked = null; // a different card: treat it as new
      this.recent = [];
    }
    this.recent.push(id);
    if (this.recent.length > this.opts.window) this.recent.shift();
    if (id === null) return null;
    if (this.recent.filter((r) => r === id).length >= this.opts.confirm) {
      this.locked = id; this.empty = 0; this.recent = [];
      return id;
    }
    return null;
  }

  /** Forget everything, e.g. when the scan target changes. */
  reset(): void { this.recent = []; this.locked = null; this.empty = 0; }
}
