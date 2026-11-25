import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { COOKIE_NAME } from '../src/auth.ts';
import { readAgentToken } from '../src/dataDir.ts';
import { ingest } from '../src/collector.ts';
import { createRun, resolveRunToken } from '../src/runs.ts';
import { hookHeaders, makeEnv, uiHeaders, type TestEnv } from './helpers.ts';

let env: TestEnv;
let cookie: string;
let pid: string;
let otherPid: string;
let launches: Array<{ cwd: string; run?: { configPath: string; runId: string } }>;

beforeEach(async () => {
  launches = [];
  env = await makeEnv({ listen: true, auth: true, launchClaude: (cwd, run) => launches.push({ cwd, run }) });
  cookie = `${COOKIE_NAME}=${env.auth.issueSession()}`;
  const mk = async (alias: string) => {
    const dir = path.join(env.root, alias.replace(/\s/g, ''));
    fs.mkdirSync(dir);
    return (await ui('POST', '/api/projects', { alias, path: dir })).body.project.id as string;
  };
  pid = await mk('Demo Shop');
  otherPid = await mk('Other Shop');
  await ui('PUT', '/api/settings/agent', { enabled: true, confirm: true });
});
afterEach(async () => env.cleanup());

async function ui(method: string, url: string, payload?: unknown) {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}
async function call(headers: Record<string, string>, method: string, url: string, payload?: unknown) {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { host: env.host, 'content-type': 'application/json', ...headers }, payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}
const asRun = (token: string) => ({ 'x-qavo-run-token': token });
const asShared = () => ({ 'x-qavo-agent-token': readAgentToken(env.paths) });
const tool = (h: Record<string, string>, name: string, args: unknown) => call(h, 'POST', `/api/agent/tools/${name}`, args);

/** Launches a playbook for a project as the person and returns the credential the launcher wrote to the run's config. */
async function launch(playbookId: string, projectId = pid) {
  const r = await ui('POST', `/api/projects/${projectId}/launch-claude`, { confirm: true, playbookId });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const run = launches[launches.length - 1]!.run!;
  const cfg = JSON.parse(fs.readFileSync(run.configPath, 'utf8')) as { mcpServers: { 'qa-office': { command: string; args: string[]; env: Record<string, string> } } };
  return { runId: run.runId, token: cfg.mcpServers['qa-office'].env.QAVO_RUN_TOKEN!, cfg, configPath: run.configPath, body: r.body };
}
const draft = (extra: object = {}) => ({ project: 'Demo Shop', title: 'Sign in', steps: ['Open the site', 'Sign in'], expectedResult: 'Home is shown', ...extra });

