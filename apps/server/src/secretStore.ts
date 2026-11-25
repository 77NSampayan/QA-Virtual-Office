/**
 * Protected storage for access tokens (Pass 3, A3). A token is NEVER written to the database, a backup or an export.
 *
 * Real store: Windows DPAPI (current user) through the PowerShell that ships with Windows 10 and 11. The token is passed
 * on standard input, never on a command line; the stored file holds only the encrypted bytes (base64), which another
 * Windows account, or the same file copied to another PC, cannot decrypt. The files live in their own folder inside the
 * data directory (which is owner-only).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface SecretStore {
  save(id: string, secret: string): Promise<void>;
  load(id: string): Promise<string | null>;
  /** True when a secret is stored (never decrypts it). */
  has(id: string): boolean;
  remove(id: string): Promise<void>;
}

const ID_RE = /^[a-z0-9_]{1,64}$/;
const checkId = (id: string) => {
  if (!ID_RE.test(id)) throw new Error('invalid secret id');
  return id;
};

const PS_PROTECT = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($in); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
const PS_UNPROTECT = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($in); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";

function powershell(script: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('protected storage timed out'));
    }, 20_000);
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('protected storage is not available'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // never include the process output in the error: it could echo the secret
      if (code === 0) resolve(out.replace(/\r?\n$/, ''));
      else reject(new Error('protected storage failed'));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  });
}

export function createDpapiStore(dir: string): SecretStore {
  const file = (id: string) => path.join(dir, `${checkId(id)}.dpapi`);
  return {
    async save(id, secret) {
      if (process.platform !== 'win32') throw new Error('protected storage is only available on Windows');
      const blob = (await powershell(PS_PROTECT, secret)).trim();
      if (!/^[A-Za-z0-9+/=]+$/.test(blob) || blob.length < 40) throw new Error('protected storage failed');
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file(id)}.tmp`;
      fs.writeFileSync(tmp, blob, 'utf8');
      fs.renameSync(tmp, file(id));
    },
    has: (id) => fs.existsSync(file(id)),
    async load(id) {
      if (!fs.existsSync(file(id))) return null;
      return powershell(PS_UNPROTECT, fs.readFileSync(file(id), 'utf8'));
    },
    async remove(id) {
      fs.rmSync(file(id), { force: true });
    },
  };
}

/** For tests: keeps secrets in memory only. */
export function createMemoryStore(): SecretStore & { size(): number; all(): string[] } {
  const m = new Map<string, string>();
  return {
    async save(id, secret) {
      m.set(checkId(id), secret);
    },
    has: (id) => m.has(checkId(id)),
    async load(id) {
      return m.get(checkId(id)) ?? null;
    },
    async remove(id) {
      m.delete(checkId(id));
    },
    size: () => m.size,
    all: () => [...m.values()],
  };
}
