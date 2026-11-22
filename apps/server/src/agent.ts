/**
 * Agent surface (Pass 2D): the ONLY thing a Claude Code agent can do to QA data, through the local MCP server.
 *
 * Rules, enforced here and in the services below it:
 *  - every call acts as the limited "agent" identity: it can draft, report, comment and note, never approve,
 *    pass, close, complete, reject, archive or delete (those tools do not exist, and the services refuse
 *    the agent actor even if called)
 *  - access is OFF until the person turns it on, and the person can revoke the token at any time
 *  - agents address projects by their safe alias, and entities by code (TC-0001, DEF-001...); no paths, no ids
 *  - everything an agent reads is redacted again on the way out
 *  - an audit row (tool, project, outcome; never the content) is written for every call
 */
import { z } from 'zod';
import { redactObject, type Actor } from '@qavo/shared';
import type { DB } from './db/index.ts';
import * as qa from './qa.ts';
import * as df from './qaDefects.ts';
import * as ex from './qaExec.ts';
import * as wk from './qaWork.ts';
import { getSetting, HttpError, newId, setSetting } from './store.ts';

const AGENT: Actor = 'agent';
const LIST_CAP = 200;

// ---------------------------------------------------------------------------- tiny schema DSL (one source for zod AND the JSON schema MCP clients see)
type Field =
  | { kind: 'string'; desc: string; req?: boolean; max?: number; enum?: readonly string[] }
  | { kind: 'strings'; desc: string; req?: boolean; maxItems?: number; maxLen?: number }
  | { kind: 'bool'; desc: string }
  | { kind: 'int'; desc: string; min: number; max: number };
type Fields = Record<string, Field>;

const str = (desc: string, o: { req?: boolean; max?: number; enum?: readonly string[] } = {}): Field => ({ kind: 'string', desc, ...o });
const strs = (desc: string, o: { req?: boolean; maxItems?: number; maxLen?: number } = {}): Field => ({ kind: 'strings', desc, ...o });

