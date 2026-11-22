import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { bootstrapDataDir } from '../src/dataDir.ts';
import { openDb } from '../src/db/index.ts';
import { buildApp, type AppHandle } from '../src/app.ts';

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export interface TestEnv extends AppHandle {
  root: string;
  dataDir: string;
  port: number;
  token: string;
  paths: ReturnType<typeof bootstrapDataDir>['paths'];
  db: ReturnType<typeof openDb>;
  settingsPath: string;
  host: string;
  origin: string;
  cleanup: () => Promise<void>;
}

export async function makeEnv(opts: { applyAcl?: boolean; listen?: boolean } = {}): Promise<TestEnv> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-srv-'));
  const dataDir = path.join(root, 'data');
  const { paths, token } = bootstrapDataDir(dataDir, { applyAcl: opts.applyAcl ?? false });
  const db = openDb(paths.db);
  const port = await freePort();
  const settingsPath = path.join(root, 'claude', 'settings.json');
  const handle = await buildApp({
    db,
    paths,
    token,
    port,
    logFile: path.join(paths.logs, 'server.log'),
    webDist: path.join(root, 'no-web'),
    claudeSettingsPath: settingsPath,
  });
  handle.regeneratePolicy();
  if (opts.listen) await handle.app.listen({ host: '127.0.0.1', port });
  return {
    ...handle,
    root,
    dataDir,
    port,
    token,
    paths,
    db,
    settingsPath,
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    cleanup: async () => {
      await handle.app.close();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Reads every file under a directory (DB, WAL, logs, policy...) as latin1 so binary files are searchable. */
export function dirDump(dir: string): string {
  let out = '';
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out += fs.readFileSync(path.join(entry.parentPath, entry.name)).toString('latin1');
  }
  return out;
}

export const uiHeaders = (env: TestEnv) => ({ host: env.host, origin: env.origin, 'x-qavo-client': '1' });
export const hookHeaders = (env: TestEnv) => ({ host: env.host, 'x-qavo-token': env.token, 'content-type': 'application/json' });
