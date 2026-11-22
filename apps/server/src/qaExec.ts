/**
 * Manual test execution service (test runs, executions, evidence).
 *
 * Rules enforced HERE (and PASSED-by-human also by a database constraint):
 *  - only APPROVED, non-archived test cases can be added to a run
 *  - only a person creates/closes runs, deletes evidence, and marks a test PASSED or SKIPPED
 *  - FAILED/BLOCKED/SKIPPED and re-testing a finished result need a note
 *  - a closed run cannot be changed
 *  - history is append-only
 * Privacy: every free-text field (notes, actual results, text evidence) is redacted before it is
 * stored. Evidence files are saved under the data directory with random names; images and PDFs cannot be
 * redacted, so the UI says so. Evidence is never part of exports or logs.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  checkExecutionChange,
  coverageRatio,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_PER_EXECUTION,
  evidenceTypeFor,
  EXECUTION_STATUSES,
  EXECUTOR_KINDS,
  matchesMagic,
  redact,
  safeFileName,
  type Actor,
  type ExecutionStatus,
  type Ratio,
} from '@qavo/shared';
import type { DB } from './db/index.ts';
import { HttpError, newId } from './store.ts';

const nowIso = () => new Date().toISOString();
type Row = Record<string, unknown>;

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => i.path.join('.') || '(root)'))].join(', ');
    throw new HttpError(400, 'invalid_input', `Invalid fields: ${fields}`);
  }
  return r.data;
}
const needHuman = (actor: Actor) => {
  if (actor !== 'human') throw new HttpError(403, 'human_required', 'Only a person can do this');
};
const clean = (s: string) => redact(s).trim();

// ---------------------------------------------------------------------------- schemas
const RunInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    environment: z.string().trim().max(120).default(''),
    build: z.string().trim().max(120).default(''),
    testCaseIds: z.array(z.string().max(64)).max(1_000).default([]),
    addAllApproved: z.boolean().default(false),
  })
  .strict();
const AddCasesInput = z.object({ testCaseIds: z.array(z.string().max(64)).max(1_000).default([]), addAllApproved: z.boolean().default(false) }).strict();
const ResultInput = z
  .object({
    status: z.enum(EXECUTION_STATUSES),
    note: z.string().max(5_000).default(''),
    actualResult: z.string().max(10_000).optional(),
    executorKind: z.enum(EXECUTOR_KINDS).optional(),
  })
  .strict();
const NoteEvidenceInput = z.object({ label: z.string().trim().max(120).default(''), body: z.string().trim().min(1).max(20_000) }).strict();
const FileEvidenceInput = z
  .object({ fileName: z.string().trim().min(1).max(200), label: z.string().trim().max(120).default(''), dataBase64: z.string().min(1).max(8 * 1024 * 1024) })
  .strict();

// ---------------------------------------------------------------------------- DTOs
export type ExecCounts = Record<ExecutionStatus, number> & { total: number };
export interface RunDTO {
  id: string;
  projectId: string;
  code: string;
  name: string;
  environment: string;
  build: string;
  status: 'open' | 'closed';
  createdBy: string;
  createdAt: string;
  closedAt: string | null;
  counts: ExecCounts;
}
export interface ExecutionDTO {
  id: string;
  runId: string;
  testCaseId: string;
  testCaseCode: string;
  title: string;
  priority: string;
  testType: string;
  caseVersion: number;
  /** True when the test case was edited, withdrawn or un-approved after it was added to the run. */
  caseChanged: boolean;
  status: ExecutionStatus;
  executorKind: string;
  executedBy: string | null;
  note: string;
  actualResult: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  evidenceCount: number;
}
export interface EvidenceDTO {
  id: string;
  executionId: string;
  kind: 'note' | 'file';
  label: string;
  body: string;
  fileName: string | null;
  mime: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  redacted: boolean;
  createdBy: string;
  createdAt: string;
}
export interface ExecutionHistoryDTO {
  id: string;
  at: string;
  actor: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string;
}
export interface ExecutionDetailDTO extends ExecutionDTO {
  run: RunDTO;
  steps: string[];
  preconditions: string;
  testData: string;
  expectedResult: string;
  history: ExecutionHistoryDTO[];
  evidence: EvidenceDTO[];
}

const emptyCounts = (): ExecCounts => ({ not_run: 0, in_progress: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, total: 0 });

