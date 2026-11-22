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
import { z } from 'zod';
import {
  analyzeRequirement,
  canTransition,
  coverageRatio,
  FLAG_STATUSES,
  FLAG_TYPES,
  inferKind,
  parseRequirements,
  PRIORITIES,
  REQUIREMENT_KINDS,
  REVIEW_STATUSES,
  TEST_CASE_STATUSES,
  TEST_TYPES,
  validateForApproval,
  type Actor,
  type Ratio,
  type TestCaseStatus,
} from '@qavo/shared';
import type { DB } from './db/index.ts';
import { executionSummary, type ExecutionSummary } from './qaExec.ts';
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
export interface TestCaseDTO {
  id: string;
  projectId: string;
  code: string;
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
export interface TestCaseDetailDTO extends TestCaseDTO {
  requirements: Array<{ id: string; ref: string; title: string }>;
  history: HistoryDTO[];
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
const TC_SELECT = `SELECT t.*,
    (SELECT group_concat(x.requirement_id, ',') FROM test_case_requirements x WHERE x.test_case_id = t.id) AS req_ids,
    (SELECT group_concat(r.ref, char(31)) FROM test_case_requirements x JOIN requirements r ON r.id = x.requirement_id WHERE x.test_case_id = t.id) AS req_refs,
    COALESCE(
      (SELECT e.status FROM test_executions e WHERE e.test_case_id = t.id AND e.status IN ('passed','failed','blocked','skipped') ORDER BY e.completed_at DESC, e.rowid DESC LIMIT 1),
      (SELECT e.status FROM test_executions e WHERE e.test_case_id = t.id AND e.status = 'in_progress' LIMIT 1)
    ) AS exec_status
  FROM test_cases t`;

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

export function createTestCase(db: DB, projectId: string, input: unknown, actor: Actor): TestCaseDTO {
  if (actor === 'system') needHuman(actor);
  const v = parse(TestCaseFields, input);
  requireProject(db, projectId);
  assertRequirementsInProject(db, projectId, v.requirementIds);
  const id = newId('tc');
  const ts = nowIso();
  db.transaction(() => {
    const seq = ((db.prepare('SELECT MAX(seq) AS m FROM test_cases WHERE project_id = ?').get(projectId) as { m: number | null }).m ?? 0) + 1;
    db.prepare(
      `INSERT INTO test_cases (id, project_id, seq, code, scenario, title, description, preconditions, steps_json, test_data, expected_result, priority, test_type,
         assigned_tester, status, authored_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    ).run(id, projectId, seq, `TC-${String(seq).padStart(4, '0')}`, v.scenario, v.title, v.description, v.preconditions, JSON.stringify(cleanSteps(v.steps)), v.testData, v.expectedResult, v.priority, v.testType, v.assignedTester, actor, ts, ts);
    const link = db.prepare('INSERT OR IGNORE INTO test_case_requirements (test_case_id, requirement_id) VALUES (?, ?)');
    for (const rid of v.requirementIds) link.run(id, rid);
    addHistory(db, id, { actor, action: 'created', to: 'draft' });
  })();
  return loadTestCase(db, id);
}

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
    where.push("(lower(t.title) LIKE ? ESCAPE '\\' OR lower(t.scenario) LIKE ? ESCAPE '\\' OR lower(t.description) LIKE ? ESCAPE '\\' OR lower(t.code) LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  return (db.prepare(`${TC_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.seq`).all(...args) as Row[]).map(tcDto);
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
  return { ...tc, requirements, history };
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
export function qaSummary(db: DB): { requirements: number; testCases: number; testCasesAwaitingReview: number; execution: ExecutionSummary } {
  const c = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    requirements: c('SELECT COUNT(*) AS c FROM requirements'),
    testCases: c('SELECT COUNT(*) AS c FROM test_cases WHERE archived = 0'),
    testCasesAwaitingReview: c("SELECT COUNT(*) AS c FROM test_cases WHERE archived = 0 AND status = 'in_review'"),
    execution: executionSummary(db),
  };
}
