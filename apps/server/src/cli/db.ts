/**
 * npm run db:backups | db:restore -- <backup-name> | db:check
 * Restore requires the server to be stopped; the current database is moved aside, never deleted.
 */
import fs from 'node:fs';
import net from 'node:net';
import { parsePolicy } from '@qavo/shared/policy';
import { dataDirPaths, defaultDataDir } from '../dataDir.ts';
import { checkDbFile, listBackups, restoreBackup } from '../maintenance.ts';

const paths = dataDirPaths(defaultDataDir());
const [cmd, arg] = process.argv.slice(2);

function serverRunning(): Promise<boolean> {
  let port = Number(process.env.QAVO_PORT ?? 0);
  if (!port) {
    try {
      port = parsePolicy(fs.readFileSync(paths.policy, 'utf8')).policy.collector.port;
    } catch {
      return Promise.resolve(false);
    }
  }
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 800 });
    s.on('connect', () => (s.destroy(), resolve(true)));
    s.on('error', () => resolve(false));
    s.on('timeout', () => (s.destroy(), resolve(false)));
  });
}

if (cmd === 'backups') {
  const list = listBackups(paths);
  if (list.length === 0) console.log('No backups yet.');
  for (const b of list) console.log(`${b.name}  ${(b.bytes / 1024).toFixed(0)} KB  ${b.createdAt}`);
} else if (cmd === 'check') {
  const r = checkDbFile(paths.db);
  console.log(r.ok ? 'Database integrity: ok' : `Database integrity problem: ${r.detail}`);
  process.exit(r.ok ? 0 : 2);
} else if (cmd === 'restore' && arg) {
  if (await serverRunning()) {
    console.error('Stop the QA Virtual Office server before restoring a backup.');
    process.exit(1);
  }
  restoreBackup(paths, arg);
  console.log(`Restored ${arg}. The previous database was kept next to it as data.db.before-restore-*.`);
} else {
  console.error('usage: db.ts backups | check | restore <backup-name>');
  process.exit(1);
}
