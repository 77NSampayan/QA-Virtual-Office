/**
 * Claude Code hook entry point (installed as an async command hook).
 * Contract: ALWAYS exits 0, never writes to stdout (stdout JSON could be read as a hook decision),
 * finishes within a hard deadline, and never persists raw stdin.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runForwarder } from './core.ts';

const HARD_DEADLINE_MS = 5000;
const MAX_STDIN_BYTES = 8 * 1024 * 1024;

const deadline = setTimeout(() => process.exit(0), HARD_DEADLINE_MS);

function resolveDataDir(): string {
  if (process.env.QAVO_DATA_DIR) return process.env.QAVO_DATA_DIR;
  // Installed layout: <dataDir>/hooks/forward.mjs
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

async function readStdin(): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > MAX_STDIN_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  try {
    const stdinText = (await readStdin()) ?? '';
    await runForwarder({ dataDir: resolveDataDir(), stdinText });
  } catch {
    /* swallow: the hook must never fail */
  } finally {
    clearTimeout(deadline);
    process.exitCode = 0;
  }
}

void main();
