import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { COOKIE_NAME } from '../src/auth.ts';
import { makeEnv, uiHeaders, type TestEnv } from './helpers.ts';

let env: TestEnv;
let pid: string;
let cookie: string;

beforeEach(async () => {
  env = await makeEnv({ listen: true, auth: true });
  cookie = `${COOKIE_NAME}=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'QaProject');
  fs.mkdirSync(dir);
  pid = (await call('POST', '/api/projects', { alias: 'QA Project', path: dir })).body.project.id;
});
afterEach(async () => env.cleanup());

async function call(method: string, url: string, payload?: unknown) {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}

describe('2C API: access control', () => {
  it('every route needs the session, and mutations need the CSRF header', async () => {
    for (const [m, u] of [
      ['GET', `/api/projects/${pid}/defects`],
      ['POST', `/api/projects/${pid}/defects`],
      ['POST', '/api/executions/x/defect'],
      ['GET', '/api/defects/x'],
      ['POST', '/api/defects/x/transition'],
      ['GET', `/api/projects/${pid}/exploratory`],
      ['POST', '/api/exploratory/x/start'],
      ['POST', '/api/exploratory-notes/x/defect'],
      ['GET', `/api/projects/${pid}/tasks`],
      ['POST', '/api/tasks/x/move'],
    ] as const) {
      const r = await env.app.inject({ method: m, url: u, headers: { host: env.host, origin: env.origin, 'x-qavo-client': '1' }, payload: m === 'POST' ? {} : undefined });
      expect(r.statusCode, `${m} ${u}`).toBe(401);
    }
    const noCsrf = await env.app.inject({ method: 'POST', url: `/api/projects/${pid}/defects`, headers: { host: env.host, origin: env.origin, cookie }, payload: { title: 'x' } });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe('2C API: defects', () => {
  it('create, list, transition to closed with a note, comment, and the right status codes', async () => {
    const c = await call('POST', `/api/projects/${pid}/defects`, { title: 'Login fails', severity: 'critical' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ code: 'DEF-001', status: 'new', reportedBy: 'human' });
    const id = c.body.id as string;
    expect((await call('POST', `/api/defects/${id}/transition`, { to: 'closed', note: 'x' })).status).toBe(409);
    expect((await call('POST', `/api/defects/${id}/transition`, { to: 'rejected' })).body.error).toBe('note_required');
    for (const to of ['open', 'in_progress', 'fixed', 'retest']) expect((await call('POST', `/api/defects/${id}/transition`, { to, note: 'ok' })).status).toBe(200);
    const closed = await call('POST', `/api/defects/${id}/transition`, { to: 'closed', note: 'Verified' });
    expect(closed.body).toMatchObject({ status: 'closed', closedBy: 'human' });
    expect((await call('POST', `/api/defects/${id}/comments`, { note: 'Thanks' })).status).toBe(200);
    expect((await call('GET', `/api/projects/${pid}/defects?openOnly=true`)).body).toHaveLength(0);
    expect((await call('GET', `/api/projects/${pid}/defects?severity=critical`)).body).toHaveLength(1);
    expect((await call('GET', '/api/defects/nope')).status).toBe(404);
    expect((await call('POST', `/api/projects/${pid}/defects`, { title: '', status: 'closed' })).status).toBe(400);
    expect((await call('GET', '/api/qa/summary')).body.defects).toMatchObject({ total: 1, open: 0 });
  });
  it('raises a defect from a failed execution', async () => {
    const t = (await call('POST', `/api/projects/${pid}/test-cases`, { title: 'Lockout', steps: ['a'], expectedResult: 'Locked' })).body.id;
    await call('POST', `/api/test-cases/${t}/transition`, { to: 'in_review' });
    await call('POST', `/api/test-cases/${t}/transition`, { to: 'approved', note: 'ok' });
    const run = (await call('POST', `/api/projects/${pid}/test-runs`, { name: 'R', addAllApproved: true })).body;
    const execId = (await call('GET', `/api/test-runs/${run.id}`)).body.executions[0].id;
    await call('POST', `/api/executions/${execId}/result`, { status: 'failed', note: 'Not locked' });
    const d = await call('POST', `/api/executions/${execId}/defect`, {});
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ testCaseCode: 'TC-0001', runCode: 'RUN-001', executionId: execId });
    expect((await call('GET', `/api/projects/${pid}/defects?executionId=${execId}`)).body).toHaveLength(1);
  });
});

describe('2C API: exploratory sessions and tasks', () => {
  it('runs a session end to end and raises a defect from a bug note', async () => {
    const s = (await call('POST', `/api/projects/${pid}/exploratory`, { charter: 'Explore checkout' })).body;
    expect((await call('POST', `/api/exploratory/${s.id}/notes`, { text: 'early' })).status).toBe(409);
    expect((await call('POST', `/api/exploratory/${s.id}/start`)).body.status).toBe('in_progress');
    const withNote = (await call('POST', `/api/exploratory/${s.id}/notes`, { kind: 'bug', text: 'NaN total' })).body;
    const noteId = withNote.notes[0].id;
    const r = await call('POST', `/api/exploratory-notes/${noteId}/defect`, {});
    expect(r.status).toBe(201);
    expect(r.body.defect).toMatchObject({ code: 'DEF-001', title: 'NaN total' });
    expect((await call('POST', `/api/exploratory/${s.id}/complete`, { summary: 'One bug' })).body).toMatchObject({ status: 'completed', bugCount: 1 });
    expect((await call('GET', `/api/exploratory/${s.id}`)).body.notes[0].defectCode).toBe('DEF-001');
  });
  it('moves a task across the board; completing is allowed for the person, blocking needs a reason', async () => {
    const t = (await call('POST', `/api/projects/${pid}/tasks`, { title: 'Write tests', assignee: 'Sam' })).body;
    expect(t).toMatchObject({ code: 'TSK-001', stage: 'backlog' });
    expect((await call('POST', `/api/tasks/${t.id}/move`, { to: 'blocked' })).status).toBe(422);
    expect((await call('POST', `/api/tasks/${t.id}/move`, { to: 'blocked', note: 'No data' })).body.stage).toBe('blocked');
    expect((await call('POST', `/api/tasks/${t.id}/move`, { to: 'completed' })).body).toMatchObject({ stage: 'completed', completedBy: 'human' });
    expect((await call('GET', `/api/projects/${pid}/tasks?stage=completed`)).body).toHaveLength(1);
    expect((await call('PATCH', `/api/tasks/${t.id}`, { title: 'Write more tests' })).body.title).toBe('Write more tests');
    expect((await call('GET', '/api/qa/summary')).body.tasks).toMatchObject({ total: 1, open: 0 });
  });
});
