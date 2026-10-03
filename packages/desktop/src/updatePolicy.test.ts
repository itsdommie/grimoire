import { describe, expect, it } from 'vitest';
import { isNewer, shouldCheckForUpdates, updatesSupported, type UpdateContext } from './updatePolicy.js';

const base: UpdateContext = { platform: 'win32', appImage: undefined, isPackaged: true, disabledByEnv: false, userEnabled: true };

describe('updatesSupported', () => {
  it('works for the Windows installer and Linux AppImage only', () => {
    expect(updatesSupported(base)).toBe(true);
    expect(updatesSupported({ ...base, platform: 'linux', appImage: '/tmp/Grimoire.AppImage' })).toBe(true);
    expect(updatesSupported({ ...base, platform: 'linux' })).toBe(false); // a .deb install
    expect(updatesSupported({ ...base, platform: 'darwin' })).toBe(false);
  });
  it('never in a development run', () => expect(updatesSupported({ ...base, isPackaged: false })).toBe(false));
});

describe('shouldCheckForUpdates', () => {
  it('honours the environment switch and the user preference', () => {
    expect(shouldCheckForUpdates(base)).toBe(true);
    expect(shouldCheckForUpdates({ ...base, disabledByEnv: true })).toBe(false);
    expect(shouldCheckForUpdates({ ...base, userEnabled: false })).toBe(false);
  });
});

describe('isNewer', () => {
  it.each([
    ['0.2.0', '0.1.9', true], ['0.1.10', '0.1.9', true], ['1.0.0', '0.99.99', true], ['v0.1.1', '0.1.0', true],
    ['0.1.0', '0.1.0', false], ['0.1.0', '0.1.1', false], ['0.9.0', '0.10.0', false], ['0.1.0-beta.1', '0.1.0', false],
  ])('%s vs %s -> %s', (a, b, expected) => expect(isNewer(a, b)).toBe(expected));
});