function runDto(db: DB, r: Row): RunDTO {
  const counts = emptyCounts();
  for (const x of db.prepare('SELECT status, COUNT(*) AS c FROM test_executions WHERE run_id = ? GROUP BY status').all(r.id) as Array<{ status: ExecutionStatus; c: number }>) {
    counts[x.status] = x.c;
    counts.total += x.c;
  }
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    code: `RUN-${String(r.seq).padStart(3, '0')}`,
    name: r.name as string,
    environment: r.environment as string,
    build: r.build as string,
    status: r.status as 'open' | 'closed',
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
    closedAt: (r.closed_at as string) ?? null,
    counts,
  };
}

const EXEC_SELECT = `SELECT e.*, t.code AS tc_code, t.title AS tc_title, t.priority AS tc_priority, t.test_type AS tc_type,
    t.version AS tc_version, t.status AS tc_status, t.archived AS tc_archived,
    t.steps_json AS tc_steps, t.preconditions AS tc_pre, t.test_data AS tc_data, t.expected_result AS tc_expected,
    (SELECT COUNT(*) FROM evidence v WHERE v.execution_id = e.id) AS ev_count
  FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id`;

function execDto(r: Row): ExecutionDTO {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    testCaseId: r.test_case_id as string,
    testCaseCode: r.tc_code as string,
    title: r.tc_title as string,
    priority: r.tc_priority as string,
    testType: r.tc_type as string,
    caseVersion: r.case_version as number,
    caseChanged: r.tc_version !== r.case_version || r.tc_status !== 'approved' || r.tc_archived === 1,
    status: r.status as ExecutionStatus,
    executorKind: r.executor_kind as string,
    executedBy: (r.executed_by as string) ?? null,
    note: r.note as string,
    actualResult: r.actual_result as string,
    startedAt: (r.started_at as string) ?? null,
    completedAt: (r.completed_at as string) ?? null,
    updatedAt: r.updated_at as string,
    evidenceCount: r.ev_count as number,
  };
}

function evDto(r: Row): EvidenceDTO {
  return {
    id: r.id as string,
    executionId: r.execution_id as string,
    kind: r.kind as 'note' | 'file',
    label: r.label as string,
    body: r.body as string,
    fileName: (r.file_name as string) ?? null,
    mime: (r.mime as string) ?? null,
    sizeBytes: (r.size_bytes as number) ?? null,
    sha256: (r.sha256 as string) ?? null,
    redacted: r.redacted === 1,
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
  };
}

function loadRun(db: DB, id: string): Row {
  const r = db.prepare('SELECT * FROM test_runs WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'run_not_found');
  return r;
}
function loadExec(db: DB, id: string): Row {
  const r = db.prepare(`${EXEC_SELECT} WHERE e.id = ?`).get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'execution_not_found');
  return r;
}
function assertOpen(run: Row) {
  if (run.status === 'closed') throw new HttpError(409, 'run_closed', 'This test run is closed and can no longer be changed');
}
function history(db: DB, executionId: string, actor: Actor, action: string, from: string | null, to: string | null, note = '') {
  db.prepare('INSERT INTO execution_history (id, execution_id, at, actor, action, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    newId('xh'),
    executionId,
    nowIso(),
    actor,
    action,
    from,
    to,
    note,
  );
}

// ---------------------------------------------------------------------------- runs
function addCasesTx(db: DB, run: Row, ids: string[], all: boolean, actor: Actor): { added: number; skipped: string[] } {
  const projectId = run.project_id as string;
  const candidates = new Set(ids);
  if (all) {
    for (const x of db.prepare("SELECT id FROM test_cases WHERE project_id = ? AND status = 'approved' AND archived = 0").all(projectId) as Array<{ id: string }>) candidates.add(x.id);
  }
  const skipped: string[] = [];
  let added = 0;
  const ins = db.prepare(
    `INSERT INTO test_executions (id, run_id, test_case_id, case_version, status, executor_kind, updated_at) VALUES (?, ?, ?, ?, 'not_run', 'human', ?)`,
  );
  for (const id of candidates) {
    const t = db.prepare('SELECT id, code, project_id, status, archived, version FROM test_cases WHERE id = ?').get(id) as
      | { id: string; code: string; project_id: string; status: string; archived: number; version: number }
      | undefined;
    if (!t || t.project_id !== projectId) throw new HttpError(400, 'test_case_invalid', 'A test case is not in this project');
    if (t.status !== 'approved' || t.archived === 1) {
      skipped.push(`${t.code} (not approved)`);
      continue;
    }
    if (db.prepare('SELECT 1 FROM test_executions WHERE run_id = ? AND test_case_id = ?').get(run.id, t.id)) {
      skipped.push(`${t.code} (already in the run)`);
      continue;
    }
    const execId = newId('exe');
    ins.run(execId, run.id, t.id, t.version, nowIso());
    history(db, execId, actor, 'added', null, 'not_run', `Added at test case version ${t.version}`);
    added += 1;
  }
  return { added, skipped };
}

