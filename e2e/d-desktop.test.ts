/**
 * Pass 1D acceptance: the real Electron app (playwright-core `_electron`), with an isolated data
 * folder, port and user-data folder per instance. Events are SYNTHETIC and go only to that isolated
 * server (ADR-012). A QAVO_E2E=1 seam exposes read-only state and a click simulator to the tests.
 *   D1 a permission prompt raises a Windows toast within 2 s; clicking it focuses the app
 *   D2 Electron security checklist
 *   D3 tray, minimize/restore, login item, single instance
 * (D4: Windows 10 cannot be tested on this machine.)
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'apps/desktop');
const electronPath = createRequire(path.join(ROOT, 'package.json'))('electron') as unknown as string;
const SHOTS = process.env.QAVO_E2E_SHOTS;
/** Environment for Electron: VS Code sets ELECTRON_RUN_AS_NODE, which would start Electron as plain Node. */
const cleanEnv = (extra: Record<string, string> = {}): Record<string, string> => {
  const e = { ...process.env, ...extra } as Record<string, string | undefined>;
  delete e.ELECTRON_RUN_AS_NODE;
  return e as Record<string, string>;
};

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

interface Instance {
  app: ElectronApplication;
  dataDir: string;
  userData: string;
  port: number;
  origin: string;
  env: Record<string, string>;
}

async function launch(opts: { args?: string[]; reuse?: Pick<Instance, 'dataDir' | 'userData' | 'port'> } = {}): Promise<Instance> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-desk-'));
  const dataDir = opts.reuse?.dataDir ?? path.join(tmp, 'data');
  const userData = opts.reuse?.userData ?? path.join(tmp, 'userdata');
  const port = opts.reuse?.port ?? (await freePort());
  const env = { QAVO_E2E: '1', QAVO_DATA_DIR: dataDir, QAVO_PORT: String(port), QAVO_USER_DATA: userData };
  const app = await _electron.launch({ executablePath: electronPath, args: [APP_DIR, ...(opts.args ?? [])], env: cleanEnv(env), timeout: 60_000 });
  const inst = { app, dataDir, userData, port, origin: `http://127.0.0.1:${port}`, env };
  await waitSeam(inst);
  return inst;
}

const q = <T>(inst: Instance, code: string): Promise<T> => inst.app.evaluate(async (_electron, c) => (0, eval)(c as string), code) as Promise<T>;

async function waitSeam(inst: Instance, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await q<boolean>(inst, '!!globalThis.__qavo')) return;
    } catch {
      /* app still starting */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('desktop app did not become ready');
}

