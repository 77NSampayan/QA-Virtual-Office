/**
 * Agent reviews of test cases (Pass P3).
 *
 * A review is a RECOMMENDATION from a named reviewer agent. It never changes a test case's status: approving and
 * rejecting stay human-only. The rule "a reviewer is not the writer" is checked here and ALSO by database triggers
 * (migration 011), so a bug in this file cannot let an agent review its own work.
 */
import { z } from 'zod';
import { MAX_REVIEW_NOTES, REVIEW_VERDICTS, redact } from '@qavo/shared';
import type { DB } from './db/index.ts';
import * as qa from './qa.ts';
import type { Actor } from '@qavo/shared';
import type { RunIdentity } from './runs.ts';
import { HttpError, newId } from './store.ts';

const Input = z
  .object({ verdict: z.enum(REVIEW_VERDICTS), notes: z.string().max(MAX_REVIEW_NOTES * 2).default('') })
  .strict();

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface ReviewResult {
  code: string;
  verdict: string;
  reviewer: string;
  /** Always unchanged: a review never approves or rejects. */
  status: string;
}

export function reviewTestCase(db: DB, testCaseId: string, input: unknown, who: RunIdentity | undefined): ReviewResult {
  if (!who) throw new HttpError(403, 'identity_required', 'Only a launched, named reviewer can record a review. Use Run this playbook on the Agents page.');
  if (who.def.kind !== 'reviewer' || who.def.area !== 'manual') throw new HttpError(403, 'not_a_reviewer', `${who.agentName} (${who.role}) is not a reviewer.`);
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw new HttpError(400, 'invalid_input', `Invalid fields: ${[...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))].join(', ')}`);
  const notes = redact(parsed.data.notes).trim().slice(0, MAX_REVIEW_NOTES);
  if (parsed.data.verdict === 'changes_requested' && !notes) throw new HttpError(400, 'notes_required', 'Say what must change.');

  const row = db.prepare('SELECT * FROM test_cases WHERE id = ?').get(testCaseId) as Record<string, unknown> | undefined;
  if (!row) throw new HttpError(404, 'test_case_not_found');
  if (row.project_id !== who.projectId) throw new HttpError(403, 'wrong_project', 'This agent was launched for a different project.');
  if (row.archived === 1) throw new HttpError(409, 'archived', 'This test case is archived.');
  if (row.status !== 'draft' && row.status !== 'in_review') throw new HttpError(409, 'not_reviewable', `A ${String(row.status)} test case no longer needs a review.`);
  const writerName = String(row.drafted_by_name ?? '');
  if (row.drafted_by_run === who.runId || (writerName && sameName(writerName, who.agentName))) {
    throw new HttpError(403, 'own_work', `${who.agentName} wrote this test case, so ${who.agentName} cannot review it. A different reviewer must.`);
  }
  const id = newId('rev');
  try {
    db.prepare('INSERT INTO agent_reviews (id, subject_kind, subject_id, run_id, reviewer_name, verdict, notes, subject_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      'test_case',
      testCaseId,
      who.runId,
      who.agentName,
      parsed.data.verdict,
      notes,
      qa.testCaseContentHash(row),
      new Date().toISOString(),
    );
  } catch (e) {
    // The database refused (identity or own-work trigger): report it as a refusal, never as a server error.
    if (/reviewer/.test(String((e as Error).message))) throw new HttpError(403, 'review_refused', 'The database refused this review.');
    throw e;
  }
  return { code: String(row.code), verdict: parsed.data.verdict, reviewer: who.agentName, status: String(row.status) };
}

export interface ReviewableItem {
  code: string;
  title: string;
  status: string;
  draftedBy: string;
  authoredBy: string;
  /** Why it is in your list: never reviewed, or edited since the last review. */
  reason: 'not_reviewed' | 'edited_since_review';
  /** What the writer answered to the previous review (only when edited since review). */
  writerReply?: string;
}

/**
 * Test cases this reviewer may review now: draft or in review, not its own work, and either never reviewed or edited
 * since the latest review (by anyone). Cases it wrote can never appear.
 */
