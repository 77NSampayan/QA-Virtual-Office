/**
 * Data directory bootstrap: %LOCALAPPDATA%\QA Virtual Office\ (override: QAVO_DATA_DIR).
 * Applies a current-user-only NTFS ACL (inheritance removed) and creates the hook token and the
 * folder-key secret. See docs/privacy.md and docs/security.md.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateFolderKeySecret, parseFolderKeySecret, type FolderKeySecret } from '@qavo/shared/folderKeys';

export const APP_DIR_NAME = 'QA Virtual Office';

export function defaultDataDir(): string {
  if (process.env.QAVO_DATA_DIR) return process.env.QAVO_DATA_DIR;
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, APP_DIR_NAME);
}

export interface DataDirPaths {
  root: string;
  db: string;
  token: string;
  policy: string;
  folderKeySecret: string;
  hooksDir: string;
  forwarder: string;
  statuslineScript: string;
  statuslineWrap: string;
  spool: string;
  exports: string;
  logs: string;
  backups: string;
  settingsBackups: string;
  installManifest: string;
}

export function dataDirPaths(root: string): DataDirPaths {
  return {
    root,
    db: path.join(root, 'data.db'),
    token: path.join(root, 'token'),
    policy: path.join(root, 'capture-policy.json'),
    folderKeySecret: path.join(root, 'folder-key.secret'),
    hooksDir: path.join(root, 'hooks'),
    forwarder: path.join(root, 'hooks', 'forward.mjs'),
    statuslineScript: path.join(root, 'hooks', 'statusline.mjs'),
    statuslineWrap: path.join(root, 'statusline-wrap.json'),
    spool: path.join(root, 'spool.jsonl'),
    exports: path.join(root, 'exports'),
    logs: path.join(root, 'logs'),
    backups: path.join(root, 'backups'),
    settingsBackups: path.join(root, 'backups', 'claude-settings'),
    installManifest: path.join(root, 'hooks', 'install-manifest.json'),
  };
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Atomic replace (temp file in the same directory + rename), retrying transient Windows locks. */
export function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt < 8 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        sleepSync(25 * (attempt + 1));
        continue;
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}

export function currentPrincipal(): string {
  if (process.platform !== 'win32') return os.userInfo().username;
  const whoami = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
  try {
    return execFileSync(whoami, { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return `${process.env.USERDOMAIN ?? os.hostname()}\\${os.userInfo().username}`;
  }
}

const icacls = () => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');

/** Restrict the data dir to the current user only (inheritance removed). */
export function applyOwnerOnlyAcl(dir: string): void {
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, 0o700);
    return;
  }
  const principal = currentPrincipal();
  execFileSync(icacls(), [dir, '/inheritance:r', '/grant:r', `${principal}:(OI)(CI)F`, '/Q'], {
    windowsHide: true,
    stdio: 'pipe',
  });
  // Existing children re-inherit from the (now owner-only) directory.
  if (fs.readdirSync(dir).length > 0) {
    execFileSync(icacls(), [path.join(dir, '*'), '/reset', '/T', '/Q'], { windowsHide: true, stdio: 'pipe' });
  }
}

export interface AclReport {
  ok: boolean;
  principals: string[];
  raw: string;
}

/** Lists principals with access to `target`; ok when the only principal is the current user. */
export function verifyOwnerOnlyAcl(target: string): AclReport {
  if (process.platform !== 'win32') {
    const mode = fs.statSync(target).mode & 0o077;
    return { ok: mode === 0, principals: [os.userInfo().username], raw: `mode ${mode.toString(8)}` };
  }
  const raw = execFileSync(icacls(), [target], { encoding: 'utf8', windowsHide: true });
  const principals = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const body = line.startsWith(target) ? line.slice(target.length) : line;
    const m = /^\s*([^:]+\\[^:]+|[A-Z ]+[A-Za-z ]*):\(/.exec(body);
    if (m) principals.add(m[1]!.trim());
  }
  const me = currentPrincipal().toLowerCase();
  const list = [...principals];
  return { ok: list.length > 0 && list.every((p) => p.toLowerCase() === me), principals: list, raw };
}

export interface BootstrapResult {
  paths: DataDirPaths;
  token: string;
  aclApplied: boolean;
}

export function bootstrapDataDir(root: string, opts: { applyAcl?: boolean } = {}): BootstrapResult {
  const paths = dataDirPaths(root);
  const isNew = !fs.existsSync(root);
  fs.mkdirSync(root, { recursive: true });
  const applyAcl = opts.applyAcl ?? true;
  if (applyAcl) applyOwnerOnlyAcl(root);
  for (const d of [paths.hooksDir, paths.logs, paths.backups, paths.settingsBackups, paths.exports]) {
    fs.mkdirSync(d, { recursive: true });
  }
  let token = fs.existsSync(paths.token) ? fs.readFileSync(paths.token, 'utf8').trim() : '';
  if (!/^[a-f0-9]{64}$/.test(token)) {
    token = crypto.randomBytes(32).toString('hex');
    writeFileAtomic(paths.token, token);
  }
  if (!loadFolderKeySecret(paths)) writeFileAtomic(paths.folderKeySecret, JSON.stringify(generateFolderKeySecret()));
  void isNew;
  return { paths, token, aclApplied: applyAcl };
}

export function loadFolderKeySecret(paths: DataDirPaths): FolderKeySecret | null {
  try {
    return parseFolderKeySecret(fs.readFileSync(paths.folderKeySecret, 'utf8'));
  } catch {
    return null;
  }
}

/** Manual rotation: writes a new {kid,key} atomically; the old key is gone (by design). */
export function rotateFolderKeySecret(paths: DataDirPaths): FolderKeySecret {
  const next = generateFolderKeySecret();
  writeFileAtomic(paths.folderKeySecret, JSON.stringify(next));
  return next;
}
