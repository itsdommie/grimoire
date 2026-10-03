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

/**
 * Which keychain Chromium should use on Linux. Left alone it only looks for one on desktops it knows (GNOME, KDE and a few others) and on
 * anything else (Hyprland, i3, sway, ...) quietly settles for a fixed password, which protects nothing. Most such setups run a Secret
 * Service (GNOME Keyring, KeePassXC, ...), so ask for that. KDE is left to its own choice (KWallet), and so is anyone who picked a
 * backend themselves. If the Secret Service is not actually there, Chromium falls back and the app then refuses to store the key.
 */
export function linuxPasswordStore(platform: string, env: Record<string, string | undefined>, argv: readonly string[]): string | null {
  if (platform !== 'linux') return null;
  if (argv.some((a) => a.startsWith('--password-store'))) return null;
  if (/\bKDE\b/i.test(env.XDG_CURRENT_DESKTOP ?? '')) return null;
  return 'gnome-libsecret';
}