export function createRun(db: DB, projectId: string, input: unknown, actor: Actor): RunDTO & { skipped: string[] } {
  needHuman(actor);
  const v = parse(RunInput, input);
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new HttpError(404, 'project_not_found');
  const out = db.transaction(() => {
    const seq = ((db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM test_runs WHERE project_id = ?').get(projectId) as { m: number }).m ?? 0) + 1;
    const id = newId('run');
    db.prepare('INSERT INTO test_runs (id, project_id, seq, name, environment, build, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      projectId,
      seq,
      clean(v.name),
      clean(v.environment),
      clean(v.build),
      'open',
      'human',
      nowIso(),
    );
    const run = loadRun(db, id);
    const { skipped } = addCasesTx(db, run, v.testCaseIds, v.addAllApproved, actor);
    return { id, skipped };
  })();
  return { ...runDto(db, loadRun(db, out.id)), skipped: out.skipped };
}

export function addCasesToRun(db: DB, runId: string, input: unknown, actor: Actor): { added: number; skipped: string[] } {
  needHuman(actor);
  const v = parse(AddCasesInput, input);
  const run = loadRun(db, runId);
  assertOpen(run);
  return db.transaction(() => addCasesTx(db, run, v.testCaseIds, v.addAllApproved, actor))();
}

export function closeRun(db: DB, runId: string, actor: Actor): RunDTO {
  needHuman(actor);
  const run = loadRun(db, runId);
  assertOpen(run);
  db.prepare("UPDATE test_runs SET status = 'closed', closed_at = ? WHERE id = ?").run(nowIso(), runId);
  return runDto(db, loadRun(db, runId));
}

export function listRuns(db: DB, projectId: string): RunDTO[] {
  return (db.prepare('SELECT * FROM test_runs WHERE project_id = ? ORDER BY seq DESC').all(projectId) as Row[]).map((r) => runDto(db, r));
}

export function getRun(db: DB, runId: string): RunDTO & { executions: ExecutionDTO[] } {
  const run = loadRun(db, runId);
  const executions = (db.prepare(`${EXEC_SELECT} WHERE e.run_id = ? ORDER BY t.seq`).all(runId) as Row[]).map(execDto);
  return { ...runDto(db, run), executions };
}

// ---------------------------------------------------------------------------- executions
export function getExecution(db: DB, id: string): ExecutionDetailDTO {
  const r = loadExec(db, id);
  let steps: string[] = [];
  try {
    steps = JSON.parse(r.tc_steps as string) as string[];
  } catch {
    steps = [];
  }
  const hist = (db.prepare('SELECT * FROM execution_history WHERE execution_id = ? ORDER BY at, rowid').all(id) as Row[]).map((h) => ({
    id: h.id as string,
    at: h.at as string,
    actor: h.actor as string,
    action: h.action as string,
    fromStatus: (h.from_status as string) ?? null,
    toStatus: (h.to_status as string) ?? null,
    note: h.note as string,
  }));
  const evidence = (db.prepare('SELECT * FROM evidence WHERE execution_id = ? ORDER BY created_at, rowid').all(id) as Row[]).map(evDto);
  return {
    ...execDto(r),
    run: runDto(db, loadRun(db, r.run_id as string)),
    steps,
    preconditions: r.tc_pre as string,
    testData: r.tc_data as string,
    expectedResult: r.tc_expected as string,
    history: hist,
    evidence,
  };
}

export function setResult(db: DB, id: string, input: unknown, actor: Actor): ExecutionDetailDTO {
  const v = parse(ResultInput, input);
  const e = loadExec(db, id);
  assertOpen(loadRun(db, e.run_id as string));
  const from = e.status as ExecutionStatus;
  const check = checkExecutionChange(from, v.status, actor, v.note);
  if (!check.ok) {
    throw new HttpError(check.code === 'human_required' ? 403 : check.code === 'unchanged' ? 409 : 422, check.code, check.message);
  }
  const note = clean(v.note);
  const ts = nowIso();
  const decided = ['passed', 'failed', 'blocked', 'skipped'].includes(v.status);
  const executorKind = actor === 'human' ? (v.executorKind ?? (e.executor_kind as string)) : 'agent_assisted';
  if (actor === 'human' && executorKind === 'automated') throw new HttpError(400, 'invalid_input', 'A person cannot record a result as automated');
  db.transaction(() => {
    db.prepare(
      `UPDATE test_executions SET status = ?, executor_kind = ?, executed_by = ?, note = ?, actual_result = ?,
         started_at = COALESCE(started_at, ?), completed_at = ?, updated_at = ? WHERE id = ?`,
    ).run(
      v.status,
      executorKind,
      v.status === 'not_run' ? null : actor,
      note || (e.note as string),
      v.actualResult === undefined ? (e.actual_result as string) : clean(v.actualResult),
      v.status === 'not_run' ? null : ts,
      decided ? ts : null,
      ts,
      id,
    );
    history(db, id, actor, 'result', from, v.status, note);
  })();
  return getExecution(db, id);
}

// ---------------------------------------------------------------------------- evidence
function countEvidence(db: DB, executionId: string): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM evidence WHERE execution_id = ?').get(executionId) as { c: number }).c;
}

export function addNoteEvidence(db: DB, executionId: string, input: unknown, actor: Actor): EvidenceDTO {
  if (actor !== 'human' && actor !== 'agent') throw new HttpError(403, 'forbidden');
  const v = parse(NoteEvidenceInput, input);
  const e = loadExec(db, executionId);
  assertOpen(loadRun(db, e.run_id as string));
  if (countEvidence(db, executionId) >= EVIDENCE_MAX_PER_EXECUTION) throw new HttpError(409, 'evidence_limit', `At most ${EVIDENCE_MAX_PER_EXECUTION} evidence items per test`);
  const body = redact(v.body);
  const id = newId('evd');
  db.transaction(() => {
    db.prepare('INSERT INTO evidence (id, execution_id, kind, label, body, redacted, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      executionId,
      'note',
      clean(v.label),
      body,
      body !== v.body ? 1 : 0,
      actor,
      nowIso(),
    );
    history(db, executionId, actor, 'evidence_added', null, null, `Note: ${clean(v.label) || '(no label)'}`);
  })();
  return evDto(db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as Row);
}

export function addFileEvidence(db: DB, evidenceDir: string, executionId: string, input: unknown, actor: Actor): EvidenceDTO {
  if (actor !== 'human' && actor !== 'agent') throw new HttpError(403, 'forbidden');
  const v = parse(FileEvidenceInput, input);
  const e = loadExec(db, executionId);
  assertOpen(loadRun(db, e.run_id as string));
  if (countEvidence(db, executionId) >= EVIDENCE_MAX_PER_EXECUTION) throw new HttpError(409, 'evidence_limit', `At most ${EVIDENCE_MAX_PER_EXECUTION} evidence items per test`);
  const type = evidenceTypeFor(v.fileName);
  if (!type) throw new HttpError(415, 'file_type_not_allowed', 'Allowed files: png, jpg, gif, webp, pdf, txt, log, json, csv');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v.dataBase64)) throw new HttpError(400, 'invalid_input', 'The file data is not valid base64');
  let bytes: Buffer = Buffer.from(v.dataBase64, 'base64');
  if (bytes.length === 0) throw new HttpError(400, 'invalid_input', 'The file is empty');
  if (bytes.length > EVIDENCE_MAX_BYTES) throw new HttpError(413, 'file_too_large', `Files can be up to ${EVIDENCE_MAX_BYTES / (1024 * 1024)} MB`);
  if (!matchesMagic(type, bytes)) throw new HttpError(415, 'file_content_mismatch', 'The file contents do not match its extension');
  let redacted = false;
  if (type.text) {
    const original = bytes.toString('utf8');
    if (original.includes('\u0000')) throw new HttpError(415, 'file_content_mismatch', 'The file contents do not match its extension');
    const safe = redact(original);
    redacted = safe !== original;
    bytes = Buffer.from(safe, 'utf8');
  }
  const id = newId('evd');
  const stored = `${id}.${type.ext}`;
  fs.mkdirSync(evidenceDir, { recursive: true });
  const target = path.join(evidenceDir, stored);
  fs.writeFileSync(target, bytes, { flag: 'wx' });
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO evidence (id, execution_id, kind, label, file_name, mime, size_bytes, sha256, stored_name, redacted, created_by, created_at)
         VALUES (?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, executionId, clean(v.label), safeFileName(v.fileName), type.mime, bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'), stored, redacted ? 1 : 0, actor, nowIso());
      history(db, executionId, actor, 'evidence_added', null, null, `File: ${safeFileName(v.fileName)}`);
    })();
  } catch (err) {
    fs.rmSync(target, { force: true });
    throw err;
  }
  return evDto(db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as Row);
}