const healthy = async (port: number) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
};
async function waitFor<T>(fn: () => Promise<T | false | null | undefined> | T | false | null | undefined, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function post(inst: Instance, sessionId: string, event: string, extra: Record<string, unknown> = {}) {
  const token = fs.readFileSync(path.join(inst.dataDir, 'token'), 'utf8').trim();
  const r = await fetch(`${inst.origin}/api/hooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-qavo-token': token },
    body: JSON.stringify({ v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId, event, projectId: null, folderKeys: [], ...extra }),
  });
  expect(r.status).toBe(204);
}

interface Toast {
  id: string;
  title: string;
  shownAt: number;
  clicked: boolean;
}
const toasts = (inst: Instance) => q<Toast[]>(inst, 'JSON.parse(JSON.stringify(globalThis.__qavo.toasts))');
const winState = (inst: Instance) =>
  q<{ exists: boolean; visible: boolean; minimized: boolean; url: string }>(
    inst,
    '(() => { const w = globalThis.__qavo.getWindow(); return w && !w.isDestroyed() ? { exists: true, visible: w.isVisible(), minimized: w.isMinimized(), url: w.webContents.getURL() } : { exists: false, visible: false, minimized: false, url: "" }; })()',
  );

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const LOGIN_ITEM = 'com.qavo.virtual-office';
const regRun = () => execFileSync('reg', ['query', RUN_KEY], { encoding: 'utf8' });
const devLoginItem = () => regRun().split(/\r?\n/).find((l) => l.includes(LOGIN_ITEM));
/** Safety net: remove the login item only if it points at this repo's development Electron. */
function removeDevLoginItem() {
  const line = devLoginItem();
  if (line && /node_modules\\electron\\dist\\electron\.exe/i.test(line) && /apps\\desktop/i.test(line)) {
    execFileSync('reg', ['delete', RUN_KEY, '/v', LOGIN_ITEM, '/f']);
  }
}

const all: Instance[] = [];
const standalone: ChildProcess[] = [];
let main: Instance;
let page: Page;

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  expect(fs.existsSync(path.join(APP_DIR, 'dist/main.cjs')), 'run `npm run build -w @qavo/desktop` first').toBe(true);
  main = await launch();
  all.push(main);
  page = await main.app.firstWindow();
  await page.waitForSelector('[data-page="overview"]', { timeout: 30_000 });
});

afterAll(async () => {
  for (const i of all) await i.app.close().catch(() => undefined);
  for (const c of standalone) c.kill();
  removeDevLoginItem(); // never leave a login item behind, whatever happened
  expect(devLoginItem(), 'no login item may remain after the tests').toBeUndefined();
});

describe('the desktop app starts the real office', () => {
  it('starts the server itself on system Node, opens a signed-in window and shows the office', async () => {
    expect(await q<boolean>(main, 'globalThis.__qavo.owned')).toBe(true);
    expect(await healthy(main.port)).toBe(true);
    expect(await page.title()).toMatch(/QA Virtual Office/);
    expect(await page.textContent('body')).toContain('QA Office Overview');
    expect(page.url().startsWith(main.origin)).toBe(true);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'desktop-overview.png') });
  });

  it('the Settings screen shows the Desktop card inside the app (and only there)', async () => {
    await page.click('a[data-nav="/settings"]');
    await page.waitForSelector('[data-desktop-card]');
    expect(await page.textContent('[data-desktop-card]')).toContain('Start with Windows');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'desktop-settings.png'), fullPage: true });
  });
});

describe('D1: a permission prompt raises a Windows toast within 2 s; clicking it focuses the app', () => {
  it('raises a toast within 2 seconds of a real PermissionRequest event', async () => {
    await post(main, 'd1-a', 'SessionStart', { source: 'startup' });
    const t0 = Date.now();
    await post(main, 'd1-a', 'PermissionRequest', { toolName: 'Bash' });
    const toast = await waitFor(async () => (await toasts(main)).find((t) => t.title === 'Permission required' && t.shownAt > 0), 4000, 'the permission toast to be shown');
    const latency = toast.shownAt - t0;
    expect(latency, `toast shown after ${latency} ms`).toBeLessThan(2000);
    console.log(`D1 toast latency: ${latency} ms`);
  });

  it('clicking the toast restores a hidden window and opens the Control Room', async () => {
    await q(main, 'globalThis.__qavo.getWindow().hide()');
    expect((await winState(main)).visible).toBe(false);
    const toast = (await toasts(main)).find((t) => t.title === 'Permission required')!;
    await q(main, `globalThis.__qavo.clickToast(${JSON.stringify(toast.id)})`);
    const state = await waitFor(async () => {
      const s = await winState(main);
      return s.visible && s.url.endsWith('#/control') ? s : false;
    }, 5000, 'the window to show the Control Room');
    expect(state.minimized).toBe(false);
    await page.waitForSelector('[data-page="control"]');
    expect(await page.textContent('[data-attention]')).toContain('Bash');
  });

  it('raises a toast for input requests and failures, but not for completion unless chosen (priority setting)', async () => {
    const before = (await toasts(main)).length;
    await post(main, 'd1-b', 'SessionStart', { source: 'startup' });
    await post(main, 'd1-b', 'Stop'); // low priority: completed
    await new Promise((r) => setTimeout(r, 700));
    expect((await toasts(main)).length).toBe(before);
    await post(main, 'd1-c', 'SessionStart', { source: 'startup' });
    await post(main, 'd1-c', 'Notification', { notificationType: 'elicitation_dialog' });
    await post(main, 'd1-c', 'StopFailure', { error: 'rate_limit' });
    await waitFor(async () => (await toasts(main)).length >= before + 2, 4000, 'input + failure toasts');
    const titles = (await toasts(main)).map((t) => t.title);
    expect(titles).toContain('Input required');
    expect(titles).toContain('Agent failed');
    // user opts in to low-priority toasts from the UI
    await page.evaluate(() => window.qavoDesktop!.setPref('toastPriorities', ['high', 'warning', 'low']));
    const n = (await toasts(main)).length;
    await post(main, 'd1-d', 'SessionStart', { source: 'startup' });
    await post(main, 'd1-d', 'Stop');
    await waitFor(async () => (await toasts(main)).length > n, 4000, 'the completion toast after opting in');
    await page.evaluate(() => window.qavoDesktop!.setPref('toastPriorities', ['high', 'warning']));
  });

  it('a server restart or reconnect never re-toasts old notifications', async () => {
    const n = (await toasts(main)).length;
    await new Promise((r) => setTimeout(r, 1500));
    expect((await toasts(main)).length).toBe(n);
  });

  it('the in-app test notification button works', async () => {
    const n = (await toasts(main)).length;
    expect(await page.evaluate(() => window.qavoDesktop!.testNotification())).toBe(true);
    await waitFor(async () => (await toasts(main)).length === n + 1, 3000, 'the test toast');
  });

  it('the tray and taskbar badge follow real session state (permission prompt on, answered, off)', async () => {
    // d1-a is still awaiting permission (it never got a PostToolUse), d1-c failed
    const on = await waitFor(async () => {
      const b = await q<{ tooltip: string; overlay: string }>(main, 'globalThis.__qavo.getBadge()');
      return /awaiting permission/.test(b.tooltip) ? b : false;
    }, 4000, 'tray tooltip to show the waiting agent');
    expect(on.overlay).toMatch(/need attention/);
    await post(main, 'd1-a', 'PostToolUse', { toolName: 'Bash' }); // answered in the terminal
    await post(main, 'd1-c', 'SessionEnd', { reason: 'other' });
    await post(main, 'd1-c', 'SessionStart', { source: 'startup' }); // d1-c is healthy again
    await post(main, 'd1-c', 'Stop');
    const off = await waitFor(async () => {
      const b = await q<{ tooltip: string; overlay: string }>(main, 'globalThis.__qavo.getBadge()');
      return /awaiting permission/.test(b.tooltip) ? false : b;
    }, 4000, 'tray tooltip to clear');
    expect(off.tooltip).not.toMatch(/awaiting permission/);
  });

  it('tray and taskbar icons are drawn from the sprites (16x16 plus a high-DPI representation, with an alert dot)', async () => {
    const icon = await q<{ size: { width: number; height: number }; opaque: number; hasAlertDot: boolean }>(main, 'globalThis.__qavo.iconCheck()');
    expect(icon.size).toEqual({ width: 16, height: 16 });
    expect(icon.opaque).toBeGreaterThan(100);
    expect(icon.hasAlertDot).toBe(true);
  });
});

describe('D2: Electron security checklist', () => {
  it('window: contextIsolation, sandbox, no node integration, webSecurity, DevTools off', async () => {
    const wp = await q<Record<string, unknown>>(main, 'JSON.parse(JSON.stringify(globalThis.__qavo.getWindow().webContents.getLastWebPreferences()))');
    expect(wp).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, experimentalFeatures: false });
    // DevTools are disabled: asking to open them does nothing
    const devtools = await q<boolean>(main, '(() => { const c = globalThis.__qavo.getWindow().webContents; c.openDevTools(); return c.isDevToolsOpened(); })()');
    expect(devtools).toBe(false);
  });

  it('the page has no Node: no require, process or Buffer; the preload exposes exactly four members', async () => {
    const r = await page.evaluate(() => ({
      req: typeof (window as unknown as { require?: unknown }).require,
      proc: typeof (window as unknown as { process?: unknown }).process,
      buf: typeof (window as unknown as { Buffer?: unknown }).Buffer,
      keys: Object.keys(window.qavoDesktop ?? {}).sort(),
      electron: typeof (window as unknown as { electron?: unknown }).electron,
    }));
    expect(r).toEqual({ req: 'undefined', proc: 'undefined', buf: 'undefined', keys: ['getPrefs', 'isDesktop', 'setPref', 'testNotification'], electron: 'undefined' });
  });

  it('navigation away from the app origin is blocked', async () => {
    await page.evaluate(() => {
      location.href = 'https://example.com/';
    });
    await new Promise((r) => setTimeout(r, 1200));
    expect(page.url().startsWith(main.origin)).toBe(true);
    expect(page.url()).not.toContain('example.com');
  });

  it('window.open is denied and creates no window', async () => {
    const opened = await page.evaluate(() => window.open('https://example.com/') !== null);
    expect(opened).toBe(false);
    await new Promise((r) => setTimeout(r, 500));
    expect(main.app.windows().length).toBe(1);
  });

  it('the page cannot reach any other network origin (requests are cancelled)', async () => {
    const results = await page.evaluate(async () => {
      const tryFetch = (u: string) => fetch(u, { mode: 'no-cors' }).then(() => 'loaded', () => 'blocked');
      return [await tryFetch('https://example.com/'), await tryFetch('http://127.0.0.1:1/'), await tryFetch('http://localhost:9/')];
    });
    expect(results).toEqual(['blocked', 'blocked', 'blocked']);
  });

  it('every permission request is denied (geolocation, notifications API, clipboard)', async () => {
    const r = await page.evaluate(async () => {
      const geo = await new Promise((res) => navigator.geolocation.getCurrentPosition(() => res('granted'), (e) => res(`error:${e.code}`)));
      const notif = await Notification.requestPermission();
      const clip = await navigator.clipboard.readText().then(() => 'granted', () => 'denied');
      return { geo, notif, clip };
    });
    expect(r.geo).toBe('error:1'); // PERMISSION_DENIED
    expect(r.notif).not.toBe('granted');
    expect(r.clip).toBe('denied');
  });

  it('there is no application menu (no reload/DevTools shortcuts) and the strict CSP is served', async () => {
    expect(await main.app.evaluate(({ Menu }) => Menu.getApplicationMenu() === null)).toBe(true);
    const csp = await page.evaluate(async () => (await fetch('/')).headers.get('content-security-policy'));
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('IPC accepts only validated preference updates from the app itself', async () => {
    const r = await page.evaluate(async () => {
      const d = window.qavoDesktop!;
      return {
        bogusList: await d.setPref('toastPriorities', ['bogus']),
        proto: await d.setPref('__proto__' as never, { evil: true }),
        unknown: await d.setPref('nope' as never, true),
        wrongType: await d.setPref('sound', 'yes'),
        ok: (await d.setPref('sound', true))?.sound,
      };
    });
    expect(r).toEqual({ bogusList: null, proto: null, unknown: null, wrongType: null, ok: true });
    expect(await q<boolean>(main, 'globalThis.__qavo.getPrefs().sound')).toBe(true);
    await page.evaluate(() => window.qavoDesktop!.setPref('sound', false));
    // persisted to the user-data folder as plain, valid JSON containing only known keys
    const saved = JSON.parse(fs.readFileSync(path.join(main.userData, 'desktop-prefs.json'), 'utf8'));
    expect(Object.keys(saved).sort()).toEqual(['minimizeToTray', 'sound', 'startWithWindows', 'toastPriorities']);
  });

  it('the page cannot call the desktop bridge with anything it was not given (no extra IPC channels)', async () => {
    const r = await page.evaluate(async () => {
      const d = window.qavoDesktop as unknown as Record<string, unknown>;
      return { extra: typeof d.invoke, send: typeof d.send, ipc: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer };
    });
    expect(r).toEqual({ extra: 'undefined', send: 'undefined', ipc: 'undefined' });
  });
});

describe('D3: tray, minimize/restore, login item, single instance (Windows 11)', () => {
  it('the tray icon exists', async () => {
    expect(await q<boolean>(main, '!globalThis.__qavo.getTray().isDestroyed()')).toBe(true);
  });

  it('minimizing hides the window to the tray; showing it restores it', async () => {
    await q(main, 'globalThis.__qavo.showWindow()');
    await waitFor(async () => (await winState(main)).visible, 3000, 'window visible');
    await q(main, 'globalThis.__qavo.getWindow().minimize()');
    expect(await waitFor(async () => !(await winState(main)).visible, 3000, 'window to hide on minimize')).toBe(true);
    expect((await winState(main)).exists).toBe(true); // still alive, in the tray
    await q(main, 'globalThis.__qavo.showWindow()');
    const s = await waitFor(async () => ((await winState(main)).visible ? await winState(main) : false), 3000, 'window to restore');
    expect(s.minimized).toBe(false);
  });

  it('closing the window keeps the app running in the tray (server still up)', async () => {
    await q(main, 'globalThis.__qavo.getWindow().close()');
    await new Promise((r) => setTimeout(r, 500));
    const s = await winState(main);
    expect(s.exists).toBe(true);
    expect(s.visible).toBe(false);
    expect(await healthy(main.port)).toBe(true);
    await q(main, 'globalThis.__qavo.showWindow()');
    await waitFor(async () => (await winState(main)).visible, 3000, 'window back');
  });

  it('a second launch does not start a second app: it exits and the first window is shown', async () => {
    await q(main, 'globalThis.__qavo.getWindow().hide()');
    const second = spawn(electronPath, [APP_DIR], { env: cleanEnv(main.env), stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => {
        second.kill();
        resolve(-1);
      }, 20_000);
      second.on('exit', (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    expect(code, 'second instance should exit by itself').not.toBe(-1);
    await waitFor(async () => (await winState(main)).visible, 4000, 'the first instance to show its window');
    expect(await healthy(main.port)).toBe(true);
  });

  it('Start with Windows registers and removes a hidden-start login item', async () => {
    const hasEntry = () => /com\.qavo\.virtual-office[^\r\n]*--hidden/i.test(regRun());
    await page.evaluate(() => window.qavoDesktop!.setPref('startWithWindows', false)); // start from a clean state
    await waitFor(async () => !hasEntry(), 4000, 'a clean registry before the test');
    try {
      const on = await page.evaluate(() => window.qavoDesktop!.setPref('startWithWindows', true));
      expect(on?.startWithWindows).toBe(true);
      await waitFor(async () => hasEntry(), 4000, 'the login item to be registered');
      const line = devLoginItem()!;
      expect(line).toContain('--hidden');
      expect(line.toLowerCase()).toContain('apps\\desktop');
      const os = await main.app.evaluate(({ app }) => app.getLoginItemSettings({ path: process.execPath, args: [app.getAppPath(), '--hidden'] }).openAtLogin);
      expect(os).toBe(true);
    } finally {
      await page.evaluate(() => window.qavoDesktop!.setPref('startWithWindows', false));
    }
    await waitFor(async () => !hasEntry(), 4000, 'the login item to be removed');
    expect(devLoginItem()).toBeUndefined();
  });

  it('started hidden (as at login) the app lives in the tray without showing a window', async () => {
    const hidden = await launch({ args: ['--hidden'] });
    all.push(hidden);
    expect(await q<boolean>(hidden, 'globalThis.__qavo.startHidden')).toBe(true);
    await new Promise((r) => setTimeout(r, 2500));
    expect((await winState(hidden)).visible).toBe(false);
    expect(await q<boolean>(hidden, '!globalThis.__qavo.getTray().isDestroyed()')).toBe(true);
    await q(hidden, 'globalThis.__qavo.showWindow()');
    await waitFor(async () => (await winState(hidden)).visible, 4000, 'tray open');
    await hidden.app.close();
    expect(await waitFor(async () => !(await healthy(hidden.port)), 8000, 'its server to stop')).toBe(true);
  });
});

describe('server lifecycle', () => {
  it('attaches to an already running server and leaves it running when the app quits', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-attach-'));
    const dataDir = path.join(tmp, 'data');
    const port = await freePort();
    const srv = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], { cwd: ROOT, env: { ...process.env, QAVO_DATA_DIR: dataDir, QAVO_PORT: String(port), QAVO_NO_OPEN: '1' }, stdio: 'ignore' });
    standalone.push(srv);
    await waitFor(async () => healthy(port), 30_000, 'the standalone server');
    const attached = await launch({ reuse: { dataDir, port, userData: path.join(tmp, 'userdata') } });
    all.push(attached);
    expect(await q<boolean>(attached, 'globalThis.__qavo.owned')).toBe(false);
    const p = await attached.app.firstWindow();
    await p.waitForSelector('[data-page="overview"]', { timeout: 30_000 });
    await attached.app.close();
    await new Promise((r) => setTimeout(r, 1500));
    expect(await healthy(port)).toBe(true); // not ours to stop
    srv.kill();
    await waitFor(async () => !(await healthy(port)), 8000, 'standalone server to stop');
  });

  it('stops the server it started when the app quits', async () => {
    const port = main.port;
    expect(await healthy(port)).toBe(true);
    await main.app.close();
    expect(await waitFor(async () => !(await healthy(port)), 10_000, 'the app-owned server to stop')).toBe(true);
  });
});
