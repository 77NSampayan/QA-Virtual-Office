/**
 * Connects the desktop app to the QA Virtual Office server.
 *  - If a server already answers on the configured port it is ATTACHED to (never replaced or killed).
 *  - Otherwise the existing server is started as a child process on the system Node (the native
 *    SQLite module is built for Node, not Electron) and supervised with a restart back-off.
 * The main process proves it is the same Windows user by reading the hook token file.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface BackendOptions {
  /** Repository root (contains node_modules/tsx and apps/server). */
  root: string;
  dataDir: string;
  port: number;
}

export interface Backend {
  origin: string;
  port: number;
  /** True when this app started the server (and so stops it on quit). */
  owned: boolean;
  /** One-time URL that signs a browser session in. */
  launchUrl: () => Promise<string>;
  /** Signs in with a fresh one-time link and returns the session cookie header value. */
  sessionCookie: () => Promise<string>;
  stop: () => void;
}

export function defaultDataDir(): string {
  if (process.env.QAVO_DATA_DIR) return process.env.QAVO_DATA_DIR;
  return path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '.', 'AppData', 'Local'), 'QA Virtual Office');
}

/** Port: QAVO_PORT, else the capture policy written by the server, else the default. */
export function resolvePort(dataDir: string): number {
  if (process.env.QAVO_PORT && Number(process.env.QAVO_PORT) > 0) return Number(process.env.QAVO_PORT);
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dataDir, 'capture-policy.json'), 'utf8')) as { collector?: { port?: number } };
    if (p.collector?.port) return p.collector.port;
  } catch {
    /* first run */
  }
  return 47821;
}

function resolveNode(): string {
  const where = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe');
  const first = execFileSync(where, ['node'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0]?.trim();
  if (!first || !/node\.exe$/i.test(first)) throw new Error('Node.js was not found on this PC; install Node 22+ or start the server yourself with `npm run start`.');
  return first;
}

async function healthy(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitHealthy(port: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await healthy(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export async function connectBackend(opts: BackendOptions, onLog: (line: string) => void = () => undefined): Promise<Backend> {
  const { root, dataDir, port } = opts;
  const origin = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;
  let stopping = false;
  let restarts = 0;

  const start = () => {
    const main = path.join(root, 'apps', 'server', 'src', 'main.ts');
    // `--import tsx` keeps this a single process, so stopping it really stops the server
    child = spawn(resolveNode(), ['--import', 'tsx', main], {
      cwd: root,
      env: { ...process.env, QAVO_NO_OPEN: '1', QAVO_PORT: String(port) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => onLog(String(d).replace(/k=[a-f0-9]+/g, 'k=<redacted>').trimEnd()));
    child.stderr?.on('data', (d) => onLog(String(d).trimEnd()));
    child.on('exit', (code) => {
      child = null;
      if (stopping) return;
      onLog(`server exited (${code}); restarting`);
      restarts++;
      const delay = Math.min(15_000, 1000 * 2 ** Math.min(restarts, 4));
      setTimeout(() => {
        if (!stopping) start();
      }, delay);
    });
  };

  let owned = false;
  if (await healthy(port)) {
    onLog('attached to the running server');
  } else {
    owned = true;
    start();
    if (!(await waitHealthy(port, 30_000))) {
      stopping = true;
      (child as ChildProcess | null)?.kill();
      throw new Error(`The server did not start on port ${port}. Is the port in use by another program?`);
    }
    restarts = 0;
  }

  const token = () => fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim();
  const nonceUrl = async (): Promise<string> => {
    const r = await fetch(`${origin}/api/auth/launch-nonce`, { method: 'POST', headers: { 'x-qavo-token': token() }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`launch link refused (HTTP ${r.status})`);
    return ((await r.json()) as { url: string }).url;
  };

  return {
    origin,
    port,
    owned,
    launchUrl: nonceUrl,
    async sessionCookie() {
      const r = await fetch(await nonceUrl(), { redirect: 'manual', signal: AbortSignal.timeout(4000) });
      const m = /qavo_session=([a-f0-9]{64})/.exec(r.headers.get('set-cookie') ?? '');
      if (!m) throw new Error('sign-in failed');
      return `qavo_session=${m[1]}`;
    },
    stop() {
      stopping = true;
      (child as ChildProcess | null)?.kill();
    },
  };
}
