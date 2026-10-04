import { existsSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * The app used to be called Grimoire, and Electron keeps its data (decks, collection, settings, the card database) in a folder named after
 * the app. Renaming the app would otherwise leave all of that behind in the old folder and start people from nothing. So the first time
 * the new name starts, the old folder becomes the new one (a rename: instant, and nothing is copied or deleted). If that can't be done for
 * any reason, carry on using the old folder rather than lose anything. Returns the folder to use.
 */
export function adoptLegacyDataFolder(current: string, legacyName: string, ops: { exists: (p: string) => boolean; rename: (from: string, to: string) => void } = { exists: existsSync, rename: renameSync }): string {
  if (basename(current) === legacyName) return current;
  const legacy = join(dirname(current), legacyName);
  if (ops.exists(current) || !ops.exists(legacy)) return current; // already moved, or a fresh install
  try { ops.rename(legacy, current); return current; } catch { return legacy; }
}
