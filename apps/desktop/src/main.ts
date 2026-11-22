/**
 * QA Virtual Office desktop shell (Electron main process).
 * Security (docs/security.md): contextIsolation + sandbox + no node integration, a minimal typed
 * preload, navigation and window.open locked to the app origin, every permission request denied,
 * network requests from the UI limited to the local server, DevTools off unless QAVO_DEVTOOLS=1,
 * single instance, no application menu, IPC accepted only from the app's own main frame.
 */
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, Tray, type IpcMainInvokeEvent } from 'electron';
import { connectBackend, defaultDataDir, resolvePort, type Backend } from './backend.ts';
import { overlayIcon, robotIcon } from './icons.ts';
import { Notifier, type Attention, type ToastInfo } from './notifier.ts';
import { applyPrefUpdate, loadPrefs, savePrefs, type Prefs } from './prefs.ts';

const APP_USER_MODEL_ID = 'com.qavo.virtual-office';
const startHidden = process.argv.includes('--hidden');
const e2e = process.env.QAVO_E2E === '1';

if (process.env.QAVO_USER_DATA) app.setPath('userData', process.env.QAVO_USER_DATA);
app.setAppUserModelId(APP_USER_MODEL_ID);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let backend: Backend | null = null;
let notifier: Notifier | null = null;
let prefs: Prefs;
let attention: Attention = { level: 'none', count: 0, permission: 0, input: 0, failed: 0 };
let quitting = false;
let lastTooltip = 'QA Virtual Office';
let lastOverlay = '';
const shownToasts: Array<{ id: string; title: string; shownAt: number; clicked: boolean }> = [];
const liveToasts = new Map<string, Notification>(); // keep references so toasts are not garbage-collected

const root = path.resolve(__dirname, '../../..'); // dist/ -> apps/desktop -> apps -> repo root
const userDir = () => app.getPath('userData');

// ---------------------------------------------------------------------------- login item
function loginItemArgs() {
  return app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
}
function osStartWithWindows(): boolean {
  return app.getLoginItemSettings({ path: process.execPath, args: loginItemArgs() }).openAtLogin;
}
function applyLoginItem(enabled: boolean) {
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: loginItemArgs() });
}

// ---------------------------------------------------------------------------- window
function appOrigin(): string {
  return backend?.origin ?? 'http://127.0.0.1:0';
}

function createWindow(url: string): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 480,
    show: false,
    backgroundColor: '#0a0f1d',
    title: 'QA Virtual Office',
    icon: robotIcon('idle'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: process.env.QAVO_DEVTOOLS === '1',
      spellcheck: false,
    },
  });
  w.on('minimize', () => {
    if (prefs.minimizeToTray) w.hide();
  });
  w.on('close', (e) => {
    if (!quitting && prefs.minimizeToTray) {
      e.preventDefault();
      w.hide();
    }
  });
  w.on('closed', () => {
    win = null;
  });
  w.once('ready-to-show', () => {
    if (!startHidden) w.show();
  });
  void w.loadURL(url);
  return w;
}