function toZod(fields: Fields) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [k, f] of Object.entries(fields)) {
    let t: z.ZodTypeAny;
    if (f.kind === 'string') t = f.enum ? z.enum(f.enum as [string, ...string[]]) : z.string().max(f.max ?? 5_000);
    else if (f.kind === 'strings') t = z.array(z.string().max(f.maxLen ?? 2_000)).max(f.maxItems ?? 100);
    else if (f.kind === 'bool') t = z.boolean();
    else t = z.number().int().min(f.min).max(f.max);
    const required = 'req' in f && f.req === true;
    shape[k] = required ? t : t.optional();
  }
  return z.object(shape).strict();
}
function toJsonSchema(fields: Fields) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [k, f] of Object.entries(fields)) {
    if (f.kind === 'string') properties[k] = { type: 'string', description: f.desc, ...(f.enum ? { enum: [...f.enum] } : { maxLength: f.max ?? 5_000 }) };
    else if (f.kind === 'strings') properties[k] = { type: 'array', items: { type: 'string' }, description: f.desc, maxItems: f.maxItems ?? 100 };
    else if (f.kind === 'bool') properties[k] = { type: 'boolean', description: f.desc };
    else properties[k] = { type: 'integer', description: f.desc, minimum: f.min, maximum: f.max };
    if ('req' in f && f.req) required.push(k);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

// ---------------------------------------------------------------------------- lookups by alias and code (no internal ids, no paths)
interface Ctx {
  db: DB;
  projectId: string;
}
function projectIdOf(db: DB, alias: string): string {
  const r = db.prepare('SELECT id FROM projects WHERE lower(alias) = lower(?) AND archived = 0').get(alias.trim()) as { id: string } | undefined;
  if (!r) throw new HttpError(404, 'project_not_found', 'No registered project has that name. Use qa_list_projects.');
  return r.id;
}
const numberOf = (code: string, prefix: string): number => {
  const m = new RegExp(`^${prefix}-(\\d+)$`, 'i').exec(code.trim());
  if (!m) throw new HttpError(400, 'invalid_input', `Expected a code like ${prefix}-001`);
  return Number(m[1]);
};
function idByCode(ctx: Ctx, table: 'defects' | 'tasks' | 'exploratory_sessions' | 'test_runs', prefix: string, code: string, notFound: string): string {
  const r = ctx.db.prepare(`SELECT id FROM ${table} WHERE project_id = ? AND seq = ?`).get(ctx.projectId, numberOf(code, prefix)) as { id: string } | undefined;
  if (!r) throw new HttpError(404, notFound);
  return r.id;
}
function testCaseId(ctx: Ctx, code: string): string {
  const r = ctx.db.prepare('SELECT id FROM test_cases WHERE project_id = ? AND lower(code) = lower(?)').get(ctx.projectId, code.trim()) as { id: string } | undefined;
  if (!r) throw new HttpError(404, 'test_case_not_found');
  return r.id;
}
function requirementId(ctx: Ctx, ref: string): string {
  const r = ctx.db.prepare('SELECT id FROM requirements WHERE project_id = ? AND lower(ref) = lower(?)').get(ctx.projectId, ref.trim()) as { id: string } | undefined;
  if (!r) throw new HttpError(404, 'requirement_not_found', `No requirement ${ref}`);
  return r.id;
}
function executionId(ctx: Ctx, runCode: string, tcCode: string): string {
  const runId = idByCode(ctx, 'test_runs', 'RUN', runCode, 'run_not_found');
  const r = ctx.db.prepare('SELECT id FROM test_executions WHERE run_id = ? AND test_case_id = ?').get(runId, testCaseId(ctx, tcCode)) as { id: string } | undefined;
  if (!r) throw new HttpError(404, 'execution_not_found', 'That test case is not in that run');
  return r.id;
}
const cap = <T>(rows: T[]): { items: T[]; truncated: boolean } => ({ items: rows.slice(0, LIST_CAP), truncated: rows.length > LIST_CAP });

// ---------------------------------------------------------------------------- tools
interface Tool {
  name: string;
  description: string;
  fields: Fields;
  /** False for tools that do not take a project (qa_list_projects). */
  project?: boolean;
  run: (ctx: Ctx, args: Record<string, unknown>) => unknown;
}
const PROJECT = str('Project name exactly as shown in Project Rooms (the safe alias)', { req: true, max: 100 });
const TC_TYPES = ['positive', 'negative', 'boundary_value', 'equivalence_partitioning', 'decision_table', 'state_transition', 'exploratory', 'regression', 'integration', 'end_to_end'] as const;
const SEVERITY = ['critical', 'major', 'minor', 'trivial'] as const;
const PRIORITY = ['critical', 'high', 'medium', 'low'] as const;
const s = <T>(v: unknown) => v as T;

const TOOLS: Tool[] = [
  {
    name: 'qa_list_projects',
    description: 'List the registered QA projects you may work in (names only).',
    fields: {},
    project: false,
    run: ({ db }) => ({ projects: (db.prepare('SELECT alias, description, type FROM projects WHERE archived = 0 ORDER BY alias').all() as Array<Record<string, unknown>>).slice(0, LIST_CAP) }),
  },
  {
    name: 'qa_get_summary',
    description: 'Current QA figures for a project: requirements, test cases by status, latest results, defects, tasks. Read-only.',
    fields: { project: PROJECT },
    run: ({ db, projectId }) => {
      const byStatus = db.prepare('SELECT status, COUNT(*) AS c FROM test_cases WHERE project_id = ? AND archived = 0 GROUP BY status').all(projectId);
      return {
        requirements: (db.prepare('SELECT COUNT(*) AS c FROM requirements WHERE project_id = ?').get(projectId) as { c: number }).c,
        testCasesByStatus: byStatus,
        execution: ex.executionSummary(db, projectId),
        defects: df.defectSummary(db, projectId),
        tasks: wk.taskSummary(db, projectId),
      };
    },
  },
  {
    name: 'qa_list_requirements',
    description: 'List the requirements of a project (reference, title, kind, review status, open flags, test case counts). Read-only.',
    fields: { project: PROJECT },
    run: ({ db, projectId }) =>
      cap(qa.listRequirements(db, projectId).map((r) => ({ ref: r.ref, title: r.title, kind: r.kind, reviewStatus: r.reviewStatus, openFlags: r.openFlags, testCases: r.testCaseCount, approvedTestCases: r.approvedTestCaseCount }))),
  },
  {
    name: 'qa_create_requirement',
    description: 'Propose a requirement (marked as agent-authored). A person reviews it; you cannot mark it reviewed or edit it afterwards.',
    fields: { project: PROJECT, ref: str('Unique reference such as REQ-12', { req: true, max: 40 }), title: str('Short title', { req: true, max: 200 }), text: str('The requirement text', { max: 10_000 }), kind: str('Document kind', { enum: ['brd', 'fsd', 'user_story', 'acceptance_criteria', 'other'] }) },
    run: ({ db, projectId }, a) => {
      const r = qa.createRequirement(db, projectId, { ref: a.ref, title: a.title, text: a.text ?? '', kind: a.kind ?? 'other', source: 'agent' }, AGENT);
      return { ref: r.ref, title: r.title, authoredBy: r.authoredBy };
    },
  },
  {
    name: 'qa_flag_requirement',
    description: 'Raise an ambiguity, gap or conflict flag on a requirement for a person to resolve. You cannot resolve or dismiss flags.',
    fields: { project: PROJECT, ref: str('Requirement reference', { req: true, max: 40 }), type: str('Kind of problem', { req: true, enum: ['ambiguity', 'gap', 'conflict', 'other'] }), note: str('What is unclear or missing', { req: true, max: 2_000 }), relatedRef: str('For a conflict: the other requirement', { max: 40 }) },
    run: (ctx, a) => {
      const f = qa.raiseFlag(ctx.db, requirementId(ctx, s<string>(a.ref)), { type: a.type, note: a.note, ...(a.relatedRef ? { relatedRequirementId: requirementId(ctx, s<string>(a.relatedRef)) } : {}) }, AGENT);
      return { flagged: true, type: f.type, status: f.status };
    },
  },
  {
    name: 'qa_list_test_cases',
    description: 'List test cases of a project (code, title, status, priority, requirement refs, latest result). Read-only.',
    fields: { project: PROJECT, status: str('Filter by status', { enum: ['draft', 'in_review', 'approved', 'rejected'] }) },
    run: ({ db, projectId }, a) =>
      cap(qa.listTestCases(db, { projectId, ...(a.status ? { status: s<string>(a.status) } : {}), includeArchived: false }).map((t) => ({ code: t.code, title: t.title, status: t.status, priority: t.priority, testType: t.testType, requirements: t.requirementRefs, authoredBy: t.authoredBy, latestResult: t.executionStatus }))),
  },
  {
    name: 'qa_get_test_case',
    description: 'Read one test case in full (steps, expected result, linked requirements). Read-only.',
    fields: { project: PROJECT, code: str('Test case code, e.g. TC-0001', { req: true, max: 20 }) },
    run: (ctx, a) => {
      const t = qa.getTestCase(ctx.db, testCaseId(ctx, s<string>(a.code)));
      return { code: t.code, title: t.title, status: t.status, scenario: t.scenario, description: t.description, preconditions: t.preconditions, steps: t.steps, testData: t.testData, expectedResult: t.expectedResult, priority: t.priority, testType: t.testType, requirements: t.requirementRefs, authoredBy: t.authoredBy };
    },
  },
  {
    name: 'qa_create_test_case_draft',
    description: 'Create a DRAFT test case (always a draft, marked agent-authored). A person reviews and approves it; you can neither submit it for review nor approve it. Use fake or masked test data only.',
    fields: {
      project: PROJECT,
      title: str('Test case title', { req: true, max: 200 }),
      steps: strs('Ordered steps, one string each', { req: true, maxItems: 100, maxLen: 2_000 }),
      expectedResult: str('Expected result', { req: true, max: 10_000 }),
      requirementRefs: strs('References of the requirements this covers, e.g. ["FR-01"]', { maxItems: 50, maxLen: 40 }),
      scenario: str('Scenario or feature name', { max: 200 }),
      description: str('Description', { max: 10_000 }),
      preconditions: str('Preconditions', { max: 5_000 }),
      testData: str('Test data (fake or masked only)', { max: 10_000 }),
      priority: str('Priority', { enum: PRIORITY }),
      testType: str('Test type', { enum: TC_TYPES }),
    },
    run: (ctx, a) => {
      const refs = (a.requirementRefs as string[] | undefined) ?? [];
      const { project: _p, requirementRefs: _r, ...fields } = a;
      void _p;
      void _r;
      const t = qa.createTestCase(ctx.db, ctx.projectId, { ...fields, requirementIds: refs.map((r) => requirementId(ctx, r)) }, AGENT);
      return { code: t.code, status: t.status, authoredBy: t.authoredBy };
    },
  },
  {
    name: 'qa_update_test_case_draft',
    description: 'Edit a draft test case that YOU created (not one written by a person, and not once it is in review or approved).',
    fields: { project: PROJECT, code: str('Test case code', { req: true, max: 20 }), title: str('New title', { max: 200 }), steps: strs('Replacement steps', { maxItems: 100, maxLen: 2_000 }), expectedResult: str('New expected result', { max: 10_000 }), description: str('New description', { max: 10_000 }), preconditions: str('New preconditions', { max: 5_000 }), testData: str('New test data', { max: 10_000 }) },
    run: (ctx, a) => {
      const { project: _p, code, ...patch } = a;
      void _p;
      const t = qa.updateTestCase(ctx.db, testCaseId(ctx, s<string>(code)), patch, AGENT);
      return { code: t.code, status: t.status, version: t.version };
    },
  },
  {
    name: 'qa_list_defects',
    description: 'List defects of a project (code, title, severity, status). Read-only.',
    fields: { project: PROJECT, openOnly: { kind: 'bool', desc: 'Only defects that are not closed, rejected or duplicate' } },
    run: ({ db, projectId }, a) => cap(df.listDefects(db, { projectId, openOnly: a.openOnly === true }).map((d) => ({ code: d.code, title: d.title, severity: d.severity, priority: d.priority, status: d.status, testCase: d.testCaseCode, run: d.runCode, reportedBy: d.reportedBy }))),
  },
  {
    name: 'qa_report_defect',
    description: 'Report a defect (status NEW, marked agent-reported). A person decides whether it is real, and only a person can reject, fix-verify or close it. Use fake or masked data only.',
    fields: { project: PROJECT, title: str('Defect title', { req: true, max: 200 }), steps: str('Steps to reproduce', { max: 10_000 }), expectedResult: str('Expected result', { max: 5_000 }), actualResult: str('Actual result', { max: 5_000 }), description: str('Details', { max: 10_000 }), severity: str('Severity', { enum: SEVERITY }), priority: str('Priority', { enum: PRIORITY }), environment: str('Environment', { max: 120 }), build: str('Build', { max: 120 }), testCaseCode: str('Related test case code', { max: 20 }) },
    run: (ctx, a) => {
      const { project: _p, testCaseCode, ...rest } = a;
      void _p;
      const d = df.createDefect(ctx.db, ctx.projectId, { ...rest, ...(testCaseCode ? { testCaseId: testCaseId(ctx, s<string>(testCaseCode)) } : {}) }, AGENT);
      return { code: d.code, status: d.status, reportedBy: d.reportedBy };
    },
  },
  {
    name: 'qa_comment_defect',
    description: 'Add a comment to a defect (for example new reproduction details). You cannot change its status.',
    fields: { project: PROJECT, code: str('Defect code, e.g. DEF-001', { req: true, max: 20 }), note: str('Comment', { req: true, max: 5_000 }) },
    run: (ctx, a) => {
      df.addDefectComment(ctx.db, idByCode(ctx, 'defects', 'DEF', s<string>(a.code), 'defect_not_found'), { note: a.note }, AGENT);
      return { commented: true };
    },
  },
  {
    name: 'qa_set_execution_result',
    description: 'Record that you started a test (in_progress) or that it FAILED or is BLOCKED (a note is required for the last two). You can never mark a test passed or skipped: only a person can. Recorded as agent-assisted.',
    fields: { project: PROJECT, runCode: str('Test run code, e.g. RUN-001', { req: true, max: 20 }), testCaseCode: str('Test case code', { req: true, max: 20 }), status: str('Result', { req: true, enum: ['in_progress', 'failed', 'blocked'] }), note: str('What you observed (required for failed and blocked)', { max: 5_000 }), actualResult: str('Actual result', { max: 10_000 }) },
    run: (ctx, a) => {
      const d = ex.setResult(ctx.db, executionId(ctx, s<string>(a.runCode), s<string>(a.testCaseCode)), { status: a.status, note: a.note ?? '', ...(a.actualResult ? { actualResult: a.actualResult } : {}) }, AGENT);
      return { testCase: d.testCaseCode, status: d.status, executorKind: d.executorKind };
    },
  },
  {
    name: 'qa_add_evidence_note',
    description: 'Attach a text note as evidence to a test execution (redacted automatically). Screenshots and files cannot be attached through MCP.',
    fields: { project: PROJECT, runCode: str('Test run code', { req: true, max: 20 }), testCaseCode: str('Test case code', { req: true, max: 20 }), label: str('Short label', { max: 120 }), body: str('The evidence', { req: true, max: 20_000 }) },
    run: (ctx, a) => {
      ex.addNoteEvidence(ctx.db, executionId(ctx, s<string>(a.runCode), s<string>(a.testCaseCode)), { label: a.label ?? '', body: a.body }, AGENT);
      return { added: true };
    },
  },
  {
    name: 'qa_add_exploratory_note',
    description: 'Add a note, bug, question or idea to a RUNNING exploratory session. You cannot start or complete sessions.',
    fields: { project: PROJECT, sessionCode: str('Session code, e.g. EXP-001', { req: true, max: 20 }), kind: str('Kind of note', { enum: ['note', 'bug', 'question', 'idea'] }), text: str('The note', { req: true, max: 5_000 }) },
    run: (ctx, a) => {
      wk.addNote(ctx.db, idByCode(ctx, 'exploratory_sessions', 'EXP', s<string>(a.sessionCode), 'session_not_found'), { kind: a.kind ?? 'note', text: a.text }, AGENT);
      return { added: true };
    },
  },
  {
    name: 'qa_create_task',
    description: 'Create a task in the Backlog. Tasks are never assigned automatically; you cannot assign it to yourself or anyone.',
    fields: { project: PROJECT, title: str('Task title', { req: true, max: 200 }), description: str('Details', { max: 5_000 }), kind: str('Kind', { enum: ['test_design', 'execution', 'retest', 'review', 'defect_followup', 'other'] }), priority: str('Priority', { enum: PRIORITY }) },
    run: ({ db, projectId }, a) => {
      const t = wk.createTask(db, projectId, { title: a.title, description: a.description ?? '', kind: a.kind ?? 'other', priority: a.priority ?? 'medium' }, AGENT);
      return { code: t.code, stage: t.stage };
    },
  },
  {
    name: 'qa_move_task',
    description: 'Move a task between stages. You can NEVER move a task to Completed (only a person can). Blocking needs a note.',
    fields: { project: PROJECT, code: str('Task code, e.g. TSK-001', { req: true, max: 20 }), to: str('Target stage', { req: true, enum: ['backlog', 'ready', 'in_progress', 'waiting_review', 'blocked'] }), note: str('Reason (required for blocked)', { max: 2_000 }) },
    run: (ctx, a) => {
      const t = wk.moveTask(ctx.db, idByCode(ctx, 'tasks', 'TSK', s<string>(a.code), 'task_not_found'), { to: a.to, note: a.note ?? '' }, AGENT);
      return { code: t.code, stage: t.stage };
    },
  },
];

export const AGENT_TOOL_NAMES = TOOLS.map((t) => t.name);
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export const agentToolList = (): ToolDescriptor[] =>
  TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: toJsonSchema(t.fields) }));