export function getEvidenceFile(db: DB, evidenceDir: string, id: string): { filePath: string; mime: string; fileName: string } {
  const r = db.prepare("SELECT * FROM evidence WHERE id = ? AND kind = 'file'").get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'evidence_not_found');
  const filePath = path.join(evidenceDir, r.stored_name as string);
  // the stored name is generated by us (id.ext); still never serve anything outside the evidence directory
  if (path.dirname(path.resolve(filePath)) !== path.resolve(evidenceDir) || !fs.existsSync(filePath)) throw new HttpError(404, 'evidence_file_missing');
  return { filePath, mime: r.mime as string, fileName: r.file_name as string };
}

export function deleteEvidence(db: DB, evidenceDir: string, id: string, actor: Actor): void {
  needHuman(actor);
  const r = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'evidence_not_found');
  const e = loadExec(db, r.execution_id as string);
  assertOpen(loadRun(db, e.run_id as string));
  db.transaction(() => {
    db.prepare('DELETE FROM evidence WHERE id = ?').run(id);
    history(db, r.execution_id as string, actor, 'evidence_deleted', null, null, r.kind === 'file' ? `File: ${r.file_name as string}` : `Note: ${(r.label as string) || '(no label)'}`);
  })();
  if (r.stored_name) fs.rmSync(path.join(evidenceDir, r.stored_name as string), { force: true });
}

