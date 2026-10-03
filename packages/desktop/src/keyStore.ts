import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { KeyStore } from '@grimoire/server/advisor';

/** What Electron's safeStorage offers (the operating system's keychain: Keychain-style services on Linux, DPAPI on Windows). */
export interface Cipher {
  /** False when there is no real keychain (on Linux, Electron falls back to a fixed password, which is not protection). */
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

/** The advisor's API key, encrypted with the keychain and kept in one file in the profile. Never written in plain text. */
export function fileKeyStore(file: string, cipher: Cipher): KeyStore {
  return {
    get canStore() { return cipher.available(); },
    get() {
      if (!cipher.available() || !existsSync(file)) return null;
      try { return cipher.decrypt(readFileSync(file)); } catch { return null; } // unreadable (another user, a reset keychain): as if none was saved
    },
    set(key) {
      if (!cipher.available()) throw new Error('No keychain is available to protect the key.');
      writeFileSync(file, cipher.encrypt(key));
      try { chmodSync(file, 0o600); } catch { /* not supported on this file system */ }
    },
    clear() { rmSync(file, { force: true }); },
  };
}