describe('launching a playbook', () => {
  it('mints a run bound to the playbook and project, writes a private config, and starts Claude with fixed arguments', async () => {
    const l = await launch('case_writer');
    expect(launches[0]!.cwd).toContain('DemoShop');
    expect(l.cfg.mcpServers['qa-office'].args[0]).toBe(env.paths.mcpScript);
    expect(l.token.length).toBeGreaterThan(30);
    expect(l.runId).toMatch(/^run_[a-f0-9]{16}$/);
    expect(l.body.run).toMatchObject({ agentName: 'Quinn', role: 'Test Case Writer', project: 'Demo Shop', status: 'active' });
    // only a hash is stored, never the credential, and the credential never appears in the API
    const stored = env.db.prepare('SELECT token_hash FROM playbook_runs WHERE id = ?').get(l.runId) as { token_hash: string };
    expect(stored.token_hash).toBe(crypto.createHash('sha256').update(l.token).digest('hex'));
    expect(JSON.stringify((await ui('GET', '/api/runs')).body)).not.toContain(l.token);
    expect(JSON.stringify(env.db.prepare('SELECT * FROM playbook_runs').all())).not.toContain(l.token);
  });

  it('is refused unless a person asks, agent access is on, the playbook exists and is available', async () => {
    expect((await call(hookHeaders(env), 'POST', `/api/projects/${pid}/launch-claude`, { confirm: true, playbookId: 'case_writer' })).status).toBeGreaterThanOrEqual(400);
    expect((await call(asShared(), 'POST', `/api/projects/${pid}/launch-claude`, { confirm: true, playbookId: 'case_writer' })).status).toBeGreaterThanOrEqual(400);
    expect((await ui('POST', `/api/projects/${pid}/launch-claude`, { playbookId: 'case_writer' })).body.error).toBe('confirm_required');
    expect((await ui('POST', `/api/projects/${pid}/launch-claude`, { confirm: true, playbookId: 'nope' })).body.error).toBe('playbook_not_found');
    expect((await ui('POST', `/api/projects/${pid}/launch-claude`, { confirm: true, playbookId: 'api_writer' })).body.error).toBe('playbook_unavailable');
    expect((await ui('POST', `/api/projects/${pid}/launch-claude`, { confirm: true, playbookId: 7 })).body.error).toBe('invalid_input');
    await ui('PUT', '/api/settings/agent', { enabled: false });
    expect((await ui('POST', `/api/projects/${pid}/launch-claude`, { confirm: true, playbookId: 'case_writer' })).body.error).toBe('agent_access_disabled');
    expect(launches).toHaveLength(0);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM playbook_runs').get()).toEqual({ n: 0 });
  });

  it('a plain launch (no playbook) still starts an ordinary session with no run', async () => {
    expect((await ui('POST', `/api/projects/${pid}/launch-claude`, { confirm: true })).status).toBe(200);
    expect(launches[0]!.run).toBeUndefined();
  });
});

