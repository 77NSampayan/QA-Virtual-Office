/**
 * Automation results service (Pass 3, A1): import JUnit XML, list runs, classify failures.
 *
 * Rules enforced here: importing, classifying and deleting are done by a PERSON only; agents have no automation
 * tools yet. Only names, status, duration and a short redacted message are stored. Imported results never change a
 * manual test case; a result is linked to a test case only when its name contains that test case's code or its
 * "Test Case ID" from the team's sheet (a plain text match, shown as such).
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  AUTOMATION_CLASSIFICATIONS,
  automationDenominator,
  coverageRatio,
  countStatuses,
  JUNIT_MAX_BYTES,
  parseJunit,
  redact,
  type Actor,
  type AutomationClassification,
  type AutomationCounts,
  type AutomationStatus,
  type Ratio,
} from '@qavo/shared';
import type { DB } from './db/index.ts';
import fs from 'node:fs';
import { detectFrameworks, type DetectionResult } from './frameworkDetect.ts';
import { getProjectPath, HttpError, newId } from './store.ts';

type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const code = (seq: number) => `AR-${String(seq).padStart(3, '0')}`;
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new HttpError(400, 'invalid_input', `Invalid fields: ${[...new Set(r.error.issues.map((i) => i.path.join('.') || '(root)'))].join(', ')}`);
  return r.data;
}
const needHuman = (actor: Actor) => {
  if (actor !== 'human') throw new HttpError(403, 'human_required', 'Only a person can do this');
};
function requireProject(db: DB, projectId: string) {
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new HttpError(404, 'project_not_found');
}

const ImportInput = z
  .object({
    text: z.string().max(JUNIT_MAX_BYTES),
    name: z.string().trim().max(120).default(''),
    environment: z.string().trim().max(80).default(''),
    dryRun: z.boolean().default(false),
  })
  .strict();
const ClassifyInput = z.object({ classification: z.enum(AUTOMATION_CLASSIFICATIONS) }).strict();

export interface AutomationRunDTO {
  id: string;
  projectId: string;
  code: string;
  name: string;
  environment: string;
  counts: AutomationCounts;
  /** passed / (passed + failed + errored); skipped tests are not counted. */
  passRate: Ratio;
  unclassifiedFailures: number;
  durationMs: number;
  importedAt: string;
}
export interface AutomationResultDTO {
  id: string;
  suite: string;
  className: string;
  name: string;
  status: AutomationStatus;
  durationMs: number;
  message: string;
  classification: AutomationClassification;
  testCaseId: string | null;
  testCaseCode: string | null;
}
export interface AutomationRunDetail extends AutomationRunDTO {
  results: AutomationResultDTO[];
}
export interface AutomationImportResult {
  dryRun: boolean;
  total: number;
  counts: AutomationCounts;
  passRate: Ratio;
  linked: number;
  problems: string[];
  alreadyImported: string | null;
  created: AutomationRunDTO | null;
  truncated: boolean;
}

const runDto = (r: Row, unclassified: number): AutomationRunDTO => {
  const counts: AutomationCounts = { total: r.total as number, passed: r.passed as number, failed: r.failed as number, errored: r.errored as number, skipped: r.skipped as number };
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    code: code(r.seq as number),
    name: r.name as string,
    environment: r.environment as string,
    counts,
    passRate: coverageRatio(counts.passed, automationDenominator(counts)),
    unclassifiedFailures: unclassified,
    durationMs: r.duration_ms as number,
    importedAt: r.imported_at as string,
  };
};
const unclassifiedOf = (db: DB, runId: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM automation_results WHERE run_id = ? AND status IN ('failed','error') AND classification = 'unknown'").get(runId) as { n: number }).n;

export function listRuns(db: DB, projectId: string): AutomationRunDTO[] {
  requireProject(db, projectId);
  return (db.prepare('SELECT * FROM automation_runs WHERE project_id = ? ORDER BY seq DESC').all(projectId) as Row[]).map((r) => runDto(r, unclassifiedOf(db, r.id as string)));
}

export function getRun(db: DB, id: string): AutomationRunDetail {
  const r = db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'automation_run_not_found');
  const results = (
    db
      .prepare(
        `SELECT a.*, t.code AS tc_code FROM automation_results a LEFT JOIN test_cases t ON t.id = a.test_case_id WHERE a.run_id = ?
         ORDER BY CASE a.status WHEN 'failed' THEN 0 WHEN 'error' THEN 1 WHEN 'skipped' THEN 3 ELSE 2 END, a.rowid`,
      )
      .all(id) as Row[]
  ).map(
    (x): AutomationResultDTO => ({
      id: x.id as string,
      suite: x.suite as string,
      className: x.class_name as string,
      name: x.name as string,
      status: x.status as AutomationStatus,
      durationMs: x.duration_ms as number,
      message: x.message as string,
      classification: x.classification as AutomationClassification,
      testCaseId: (x.test_case_id as string | null) ?? null,
      testCaseCode: (x.tc_code as string | null) ?? null,
    }),
  );
  return { ...runDto(r, unclassifiedOf(db, id)), results };
}

