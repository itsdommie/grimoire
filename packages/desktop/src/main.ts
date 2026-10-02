import { app, BrowserWindow, Menu, session, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, statSync, truncateSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildServer } from '@grimoire/server/server';
import { dbPathFor, openDb } from '@grimoire/server/db';

// Tests (and portable installs) can relocate all app data.
if (process.env.GRIMOIRE_USER_DATA) app.setPath('userData', process.env.GRIMOIRE_USER_DATA);

const isDev = !app.isPackaged;
let server: ReturnType<typeof buildServer> | undefined;
let mainWindow: BrowserWindow | undefined;

/** Append-only log file in the user data dir (truncated when it grows past 5 MB), so problems can be diagnosed from a bug report. */
function openLogStream() {
  const dir = join(app.getPath('userData'), 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'grimoire.log');
  try { if (statSync(file).size > 5_000_000) truncateSync(file, 0); } catch { /* no log yet */ }
  return createWriteStream(file, { flags: 'a' });
}

async function startServer(): Promise<string> {
  const dataDir = join(app.getPath('userData'), 'data');
  const db = openDb(dbPathFor(dataDir));
  const token = randomBytes(24).toString('hex');
  // The built UI ships as an extra resource when packaged; in a dev run it's the Vite build output.
  const webRoot = app.isPackaged ? join(process.resourcesPath, 'web') : resolve(__dirname, '../../web/dist');
  server = buildServer({
    db, dataDir, webRoot, token,
    logger: { level: 'info', stream: openLogStream() },
    bulkFile: process.env.GRIMOIRE_BULK_FILE,
  });
  await server.listen({ port: 0, host: '127.0.0.1' }); // random free port, loopback only
  const { port } = server.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function createWindow(origin: string) {
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: 'Grimoire', backgroundColor: '#12131a', show: false, autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  win.once('ready-to-show', () => win.show());

  // Card links open in the user's browser; the app window never navigates away from its own origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) event.preventDefault();
  });

  void win.loadURL(origin);
  return win;
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ type: 'separator' as const }, { role: 'toggleDevTools' as const }] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Card data by Scryfall', click: () => void shell.openExternal('https://scryfall.com') },
        { label: 'Open data folder', click: () => void shell.openPath(app.getPath('userData')) },
      ],
    },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  void app.whenReady().then(async () => {
    // The UI needs no device or notification permissions.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    buildMenu();
    try {
      mainWindow = createWindow(await startServer());
    } catch (err) {
      console.error('Failed to start Grimoire:', err);
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { void server?.close(); });
}
