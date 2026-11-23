/**
 * The REAL bundled qa-office MCP server started the way a playbook launch configures it: a child process whose
 * environment is exactly the per-run config the server wrote (run credential + port), with NO shared agent token
 * available to it. Proves: the agent gets its playbook as instructions, sees only its role's tools, is refused
 * the others by the server, and its drafts carry its name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { COOKIE_NAME } from '../src/auth.ts';
import { makeEnv, uiHeaders, type TestEnv } from './helpers.ts';

const ROOT = path.resolve(__dirname, '../../..');
let env: TestEnv;
let cookie: string;
let launches: Array<{ run?: { configPath: string; runId: string } }>;
const children: ChildProcessWithoutNullStreams[] = [];

const ui = async (method: string, url: string, payload?: unknown) => {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};

interface Agent {
  rpc: (method: string, params?: unknown) => Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }>;
  tool: (name: string, args: unknown) => Promise<{ isError: boolean; text: string }>;
}
/** Starts the MCP bundle with the environment of the per-run config the launch wrote, in an empty data dir (no shared token). */
async function startAgent(playbookId: string, projectId: string): Promise<Agent> {
  const r = await ui('POST', `/api/projects/${projectId}/launch-claude`, { confirm: true, playbookId });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const cfg = JSON.parse(fs.readFileSync(launches[launches.length - 1]!.run!.configPath, 'utf8')) as { mcpServers: { 'qa-office': { env: Record<string, string> } } };
  const emptyDir = fs.mkdtempSync(path.join(env.root, 'nodata-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'apps/mcp/dist/qa-office-mcp.mjs')], {
    env: { ...process.env, QAVO_DATA_DIR: emptyDir, ...cfg.mcpServers['qa-office'].env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let buf = '';
  const waiters: Array<(m: Record<string, unknown>) => void> = [];
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      waiters.shift()?.(JSON.parse(line) as Record<string, unknown>);
    }
  });
  let id = 1;
  const rpc: Agent['rpc'] = (method, params) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no reply to ${method}`)), 15_000);
      waiters.push((m) => (clearTimeout(t), resolve(m as never)));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) + '\n');
    });
  const tool: Agent['tool'] = async (name, args) => {
    const res = (await rpc('tools/call', { name, arguments: args })).result as { isError: boolean; content: Array<{ text: string }> };
    return { isError: res.isError, text: res.content[0]!.text };
  };
  return { rpc, tool };
}

let pid: string;
beforeAll(async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'apps/mcp/build.mjs')], { stdio: 'ignore' });
  launches = [];
  env = await makeEnv({ listen: true, auth: true, launchClaude: (_cwd, run) => launches.push({ run }) });
  cookie = `${COOKIE_NAME}=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'Shop');
  fs.mkdirSync(dir);
  pid = (await ui('POST', '/api/projects', { alias: 'Demo Shop', path: dir })).body.project.id;
  await ui('PUT', '/api/settings/agent', { enabled: true, confirm: true });
  await ui('PATCH', '/api/playbooks/case_writer', { houseRules: 'Always include a negative case.' });
});
afterAll(async () => {
  for (const c of children) c.kill();
  await env.cleanup();
});

describe('a launched playbook over stdio', () => {
  it('Quinn gets her playbook as instructions, writes a draft under her name, and is refused tools outside her role', async () => {
    const quinn = await startAgent('case_writer', pid);
    const init = await quinn.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const text = String((init.result as { instructions: string }).instructions);
    expect(text).toContain('You are Quinn, the Test Case Writer');
    expect(text).toContain('Always include a negative case.');
    expect(text).toContain('Demo Shop');
    const names = ((await quinn.rpc('tools/list')).result!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('qa_create_test_case_draft');
    expect(names).not.toContain('qa_report_defect');
    expect(names).not.toContain('qa_create_task');

    const draft = await quinn.tool('qa_create_test_case_draft', { project: 'Demo Shop', title: 'Register', steps: ['Open', 'Submit'], expectedResult: 'Account created' });
    expect(draft.isError).toBe(false);
    const stored = (await ui('GET', `/api/projects/${pid}/test-cases`)).body[0];
    expect(stored).toMatchObject({ status: 'draft', authoredBy: 'agent', draftedBy: 'Quinn' });

    const refused = await quinn.tool('qa_report_defect', { project: 'Demo Shop', title: 'x' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('tool_not_allowed');
    const other = await quinn.tool('qa_list_requirements', { project: 'Some Other Project' });
    expect(other.isError).toBe(true);
  });

  it('Rhea sees no way to write, and cannot read as someone else', async () => {
    const rhea = await startAgent('case_reviewer', pid);
    const init = await rhea.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(String((init.result as { instructions: string }).instructions)).toContain('You are Rhea, the Test Case Reviewer');
    const names = ((await rhea.rpc('tools/list')).result!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('qa_get_test_case');
    expect(names.filter((n) => /create|update|report|move|set_execution/.test(n))).toEqual([]);
    const r = await rhea.tool('qa_create_test_case_draft', { project: 'Demo Shop', title: 'Nope', steps: ['a'], expectedResult: 'b' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('tool_not_allowed');
    expect((await ui('GET', `/api/projects/${pid}/test-cases`)).body).toHaveLength(1); // only Quinn's draft exists
  });

  it('Rhea reviews Quinn’s draft over stdio; Quinn cannot review, and the review changes no status', async () => {
    const rhea = await startAgent('case_reviewer', pid);
    await rhea.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const mine = JSON.parse((await rhea.tool('qa_list_my_reviewable', { project: 'Demo Shop' })).text) as { items: Array<{ code: string; draftedBy: string }> };
    expect(mine.items).toEqual([expect.objectContaining({ code: 'TC-0001', draftedBy: 'Quinn' })]);
    const done = await rhea.tool('qa_review_test_case', { project: 'Demo Shop', code: 'TC-0001', verdict: 'changes_requested', notes: 'Add a negative case.' });
    expect(done.isError).toBe(false);
    expect(JSON.parse(done.text)).toMatchObject({ verdict: 'changes_requested', reviewer: 'Rhea', status: 'draft' });
    const tc = (await ui('GET', `/api/projects/${pid}/test-cases`)).body[0];
    expect(tc).toMatchObject({ status: 'draft', approvedBy: null, review: { by: 'Rhea', verdict: 'changes_requested', current: true } });

    const quinn = await startAgent('case_writer', pid);
    await quinn.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const names = ((await quinn.rpc('tools/list')).result!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain('qa_review_test_case');
    const seen = JSON.parse((await quinn.tool('qa_get_test_case', { project: 'Demo Shop', code: 'TC-0001' })).text) as { review: { notes: string } };
    expect(seen.review.notes).toBe('Add a negative case.'); // the writer reads what to fix
    const own = await quinn.tool('qa_review_test_case', { project: 'Demo Shop', code: 'TC-0001', verdict: 'recommend_approve' });
    expect(own.isError).toBe(true);
    expect(own.text).toContain('tool_not_allowed');
  });

  it('once the person stops the run, the next call fails and nothing else changes', async () => {
    const quinn = await startAgent('case_writer', pid);
    expect((await quinn.tool('qa_list_projects', {})).isError).toBe(false);
    const run = launches[launches.length - 1]!.run!;
    await ui('POST', `/api/runs/${run.runId}/revoke`);
    const after = await quinn.tool('qa_create_test_case_draft', { project: 'Demo Shop', title: 'Late', steps: ['a'], expectedResult: 'b' });
    expect(after.isError).toBe(true);
    expect((await ui('GET', `/api/projects/${pid}/test-cases`)).body).toHaveLength(1);
  });
});