export function importJunit(db: DB, projectId: string, input: unknown, actor: Actor): AutomationImportResult {
  needHuman(actor);
  const v = parse(ImportInput, input);
  requireProject(db, projectId);
  const parsed = parseJunit(v.text);
  const counts = countStatuses(parsed.cases);
  const passRate = coverageRatio(counts.passed, automationDenominator(counts));
  if (parsed.cases.length === 0) throw new HttpError(400, 'nothing_to_import', parsed.problems[0] ?? 'No test results were found in the file');

  const hash = crypto.createHash('sha256').update(v.text).digest('hex');
  const dup = db.prepare('SELECT seq FROM automation_runs WHERE project_id = ? AND content_hash = ?').get(projectId, hash) as { seq: number } | undefined;

  // plain text matches between a result name and a test case: its code (TC-0001) or its Test Case ID from the sheet
  const byToken = new Map<string, string>();
  for (const t of db.prepare('SELECT id, code, external_id FROM test_cases WHERE project_id = ?').all(projectId) as Array<{ id: string; code: string; external_id: string }>) {
    byToken.set(t.code.toLowerCase(), t.id);
    if (t.external_id) byToken.set(t.external_id.toLowerCase(), t.id);
  }
  const link = (name: string, className: string): string | null => {
    for (const tok of `${name} ${className}`.split(/[^A-Za-z0-9_-]+/)) {
      const id = tok ? byToken.get(tok.toLowerCase()) : undefined;
      if (id) return id;
    }
    return null;
  };
  const linkedIds = parsed.cases.map((c) => link(c.name, c.className));
  const linked = linkedIds.filter(Boolean).length;
  const base: AutomationImportResult = {
    dryRun: v.dryRun,
    total: parsed.cases.length,
    counts,
    passRate,
    linked,
    problems: parsed.problems,
    alreadyImported: dup ? code(dup.seq) : null,
    created: null,
    truncated: parsed.truncated,
  };
  if (v.dryRun) return base;
  if (dup) throw new HttpError(409, 'already_imported', `This exact file was already imported as ${code(dup.seq)}`);

  const id = newId('aur');
  const ts = nowIso();
  db.transaction(() => {
    const seq = ((db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM automation_runs WHERE project_id = ?').get(projectId) as { m: number }).m ?? 0) + 1;
    const name = redact(v.name).trim() || `JUnit import ${ts.slice(0, 16).replace('T', ' ')}`;
    const duration = parsed.cases.reduce((s, c) => s + c.durationMs, 0);
    db.prepare(
      `INSERT INTO automation_runs (id, project_id, seq, name, source, environment, content_hash, total, passed, failed, errored, skipped, duration_ms, imported_at)
       VALUES (?, ?, ?, ?, 'junit', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, projectId, seq, name, redact(v.environment).trim(), hash, counts.total, counts.passed, counts.failed, counts.errored, counts.skipped, duration, ts);
    const ins = db.prepare('INSERT INTO automation_results (id, run_id, suite, class_name, name, status, duration_ms, message, test_case_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    parsed.cases.forEach((c, i) => ins.run(newId('aures'), id, c.suite, c.className, c.name, c.status, c.durationMs, c.message, linkedIds[i]));
  })();
  return { ...base, created: runDto(db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id) as Row, counts.failed + counts.errored), alreadyImported: null };
}

export function classifyResult(db: DB, resultId: string, input: unknown, actor: Actor): AutomationResultDTO {
  needHuman(actor);
  const v = parse(ClassifyInput, input);
  const r = db.prepare('SELECT run_id, status FROM automation_results WHERE id = ?').get(resultId) as { run_id: string; status: string } | undefined;
  if (!r) throw new HttpError(404, 'automation_result_not_found');
  if (r.status !== 'failed' && r.status !== 'error') throw new HttpError(409, 'not_a_failure', 'Only a failed or errored test can be classified');
  db.prepare('UPDATE automation_results SET classification = ?, classified_at = ? WHERE id = ?').run(v.classification, v.classification === 'unknown' ? null : nowIso(), resultId);
  return getRun(db, r.run_id).results.find((x) => x.id === resultId)!;
}

export function projectOfRun(db: DB, runId: string): string | undefined {
  return (db.prepare('SELECT project_id FROM automation_runs WHERE id = ?').get(runId) as { project_id: string } | undefined)?.project_id;
}
export function projectOfResult(db: DB, resultId: string): string | undefined {
  return (db.prepare('SELECT r.project_id FROM automation_results a JOIN automation_runs r ON r.id = a.run_id WHERE a.id = ?').get(resultId) as { project_id: string } | undefined)?.project_id;
}

export function deleteRun(db: DB, id: string, actor: Actor): { deleted: true } {
  needHuman(actor);
  if (!db.prepare('SELECT 1 FROM automation_runs WHERE id = ?').get(id)) throw new HttpError(404, 'automation_run_not_found');
  db.prepare('DELETE FROM automation_runs WHERE id = ?').run(id);
  return { deleted: true };
}

/**
 * Scan the project's folder for test frameworks (names and declared versions only). Person-only, on demand, read-only.
 * Nothing is stored: the answer is shown and forgotten, so it can never be stale or leak later.
 */
export function detectProjectFrameworks(db: DB, projectId: string, actor: Actor): DetectionResult {
  needHuman(actor);
  requireProject(db, projectId);
  const p = getProjectPath(db, projectId);
  const root = p.pathCanonical ?? p.pathEntered;
  let ok = false;
  try {
    ok = fs.statSync(root).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(409, 'project_folder_missing', 'The project folder cannot be found on this computer, so it cannot be scanned');
  return detectFrameworks(root);
}