// ---------------------------------------------------------------------------- access switch and audit
export const agentAccessEnabled = (db: DB): boolean => getSetting<boolean>(db, 'agent_access', false) === true;
export const setAgentAccess = (db: DB, enabled: boolean) => setSetting(db, 'agent_access', enabled);

function audit(db: DB, tool: string, projectId: string | null, outcome: 'ok' | 'denied' | 'error', code = '') {
  db.prepare('INSERT INTO agent_audit (id, at, tool, project_id, outcome, code) VALUES (?, ?, ?, ?, ?, ?)').run(newId('aud'), new Date().toISOString(), tool.slice(0, 60), projectId, outcome, code.slice(0, 60));
}
export function recentAgentActivity(db: DB, limit = 50) {
  return (
    db
      .prepare('SELECT a.at, a.tool, a.outcome, a.code, p.alias AS project FROM agent_audit a LEFT JOIN projects p ON p.id = a.project_id ORDER BY a.at DESC, a.rowid DESC LIMIT ?')
      .all(Math.min(limit, 200)) as Array<{ at: string; tool: string; outcome: string; code: string; project: string | null }>
  ).map((r) => ({ at: r.at, tool: r.tool, outcome: r.outcome, code: r.code, project: r.project }));
}

/** Runs one agent tool. Returns redacted output; throws HttpError for everything the caller should see. */
export function callAgentTool(db: DB, name: string, rawArgs: unknown): unknown {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    audit(db, 'unknown', null, 'denied', 'unknown_tool');
    throw new HttpError(404, 'unknown_tool', 'There is no such tool. Agents can only use the listed qa_* tools.');
  }
  if (!agentAccessEnabled(db)) {
    audit(db, name, null, 'denied', 'agent_access_disabled');
    throw new HttpError(403, 'agent_access_disabled', 'Agent access is turned off. A person can turn it on in Settings.');
  }
  let projectId: string | null = null;
  try {
    const parsed = toZod(tool.fields).safeParse(rawArgs ?? {});
    if (!parsed.success) throw new HttpError(400, 'invalid_input', `Invalid fields: ${[...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))].join(', ')}`);
    const args = parsed.data as Record<string, unknown>;
    const needsProject = tool.project !== false;
    if (needsProject) projectId = projectIdOf(db, s<string>(args.project));
    const out = tool.run({ db, projectId: projectId ?? '' }, args);
    audit(db, name, projectId, 'ok');
    return redactObject(out);
  } catch (err) {
    const code = err instanceof HttpError ? err.code : 'error';
    audit(db, name, projectId, err instanceof HttpError && err.status === 403 ? 'denied' : 'error', code);
    throw err;
  }
}
