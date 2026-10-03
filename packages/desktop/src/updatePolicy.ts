// Pure rules for when the app may check for updates, kept free of Electron so they can be unit-tested.

export interface UpdateContext {
  platform: NodeJS.Platform;
  /** Set by the AppImage runtime: the path of the running AppImage. */
  appImage: string | undefined;
  isPackaged: boolean;
  /** GRIMOIRE_DISABLE_UPDATES (tests, managed installs). */
  disabledByEnv: boolean;
  /** The user's choice in the Help menu. */
  userEnabled: boolean;
}

/**
 * Self-updating works for the Windows installer and the Linux AppImage. A .deb is managed by the system's package tools, and a
 * development run has nothing to update, so neither checks.
 */
export function updatesSupported(c: Pick<UpdateContext, 'platform' | 'appImage' | 'isPackaged'>): boolean {
  if (!c.isPackaged) return false;
  if (c.platform === 'win32') return true;
  if (c.platform === 'linux') return !!c.appImage;
  return false;
}

export function shouldCheckForUpdates(c: UpdateContext): boolean {
  return !c.disabledByEnv && c.userEnabled && updatesSupported(c);
}

/** True if `candidate` is a newer semantic version than `current` (ignores pre-release tags beyond ordering of numbers). */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string) => v.replace(/^v/, '').split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(candidate), b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