async function showWindow(hash?: string): Promise<void> {
  if (!backend) return;
  if (!win || win.isDestroyed()) {
    win = createWindow(await backend.launchUrl());
    win.once('ready-to-show', () => win?.show());
  } else if (hash) {
    await win.loadURL(`${appOrigin()}/#${hash}`);
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------------------------------------------------------------------------- tray + badge
function updateAttention(a: Attention) {
  attention = a;
  lastTooltip =
    a.count === 0
      ? 'QA Virtual Office: nothing needs attention'
      : `QA Virtual Office: ${[a.permission && `${a.permission} awaiting permission`, a.input && `${a.input} awaiting input`, a.failed && `${a.failed} failed`].filter(Boolean).join(', ')}`;
  lastOverlay = a.count > 0 ? `${a.count} need attention` : '';
  tray?.setImage(robotIcon(a.level === 'none' ? 'idle' : 'awaiting_permission', a.level));
  tray?.setToolTip(lastTooltip);
  if (win && !win.isDestroyed()) {
    win.setOverlayIcon(a.count > 0 ? overlayIcon(a.level === 'alert' ? '#ff5d6c' : '#ff9f43') : null, lastOverlay);
  }
}

function buildMenu(): Menu {
  const toggle = (label: string, key: 'minimizeToTray' | 'sound' | 'startWithWindows') => ({
    label,
    type: 'checkbox' as const,
    checked: prefs[key],
    click: () => setPref(key, !prefs[key]),
  });
  return Menu.buildFromTemplate([
    { label: 'Open QA Virtual Office', click: () => void showWindow() },
    { label: 'Open QA Control Room', click: () => void showWindow('/control') },
    { type: 'separator' },
    toggle('Minimize to tray', 'minimizeToTray'),
    toggle('Start with Windows', 'startWithWindows'),
    toggle('Sound with alerts', 'sound'),
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function setPref(key: unknown, value: unknown): Prefs | null {
  const next = applyPrefUpdate(prefs, key, value);
  if (!next) return null;
  prefs = next;
  if (key === 'startWithWindows') applyLoginItem(prefs.startWithWindows);
  savePrefs(userDir(), prefs);
  tray?.setContextMenu(buildMenu());
  return prefs;
}

// ---------------------------------------------------------------------------- toasts
function toast(n: ToastInfo) {
  if (!Notification.isSupported()) return;
  const t = new Notification({ title: n.title, body: n.body, silent: !prefs.sound });
  const record = { id: n.id, title: n.title, shownAt: 0, clicked: false };
  t.on('show', () => {
    record.shownAt = Date.now();
  });
  t.on('click', () => {
    record.clicked = true;
    void showWindow('/control');
  });
  t.on('close', () => liveToasts.delete(n.id));
  liveToasts.set(n.id, t);
  shownToasts.push(record);
  if (shownToasts.length > 50) shownToasts.shift();
  t.show();
}

// ---------------------------------------------------------------------------- security
function lockDownSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // The UI may only talk to the local server.
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    try {
      const u = new URL(details.url);
      const o = new URL(appOrigin());
      cb({ cancel: !(u.hostname === o.hostname && u.port === o.port && ['http:', 'ws:'].includes(u.protocol)) });
    } catch {
      cb({ cancel: true });
    }
  });
}

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== appOrigin()) e.preventDefault();
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.on('will-redirect', (e, url) => {
    if (new URL(url).origin !== appOrigin()) e.preventDefault();
  });
});

const trusted = (e: IpcMainInvokeEvent): boolean => {
  try {
    return e.senderFrame === e.sender.mainFrame && new URL(e.senderFrame.url).origin === appOrigin();
  } catch {
    return false;
  }
};
ipcMain.handle('prefs:get', (e) => (trusted(e) ? prefs : null));
ipcMain.handle('prefs:set', (e, key: unknown, value: unknown) => (trusted(e) ? setPref(key, value) : null));
ipcMain.handle('notify:test', (e) => {
  if (!trusted(e)) return false;
  toast({ id: `test-${Date.now()}`, kind: 'test', priority: 'high', title: 'Test notification', body: 'This is how QA Virtual Office alerts you when an agent needs permission.' });
  return true;
});

// ---------------------------------------------------------------------------- lifecycle
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => void showWindow());

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    prefs = loadPrefs(userDir());
    prefs = { ...prefs, startWithWindows: osStartWithWindows() };
    tray = new Tray(robotIcon('idle'));
    tray.setContextMenu(buildMenu());
    tray.setToolTip('QA Virtual Office');
    tray.on('click', () => void showWindow());

    try {
      const dataDir = defaultDataDir();
      backend = await connectBackend({ root, dataDir, port: resolvePort(dataDir) }, (l) => console.log(`[server] ${l}`));
    } catch (err) {
      dialog.showErrorBox('QA Virtual Office could not start', (err as Error).message);
      quitting = true;
      app.quit();
      return;
    }
    lockDownSession();
    notifier = new Notifier({ backend, getPrefs: () => prefs, onToast: toast, onAttention: updateAttention, log: (l) => console.log(`[notifier] ${l}`) });
    void notifier.start();
    win = createWindow(await backend.launchUrl());

    if (e2e) {
      (globalThis as Record<string, unknown>).__qavo = {
        getWindow: () => win,
        getTray: () => tray,
        getPrefs: () => prefs,
        getAttention: () => attention,
        /** Read-only view of what the tray/taskbar currently show (Electron has no getters for these). */
        getBadge: () => ({ tooltip: lastTooltip, overlay: lastOverlay }),
        iconCheck: () => {
          const bmp = robotIcon('idle', 'alert').toBitmap();
          let opaque = 0;
          for (let i = 3; i < bmp.length; i += 4) if (bmp[i] === 255) opaque++;
          return { size: robotIcon('idle').getSize(), opaque, hasAlertDot: bmp.includes(Buffer.from([0x6c, 0x5d, 0xff, 0xff])) };
        },
        toasts: shownToasts,
        showWindow,
        /** Test seam only (QAVO_E2E=1): simulates the user clicking a toast. */
        clickToast: (id: string) => liveToasts.get(id)?.emit('click') ?? false,
        origin: backend.origin,
        owned: backend.owned,
        startHidden,
      };
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    notifier?.stop();
    backend?.stop();
  });
  app.on('window-all-closed', () => {
    /* stay in the tray; Quit from the tray menu exits */
  });
}
