import { app, dialog, shell, type MenuItemConstructorOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shouldCheckForUpdates, updatesSupported } from './updatePolicy.js';

const RELEASES_URL = 'https://github.com/itsdommie/grimoire/releases/latest';
const SIX_HOURS = 6 * 60 * 60 * 1000;

const prefFile = () => join(app.getPath('userData'), 'updates.json');
function readPref(): boolean {
  try { if (existsSync(prefFile())) return (JSON.parse(readFileSync(prefFile(), 'utf8')) as { auto?: boolean }).auto !== false; } catch { /* unreadable: default on */ }
  return true;
}
const writePref = (auto: boolean) => { try { writeFileSync(prefFile(), JSON.stringify({ auto })); } catch { /* read-only profile: the choice just won't persist */ } };

let auto = true;
let manualCheck = false;
let started = false;

const context = () => ({
  platform: process.platform, appImage: process.env.APPIMAGE, isPackaged: app.isPackaged,
  disabledByEnv: !!process.env.GRIMOIRE_DISABLE_UPDATES, userEnabled: auto,
});

/** Look for an update, downloading it in the background. Updates come from GitHub Releases over HTTPS and are verified by checksum. */
async function check(): Promise<void> {
  try { await autoUpdater.checkForUpdates(); } catch (err) {
    console.warn('Update check failed:', err instanceof Error ? err.message : err);
    if (manualCheck) void dialog.showMessageBox({ type: 'warning', message: "Couldn't check for updates", detail: 'Check your internet connection and try again.' });
  }
}

export function startUpdater(): void {
  auto = readPref();
  if (started) return;
  started = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-not-available', () => {
    if (manualCheck) void dialog.showMessageBox({ type: 'info', message: "You're up to date", detail: `Grimoire ${app.getVersion()} is the latest version.` });
    manualCheck = false;
  });
  autoUpdater.on('update-available', (info) => {
    if (manualCheck) void dialog.showMessageBox({ type: 'info', message: `Downloading Grimoire ${info.version}`, detail: "It downloads in the background. You'll be asked before it installs." });
    manualCheck = false;
  });
  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info', buttons: ['Restart and install', 'Later'], defaultId: 0, cancelId: 1,
      message: `Grimoire ${info.version} is ready to install`, detail: 'Your decks and collection are kept. It will also install the next time you quit.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (err) => console.warn('Updater error:', err?.message ?? err));

  if (shouldCheckForUpdates(context())) {
    setTimeout(() => { if (shouldCheckForUpdates(context())) void check(); }, 15_000);
    setInterval(() => { if (shouldCheckForUpdates(context())) void check(); }, SIX_HOURS).unref();
  }
}

/** Help-menu entries: a manual check and the on/off switch. */
export function updateMenuItems(): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Check for updates…',
      click: () => {
        if (!updatesSupported(context())) {
          void dialog.showMessageBox({ type: 'info', buttons: ['Open downloads page', 'Close'], defaultId: 0, cancelId: 1, message: 'Updates for this installation', detail: app.isPackaged ? 'This installation is updated through your package manager, or by downloading the new version.' : 'This is a development build.' })
            .then((r) => { if (r.response === 0) void shell.openExternal(RELEASES_URL); });
          return;
        }
        manualCheck = true;
        void check();
      },
    },
    { label: 'Check for updates automatically', type: 'checkbox', checked: auto, enabled: updatesSupported(context()), click: (item) => { auto = item.checked; writePref(auto); } },
  ];
}
