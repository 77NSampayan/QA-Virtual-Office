/**
 * Claude Code PermissionRequest hook entry point (installed as a SYNCHRONOUS command hook, only when the person
 * installs it). Contract: ALWAYS exits 0; prints a decision ONLY after a person decided in the office; otherwise
 * prints nothing so Claude Code shows its normal permission prompt. Never persists raw stdin.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPermissionHook } from './permissionCore.ts';

const HARD_DEADLINE_MS = 125_000; // below the 130 s timeout the installer configures
const MAX_STDIN_BYTES = 8 * 1024 * 1024;

const deadline = setTimeout(() => process.exit(0), HARD_DEADLINE_MS); // silence = Claude Code's normal prompt

function resolveDataDir(): string {
  if (process.env.QAVO_DATA_DIR) return process.env.QAVO_DATA_DIR;
  // Installed layout: <dataDir>/hooks/permission.mjs
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > MAX_STDIN_BYTES) return ''; // too large to handle: no decision
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let out = '';
  try {
    out = (await runPermissionHook({ dataDir: resolveDataDir(), stdinText: await readStdin() })).stdout;
  } catch {
    out = ''; // never fail, never decide
  }
  clearTimeout(deadline);
  // No process.exit() here: ending the process while a socket is closing can crash a Windows exit (non-zero code).
  // Let the event loop drain; the sockets are already closed (connection: close) and the timers are cleared.
  process.exitCode = 0;
  if (out) process.stdout.write(out);
}

void main();