export function listReviewable(db: DB, who: RunIdentity | undefined): ReviewableItem[] {
  if (!who) throw new HttpError(403, 'identity_required', 'Only a launched, named reviewer can list what to review.');
  if (who.def.kind !== 'reviewer' || who.def.area !== 'manual') throw new HttpError(403, 'not_a_reviewer', `${who.agentName} (${who.role}) is not a reviewer.`);
  const out: ReviewableItem[] = [];
  for (const t of qa.listTestCases(db, { projectId: who.projectId, includeArchived: false })) {
    if (t.status !== 'draft' && t.status !== 'in_review') continue;
    if (t.draftedBy && sameName(t.draftedBy, who.agentName)) continue;
    const row = db.prepare('SELECT drafted_by_run AS r FROM test_cases WHERE id = ?').get(t.id) as { r: string | null };
    if (row.r === who.runId) continue;
    if (t.review === null) out.push({ code: t.code, title: t.title, status: t.status, draftedBy: t.draftedBy, authoredBy: t.authoredBy, reason: 'not_reviewed' });
    else if (!t.review.current) {
      const replies = qa.repliesSinceReview(db, t.id);
      out.push({ code: t.code, title: t.title, status: t.status, draftedBy: t.draftedBy, authoredBy: t.authoredBy, reason: 'edited_since_review', ...(replies.length ? { writerReply: replies[replies.length - 1]!.note } : {}) });
    }
  }
  return out;
}

export interface ChangesRequestedItem {
  code: string;
  title: string;
  reviewer: string;
  reviewedAt: string;
  notes: string;
}

/**
 * Writer agents only: its OWN drafts (by its agent name) that are still drafts and whose latest, current review asks for
 * changes. Once the writer edits one, the review is outdated and it leaves this list until a reviewer looks again.
 */
export function listMyChangesRequested(db: DB, who: RunIdentity | undefined): { items: ChangesRequestedItem[]; notYours: number } {
  if (!who) throw new HttpError(403, 'identity_required', 'Only a launched, named writer can list its own drafts.');
  if (who.def.kind !== 'writer' || who.def.area !== 'manual') throw new HttpError(403, 'not_a_writer', `${who.agentName} (${who.role}) is not a writer.`);
  const sentBack = qa.listTestCases(db, { projectId: who.projectId, includeArchived: false }).filter((t) => t.status === 'draft' && t.review?.current && t.review.verdict === 'changes_requested');
  const items = sentBack
    .filter((t) => t.draftedBy && sameName(t.draftedBy, who.agentName))
    .map((t) => ({ code: t.code, title: t.title, reviewer: t.review!.by, reviewedAt: t.review!.at, notes: t.review!.notes }));
  // agent drafts written before agents had names: not hers to edit until a person hands them over
  const notYours = sentBack.filter((t) => t.authoredBy === 'agent' && !t.draftedBy).length;
  return { items, notYours };
}

/**
 * A PERSON hands an old agent draft (written before agents had names) to a writer agent, so that agent may fix it. Only
 * unattributed agent drafts that are still drafts; only to a writer role; and never to an agent whose name has reviewed
 * that case (a reviewer must not become its writer). The review stays valid: handing over changes no content.
 */
export function handDraftToWriter(db: DB, testCaseId: string, writer: { agentName: string; kind: string; area?: string }, actor: Actor): { code: string; draftedBy: string } {
  if (actor !== 'human') throw new HttpError(403, 'human_required', 'Only a person can hand a draft to an agent');
  if (writer.kind !== 'writer' || (writer.area !== undefined && writer.area !== 'manual')) throw new HttpError(400, 'not_a_writer', 'A draft can only be handed to a writer agent.');
  const row = db.prepare('SELECT code, status, archived, authored_by, drafted_by_name FROM test_cases WHERE id = ?').get(testCaseId) as
    | { code: string; status: string; archived: number; authored_by: string; drafted_by_name: string }
    | undefined;
  if (!row) throw new HttpError(404, 'test_case_not_found');
  if (row.archived === 1) throw new HttpError(409, 'archived', 'Restore the test case first.');
  if (row.authored_by !== 'agent' || row.drafted_by_name !== '') throw new HttpError(409, 'not_handable', 'Only agent drafts written before agents had names can be handed over.');
  if (row.status !== 'draft') throw new HttpError(409, 'not_a_draft', `A ${row.status} test case can no longer be handed to an agent.`);
  const clash = db.prepare('SELECT 1 FROM agent_reviews WHERE subject_id = ? AND lower(trim(reviewer_name)) = lower(trim(?))').get(testCaseId, writer.agentName);
  if (clash) throw new HttpError(409, 'reviewer_conflict', `${writer.agentName} has reviewed this test case, so it cannot become its writer.`);
  db.transaction(() => {
    db.prepare('UPDATE test_cases SET drafted_by_name = ? WHERE id = ?').run(writer.agentName, testCaseId);
    db.prepare('INSERT INTO test_case_history (id, test_case_id, at, actor, action, from_status, to_status, note, changes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      newId('hst'),
      testCaseId,
      new Date().toISOString(),
      'human',
      'handed_to_agent',
      null,
      null,
      `Handed to ${writer.agentName}`,
      JSON.stringify({ draftedBy: writer.agentName }),
    );
  })();
  return { code: row.code, draftedBy: writer.agentName };
}
