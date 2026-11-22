import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { COOKIE_NAME } from '../src/auth.ts';
import { readAgentToken } from '../src/dataDir.ts';
import { makeEnv, uiHeaders, type TestEnv } from './helpers.ts';

let env: TestEnv;
let cookie: string;
let pid: string;
let launched: string[];

beforeEach(async () => {
  launched = [];
  env = await makeEnv({ listen: true, auth: true, launchClaude: (cwd) => launched.push(cwd) });
  cookie = `${COOKIE_NAME}=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'Shop');
  fs.mkdirSync(dir);
  pid = (await ui('POST', '/api/projects', { alias: 'Demo Shop', path: dir })).body.project.id;
});
afterEach(async () => env.cleanup());

async function ui(method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie, ...extra }, payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}
const agentHeaders = (token = readAgentToken(env.paths)) => ({ host: env.host, 'x-qavo-agent-token': token, 'content-type': 'application/json' });
async function agent(name: string, args: unknown, token?: string) {
  const r = await env.app.inject({ method: 'POST', url: `/api/agent/tools/${name}`, headers: agentHeaders(token), payload: args as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}
const enable = () => ui('PUT', '/api/settings/agent', { enabled: true, confirm: true });
const ok = async (name: string, args: unknown) => {
  const r = await agent(name, args);
  expect(r.status, `${name}: ${JSON.stringify(r.body)}`).toBe(200);
  return r.body.result;
};
const P = { project: 'Demo Shop' };
async function approvedCase(title = 'Sign in') {
  const t = (await ui('POST', `/api/projects/${pid}/test-cases`, { title, steps: ['Open'], expectedResult: 'Works' })).body;
  await ui('POST', `/api/test-cases/${t.id}/transition`, { to: 'in_review' });
  await ui('POST', `/api/test-cases/${t.id}/transition`, { to: 'approved', note: 'ok' });
  return t;
}

describe('agent access control', () => {
  it('is OFF by default: tools and calls are refused and the refusal is audited', async () => {
    const list = await env.app.inject({ method: 'GET', url: '/api/agent/tools', headers: agentHeaders() });
    expect(list.statusCode).toBe(403);
    expect(list.json().error).toBe('agent_access_disabled');
    const call = await agent('qa_list_projects', {});
    expect(call.status).toBe(403);
    const audit = (await ui('GET', '/api/settings/agent')).body.activity;
    expect(audit[0]).toMatchObject({ tool: 'qa_list_projects', outcome: 'denied', code: 'agent_access_disabled' });
  });

  it('turning it on needs the person (cookie + CSRF header) and an explicit confirmation', async () => {
    expect((await ui('PUT', '/api/settings/agent', { enabled: true })).body.error).toBe('confirm_required');
    const noCsrf = await env.app.inject({ method: 'PUT', url: '/api/settings/agent', headers: { host: env.host, origin: env.origin, cookie }, payload: { enabled: true, confirm: true } });
    expect(noCsrf.statusCode).toBe(403);
    const noCookie = await env.app.inject({ method: 'PUT', url: '/api/settings/agent', headers: { ...uiHeaders(env) }, payload: { enabled: true, confirm: true } });
    expect(noCookie.statusCode).toBe(401);
    // the agent token cannot turn itself on
    const viaAgent = await env.app.inject({ method: 'PUT', url: '/api/settings/agent', headers: { ...agentHeaders(), origin: env.origin, 'x-qavo-client': '1' }, payload: { enabled: true, confirm: true } });
    expect(viaAgent.statusCode).toBe(401);
    expect((await ui('GET', '/api/settings/agent')).body.enabled).toBe(false);
    expect((await enable()).body.enabled).toBe(true);
  });

  it('needs the agent token: missing/wrong/hook token and browser requests (Origin) are refused', async () => {
    await enable();
    expect((await agent('qa_list_projects', {}, 'x'.repeat(64))).status).toBe(401);
    const none = await env.app.inject({ method: 'GET', url: '/api/agent/tools', headers: { host: env.host } });
    expect(none.statusCode).toBe(401);
    const hookToken = await env.app.inject({ method: 'GET', url: '/api/agent/tools', headers: { host: env.host, 'x-qavo-agent-token': env.token } });
    expect(hookToken.statusCode).toBe(401);
    const browser = await env.app.inject({ method: 'GET', url: '/api/agent/tools', headers: { ...agentHeaders(), origin: 'https://evil.example' } });
    expect(browser.statusCode).toBe(403);
    const badHost = await env.app.inject({ method: 'GET', url: '/api/agent/tools', headers: { ...agentHeaders(), host: 'evil.example' } });
    expect(badHost.statusCode).toBe(403);
  });

  it('the agent token opens NOTHING else: no UI API, no hook route', async () => {
    await enable();
    for (const url of ['/api/projects', '/api/sessions', '/api/qa/summary', `/api/projects/${pid}/requirements`]) {
      const r = await env.app.inject({ method: 'GET', url, headers: { host: env.host, 'x-qavo-agent-token': readAgentToken(env.paths) } });
      expect(r.statusCode, url).toBe(401);
    }
    const hooks = await env.app.inject({ method: 'POST', url: '/api/hooks', headers: { host: env.host, 'x-qavo-agent-token': readAgentToken(env.paths), 'content-type': 'application/json' }, payload: {} });
    expect(hooks.statusCode).toBe(401);
  });

  it('revoking the token takes effect immediately', async () => {
    await enable();
    const old = readAgentToken(env.paths);
    expect((await agent('qa_list_projects', {}, old)).status).toBe(200);
    expect((await ui('POST', '/api/settings/agent/rotate-token')).status).toBe(200);
    expect((await agent('qa_list_projects', {}, old)).status).toBe(401);
    expect((await agent('qa_list_projects', {})).status).toBe(200);
    expect(readAgentToken(env.paths)).toMatch(/^[a-f0-9]{64}$/);
    expect(readAgentToken(env.paths)).not.toBe(old);
  });

  it('the agent token file is separate from the hook token', () => {
    expect(readAgentToken(env.paths)).not.toBe(env.token);
    expect(readAgentToken(env.paths)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('the tool surface cannot approve, pass, close, complete, delete or archive', () => {
  it('lists only qa_* tools, none of them named for a human-only decision', async () => {
    await enable();
    const r = await env.app.inject({ method: 'GET', url: '/api/agent/tools', headers: agentHeaders() });
    const tools = r.json().tools as Array<{ name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }>;
    expect(tools.length).toBeGreaterThanOrEqual(15);
    for (const t of tools) {
      expect(t.name).toMatch(/^qa_[a-z_]+$/);
      expect(t.name, t.name).not.toMatch(/approve|reject|close|complete|delete|remove|archive|resolve|dismiss|submit|transition|launch|install/);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.qa_set_execution_result!.inputSchema.properties.status!.enum).toEqual(['in_progress', 'failed', 'blocked']);
    expect(byName.qa_move_task!.inputSchema.properties.to!.enum).not.toContain('completed');
  });

  it('unknown tools do not exist, even ones a person can do', async () => {
    await enable();
    for (const name of ['qa_approve_test_case', 'qa_close_defect', 'qa_complete_task', 'qa_delete_requirement', 'qa_mark_passed', 'ui_anything']) {
      expect((await agent(name, {})).status, name).toBe(404);
    }
  });

  it('schema refuses forbidden values: passed, skipped, completed, unknown fields', async () => {
    await enable();
    const tc = await approvedCase();
    const run = (await ui('POST', `/api/projects/${pid}/test-runs`, { name: 'R', addAllApproved: true })).body;
    const base = { ...P, runCode: run.code, testCaseCode: tc.code };
    for (const status of ['passed', 'skipped']) expect((await agent('qa_set_execution_result', { ...base, status, note: 'trust me' })).status, status).toBe(400);
    const task = await ok('qa_create_task', { ...P, title: 'T' });
    expect((await agent('qa_move_task', { ...P, code: task.code, to: 'completed', note: 'done' })).status).toBe(400);
    expect((await agent('qa_create_task', { ...P, title: 'T', assignee: 'me' })).status).toBe(400);
    expect((await agent('qa_create_test_case_draft', { ...P, title: 'x', steps: ['a'], expectedResult: 'b', status: 'approved' })).status).toBe(400);
    expect((await agent('qa_report_defect', { ...P, title: 'x', status: 'closed' })).status).toBe(400);
    expect((await ui('GET', `/api/test-runs/${run.id}`)).body.executions[0].status).toBe('not_run');
  });
});

describe('what an agent can do', () => {
  beforeEach(async () => {
    await enable();
  });

  it('lists projects by safe name only (no paths or ids), case-insensitively; archived ones are hidden', async () => {
    const r = await ok('qa_list_projects', {});
    expect(r.projects).toEqual([{ alias: 'Demo Shop', description: '', type: 'general' }]);
    expect(JSON.stringify(r)).not.toContain(env.root);
    expect((await ok('qa_get_summary', { project: 'demo shop' })).requirements).toBe(0);
    expect((await agent('qa_get_summary', { project: 'Nope' })).status).toBe(404);
    await ui('PATCH', `/api/projects/${pid}`, { archived: true });
    expect((await agent('qa_get_summary', P)).status).toBe(404);
    expect((await ok('qa_list_projects', {})).projects).toEqual([]);
  });

  it('proposes a requirement and flags one; both are marked as agent work', async () => {
    const r = await ok('qa_create_requirement', { ...P, ref: 'REQ-1', title: 'Lockout', text: 'Lock after 5 failures', kind: 'fsd' });
    expect(r).toMatchObject({ ref: 'REQ-1', authoredBy: 'agent' });
    expect((await ok('qa_flag_requirement', { ...P, ref: 'req-1', type: 'ambiguity', note: 'Which 5 minutes?' })).status).toBe('open');
    expect((await ok('qa_list_requirements', P)).items[0]).toMatchObject({ ref: 'REQ-1', openFlags: 1 });
    // a person still decides: the agent cannot resolve the flag (no tool), and the service refuses the actor anyway
    const flags = (await ui('GET', `/api/requirements/${(await ui('GET', `/api/projects/${pid}/requirements`)).body[0].id}`)).body.flags;
    expect(flags[0].raisedBy).toBe('agent');
  });

  it('creates DRAFT test cases linked to requirements by reference, and edits only its own draft', async () => {
    await ok('qa_create_requirement', { ...P, ref: 'FR-01', title: 'Register' });
    const d = await ok('qa_create_test_case_draft', { ...P, title: 'Register with valid details', steps: ['Open', 'Submit'], expectedResult: 'Account created', requirementRefs: ['FR-01'], testType: 'positive' });
    expect(d).toMatchObject({ status: 'draft', authoredBy: 'agent' });
    const full = await ok('qa_get_test_case', { ...P, code: d.code });
    expect(full.requirements).toEqual(['FR-01']);
    await ok('qa_update_test_case_draft', { ...P, code: d.code, title: 'Register (edited)' });
    expect((await ok('qa_get_test_case', { ...P, code: d.code })).title).toBe('Register (edited)');
    // a person's test case is off limits for edits
    const mine = (await ui('POST', `/api/projects/${pid}/test-cases`, { title: 'Human case', steps: ['a'], expectedResult: 'b' })).body;
    const denied = await agent('qa_update_test_case_draft', { ...P, code: mine.code, title: 'hijack' });
    expect(denied.status).toBe(403);
    expect((await agent('qa_create_test_case_draft', { ...P, title: 'x', steps: ['a'], expectedResult: 'b', requirementRefs: ['NOPE-9'] })).status).toBe(404);
    // once a person submits it for review the agent can no longer touch it
    const agentCase = (await ui('GET', `/api/projects/${pid}/test-cases`)).body.find((t: { code: string }) => t.code === d.code);
    await ui('POST', `/api/test-cases/${agentCase.id}/transition`, { to: 'in_review' });
    expect((await agent('qa_update_test_case_draft', { ...P, code: d.code, title: 'late' })).status).toBe(403);
  });

  it('reports defects (status NEW, agent-reported), comments, but cannot change a status', async () => {
    const tc = await approvedCase();
    const d = await ok('qa_report_defect', { ...P, title: 'Total shows NaN', severity: 'major', testCaseCode: tc.code });
    expect(d).toMatchObject({ code: 'DEF-001', status: 'new', reportedBy: 'agent' });
    await ok('qa_comment_defect', { ...P, code: d.code, note: 'Also on mobile' });
    const detail = (await ui('GET', `/api/projects/${pid}/defects`)).body[0];
    const hist = (await ui('GET', `/api/defects/${detail.id}`)).body.history.map((h: { action: string; actor: string }) => `${h.action}:${h.actor}`);
    expect(hist).toEqual(['created:agent', 'comment:agent']);
    expect((await ok('qa_list_defects', { ...P, openOnly: true })).items).toHaveLength(1);
  });

  it('starts and fails a test (agent assisted) and attaches an evidence note; a pass stays impossible', async () => {
    const tc = await approvedCase();
    const run = (await ui('POST', `/api/projects/${pid}/test-runs`, { name: 'R', addAllApproved: true })).body;
    const a = { ...P, runCode: run.code, testCaseCode: tc.code };
    expect((await ok('qa_set_execution_result', { ...a, status: 'in_progress' })).executorKind).toBe('agent_assisted');
    expect((await agent('qa_set_execution_result', { ...a, status: 'failed' })).body.error).toBe('note_required');
    const failed = await ok('qa_set_execution_result', { ...a, status: 'failed', note: 'Error banner shown', actualResult: 'Banner' });
    expect(failed.status).toBe('failed');
    await ok('qa_add_evidence_note', { ...a, label: 'Observed', body: 'Saw jane.doe@example.com in the banner' });
    const exec = (await ui('GET', `/api/test-runs/${run.id}`)).body.executions[0];
    const detail = (await ui('GET', `/api/executions/${exec.id}`)).body;
    expect(detail).toMatchObject({ status: 'failed', executedBy: 'agent' });
    expect(detail.evidence[0].body).not.toContain('jane.doe@example.com'); // redacted on write
    expect((await agent('qa_set_execution_result', { ...a, runCode: 'RUN-999', status: 'in_progress' })).status).toBe(404);
  });

  it('adds notes to a RUNNING exploratory session only', async () => {
    const s = (await ui('POST', `/api/projects/${pid}/exploratory`, { charter: 'Explore checkout' })).body;
    expect((await agent('qa_add_exploratory_note', { ...P, sessionCode: s.code, text: 'early' })).status).toBe(409);
    await ui('POST', `/api/exploratory/${s.id}/start`);
    await ok('qa_add_exploratory_note', { ...P, sessionCode: s.code, kind: 'bug', text: 'NaN total' });
    expect((await ui('GET', `/api/exploratory/${s.id}`)).body.notes[0]).toMatchObject({ kind: 'bug', createdBy: 'agent' });
  });

  it('creates and moves tasks but nothing is assigned automatically', async () => {
    const t = await ok('qa_create_task', { ...P, title: 'Write negative tests', kind: 'test_design', priority: 'high' });
    expect(t).toMatchObject({ code: 'TSK-001', stage: 'backlog' });
    expect((await ok('qa_move_task', { ...P, code: t.code, to: 'ready' })).stage).toBe('ready');
    expect((await agent('qa_move_task', { ...P, code: t.code, to: 'blocked' })).body.error).toBe('note_required');
    const task = (await ui('GET', `/api/projects/${pid}/tasks`)).body[0];
    expect(task).toMatchObject({ assignee: '', createdBy: 'agent' });
  });
});

describe('what an agent reads is redacted, and the audit never holds content', () => {
  beforeEach(async () => {
    await enable();
  });

  it('personal data and secrets typed by a person never reach the agent', async () => {
    const t = (
      await ui('POST', `/api/projects/${pid}/test-cases`, {
        title: 'Contact jane.doe@example.com',
        steps: ['Call +1 415 555 0100', 'Use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'],
        expectedResult: 'ok',
        description: 'Card 4242 4242 4242 4242',
      })
    ).body;
    const full = await ok('qa_get_test_case', { ...P, code: t.code });
    const text = JSON.stringify(full);
    expect(text).not.toContain('jane.doe@example.com');
    expect(text).not.toContain('sk-ant-');
    expect(text).not.toContain('4242 4242 4242 4242');
    expect(text).not.toContain('555 0100');
    expect((await ok('qa_list_test_cases', { ...P })).items[0].title).not.toContain('jane.doe');
  });

  it('every call is audited by tool, project and outcome only; contents are never stored', async () => {
    await ok('qa_create_requirement', { ...P, ref: 'REQ-1', title: 'SECRET-TITLE-123' });
    await agent('qa_get_summary', { project: 'Missing Project' });
    await agent('qa_create_task', { ...P, title: 'SECRET-TASK-456', assignee: 'x' });
    const activity = (await ui('GET', '/api/settings/agent')).body.activity as Array<{ tool: string; outcome: string; project: string | null }>;
    expect(activity.map((a) => `${a.tool}:${a.outcome}`)).toEqual(['qa_create_task:error', 'qa_get_summary:error', 'qa_create_requirement:ok']);
    const raw = JSON.stringify(env.db.prepare('SELECT * FROM agent_audit').all());
    expect(raw).not.toContain('SECRET-TITLE-123');
    expect(raw).not.toContain('SECRET-TASK-456');
    expect(() => env.db.prepare("UPDATE agent_audit SET tool = 'x'").run()).toThrow(/append-only/);
  });
});

describe('setup helper and "Launch Claude Code here"', () => {
  it('the setup command is a sensitive GET (CSRF header) and never contains a token', async () => {
    const noHeader = await env.app.inject({ method: 'GET', url: '/api/settings/agent/setup', headers: { host: env.host, origin: env.origin, cookie } });
    expect(noHeader.statusCode).toBe(403);
    const r = (await ui('GET', '/api/settings/agent/setup')).body;
    expect(r.command).toContain('claude mcp add --scope user qa-office');
    expect(r.command).toContain('qa-office-mcp.mjs');
    expect(JSON.stringify(r)).not.toContain(readAgentToken(env.paths));
    expect(JSON.stringify(r)).not.toContain(env.token);
    expect(JSON.stringify((await ui('GET', '/api/settings/agent')).body)).not.toContain(env.root);
  });

  it('launching needs a confirmation, a live registered folder, and refuses names a terminal could misread', async () => {
    expect((await ui('POST', `/api/projects/${pid}/launch-claude`, {})).body.error).toBe('confirm_required');
    expect(launched).toEqual([]);
    const ok1 = await ui('POST', `/api/projects/${pid}/launch-claude`, { confirm: true });
    expect(ok1.body).toEqual({ launched: true });
    expect(launched).toHaveLength(1);
    expect(launched[0]!.toLowerCase()).toContain('shop');
    expect((await ui('POST', '/api/projects/nope/launch-claude', { confirm: true })).status).toBe(404);
    const weird = path.join(env.root, 'a&b');
    fs.mkdirSync(weird);
    const w = (await ui('POST', '/api/projects', { alias: 'Weird', path: weird })).body.project.id;
    const r = await ui('POST', `/api/projects/${w}/launch-claude`, { confirm: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('path_not_launchable');
    fs.rmSync(path.join(env.root, 'Shop'), { recursive: true, force: true });
    expect((await ui('POST', `/api/projects/${pid}/launch-claude`, { confirm: true })).body.error).toBe('path_missing');
    expect(launched).toHaveLength(1);
  });

  it('the agent token cannot launch anything', async () => {
    const r = await env.app.inject({ method: 'POST', url: `/api/projects/${pid}/launch-claude`, headers: { host: env.host, 'x-qavo-agent-token': readAgentToken(env.paths), 'content-type': 'application/json' }, payload: { confirm: true } });
    expect(r.statusCode).toBe(401);
    expect(launched).toEqual([]);
  });
});
