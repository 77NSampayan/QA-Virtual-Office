/** npm run hooks:install | hooks:uninstall | hooks:status   (flags: --yes, --dry-run) */
import readline from 'node:readline/promises';
import { bootstrapDataDir, defaultDataDir } from '../dataDir.ts';
import {
  claudeSettingsPath,
  CROSS_PROJECT_WARNING,
  hookStatus,
  install,
  planInstall,
  resolveNodePath,
  uninstall,
} from '../installer.ts';
import fs from 'node:fs';

const [cmd, ...flags] = process.argv.slice(2);
const yes = flags.includes('--yes');
const dryRun = flags.includes('--dry-run');
const { paths } = bootstrapDataDir(defaultDataDir());

async function confirm(question: string): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    console.error('Non-interactive shell: re-run with --yes after reading the warning above.');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

if (cmd === 'install') {
  console.log(CROSS_PROJECT_WARNING + '\n');
  if (dryRun) {
    const file = claudeSettingsPath();
    const cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    console.log(JSON.stringify(planInstall(cur, resolveNodePath(), paths.forwarder), null, 2));
    process.exit(0);
  }
  if (!(await confirm('Install QA Virtual Office hooks for ALL Claude Code sessions on this PC?'))) process.exit(1);
  const r = install({ paths });
  console.log(r.changed ? `Installed. Backup: ${r.backupPath ?? '(no previous settings.json)'}` : 'Already installed (no changes).');
  console.log(`Verified: ${r.verified}`);
  process.exit(r.verified ? 0 : 2);
} else if (cmd === 'uninstall') {
  const r = uninstall({ paths });
  console.log(r.changed ? `Uninstalled. Backup of pre-uninstall file: ${r.backupPath}` : 'Not installed (no changes).');
  console.log(`Verified removed: ${r.verified}`);
  process.exit(r.verified ? 0 : 2);
} else if (cmd === 'status') {
  console.log(JSON.stringify(hookStatus({ paths }), null, 2));
} else {
  console.error('usage: hooks.ts install [--yes] [--dry-run] | uninstall | status');
  process.exit(1);
}
