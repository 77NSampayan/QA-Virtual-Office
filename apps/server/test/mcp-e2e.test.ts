/**
 * The REAL bundled qa-office MCP server, started as Claude Code would start it (a child process speaking
 * JSON-RPC on stdio), talking to a live test server. Proves the whole path: stdio -> token -> HTTP -> rules.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { COOKIE_NAME } from '../src/auth.ts';
import { readAgentToken, rotateAgentToken } from '../src/dataDir.ts';
import { makeEnv, uiHeaders, type TestEnv } from './helpers.ts';

const ROOT = path.resolve(__dirname, '../../..');
let env: TestEnv;
let cookie: string;
let child: ChildProcessWithoutNullStreams;
let buf = '';
const waiters: Array<(m: Record<string, unknown>) => void> = [];

const ui = async (method: string, url: string, payload?: unknown) => {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
function startChild() {
  buf = '';
  child = spawn(process.execPath, [path.join(ROOT, 'apps/mcp/dist/qa-office-mcp.mjs')], {
    env: { ...process.env, QAVO_DATA_DIR: env.dataDir, QAVO_PORT: String(env.port) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      waiters.shift()?.(JSON.parse(line) as Record<string, unknown>);
    }
  });
}
let nextId = 1;
const rpc = (method: string, params?: unknown): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no reply to ${method}`)), 15_000);
    waiters.push((m) => {
      clearTimeout(t);
      resolve(m as never);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }) + '\n');
  });
const tool = async (name: string, args: unknown) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const res = r.result as { isError: boolean; content: Array<{ text: string }> };
  return { isError: res.isError, text: res.content[0]!.text };
};

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'apps/mcp/build.mjs')], { stdio: 'ignore' });
  env = await makeEnv({ listen: true, auth: true });
  cookie = `${COOKIE_NAME}=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'Shop');
  fs.mkdirSync(dir);
  await ui('POST', '/api/projects', { alias: 'Demo Shop', path: dir });
  startChild();
});
afterAll(async () => {
  child?.kill();
  await env.cleanup();
});

describe('qa-office MCP server over stdio', () => {
  it('while agent access is OFF, listing tools fails with a clear message', async () => {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const r = await rpc('tools/list');
    expect(r.error?.message).toContain('agent_access_disabled');
    expect((await tool('qa_list_projects', {})).isError).toBe(true);
  });

  it('once a person turns it on, tools work end to end and drafts carry the agent label', async () => {
    await ui('PUT', '/api/settings/agent', { enabled: true, confirm: true });
    const list = await rpc('tools/list');
    const names = (list.result!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('qa_create_test_case_draft');
    expect(names.some((n) => /approve|close|complete|delete/.test(n))).toBe(false);
    const projects = await tool('qa_list_projects', {});
    expect(projects.isError).toBe(false);
    expect(JSON.parse(projects.text).projects[0].alias).toBe('Demo Shop');
    const draft = await tool('qa_create_test_case_draft', { project: 'Demo Shop', title: 'Register', steps: ['Open', 'Submit'], expectedResult: 'Account created' });
    expect(JSON.parse(draft.text)).toMatchObject({ status: 'draft', authoredBy: 'agent' });
    const stored = (await ui('GET', `/api/projects/${(await ui('GET', '/api/projects')).body[0].id}/test-cases`)).body[0];
    expect(stored).toMatchObject({ status: 'draft', authoredBy: 'agent' });
  });

  it('human-only decisions cannot be reached: forbidden values come back as tool errors, not as changes', async () => {
    const bad = await tool('qa_create_task', { project: 'Demo Shop', title: 'T', assignee: 'me' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('invalid_input');
    const missing = await tool('qa_approve_test_case', { project: 'Demo Shop', code: 'TC-0001' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('unknown_tool');
  });

  it('after a token rotation the running MCP server keeps working (it re-reads the token), while the old token is dead', async () => {
    const old = readAgentToken(env.paths);
    rotateAgentToken(env.paths);
    expect((await tool('qa_list_projects', {})).isError).toBe(false);
    const stale = await env.app.inject({ method: 'GET', url: '/api/agent/tools', headers: { host: env.host, 'x-qavo-agent-token': old } });
    expect(stale.statusCode).toBe(401);
  });

  it('exits cleanly when stdin closes and writes nothing but JSON-RPC to stdout', async () => {
    startChild();
    const exited = new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(buf).toBe('');
  });
});