// ---------------------------------------------------------------------------- figures
export interface ExecutionSummary {
  /** Approved, non-archived test cases: the denominator of every figure below. */
  approvedTestCases: number;
  /** Latest finished result per approved test case (older runs do not count twice). */
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  /** Approved test cases that have no finished result yet. */
  pending: number;
  /** Executions that have a finished result, across all runs. */
  resultsRecorded: number;
  openRuns: number;
  /** passed / (passed + failed + blocked); skipped tests are left out. */
  passRate: Ratio;
}

export function executionSummary(db: DB, projectId?: string): ExecutionSummary {
  const scope = projectId ? 'AND t.project_id = ?' : '';
  const args = projectId ? [projectId] : [];
  const approved = (db.prepare(`SELECT COUNT(*) AS c FROM test_cases t WHERE t.archived = 0 AND t.status = 'approved' ${scope}`).get(...args) as { c: number }).c;
  const latest = db
    .prepare(
      `WITH ranked AS (
         SELECT e.test_case_id, e.status,
                ROW_NUMBER() OVER (PARTITION BY e.test_case_id ORDER BY e.completed_at DESC, e.rowid DESC) AS rn
         FROM test_executions e WHERE e.status IN ('passed','failed','blocked','skipped'))
       SELECT r.status AS status, COUNT(*) AS c FROM ranked r JOIN test_cases t ON t.id = r.test_case_id
       WHERE r.rn = 1 AND t.archived = 0 AND t.status = 'approved' ${scope} GROUP BY r.status`,
    )
    .all(...args) as Array<{ status: string; c: number }>;
  const n = (s: string) => latest.find((x) => x.status === s)?.c ?? 0;
  const [passed, failed, blocked, skipped] = [n('passed'), n('failed'), n('blocked'), n('skipped')];
  const recorded = (
    db.prepare(`SELECT COUNT(*) AS c FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id WHERE e.status IN ('passed','failed','blocked','skipped') ${scope}`).get(...args) as { c: number }
  ).c;
  const openRuns = (db.prepare(`SELECT COUNT(*) AS c FROM test_runs WHERE status = 'open' ${projectId ? 'AND project_id = ?' : ''}`).get(...args) as { c: number }).c;
  return {
    approvedTestCases: approved,
    passed,
    failed,
    blocked,
    skipped,
    pending: Math.max(0, approved - passed - failed - blocked - skipped),
    resultsRecorded: recorded,
    openRuns,
    passRate: coverageRatio(passed, passed + failed + blocked),
  };
}
