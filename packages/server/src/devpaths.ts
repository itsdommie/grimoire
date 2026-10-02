import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Development entry points only (not bundled into the desktop app, which uses the per-user app-data directory).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_DATA_DIR = process.env.GRIMOIRE_DATA_DIR ?? resolve(repoRoot, 'data');
