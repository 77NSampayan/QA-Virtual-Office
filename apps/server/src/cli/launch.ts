/** npm run launch — asks the running server for a one-time login URL and opens it in the browser. */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { parsePolicy } from '@qavo/shared/policy';
import { dataDirPaths, defaultDataDir } from '../dataDir.ts';

const paths = dataDirPaths(defaultDataDir());
let token: string;
let port = Number(process.env.QAVO_PORT ?? 0);
try {
  token = fs.readFileSync(paths.token, 'utf8').trim();
  if (!port) port = parsePolicy(fs.readFileSync(paths.policy, 'utf8')).policy.collector.port;
} catch {
  console.error('QA Virtual Office has not been started yet (no data directory). Run `npm run start` first.');
  process.exit(1);
}

try {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/launch-nonce`, {
    method: 'POST',
    headers: { 'x-qavo-token': token },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { url } = (await res.json()) as { url: string };
  console.log(`Opening ${url.split('?')[0]} (one-time link)`);
  if (process.env.QAVO_NO_OPEN === '1') console.log(url);
  else execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, () => undefined);
} catch (err) {
  console.error(`Could not reach the server on port ${port}: ${(err as Error).message}. Is it running?`);
  process.exit(1);
}
