import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileKeyStore, type Cipher } from './keyStore.js';

const rot: Cipher = { available: () => true, encrypt: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)), decrypt: (d) => Buffer.from([...d].map((b) => b ^ 0x5a)).toString() };
const file = () => join(mkdtempSync(join(tmpdir(), 'grimoire-key-')), 'advisor-key.bin');

describe('the advisor key store', () => {
  it('keeps a key encrypted on disk and reads it back', () => {
    const f = file();
    const store = fileKeyStore(f, rot);
    expect(store.get()).toBeNull();
    store.set('sk-ant-secret-value-123456789');
    expect(store.get()).toBe('sk-ant-secret-value-123456789');
    expect(readFileSync(f).toString()).not.toContain('secret'); // not in plain text
    expect(fileKeyStore(f, rot).get()).toBe('sk-ant-secret-value-123456789'); // survives a restart
  });

  it('forgets the key when cleared', () => {
    const f = file();
    const store = fileKeyStore(f, rot);
    store.set('sk-ant-secret-value-123456789');
    store.clear();
    expect(store.get()).toBeNull();
    expect(existsSync(f)).toBe(false);
    store.clear(); // clearing nothing is fine
  });

  it('refuses to store without a real keychain, and says it cannot', () => {
    const store = fileKeyStore(file(), { ...rot, available: () => false });
    expect(store.canStore).toBe(false);
    expect(() => store.set('sk-ant-secret-value-123456789')).toThrow(/keychain/);
    expect(store.get()).toBeNull();
  });

  it('treats a file it cannot decrypt as no key', () => {
    const f = file();
    fileKeyStore(f, rot).set('sk-ant-secret-value-123456789');
    const broken: Cipher = { ...rot, decrypt: () => { throw new Error('wrong user'); } };
    expect(fileKeyStore(f, broken).get()).toBeNull();
  });
});

import { linuxPasswordStore } from './keyStore.js';
describe('choosing a Linux keychain', () => {
  it('asks for the Secret Service on desktops Chromium does not recognise', () => {
    expect(linuxPasswordStore('linux', { XDG_CURRENT_DESKTOP: 'Hyprland' }, [])).toBe('gnome-libsecret');
    expect(linuxPasswordStore('linux', {}, [])).toBe('gnome-libsecret');
    expect(linuxPasswordStore('linux', { XDG_CURRENT_DESKTOP: 'GNOME' }, [])).toBe('gnome-libsecret');
  });
  it('leaves KDE, an explicit choice, and other systems alone', () => {
    expect(linuxPasswordStore('linux', { XDG_CURRENT_DESKTOP: 'KDE' }, [])).toBeNull();
    expect(linuxPasswordStore('linux', { XDG_CURRENT_DESKTOP: 'Hyprland' }, ['--password-store=kwallet6'])).toBeNull();
    expect(linuxPasswordStore('win32', {}, [])).toBeNull();
    expect(linuxPasswordStore('darwin', {}, [])).toBeNull();
  });
});
