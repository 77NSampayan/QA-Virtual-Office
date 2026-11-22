/**
 * qa-office MCP server (stdio). Started by Claude Code (`claude mcp add ... qa-office`).
 * Reads the agent token from the data directory on every call (so revoking it takes effect at once) and
 * talks only to the local QA Virtual Office server on 127.0.0.1. Nothing is written to stdout except JSON-RPC.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { handleMessage, type Backend, type ProxyResult } from './protocol.ts';

const dataDir = process.env.QAVO_DATA_DIR ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'QA Virtual Office');
const port = Number(process.env.QAVO_PORT ?? 47821);
const base = `http://127.0.0.1:${port}`;

const readToken = (): string => {
  try {
    return fs.readFileSync(path.join(dataDir, 'agent-token'), 'utf8').trim();
  } catch {
    return '';
  }
};

async function request(method: 'GET' | 'POST', url: string, body?: unknown): Promise<ProxyResult> {
  const token = readToken();
  if (!token) return { ok: false, status: 0, body: { error: 'no_agent_token', message: 'The QA Virtual Office data folder was not found. Start the app first.' } };
  try {
    const res = await fetch(base + url, {
      method,
      headers: { 'x-qavo-agent-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } catch {
    return { ok: false, status: 0, body: { error: 'server_unreachable', message: `QA Virtual Office is not running on port ${port}. Start the app, then try again.` } };
  }
}

const backend: Backend = {
  listTools: () => request('GET', '/api/agent/tools'),
  callTool: (name, args) => request('POST', `/api/agent/tools/${encodeURIComponent(name)}`, args),
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain: Promise<void> = Promise.resolve();
rl.on('line', (line) => {
  if (!line.trim()) return;
  chain = chain.then(async () => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const out = await handleMessage(msg, backend);
    if (out !== null) process.stdout.write(JSON.stringify(out) + '\n');
  });
});
rl.on('close', () => void chain.then(() => process.exit(0)));
