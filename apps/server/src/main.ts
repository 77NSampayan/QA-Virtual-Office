/** Standalone server entry: `npm run start` (Electron wraps this in Pass 1D). */
import { bootstrapDataDir, defaultDataDir } from './dataDir.ts';
import { openDb } from './db/index.ts';
import { buildApp, VERSION } from './app.ts';
import { runTimers } from './collector.ts';
import { refreshProjectPaths } from './store.ts';

const port = Number(process.env.QAVO_PORT ?? 47821);
const { paths, token } = bootstrapDataDir(defaultDataDir());
const db = openDb(paths.db);
refreshProjectPaths(db);

const { app, broadcast, regeneratePolicy } = await buildApp({ db, paths, token, port });
const policyVersion = regeneratePolicy();

const timer = setInterval(() => {
  try {
    runTimers(db, broadcast);
  } catch (err) {
    app.log.error({ err }, 'timer_failed');
  }
}, 30_000);

await app.listen({ host: '127.0.0.1', port });
console.log(`QA Virtual Office ${VERSION} listening on http://127.0.0.1:${port} (policy v${policyVersion})`);

const shutdown = async () => {
  clearInterval(timer);
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