describe('what a named agent can do, enforced by the server', () => {
  it('sees only its own role’s tools', async () => {
    const quinn = await launch('case_writer');
    const rhea = await launch('case_reviewer');
    const names = async (token: string) => ((await call(asRun(token), 'GET', '/api/agent/tools')).body.tools as Array<{ name: string }>).map((t) => t.name);
    expect(await names(quinn.token)).toContain('qa_create_test_case_draft');
    expect(await names(rhea.token)).not.toContain('qa_create_test_case_draft');
    expect(await names(rhea.token)).not.toContain('qa_create_task');
    expect((await names(quinn.token)).length).toBeLessThan((await call(asShared(), 'GET', '/api/agent/tools')).body.tools.length); // the shared token still sees all
  });

  it('refuses a tool outside the role (and says so in the audit, never the content)', async () => {
    const rhea = await launch('case_reviewer');
    const r = await tool(asRun(rhea.token), 'qa_create_test_case_draft', draft());
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('tool_not_allowed');
    expect((await tool(asRun((await launch('qa_lead')).token), 'qa_create_test_case_draft', draft())).body.error).toBe('tool_not_allowed');
    expect((await tool(asRun((await launch('analyst')).token), 'qa_report_defect', { project: 'Demo Shop', title: 'x' })).body.error).toBe('tool_not_allowed');
    const audit = (await ui('GET', '/api/settings/agent')).body.activity as Array<{ tool: string; outcome: string; code: string; agent: string | null }>;
    expect(audit[0]).toMatchObject({ tool: 'qa_report_defect', outcome: 'denied', code: 'tool_not_allowed', agent: 'Ada (Requirements Analyst)' });
    expect(JSON.stringify(audit)).not.toContain('Sign in');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM test_cases').get()).toEqual({ n: 0 });
  });

  it('is locked to the project it was launched for', async () => {
    const quinn = await launch('case_writer');
    const r = await tool(asRun(quinn.token), 'qa_list_requirements', { project: 'Other Shop' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('wrong_project');
    expect((await tool(asRun(quinn.token), 'qa_create_test_case_draft', draft({ project: 'Other Shop' }))).body.error).toBe('wrong_project');
    expect((await tool(asRun(quinn.token), 'qa_list_projects', {})).body.result.projects).toEqual([expect.objectContaining({ alias: 'Demo Shop' })]);
    expect((await tool(asShared(), 'qa_list_projects', {})).body.result.projects).toHaveLength(2);
  });

  it('records who drafted a case; the shared token stays unattributed; a named agent edits only its own drafts', async () => {
    const quinn = await launch('case_writer');
    await tool(asRun(quinn.token), 'qa_create_test_case_draft', draft());
    await tool(asShared(), 'qa_create_test_case_draft', draft({ title: 'Shared draft' }));
    const list = (await ui('GET', `/api/projects/${pid}/test-cases`)).body as Array<{ title: string; draftedBy: string; authoredBy: string; status: string }>;
    expect(list.find((t) => t.title === 'Sign in')).toMatchObject({ draftedBy: 'Quinn', authoredBy: 'agent', status: 'draft' });
    expect(list.find((t) => t.title === 'Shared draft')).toMatchObject({ draftedBy: '', authoredBy: 'agent' });
    expect((await tool(asRun(quinn.token), 'qa_update_test_case_draft', { project: 'Demo Shop', code: 'TC-0001', title: 'Sign in again' })).status).toBe(200);
    const notMine = await tool(asRun(quinn.token), 'qa_update_test_case_draft', { project: 'Demo Shop', code: 'TC-0002', title: 'Hijack' });
    expect(notMine.body.error).toBe('not_your_draft');
    // a rename later does not rewrite who drafted the case
    await ui('PATCH', '/api/playbooks/case_writer', { agentName: 'Nova' });
    expect(((await ui('GET', `/api/projects/${pid}/test-cases`)).body as Array<{ draftedBy: string }>)[0]!.draftedBy).toBe('Quinn');
  });

  it('still cannot approve anything: no role has such a tool, and the server refuses the agent actor anyway', async () => {
    const quinn = await launch('case_writer');
    expect((await tool(asRun(quinn.token), 'qa_approve_test_case', { project: 'Demo Shop', code: 'TC-0001' })).body.error).toMatch(/unknown_tool|tool_not_allowed/);
    await tool(asRun(quinn.token), 'qa_create_test_case_draft', draft());
    const t = (await ui('GET', `/api/projects/${pid}/test-cases`)).body[0];
    expect(t.status).toBe('draft');
    expect(t.approvedBy).toBeNull();
  });

  it('whoami gives a launched agent its playbook, with house rules labelled as the person’s; the shared token gets nothing', async () => {
    await ui('PATCH', '/api/playbooks/case_writer', { houseRules: 'Always include a negative case.' });
    const quinn = await launch('case_writer');
    const w = (await call(asRun(quinn.token), 'GET', '/api/agent/whoami')).body;
    expect(w).toMatchObject({ attributed: true, agentName: 'Quinn', role: 'Test Case Writer', project: 'Demo Shop' });
    expect(w.instructions).toContain('qa_create_test_case_draft');
    expect(w.instructions).toMatch(/Extra rules from the person.*\n.*Always include a negative case\./);
    expect(w.instructions).toMatch(/never approve or reject/);
    expect(w.instructions).not.toContain(env.root); // no folder paths
    expect((await call(asShared(), 'GET', '/api/agent/whoami')).body).toEqual({ attributed: false });
  });
});

describe('run credentials: expiry, revocation and misuse', () => {
  it('a revoked, expired, unknown or malformed credential is refused, and never falls back to the shared token', async () => {
    const quinn = await launch('case_writer');
    expect((await tool(asRun(quinn.token), 'qa_list_projects', {})).status).toBe(200);
    expect((await ui('POST', `/api/runs/${quinn.runId}/revoke`)).body.status).toBe('revoked');
    expect(fs.existsSync(quinn.configPath)).toBe(false); // the credential file is removed
    expect((await tool(asRun(quinn.token), 'qa_list_projects', {})).status).toBe(401);
    expect((await tool({ ...asRun(quinn.token), ...asShared() }, 'qa_list_projects', {})).status).toBe(401); // a bad run token plus a good shared token is still refused

    const rhea = await launch('case_reviewer');
    env.db.prepare('UPDATE playbook_runs SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), rhea.runId);
    expect((await tool(asRun(rhea.token), 'qa_list_projects', {})).status).toBe(401);
    for (const bad of ['', 'x', 'a'.repeat(300), 'not-a-real-credential-but-long-enough-0000']) expect((await tool(asRun(bad), 'qa_list_projects', {})).status, bad).toBe(401);
    expect((await call({}, 'GET', '/api/agent/tools')).status).toBe(401);
  });

  it('a run credential cannot reach the person’s API (cookie routes, hook routes) and an agent cannot start or stop runs', async () => {
    const quinn = await launch('case_writer');
    for (const [m, u] of [['GET', '/api/runs'], ['POST', `/api/runs/${quinn.runId}/revoke`], ['PATCH', '/api/playbooks/case_writer'], ['POST', `/api/projects/${pid}/launch-claude`]] as const) {
      const r = await call({ ...asRun(quinn.token), 'x-qavo-client': '1' }, m, u, { agentName: 'Evil', confirm: true, playbookId: 'case_writer' });
      expect(r.status, `${m} ${u}`).toBeGreaterThanOrEqual(400);
    }
    expect((await call({ ...asShared(), 'x-qavo-client': '1' }, 'POST', `/api/runs/${quinn.runId}/revoke`)).status).toBeGreaterThanOrEqual(400);
    expect((await call(hookHeaders(env), 'POST', `/api/runs/${quinn.runId}/revoke`)).status).toBeGreaterThanOrEqual(400);
    expect(((await ui('GET', '/api/runs')).body as Array<{ id: string; status: string }>).find((r) => r.id === quinn.runId)!.status).toBe('active');
    expect(() => createRun(env.db, pid, 'case_writer', 'agent')).toThrow(/Only a person/);
    expect(() => createRun(env.db, pid, 'case_writer', 'system')).toThrow(/Only a person/);
  });

  it('resolves only active runs of real playbooks and lists runs newest first', async () => {
    const a = await launch('case_writer');
    const b = await launch('case_reviewer');
    expect(resolveRunToken(env.db, a.token)?.agentName).toBe('Quinn');
    expect(resolveRunToken(env.db, b.token)?.agentName).toBe('Rhea');
    expect(resolveRunToken(env.db, a.token, Date.now() + 9 * 3_600_000)).toBeNull(); // past 8 hours
    const runs = (await ui('GET', '/api/runs')).body as Array<{ id: string }>;
    expect(runs.map((r) => r.id)).toEqual([b.runId, a.runId]);
  });

  it('removes stale credential files the next time something is launched', async () => {
    const a = await launch('case_writer');
    env.db.prepare('UPDATE playbook_runs SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), a.runId);
    expect(fs.existsSync(a.configPath)).toBe(true);
    await launch('case_reviewer');
    expect(fs.existsSync(a.configPath)).toBe(false);
  });
});

describe('the office link: a launched agent gets its own robot', () => {
  const send = (sessionId: string, event: string, extra: Record<string, unknown> = {}) =>
    ingest(env.db, { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId, event, projectId: pid, folderKeys: [], ...extra }, () => undefined);
  const robotOf = (sessionId: string) => env.db.prepare('SELECT r.* FROM sessions s JOIN robots r ON r.id = s.robot_id WHERE s.session_id = ?').get(sessionId) as { id: string; name: string; robot_type: string; playbook_id: string | null };

  it('names and styles the robot from the agent, reuses it, and keeps it away from ordinary sessions', async () => {
    const quinn = await launch('case_writer');
    send('s-quinn', 'SessionStart', { source: 'startup', runId: quinn.runId });
    expect(robotOf('s-quinn')).toMatchObject({ name: 'Quinn', robot_type: 'manual_tester', playbook_id: 'case_writer' });
    send('s-plain', 'SessionStart', { source: 'startup' });
    expect(robotOf('s-plain').name).toMatch(/^Unit-/);
    expect(robotOf('s-plain').id).not.toBe(robotOf('s-quinn').id);
    send('s-quinn', 'SessionEnd', { reason: 'other', runId: quinn.runId });
    send('s-plain2', 'SessionStart', { source: 'startup' }); // the free robot pool never contains Quinn
    expect(robotOf('s-plain2').name).not.toBe('Quinn');
    const second = await launch('case_writer');
    send('s-quinn-2', 'SessionStart', { source: 'startup', runId: second.runId });
    expect(robotOf('s-quinn-2').id).toBe(robotOf('s-quinn').id); // the same agent, the same robot
    const rhea = await launch('case_reviewer');
    send('s-rhea', 'SessionStart', { source: 'startup', runId: rhea.runId });
    expect(robotOf('s-rhea')).toMatchObject({ name: 'Rhea', robot_type: 'regression_tester' });
  });

  it('follows a rename for later runs', async () => {
    send('s1', 'SessionStart', { source: 'startup', runId: (await launch('case_writer')).runId });
    await ui('PATCH', '/api/playbooks/case_writer', { agentName: 'Nova' });
    send('s2', 'SessionStart', { source: 'startup', runId: (await launch('case_writer')).runId });
    expect(robotOf('s2').name).toBe('Nova');
  });

  it('ignores a run id that is unknown, revoked, expired or for another project', async () => {
    const quinn = await launch('case_writer');
    send('s-unknown', 'SessionStart', { source: 'startup', runId: 'run_0000000000000000' });
    expect(robotOf('s-unknown').name).toMatch(/^Unit-/);
    ingest(env.db, { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId: 's-other', event: 'SessionStart', source: 'startup', projectId: otherPid, folderKeys: [], runId: quinn.runId }, () => undefined);
    expect(robotOf('s-other').name).toMatch(/^Unit-/);
    await ui('POST', `/api/runs/${quinn.runId}/revoke`);
    send('s-revoked', 'SessionStart', { source: 'startup', runId: quinn.runId });
    expect(robotOf('s-revoked').name).toMatch(/^Unit-/);
  });

  it('keeps an agent robot’s name tied to the agent (look stays editable), and marks which robots belong to agents', async () => {
    send('s-quinn', 'SessionStart', { source: 'startup', runId: (await launch('case_writer')).runId });
    send('s-plain', 'SessionStart', { source: 'startup' });
    const robots = (await ui('GET', '/api/robots')).body as Array<{ id: string; name: string; playbookId: string | null }>;
    const quinn = robots.find((r) => r.name === 'Quinn')!;
    const plain = robots.find((r) => r.name.startsWith('Unit-'))!;
    expect(quinn.playbookId).toBe('case_writer');
    expect(plain.playbookId).toBeNull();
    const rename = await ui('PATCH', `/api/robots/${quinn.id}`, { name: 'Impostor' });
    expect(rename.status).toBe(409);
    expect(rename.body.error).toBe('name_follows_agent');
    expect((await ui('PATCH', `/api/robots/${quinn.id}`, { name: 'Quinn', palette: { primary: '#112233', accent: '#445566' } })).status).toBe(200); // same name + new colours is fine
    expect((await ui('PATCH', `/api/robots/${plain.id}`, { name: 'Scout' })).body.name).toBe('Scout'); // ordinary robots stay renamable
  });

  it('rejects a malformed run id at the door', async () => {
    const r = await call(hookHeaders(env), 'POST', '/api/hooks', { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId: 's', event: 'SessionStart', projectId: pid, folderKeys: [], runId: 'nope; DROP' });
    expect(r.status).toBe(400);
  });
});
