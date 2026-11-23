import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { COOKIE_NAME } from '../src/auth.ts';
import { readAgentToken } from '../src/dataDir.ts';
import { ingest } from '../src/collector.ts';
import { retireRobot, RETIRE_QUIET_MS } from '../src/store.ts';
import { hookHeaders, makeEnv, uiHeaders, type TestEnv } from './helpers.ts';

let env: TestEnv;
let cookie: string;
let pid: string;
let launches: Array<{ run?: { configPath: string; runId: string } }>;

beforeEach(async () => {
  launches = [];
  env = await makeEnv({ listen: true, auth: true, launchClaude: (_c, run) => launches.push({ run }) });
  cookie = `${COOKIE_NAME}=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'Shop');
  fs.mkdirSync(dir);
  pid = (await ui('POST', '/api/projects', { alias: 'Demo Shop', path: dir })).body.project.id;
});
afterEach(async () => env.cleanup());

async function ui(method: string, url: string, payload?: unknown) {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}
const send = (sessionId: string, event: string, extra: Record<string, unknown> = {}) =>
  ingest(env.db, { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId, event, projectId: pid, folderKeys: [], ...extra }, () => undefined);
const robots = async () => (await ui('GET', '/api/robots')).body as Array<{ id: string; name: string; playbookId: string | null }>;
const robotOf = (sessionId: string) => (env.db.prepare('SELECT robot_id AS r FROM sessions WHERE session_id = ?').get(sessionId) as { r: string }).r;
const age = (sessionId: string, ms: number) => env.db.prepare('UPDATE sessions SET last_event_at = ? WHERE session_id = ?').run(Date.now() - ms, sessionId);

describe('retiring a robot', () => {
  it('is refused while its session looks alive, then hides the robot without deleting anything', async () => {
    send('s1', 'SessionStart', { source: 'startup' });
    const id = robotOf('s1');
    const early = await ui('POST', `/api/robots/${id}/retire`);
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('robot_recently_active');
    expect((await robots()).map((r) => r.id)).toContain(id);

    age('s1', RETIRE_QUIET_MS + 1000);
    const ok = await ui('POST', `/api/robots/${id}/retire`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toEqual({ id, retired: true });
    expect((await robots()).map((r) => r.id)).not.toContain(id); // hidden from the office and the Team page
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM robots WHERE id = ?').get(id)).toEqual({ n: 1 }); // not deleted
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE robot_id = ?').get(id)).toEqual({ n: 1 }); // history kept
  });

  it('comes back by itself when its session becomes active again, and a retired robot is never reused for a new session', async () => {
    send('old', 'SessionStart', { source: 'startup' });
    send('old', 'SessionEnd', { reason: 'other' });
    const id = robotOf('old');
    age('old', RETIRE_QUIET_MS + 1000);
    await ui('POST', `/api/robots/${id}/retire`);
    send('fresh', 'SessionStart', { source: 'startup' }); // would reuse the free robot if it were not retired
    expect(robotOf('fresh')).not.toBe(id);
    send('old', 'UserPromptSubmit'); // the old session is alive again
    expect((await robots()).map((r) => r.id)).toContain(id);
  });

  it('is only for a person, only for ordinary robots, and unknown ids are 404', async () => {
    send('s1', 'SessionStart', { source: 'startup' });
    const id = robotOf('s1');
    age('s1', RETIRE_QUIET_MS + 1000);
    const as = (headers: Record<string, string>) => env.app.inject({ method: 'POST', url: `/api/robots/${id}/retire`, headers: { 'x-qavo-client': '1', ...headers } });
    expect((await as(hookHeaders(env))).statusCode).toBeGreaterThanOrEqual(400);
    expect((await as({ host: env.host, 'x-qavo-agent-token': readAgentToken(env.paths) })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await as({ host: env.host, origin: env.origin })).statusCode).toBe(401); // no session cookie
    expect((await robots()).map((r) => r.id)).toContain(id);
    expect(() => retireRobot(env.db, id, 'agent')).toThrow(/Only a person/);
    expect(() => retireRobot(env.db, id, 'system')).toThrow(/Only a person/);
    expect((await ui('POST', '/api/robots/bot_missing/retire')).body.error).toBe('robot_not_found');

    // an agent's robot belongs to the agent: it is never retired
    await ui('PUT', '/api/settings/agent', { enabled: true, confirm: true });
    await ui('POST', `/api/projects/${pid}/launch-claude`, { confirm: true, playbookId: 'case_writer' });
    send('s-quinn', 'SessionStart', { source: 'startup', runId: launches[0]!.run!.runId });
    const quinn = (await robots()).find((r) => r.name === 'Quinn')!;
    age('s-quinn', RETIRE_QUIET_MS + 1000);
    expect((await ui('POST', `/api/robots/${quinn.id}/retire`)).body.error).toBe('robot_belongs_to_agent');
  });
});
