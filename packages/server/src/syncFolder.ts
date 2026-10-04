import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SyncConflict, type SyncStore } from './sync.js';

// A folder as the place the sync file lives. Point it at a folder that Dropbox, Syncthing, Nextcloud or similar already keeps in step
// between your computers and Grimoire needs no account of its own. Desktop only (it needs the file system).

export const SYNC_FILE_NAME = 'grimoire-sync.json';

export class FolderStore implements SyncStore {
  readonly file: string;
  constructor(readonly dir: string) { this.file = join(dir, SYNC_FILE_NAME); }

  /** Throws a message a person can act on if the folder can't be used. */
  check(): void {
    if (!existsSync(this.dir) || !statSync(this.dir).isDirectory()) throw new Error(`The folder ${this.dir} doesn't exist.`);
    const probe = join(this.dir, `.grimoire-write-test-${process.pid}`);
    try { writeFileSync(probe, ''); rmSync(probe); } catch { throw new Error(`Grimoire can't write to ${this.dir}.`); }
  }

  /**
   * A fingerprint of the file's contents. (Not its modified time: that can be coarse, or the same for two quick writes, and a missed
   * change here would mean overwriting another device's work.)
   */
  private version(): string | null {
    return existsSync(this.file) ? createHash('sha256').update(readFileSync(this.file)).digest('hex') : null;
  }

  async read() {
    if (!existsSync(this.file)) return null;
    const text = readFileSync(this.file, 'utf8');
    return { text, version: createHash('sha256').update(text).digest('hex') };
  }

  async write(text: string, expect: string | null): Promise<string> {
    if (this.version() !== expect) throw new SyncConflict('The sync file changed while syncing.');
    // Write beside it and rename over it, so another device (or a sync tool) never sees half a file.
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, this.file);
    return createHash('sha256').update(text).digest('hex');
  }
}
