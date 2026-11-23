/**
 * Manual QA service (requirements, flags, test cases, traceability).
 *
 * Every mutation takes an `actor`. The rules are enforced HERE (and for the critical ones also by
 * database constraints/triggers), never only in the UI or the route layer:
 *  - approving/rejecting/any workflow transition, resolving flags, editing or deleting requirements,
 *    archiving: HUMAN only
 *  - an agent may create requirements and DRAFT test cases (marked agent-authored), raise flags, and
 *    edit only its own drafts
 *  - `system` raises automatic hints only
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  analyzeRequirement,
  canTransition,
  coverageRatio,
  FLAG_STATUSES,
  FLAG_TYPES,
  inferKind,
  parseRequirements,
  parseTestCaseTable,
  PRIORITIES,
  redact,
  REQUIREMENT_KINDS,
  REVIEW_FILTERS,
  REVIEW_STATUSES,
  TEST_CASE_STATUSES,
  TEST_TYPES,
  validateForApproval,
  type Actor,
  type Ratio,
  type TestCaseStatus,
} from '@qavo/shared';
import type { DB } from './db/index.ts';
import { defectSummary, type DefectSummary } from './qaDefects.ts';
import { executionSummary, type ExecutionSummary } from './qaExec.ts';
import { taskSummary } from './qaWork.ts';
import { HttpError, newId } from './store.ts';

const nowIso = () => new Date().toISOString();

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

// ---------------------------------------------------------------------------- schemas
const RequirementFields = z
  .object({
    ref: z.string().trim().min(1).max(40),
    title: z.string().trim().min(1).max(200),
    text: z.string().max(10_000).default(''),
    source: z.string().trim().max(200).default(''),
    kind: z.enum(REQUIREMENT_KINDS).default('other'),
  })
  .strict();
const RequirementPatch = RequirementFields.partial().extend({ reviewStatus: z.enum(REVIEW_STATUSES).optional() }).strict();

const TestCaseFields = z
  .object({
    scenario: z.string().trim().max(200).default(''),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(10_000).default(''),
    preconditions: z.string().max(5_000).default(''),
    steps: z.array(z.string().max(2_000)).max(100).default([]),
    testData: z.string().max(10_000).default(''),
    expectedResult: z.string().max(10_000).default(''),
    priority: z.enum(PRIORITIES).default('medium'),
    testType: z.enum(TEST_TYPES).default('positive'),
    assignedTester: z.string().trim().max(100).default(''),
    requirementIds: z.array(z.string().max(64)).max(200).default([]),
  })
  .strict();
const TestCasePatch = TestCaseFields.partial().strict();

const FlagInput = z
  .object({ type: z.enum(FLAG_TYPES), note: z.string().trim().min(1).max(2_000), relatedRequirementId: z.string().max(64).optional() })
  .strict();
const FlagResolution = z.object({ status: z.enum(['resolved', 'dismissed']), note: z.string().trim().max(2_000).optional() }).strict();
const ImportInput = z
  .object({ text: z.string().max(300_000), source: z.string().trim().max(200).default(''), kind: z.enum(['auto', ...REQUIREMENT_KINDS]).default('auto'), onlyPrefixes: z.array(z.string().max(10)).max(50).optional(), dryRun: z.boolean().default(false) })
  .strict();

// ---------------------------------------------------------------------------- DTOs
export interface FlagDTO {
  id: string;
  requirementId: string;
  type: string;
  note: string;
  relatedRequirementId: string | null;
  raisedBy: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedNote: string | null;
}
export interface RequirementDTO {
  id: string;
  projectId: string;
  ref: string;
  title: string;
  text: string;
  source: string;
  kind: string;
  reviewStatus: string;
  authoredBy: string;
  openFlags: number;
  testCaseCount: number;
  approvedTestCaseCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface RequirementDetailDTO extends RequirementDTO {
  flags: FlagDTO[];
  testCases: Array<{ id: string; code: string; title: string; status: string }>;
}
export interface ReviewSummary {
  verdict: 'recommend_approve' | 'changes_requested';
  by: string;
  at: string;
  notes: string;
  /** False when the test case was edited after this review (the review is about an older version). */
  current: boolean;
}
export interface TestCaseDTO {
  id: string;
  projectId: string;
  code: string;
  /** The id from the team's own sheet when imported ("" if written in the app). */
  externalId: string;
  /** The named agent that drafted it (empty if a person, an import, or an unattributed agent). */
  draftedBy: string;
  scenario: string;
  title: string;
  description: string;
  preconditions: string;
  steps: string[];
  testData: string;
  expectedResult: string;
  priority: string;
  testType: string;
  assignedTester: string;
  requirementIds: string[];
  requirementRefs: string[];
  status: TestCaseStatus;
  authoredBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionNote: string;
  version: number;
  /** The latest recommendation from a reviewer agent (Pass P3), or null. Never a decision: a person approves. */
  review: ReviewSummary | null;
  /** Latest finished result from test runs (Pass 2B), else IN PROGRESS, else NOT RUN. */
  executionStatus: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface HistoryDTO {
  id: string;
  at: string;
  actor: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string;
  changes: Record<string, unknown>;
}
export interface ReplyDTO {
  by: string;
  at: string;
  note: string;
}
export interface TestCaseDetailDTO extends TestCaseDTO {
  requirements: Array<{ id: string; ref: string; title: string }>;
  history: HistoryDTO[];
  /** What the writer agent answered to the latest review (since that review), oldest first. */
  replies: ReplyDTO[];
}

type Row = Record<string, unknown>;

function flagDto(r: Row): FlagDTO {
  return {
    id: r.id as string,
    requirementId: r.requirement_id as string,
    type: r.type as string,
    note: r.note as string,
    relatedRequirementId: (r.related_requirement_id as string) ?? null,
    raisedBy: r.raised_by as string,
    status: r.status as string,
    createdAt: r.created_at as string,
    resolvedAt: (r.resolved_at as string) ?? null,
    resolvedNote: (r.resolved_note as string) ?? null,
  };
}

const REQ_SELECT = `SELECT r.*,
    (SELECT COUNT(*) FROM requirement_flags f WHERE f.requirement_id = r.id AND f.status = 'open') AS open_flags,
    (SELECT COUNT(*) FROM test_case_requirements x JOIN test_cases t ON t.id = x.test_case_id WHERE x.requirement_id = r.id AND t.archived = 0) AS tc_count,
    (SELECT COUNT(*) FROM test_case_requirements x JOIN test_cases t ON t.id = x.test_case_id WHERE x.requirement_id = r.id AND t.archived = 0 AND t.status = 'approved') AS tc_approved
  FROM requirements r`;

function reqDto(r: Row): RequirementDTO {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    ref: r.ref as string,
    title: r.title as string,
    text: r.text as string,
    source: r.source as string,
    kind: r.kind as string,
    reviewStatus: r.review_status as string,
    authoredBy: r.authored_by as string,
    openFlags: r.open_flags as number,
    testCaseCount: r.tc_count as number,
    approvedTestCaseCount: r.tc_approved as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function requireProject(db: DB, projectId: string) {
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new HttpError(404, 'project_not_found');
}
const naturalRefOrder = (a: RequirementDTO, b: RequirementDTO) => a.ref.localeCompare(b.ref, undefined, { numeric: true, sensitivity: 'base' });

// ---------------------------------------------------------------------------- requirements
function refTaken(db: DB, projectId: string, ref: string, exceptId?: string): boolean {
  const r = db.prepare('SELECT id FROM requirements WHERE project_id = ? AND lower(ref) = lower(?)').get(projectId, ref) as { id: string } | undefined;
  return !!r && r.id !== exceptId;
}

export function createRequirement(db: DB, projectId: string, input: unknown, actor: Actor): RequirementDTO {
  if (actor === 'system') needHuman(actor);
  const v = parse(RequirementFields, input);
  requireProject(db, projectId);
  if (refTaken(db, projectId, v.ref)) throw new HttpError(409, 'duplicate_ref', `Requirement ${v.ref} already exists in this project`);
  const id = newId('req');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO requirements (id, project_id, ref, title, text, source, kind, authored_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, v.ref, v.title, v.text, v.source, v.kind, actor, ts, ts);
  return reqDto(db.prepare(`${REQ_SELECT} WHERE r.id = ?`).get(id) as Row);
}

export function updateRequirement(db: DB, id: string, patch: unknown, actor: Actor): RequirementDTO {
  needHuman(actor);
  const v = parse(RequirementPatch, patch);
  const cur = db.prepare('SELECT * FROM requirements WHERE id = ?').get(id) as Row | undefined;
  if (!cur) throw new HttpError(404, 'requirement_not_found');
  if (v.ref !== undefined && refTaken(db, cur.project_id as string, v.ref, id)) throw new HttpError(409, 'duplicate_ref', `Requirement ${v.ref} already exists in this project`);
  db.prepare('UPDATE requirements SET ref = ?, title = ?, text = ?, source = ?, kind = ?, review_status = ?, updated_at = ? WHERE id = ?').run(
    v.ref ?? cur.ref,
    v.title ?? cur.title,
    v.text ?? cur.text,
    v.source ?? cur.source,
    v.kind ?? cur.kind,
    v.reviewStatus ?? cur.review_status,
    nowIso(),
    id,
  );
  return reqDto(db.prepare(`${REQ_SELECT} WHERE r.id = ?`).get(id) as Row);
}

export function deleteRequirement(db: DB, id: string, actor: Actor): void {
  needHuman(actor);
  if (db.prepare('DELETE FROM requirements WHERE id = ?').run(id).changes === 0) throw new HttpError(404, 'requirement_not_found');
}

export function listRequirements(db: DB, projectId: string): RequirementDTO[] {
  return (db.prepare(`${REQ_SELECT} WHERE r.project_id = ?`).all(projectId) as Row[]).map(reqDto).sort(naturalRefOrder);
}

export function getRequirement(db: DB, id: string): RequirementDetailDTO {
  const r = db.prepare(`${REQ_SELECT} WHERE r.id = ?`).get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'requirement_not_found');
  const flags = (db.prepare('SELECT * FROM requirement_flags WHERE requirement_id = ? ORDER BY created_at, id').all(id) as Row[]).map(flagDto);
  const testCases = db
    .prepare(
      `SELECT t.id, t.code, t.title, t.status FROM test_case_requirements x JOIN test_cases t ON t.id = x.test_case_id
       WHERE x.requirement_id = ? AND t.archived = 0 ORDER BY t.seq`,
    )
    .all(id) as Array<{ id: string; code: string; title: string; status: string }>;
  return { ...reqDto(r), flags, testCases };
}

export interface ImportResult {
  dryRun: boolean;
  wouldCreate: string[];
  created: string[];
  skippedExisting: string[];
  unparsed: string[];
  duplicates: string[];
  /** Distinct requirements found per reference prefix, before the prefix filter (for the preview chips). */
  byPrefix: Record<string, number>;
}

export function importRequirements(db: DB, projectId: string, input: unknown, actor: Actor): ImportResult {
  needHuman(actor);
  const v = parse(ImportInput, input);
  requireProject(db, projectId);
  const parsed = parseRequirements(v.text);
  if (parsed.items.length === 0) throw new HttpError(400, 'nothing_to_import', 'No requirements were found: start each one with a reference such as REQ-1:');
  const wouldCreate: string[] = [];
  const skippedExisting: string[] = [];
  const seen = new Set<string>();
  const todo: typeof parsed.items = [];
  const byPrefix: Record<string, number> = {};
  const only = v.onlyPrefixes ? new Set(v.onlyPrefixes.map((x) => x.toUpperCase())) : null;
  for (const item of parsed.items) {
    const key = item.ref.toLowerCase();
    if (seen.has(key)) continue; // repeated within the pasted text: first occurrence wins
    seen.add(key);
    byPrefix[item.prefix] = (byPrefix[item.prefix] ?? 0) + 1;
    if (only && !only.has(item.prefix)) continue;
    if (refTaken(db, projectId, item.ref)) skippedExisting.push(item.ref);
    else {
      wouldCreate.push(item.ref);
      todo.push(item);
    }
  }
  const created: string[] = [];
  if (!v.dryRun) {
    const ins = db.prepare(
      `INSERT INTO requirements (id, project_id, ref, title, text, source, kind, authored_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'human', ?, ?)`,
    );
    db.transaction(() => {
      for (const i of todo) {
        const ts = nowIso();
        ins.run(newId('req'), projectId, i.ref, i.title.slice(0, 200), i.text.slice(0, 10_000), v.source, v.kind === 'auto' ? inferKind(i.ref) : v.kind, ts, ts);
        created.push(i.ref);
      }
    })();
  }
  return { dryRun: v.dryRun, wouldCreate, created, skippedExisting, unparsed: parsed.unparsed, duplicates: parsed.duplicates, byPrefix };
}

// ---------------------------------------------------------------------------- flags and automatic hints
export function raiseFlag(db: DB, requirementId: string, input: unknown, actor: Actor): FlagDTO {
  const v = parse(FlagInput, input);
  const req = db.prepare('SELECT project_id FROM requirements WHERE id = ?').get(requirementId) as { project_id: string } | undefined;
  if (!req) throw new HttpError(404, 'requirement_not_found');
  if (v.relatedRequirementId) {
    const rel = db.prepare('SELECT project_id FROM requirements WHERE id = ?').get(v.relatedRequirementId) as { project_id: string } | undefined;
    if (!rel || rel.project_id !== req.project_id) throw new HttpError(400, 'related_requirement_invalid', 'The related requirement must be in the same project');
  }
  const id = newId('flg');
  db.prepare('INSERT INTO requirement_flags (id, requirement_id, type, note, related_requirement_id, raised_by, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    requirementId,
    v.type,
    v.note,
    v.relatedRequirementId ?? null,
    actor,
    'open',
    nowIso(),
  );
  return flagDto(db.prepare('SELECT * FROM requirement_flags WHERE id = ?').get(id) as Row);
}

export function resolveFlag(db: DB, flagId: string, input: unknown, actor: Actor): FlagDTO {
  needHuman(actor);
  const v = parse(FlagResolution, input);
  const f = db.prepare('SELECT * FROM requirement_flags WHERE id = ?').get(flagId) as Row | undefined;
  if (!f) throw new HttpError(404, 'flag_not_found');
  if (f.status !== 'open') throw new HttpError(409, 'flag_not_open');
  void FLAG_STATUSES;
  db.prepare('UPDATE requirement_flags SET status = ?, resolved_at = ?, resolved_note = ? WHERE id = ?').run(v.status, nowIso(), v.note ?? null, flagId);
  return flagDto(db.prepare('SELECT * FROM requirement_flags WHERE id = ?').get(flagId) as Row);
}

/**
 * Deterministic ambiguity checks over every requirement of a project. Hints become OPEN flags
 * (raised_by "system") that a person resolves or dismisses; a hint that was dismissed or resolved is
 * never raised again (unique marker), and re-running is harmless.
 */
export function runRequirementChecks(db: DB, projectId: string, actor: Actor = 'human'): { requirementsChecked: number; raised: number } {
  needHuman(actor);
  requireProject(db, projectId);
  const reqs = db.prepare('SELECT id, title, text FROM requirements WHERE project_id = ?').all(projectId) as Array<{ id: string; title: string; text: string }>;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO requirement_flags (id, requirement_id, type, note, raised_by, marker, status, created_at) VALUES (?, ?, 'ambiguity', ?, 'system', ?, 'open', ?)`,
  );
  let raised = 0;
  db.transaction(() => {
    for (const r of reqs) {
      for (const f of analyzeRequirement(r.text || r.title)) {
        raised += ins.run(newId('flg'), r.id, `${f.term}: ${f.note}`, `hint:${f.kind}:${f.term.toLowerCase()}`, nowIso()).changes;
      }
    }
  })();
  return { requirementsChecked: reqs.length, raised };
}

// ---------------------------------------------------------------------------- test cases
/** Fingerprint of everything a reviewer reads: an edit changes it, so an older review is shown as outdated. */
export function testCaseContentHash(r: Row): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([r.title, r.scenario, r.description, r.preconditions, r.steps_json, r.test_data, r.expected_result]))
    .digest('hex');
}

const TC_SELECT = `SELECT t.*,
    (SELECT json_object('verdict', v.verdict, 'by', v.reviewer_name, 'at', v.created_at, 'notes', v.notes, 'hash', v.subject_hash)
       FROM agent_reviews v WHERE v.subject_id = t.id ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1) AS latest_review,
    (SELECT group_concat(x.requirement_id, ',') FROM test_case_requirements x WHERE x.test_case_id = t.id) AS req_ids,
    (SELECT group_concat(r.ref, char(31)) FROM test_case_requirements x JOIN requirements r ON r.id = x.requirement_id WHERE x.test_case_id = t.id) AS req_refs,
    COALESCE(
      (SELECT e.status FROM test_executions e WHERE e.test_case_id = t.id AND e.status IN ('passed','failed','blocked','skipped') ORDER BY e.completed_at DESC, e.rowid DESC LIMIT 1),
      (SELECT e.status FROM test_executions e WHERE e.test_case_id = t.id AND e.status = 'in_progress' LIMIT 1)
    ) AS exec_status
  FROM test_cases t`;

function reviewOf(r: Row): ReviewSummary | null {
  if (!r.latest_review) return null;
  try {
    const v = JSON.parse(r.latest_review as string) as { verdict: ReviewSummary['verdict']; by: string; at: string; notes: string; hash: string };
    return { verdict: v.verdict, by: v.by, at: v.at, notes: v.notes, current: v.hash === testCaseContentHash(r) };
  } catch {
    return null;
  }
}

function tcDto(r: Row): TestCaseDTO {
  let steps: string[] = [];
  try {
    steps = JSON.parse(r.steps_json as string) as string[];
  } catch {
    steps = [];
  }
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    code: r.code as string,
    externalId: (r.external_id as string) ?? '',
    draftedBy: (r.drafted_by_name as string) ?? '',
    review: reviewOf(r),
    scenario: r.scenario as string,
    title: r.title as string,
    description: r.description as string,
    preconditions: r.preconditions as string,
    steps,
    testData: r.test_data as string,
    expectedResult: r.expected_result as string,
    priority: r.priority as string,
    testType: r.test_type as string,
    assignedTester: r.assigned_tester as string,
    requirementIds: r.req_ids ? (r.req_ids as string).split(',') : [],
    requirementRefs: r.req_refs ? (r.req_refs as string).split('\u001f') : [],
    status: r.status as TestCaseStatus,
    authoredBy: r.authored_by as string,
    approvedBy: (r.approved_by as string) ?? null,
    approvedAt: (r.approved_at as string) ?? null,
    rejectionNote: r.rejection_note as string,
    version: r.version as number,
    executionStatus: r.exec_status ? (r.exec_status as string).replace('_', ' ').toUpperCase() : 'NOT RUN',
    archived: r.archived === 1,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function loadTestCase(db: DB, id: string): TestCaseDTO {
  const r = db.prepare(`${TC_SELECT} WHERE t.id = ?`).get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'test_case_not_found');
  return tcDto(r);
}

function assertRequirementsInProject(db: DB, projectId: string, ids: string[]) {
  const q = db.prepare('SELECT project_id FROM requirements WHERE id = ?');
  for (const id of ids) {
    const r = q.get(id) as { project_id: string } | undefined;
    if (!r || r.project_id !== projectId) throw new HttpError(400, 'requirement_not_in_project', 'Every linked requirement must exist in this project');
  }
}

function addHistory(
  db: DB,
  testCaseId: string,
  e: { actor: Actor; action: string; from?: string | null; to?: string | null; note?: string; changes?: Record<string, unknown> },
) {
  db.prepare('INSERT INTO test_case_history (id, test_case_id, at, actor, action, from_status, to_status, note, changes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    newId('hst'),
    testCaseId,
    nowIso(),
    e.actor,
    e.action,
    e.from ?? null,
    e.to ?? null,
    e.note ?? '',
    JSON.stringify(e.changes ?? {}),
  );
}

const cleanSteps = (steps: string[]) => steps.map((s) => s.trim()).filter(Boolean);

/** Inserts one DRAFT test case (call inside a transaction). Never approved: approval is a separate human-only step. */
function insertDraft(db: DB, projectId: string, v: z.infer<typeof TestCaseFields>, actor: Actor, extra: { externalId?: string; action?: string; note?: string; draftedBy?: { name: string; runId: string } } = {}): string {
  const id = newId('tc');
  const ts = nowIso();
  const seq = ((db.prepare('SELECT MAX(seq) AS m FROM test_cases WHERE project_id = ?').get(projectId) as { m: number | null }).m ?? 0) + 1;
  db.prepare(
    `INSERT INTO test_cases (id, project_id, seq, code, external_id, drafted_by_name, drafted_by_run, scenario, title, description, preconditions, steps_json, test_data, expected_result, priority, test_type,
       assigned_tester, status, authored_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
  ).run(id, projectId, seq, `TC-${String(seq).padStart(4, '0')}`, extra.externalId ?? '', extra.draftedBy?.name ?? '', extra.draftedBy?.runId ?? null, v.scenario, v.title, v.description, v.preconditions, JSON.stringify(cleanSteps(v.steps)), v.testData, v.expectedResult, v.priority, v.testType, v.assignedTester, actor, ts, ts);
  const link = db.prepare('INSERT OR IGNORE INTO test_case_requirements (test_case_id, requirement_id) VALUES (?, ?)');
  for (const rid of v.requirementIds) link.run(id, rid);
  addHistory(db, id, { actor, action: extra.action ?? 'created', to: 'draft', note: extra.note });
  return id;
}

export function createTestCase(db: DB, projectId: string, input: unknown, actor: Actor, draftedBy?: { name: string; runId: string }): TestCaseDTO {
  if (actor === 'system') needHuman(actor);
  const v = parse(TestCaseFields, input);
  requireProject(db, projectId);
  assertRequirementsInProject(db, projectId, v.requirementIds);
  const id = db.transaction(() => insertDraft(db, projectId, v, actor, { draftedBy }))();
  return loadTestCase(db, id);
}

// ---------------------------------------------------------------------------- import test cases from a table
const TestCaseImportInput = z.object({ text: z.string().max(400_000), dryRun: z.boolean().default(false) }).strict();

export interface TestCaseImportResult {
  dryRun: boolean;
  format: string;
  total: number;
  wouldCreate: Array<{ row: number; externalId: string; title: string }>;
  created: number;
  skippedExisting: string[];
  duplicatesInText: string[];
  rowErrors: Array<{ row: number; reason: string }>;
  warnings: Array<{ row: number; text: string }>;
  columns: { recognised: string[]; ignored: string[]; unknown: string[] };
  rowsWithoutId: number;
  truncated: boolean;
}

/**
 * Imports test cases from a Markdown table or a table pasted from a spreadsheet. HUMAN only. Every imported case
 * is a DRAFT authored by the person (never approved, never given a result): approval and execution stay human
 * steps afterwards. Re-importing is safe: a row whose Test Case ID already exists in the project is skipped.
 */
export function importTestCases(db: DB, projectId: string, input: unknown, actor: Actor): TestCaseImportResult {
  needHuman(actor);
  const v = parse(TestCaseImportInput, input);
  requireProject(db, projectId);
  const parsed = parseTestCaseTable(v.text);
  if (parsed.missingDescriptionColumn) throw new HttpError(400, 'missing_column', 'The table needs a "Test Case Description" column');
  if (parsed.rows.length === 0 && parsed.rowErrors.length === 0) {
    throw new HttpError(400, 'nothing_to_import', 'No test cases were found: paste a Markdown table (or cells copied from a spreadsheet) with a header row');
  }
  const reqByRef = new Map<string, string>(
    (db.prepare('SELECT id, ref FROM requirements WHERE project_id = ?').all(projectId) as Array<{ id: string; ref: string }>).map((r) => [r.ref.toLowerCase(), r.id]),
  );
  const existingIds = new Set(
    (db.prepare("SELECT lower(external_id) AS e FROM test_cases WHERE project_id = ? AND external_id <> ''").all(projectId) as Array<{ e: string }>).map((r) => r.e),
  );
  const seen = new Set<string>();
  const skippedExisting: string[] = [];
  const duplicatesInText: string[] = [];
  const rowErrors = [...parsed.rowErrors];
  const warnings: Array<{ row: number; text: string }> = [];
  const todo: Array<{ row: number; externalId: string; input: z.infer<typeof TestCaseFields> }> = [];
  let rowsWithoutId = 0;
  for (const r of parsed.rows) {
    for (const w of r.warnings) warnings.push({ row: r.row, text: w });
    const key = r.externalId.toLowerCase();
    if (key) {
      if (existingIds.has(key)) {
        skippedExisting.push(r.externalId);
        continue;
      }
      if (seen.has(key)) {
        duplicatesInText.push(r.externalId);
        continue;
      }
      seen.add(key);
    } else rowsWithoutId++;
    const requirementIds: string[] = [];
    for (const ref of r.requirementRefs) {
      const rid = reqByRef.get(ref.toLowerCase());
      if (rid) requirementIds.push(rid);
      else warnings.push({ row: r.row, text: `Requirement "${ref.slice(0, 40)}" does not exist in this project, so it was not linked` });
    }
    const parsedCase = TestCaseFields.safeParse({
      scenario: clipText([r.module, r.subModule].filter(Boolean).join(' › '), 200),
      title: r.title,
      description: clipText(r.description, 10_000),
      preconditions: clipText(r.preconditions, 5_000),
      steps: r.steps.slice(0, 100).map((s) => clipText(s, 2_000)),
      testData: clipText(r.testData, 10_000),
      expectedResult: clipText(r.expectedResult, 10_000),
      priority: r.priority,
      testType: r.testType,
      assignedTester: r.assignedTester,
      requirementIds,
    });
    if (!parsedCase.success) rowErrors.push({ row: r.row, reason: 'The row could not be read as a test case' });
    else todo.push({ row: r.row, externalId: r.externalId, input: parsedCase.data });
  }
  let created = 0;
  if (!v.dryRun && todo.length) {
    db.transaction(() => {
      for (const t of todo) {
        insertDraft(db, projectId, t.input, 'human', { externalId: t.externalId, action: 'imported', note: `Imported from a table (row ${t.row})` });
        created++;
      }
    })();
  }
  return {
    dryRun: v.dryRun,
    format: parsed.format,
    total: parsed.rows.length + parsed.rowErrors.length,
    wouldCreate: todo.map((t) => ({ row: t.row, externalId: t.externalId, title: t.input.title })),
    created,
    skippedExisting,
    duplicatesInText,
    rowErrors,
    warnings,
    columns: parsed.columns,
    rowsWithoutId,
    truncated: parsed.truncated,
  };
}
const clipText = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

const SHORT_FIELDS = new Set(['title', 'scenario', 'priority', 'testType', 'assignedTester']);

export function updateTestCase(db: DB, id: string, patch: unknown, actor: Actor): TestCaseDTO {
  const v = parse(TestCasePatch, patch);
  const cur = loadTestCase(db, id);
  if (actor === 'system') needHuman(actor);
  if (actor === 'agent' && !(cur.authoredBy === 'agent' && cur.status === 'draft')) throw new HttpError(403, 'human_required', 'An agent may edit only its own drafts');
  if (cur.archived) throw new HttpError(409, 'archived', 'Restore the test case before editing it');
  if (v.requirementIds) assertRequirementsInProject(db, cur.projectId, v.requirementIds);

  const next: Record<string, unknown> = {
    scenario: v.scenario ?? cur.scenario,
    title: v.title ?? cur.title,
    description: v.description ?? cur.description,
    preconditions: v.preconditions ?? cur.preconditions,
    steps: v.steps ? cleanSteps(v.steps) : cur.steps,
    testData: v.testData ?? cur.testData,
    expectedResult: v.expectedResult ?? cur.expectedResult,
    priority: v.priority ?? cur.priority,
    testType: v.testType ?? cur.testType,
    assignedTester: v.assignedTester ?? cur.assignedTester,
  };
  const changes: Record<string, unknown> = {};
  for (const k of Object.keys(next)) {
    if (JSON.stringify(next[k]) === JSON.stringify((cur as unknown as Record<string, unknown>)[k])) continue;
    changes[k] = SHORT_FIELDS.has(k) ? { from: (cur as unknown as Record<string, unknown>)[k], to: next[k] } : { changed: true };
  }
  const newLinks = v.requirementIds ? [...new Set(v.requirementIds)] : null;
  if (newLinks && JSON.stringify([...newLinks].sort()) !== JSON.stringify([...cur.requirementIds].sort())) {
    changes.requirementIds = { changed: true, count: newLinks.length };
  }
  if (Object.keys(changes).length === 0) return cur;

  const leavingReview = cur.status !== 'draft';
  db.transaction(() => {
    db.prepare(
      `UPDATE test_cases SET scenario = ?, title = ?, description = ?, preconditions = ?, steps_json = ?, test_data = ?, expected_result = ?, priority = ?,
         test_type = ?, assigned_tester = ?, status = 'draft', approved_by = NULL, approved_at = NULL, version = version + ?, updated_at = ? WHERE id = ?`,
    ).run(next.scenario, next.title, next.description, next.preconditions, JSON.stringify(next.steps), next.testData, next.expectedResult, next.priority, next.testType, next.assignedTester, leavingReview ? 1 : 0, nowIso(), id);
    if (newLinks) {
      db.prepare('DELETE FROM test_case_requirements WHERE test_case_id = ?').run(id);
      const link = db.prepare('INSERT INTO test_case_requirements (test_case_id, requirement_id) VALUES (?, ?)');
      for (const rid of newLinks) link.run(id, rid);
    }
    addHistory(db, id, { actor, action: 'edited', from: cur.status, to: 'draft', changes });
  })();
  return loadTestCase(db, id);
}

export function transitionTestCase(db: DB, id: string, to: string, note: string, actor: Actor): TestCaseDTO {
  if (!(TEST_CASE_STATUSES as readonly string[]).includes(to)) throw new HttpError(400, 'invalid_status');
  needHuman(actor);
  const cur = loadTestCase(db, id);
  if (cur.archived) throw new HttpError(409, 'archived', 'Restore the test case before changing its status');
  const target = to as TestCaseStatus;
  if (!canTransition(cur.status, target)) throw new HttpError(409, 'invalid_transition', `A ${cur.status} test case cannot become ${target}`);
  const trimmed = (note ?? '').trim();
  if (target === 'approved') {
    const missing = validateForApproval({ title: cur.title, steps: cur.steps, expectedResult: cur.expectedResult });
    if (missing.length) throw new HttpError(422, 'approval_requirements_missing', missing.join(','));
  }
  if (target === 'rejected' && !trimmed) throw new HttpError(400, 'note_required', 'Say why the test case is rejected');
  const ts = nowIso();
  db.transaction(() => {
    db.prepare(
      `UPDATE test_cases SET status = ?, approved_by = ?, approved_at = ?, rejection_note = ?, updated_at = ? WHERE id = ?`,
    ).run(
      target,
      target === 'approved' ? 'human' : null,
      target === 'approved' ? ts : null,
      target === 'rejected' ? trimmed : target === 'in_review' ? '' : cur.rejectionNote,
      ts,
      id,
    );
    addHistory(db, id, { actor, action: 'transition', from: cur.status, to: target, note: trimmed });
  })();
  return loadTestCase(db, id);
}

export function setArchived(db: DB, id: string, archived: boolean, actor: Actor): TestCaseDTO {
  needHuman(actor);
  const cur = loadTestCase(db, id);
  if (cur.archived === archived) return cur;
  db.transaction(() => {
    db.prepare('UPDATE test_cases SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, nowIso(), id);
    addHistory(db, id, { actor, action: archived ? 'archived' : 'restored' });
  })();
  return loadTestCase(db, id);
}

export interface TestCaseFilters {
  projectId: string;
  status?: string;
  testType?: string;
  priority?: string;
  requirementId?: string;
  authoredBy?: string;
  q?: string;
  includeArchived?: boolean;
  /** By the latest reviewer recommendation: recommend_approve | changes_requested | outdated | unreviewed. */
  review?: string;
}

export function listTestCases(db: DB, f: TestCaseFilters): TestCaseDTO[] {
  const where = ['t.project_id = ?'];
  const args: unknown[] = [f.projectId];
  if (!f.includeArchived) where.push('t.archived = 0');
  const filter = (clause: string, value: string | undefined) => {
    if (value) {
      where.push(clause);
      args.push(value);
    }
  };
  filter('t.status = ?', f.status);
  filter('t.test_type = ?', f.testType);
  filter('t.priority = ?', f.priority);
  filter('t.authored_by = ?', f.authoredBy);
  filter('EXISTS (SELECT 1 FROM test_case_requirements x WHERE x.test_case_id = t.id AND x.requirement_id = ?)', f.requirementId);
  if (f.q?.trim()) {
    const like = `%${f.q.trim().toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push("(lower(t.title) LIKE ? ESCAPE '\\' OR lower(t.scenario) LIKE ? ESCAPE '\\' OR lower(t.description) LIKE ? ESCAPE '\\' OR lower(t.code) LIKE ? ESCAPE '\\' OR lower(t.external_id) LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like, like);
  }
  const all = (db.prepare(`${TC_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.seq`).all(...args) as Row[]).map(tcDto);
  const want = (REVIEW_FILTERS as readonly string[]).includes(f.review ?? '') ? f.review : undefined;
  if (!want) return all;
  return all.filter((t) => {
    if (want === 'unreviewed') return t.review === null;
    if (want === 'outdated') return t.review !== null && !t.review.current;
    return t.review !== null && t.review.current && t.review.verdict === want;
  });
}

export function getTestCase(db: DB, id: string): TestCaseDetailDTO {
  const tc = loadTestCase(db, id);
  const requirements = db
    .prepare('SELECT r.id, r.ref, r.title FROM test_case_requirements x JOIN requirements r ON r.id = x.requirement_id WHERE x.test_case_id = ? ORDER BY r.ref')
    .all(id) as Array<{ id: string; ref: string; title: string }>;
  const history = (db.prepare('SELECT * FROM test_case_history WHERE test_case_id = ? ORDER BY at, rowid').all(id) as Row[]).map(
    (h): HistoryDTO => ({
      id: h.id as string,
      at: h.at as string,
      actor: h.actor as string,
      action: h.action as string,
      fromStatus: (h.from_status as string) ?? null,
      toStatus: (h.to_status as string) ?? null,
      note: h.note as string,
      changes: JSON.parse(h.changes_json as string) as Record<string, unknown>,
    }),
  );
  return { ...tc, requirements, history, replies: repliesSinceReview(db, id) };
}

export const MAX_REPLY = 1_000;

/** What the writer answered to the latest review, since that review. Empty when there is no review. */
export function repliesSinceReview(db: DB, testCaseId: string): ReplyDTO[] {
  const tc = loadTestCase(db, testCaseId);
  if (!tc.review) return [];
  return (
    db.prepare("SELECT at, note, changes_json FROM test_case_history WHERE test_case_id = ? AND action = 'reply_to_review' AND at >= ? ORDER BY at, rowid").all(testCaseId, tc.review.at) as Array<{ at: string; note: string; changes_json: string }>
  ).map((h) => ({ by: String((JSON.parse(h.changes_json) as { by?: string }).by ?? ''), at: h.at, note: h.note }));
}

/**
 * A named writer agent answers the reviewer's latest review (for example why it did not change something). Saved in the
 * append-only history with the agent's name; redacted and capped. It decides nothing and changes nothing else.
 */
export function addReplyToReview(db: DB, testCaseId: string, agentName: string, note: string): ReplyDTO {
  const tc = loadTestCase(db, testCaseId);
  if (!tc.review) throw new HttpError(409, 'no_review_to_reply_to', 'There is no review on this test case to answer.');
  const text = redact(note).trim().slice(0, MAX_REPLY);
  if (!text) throw new HttpError(400, 'invalid_input', 'The reply is empty.');
  const at = nowIso();
  db.prepare('INSERT INTO test_case_history (id, test_case_id, at, actor, action, from_status, to_status, note, changes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    newId('hst'),
    testCaseId,
    at,
    'agent',
    'reply_to_review',
    null,
    null,
    text,
    JSON.stringify({ by: agentName, reviewBy: tc.review.by }),
  );
  return { by: agentName, at, note: text };
}

// ---------------------------------------------------------------------------- traceability
export interface TraceRow {
  requirementId: string;
  ref: string;
  title: string;
  reviewStatus: string;
  openFlags: number;
  testCases: Array<{ id: string; code: string; title: string; status: string }>;
  covered: 'approved' | 'unapproved' | 'none';
}
export interface Traceability {
  rows: TraceRow[];
  summary: {
    requirements: number;
    testCases: number;
    requirementsWithApprovedTestCase: Ratio;
    requirementsWithAnyTestCase: Ratio;
    untracedTestCases: number;
    formulas: { approved: string; any: string };
  };
}

export function traceability(db: DB, projectId: string): Traceability {
  requireProject(db, projectId);
  const reqs = listRequirements(db, projectId);
  const links = db
    .prepare(
      `SELECT x.requirement_id AS rid, t.id, t.code, t.title, t.status FROM test_case_requirements x JOIN test_cases t ON t.id = x.test_case_id
       WHERE t.project_id = ? AND t.archived = 0 ORDER BY t.seq`,
    )
    .all(projectId) as Array<{ rid: string; id: string; code: string; title: string; status: string }>;
  const rows: TraceRow[] = reqs.map((r) => {
    const testCases = links.filter((l) => l.rid === r.id).map(({ id: tid, code, title, status }) => ({ id: tid, code, title, status }));
    return {
      requirementId: r.id,
      ref: r.ref,
      title: r.title,
      reviewStatus: r.reviewStatus,
      openFlags: r.openFlags,
      testCases,
      covered: testCases.some((t) => t.status === 'approved') ? 'approved' : testCases.length ? 'unapproved' : 'none',
    };
  });
  const totalCases = (db.prepare('SELECT COUNT(*) AS c FROM test_cases WHERE project_id = ? AND archived = 0').get(projectId) as { c: number }).c;
  const untraced = (db
    .prepare('SELECT COUNT(*) AS c FROM test_cases t WHERE t.project_id = ? AND t.archived = 0 AND NOT EXISTS (SELECT 1 FROM test_case_requirements x WHERE x.test_case_id = t.id)')
    .get(projectId) as { c: number }).c;
  return {
    rows,
    summary: {
      requirements: reqs.length,
      testCases: totalCases,
      requirementsWithApprovedTestCase: coverageRatio(rows.filter((r) => r.covered === 'approved').length, reqs.length),
      requirementsWithAnyTestCase: coverageRatio(rows.filter((r) => r.covered !== 'none').length, reqs.length),
      untracedTestCases: untraced,
      formulas: {
        approved: 'Requirements with at least one approved, non-archived test case, divided by all requirements in the project.',
        any: 'Requirements with at least one non-archived test case (any status), divided by all requirements in the project.',
      },
    },
  };
}

/** Counts for the Overview KPIs (real records only). */
/** The same figures for one project (Project Room). */
export function projectQaSummary(db: DB, projectId: string) {
  const c = (sql: string) => (db.prepare(sql).get(projectId) as { c: number }).c;
  return {
    requirements: c('SELECT COUNT(*) AS c FROM requirements WHERE project_id = ?'),
    testCases: c('SELECT COUNT(*) AS c FROM test_cases WHERE project_id = ? AND archived = 0'),
    approvedTestCases: c("SELECT COUNT(*) AS c FROM test_cases WHERE project_id = ? AND archived = 0 AND status = 'approved'"),
    execution: executionSummary(db, projectId),
    defects: defectSummary(db, projectId),
    tasks: taskSummary(db, projectId),
  };
}

export function qaSummary(db: DB): { requirements: number; testCases: number; testCasesAwaitingReview: number; execution: ExecutionSummary; defects: DefectSummary; tasks: { total: number; open: number; blocked: number } } {
  const c = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    requirements: c('SELECT COUNT(*) AS c FROM requirements'),
    testCases: c('SELECT COUNT(*) AS c FROM test_cases WHERE archived = 0'),
    testCasesAwaitingReview: c("SELECT COUNT(*) AS c FROM test_cases WHERE archived = 0 AND status = 'in_review'"),
    execution: executionSummary(db),
    defects: defectSummary(db),
    tasks: taskSummary(db),
  };
}
