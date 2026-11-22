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

async function call(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie, ...headers }, payload: payload as object });
  return { status: r.statusCode, body: r.body && r.headers['content-type']?.toString().includes('json') ? r.json() : null, raw: r.body, headers: r.headers };
}
async function approvedCase(title = 'Sign in works') {
  const t = (await call('POST', `/api/projects/${pid}/test-cases`, { title, steps: ['Open', 'Sign in'], expectedResult: 'Dashboard' })).body;
  await call('POST', `/api/test-cases/${t.id}/transition`, { to: 'in_review' });
  await call('POST', `/api/test-cases/${t.id}/transition`, { to: 'approved', note: 'ok' });
  return t.id as string;
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('image-bytes')]);

describe('execution API: access control', () => {
  it('every route needs the signed-in session, and mutations need the CSRF header', async () => {
    for (const [m, u] of [
      ['GET', `/api/projects/${pid}/test-runs`],
      ['POST', `/api/projects/${pid}/test-runs`],
      ['GET', '/api/test-runs/x'],
      ['POST', '/api/test-runs/x/close'],
      ['GET', '/api/executions/x'],
      ['POST', '/api/executions/x/result'],
      ['POST', '/api/executions/x/evidence/file'],
      ['GET', '/api/evidence/x/file'],
      ['DELETE', '/api/evidence/x'],
    ] as const) {
      const r = await env.app.inject({ method: m, url: u, headers: { host: env.host, origin: env.origin, 'x-qavo-client': '1' }, payload: m === 'POST' ? {} : undefined });
      expect(r.statusCode, `${m} ${u}`).toBe(401);
    }
    const noCsrf = await env.app.inject({ method: 'POST', url: `/api/projects/${pid}/test-runs`, headers: { host: env.host, origin: env.origin, cookie }, payload: { name: 'x' } });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe('execution API: run, result, evidence', () => {
  it('full flow with proper status codes; only approved cases are added', async () => {
    const approved = await approvedCase();
    const draft = (await call('POST', `/api/projects/${pid}/test-cases`, { title: 'Draft', steps: ['a'], expectedResult: 'b' })).body.id;
    const run = await call('POST', `/api/projects/${pid}/test-runs`, { name: 'Sprint 1', environment: 'staging', testCaseIds: [approved, draft] });
    expect(run.status).toBe(201);
    expect(run.body).toMatchObject({ code: 'RUN-001', counts: { total: 1, not_run: 1 } });
    expect(run.body.skipped).toHaveLength(1);

    const detail = (await call('GET', `/api/test-runs/${run.body.id}`)).body;
    const execId = detail.executions[0].id as string;
    expect((await call('POST', `/api/executions/${execId}/result`, { status: 'failed' })).body.error).toBe('note_required');
    expect((await call('POST', `/api/executions/${execId}/result`, { status: 'passed', actualResult: 'Dashboard shown' })).body).toMatchObject({ status: 'passed', executedBy: 'human' });

    const list = (await call('GET', `/api/projects/${pid}/test-cases`)).body as Array<{ id: string; executionStatus: string }>;
    expect(list.find((t) => t.id === approved)!.executionStatus).toBe('PASSED');

    const s = (await call('GET', '/api/qa/summary')).body;
    expect(s.execution).toMatchObject({ approvedTestCases: 1, passed: 1, pending: 0, resultsRecorded: 1 });
    expect(s.execution.passRate).toMatchObject({ numerator: 1, denominator: 1, percent: 100 });
  });

  it('uploads a file, downloads it as a locked-down attachment, and deletes it', async () => {
    const run = (await call('POST', `/api/projects/${pid}/test-runs`, { name: 'R', testCaseIds: [await approvedCase()] })).body;
    const execId = (await call('GET', `/api/test-runs/${run.id}`)).body.executions[0].id as string;
    const up = await call('POST', `/api/executions/${execId}/evidence/file`, { fileName: 'shot.png', label: 'Banner', dataBase64: PNG.toString('base64') });
    expect(up.status).toBe(201);
    const dl = await env.app.inject({ method: 'GET', url: `/api/evidence/${up.body.id}/file`, headers: { ...uiHeaders(env), cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(PNG)).toBe(true);
    expect(dl.headers['content-type']).toBe('image/png');
    expect(String(dl.headers['content-disposition'])).toMatch(/^attachment; filename="shot\.png"/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(String(dl.headers['content-security-policy'])).toContain('sandbox');
    expect((await call('POST', `/api/executions/${execId}/evidence/file`, { fileName: 'x.exe', dataBase64: 'TVo=' })).status).toBe(415);
    expect((await call('DELETE', `/api/evidence/${up.body.id}`)).status).toBe(200);
    expect((await call('GET', `/api/evidence/${up.body.id}/file`)).status).toBe(404);
  });

  it('rejects bodies over the upload limit and unknown ids', async () => {
    const run = (await call('POST', `/api/projects/${pid}/test-runs`, { name: 'R', testCaseIds: [await approvedCase()] })).body;
    const execId = (await call('GET', `/api/test-runs/${run.id}`)).body.executions[0].id as string;
    const huge = await call('POST', `/api/executions/${execId}/evidence/file`, { fileName: 'a.txt', dataBase64: 'A'.repeat(9 * 1024 * 1024) });
    expect(huge.status).toBe(413);
    expect((await call('GET', '/api/executions/nope')).status).toBe(404);
    expect((await call('POST', '/api/test-runs/nope/close')).status).toBe(404);
  });

  it('a closed run refuses changes with 409', async () => {
    const run = (await call('POST', `/api/projects/${pid}/test-runs`, { name: 'R', testCaseIds: [await approvedCase()] })).body;
    const execId = (await call('GET', `/api/test-runs/${run.id}`)).body.executions[0].id as string;
    expect((await call('POST', `/api/test-runs/${run.id}/close`)).body.status).toBe('closed');
    const r = await call('POST', `/api/executions/${execId}/result`, { status: 'passed' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('run_closed');
  });
});
