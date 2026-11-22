/** Standalone server entry: `npm run start` (Electron wraps this in Pass 1D). */
import { execFile } from 'node:child_process';
import { bootstrapDataDir, defaultDataDir } from './dataDir.ts';
import { buildApp, VERSION } from './app.ts';
import { runTimers } from './collector.ts';
import { maybeDailyBackup, openDbWithRecovery, runRetention } from './maintenance.ts';
import { replaySpool } from './spool.ts';
import { refreshProjectPaths } from './store.ts';

const port = Number(process.env.QAVO_PORT ?? 47821);
const { paths, token } = bootstrapDataDir(defaultDataDir());
const { db, recovery } = openDbWithRecovery(paths);
if (recovery) {
  console.warn(
    `Database problem detected (${recovery.reason}). Corrupt file kept aside; ${
      recovery.restoredFrom ? `restored from backup ${recovery.restoredFrom}` : 'started with a fresh database'
    }.`,
  );
}
refreshProjectPaths(db);

const { app, broadcast, regeneratePolicy, runtime, createLaunchUrl } = await buildApp({ db, paths, token, port, recovery });
const policyVersion = regeneratePolicy();

const guard = (name: string, fn: () => unknown | Promise<unknown>) => async () => {
  try {
    await fn();
  } catch (err) {
    app.log.error({ err }, `${name}_failed`);
  }
};

const replay = guard('spool_replay', () => {
  const r = replaySpool(db, paths, broadcast);
  if (r.files > 0) {
    runtime.lastReplay = { ...r, at: new Date().toISOString() };
    app.log.info({ replay: r }, 'spool_replayed');
  }
});
const retention = guard('retention', () => {
  const r = runRetention(db);
  app.log.info({ retention: r }, 'retention_ran');
});
const backup = guard('backup', async () => {
  const b = await maybeDailyBackup(db, paths);
  if (b) app.log.info({ backup: b.name }, 'backup_created');
});

await app.listen({ host: '127.0.0.1', port });
console.log(`QA Virtual Office ${VERSION} listening on http://127.0.0.1:${port} (policy v${policyVersion})`);

await replay(); // events spooled while the server was down
setTimeout(() => void retention().then(backup), 15_000);
const timers = [
  setInterval(guard('timers', () => runTimers(db, broadcast)), 30_000),
  setInterval(replay, 10_000),
  setInterval(() => void retention().then(backup), 6 * 3600_000),
];

const launchUrl = createLaunchUrl();
console.log(`Open the UI with this one-time link (valid 5 minutes, single use):\n  ${launchUrl}`);
if (process.env.QAVO_NO_OPEN !== '1' && process.platform === 'win32') {
  // The URL contains only hex characters; opened through the default browser handler.
  execFile('cmd.exe', ['/c', 'start', '', launchUrl], { windowsHide: true }, () => undefined);
}

const shutdown = async () => {
  for (const t of timers) clearInterval(t);
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
