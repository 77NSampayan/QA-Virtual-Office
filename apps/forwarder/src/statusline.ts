/**
 * Claude Code status-line entry point (opt-in). Contract: always exits 0, hard deadline,
 * forwards ONLY a sanitized numbers-only snapshot (same local project resolution and scope rules
 * as the hook forwarder), and prints either the wrapped command's output or a compact line.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFolderKeySecret } from '@qavo/shared/folderKeys';
import { parsePolicy } from '@qavo/shared/policy';
import { resolveProject } from '@qavo/shared/resolve';
import { formatStatusLine, sanitizeStatusLine } from '@qavo/shared/statusline';
import { POST_TIMEOUT_MS } from './core.ts';

const HARD_DEADLINE_MS = 3500;
const WRAP_TIMEOUT_MS = 2500;
const MAX_STDIN_BYTES = 2 * 1024 * 1024;
const MAX_WRAPPED_OUTPUT = 64 * 1024;

const dataDir = process.env.QAVO_DATA_DIR || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f: string) => {
  try {
    return fs.readFileSync(path.join(dataDir, f), 'utf8');
  } catch {
    return null;
  }
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > MAX_STDIN_BYTES) break;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Runs the user's original status line command (saved at install time) with the same stdin. */
function runWrapped(stdinText: string): Promise<string | null> {
  let cfg: { command?: unknown } | null = null;
  try {
    cfg = JSON.parse(read('statusline-wrap.json') ?? 'null');
  } catch {
    cfg = null;
  }
  if (!cfg || typeof cfg.command !== 'string' || !cfg.command) return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cfg!.command as string, { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill();
      resolve(out || null);
    }, WRAP_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      if (out.length < MAX_WRAPPED_OUTPUT) out += d;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdinText);
  });
}

async function forward(raw: unknown): Promise<string | null> {
  try {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const ws = r.workspace && typeof r.workspace === 'object' ? (r.workspace as Record<string, unknown>) : {};
    const cwd = ws.current_dir ?? ws.project_dir ?? r.cwd;
    const { policy } = parsePolicy(read('capture-policy.json'));
    const resolution = resolveProject(cwd, policy, () => parseFolderKeySecret(read('folder-key.secret')));
    if (resolution.kind === 'drop') return null;
    const snap = sanitizeStatusLine(raw, resolution);
    if (!snap) return null;
    const token = read('token')?.trim();
    if (token) {
      try {
        await fetch(`http://127.0.0.1:${policy.collector.port}/api/statusline`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-qavo-token': token },
          body: JSON.stringify(snap),
          signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });
      } catch {
        /* snapshots are best-effort and are not spooled (only the latest matters) */
      }
    }
    return formatStatusLine(snap);
  } catch {
    return null;
  }
}

async function main() {
  const deadline = setTimeout(() => process.exit(0), HARD_DEADLINE_MS);
  try {
    const stdinText = await readStdin();
    let raw: unknown = null;
    try {
      raw = JSON.parse(stdinText);
    } catch {
      /* ignore */
    }
    const [wrapped, compact] = await Promise.all([runWrapped(stdinText), forward(raw)]);
    const line = wrapped !== null && wrapped.trim() !== '' ? wrapped.replace(/\s+$/, '') : compact;
    if (line) process.stdout.write(line + '\n');
  } catch {
    /* swallow */
  } finally {
    clearTimeout(deadline);
    process.exitCode = 0;
  }
}

void main();
