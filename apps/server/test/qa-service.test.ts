import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '../src/db/index.ts';
import * as qa from '../src/qa.ts';
import { createProject, deleteProject, HttpError } from '../src/store.ts';

let db: DB;
let root: string;
let projectId: string;
let otherProjectId: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-qa-'));
  db = openDb(path.join(root, 'test.db'));
  const mk = (name: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    return createProject(db, { alias: name, path: dir }).project.id;
  };
  projectId = mk('Alpha');
  otherProjectId = mk('Beta');
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function http(fn: () => unknown, status: number, code?: string) {
  try {
    fn();
  } catch (e) {
    expect(e, `expected HttpError, got ${String(e)}`).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(status);
    if (code) expect((e as HttpError).code).toBe(code);
    return e as HttpError;
  }
  throw new Error(`expected HttpError ${status}${code ? ' ' + code : ''}, but nothing was thrown`);
}

const req = (ref: string, text = 'The system shall lock an account after 5 failed sign-ins.', extra: object = {}) =>
  qa.createRequirement(db, projectId, { ref, title: text.slice(0, 40), text, ...extra }, 'human');
const goodCase = (extra: object = {}) => ({
  title: 'Sign in with valid credentials',
  steps: ['Open the sign-in page', 'Enter valid email and password', 'Press Sign in'],
  expectedResult: 'The dashboard is shown',
  ...extra,
});

describe('requirements', () => {
  it('creates a requirement with defaults and normalises the reference', () => {
    const r = req('REQ-1');
    expect(r).toMatchObject({ ref: 'REQ-1', kind: 'other', reviewStatus: 'unreviewed', authoredBy: 'human', openFlags: 0, testCaseCount: 0 });
    expect(r.id).toMatch(/^req_[a-f0-9]{16}$/);
  });

  it('validates input and rejects unknown fields and bad enums', () => {
    http(() => qa.createRequirement(db, projectId, { ref: '', title: 'x' }, 'human'), 400, 'invalid_input');
    http(() => qa.createRequirement(db, projectId, { ref: 'R1', title: '' }, 'human'), 400, 'invalid_input');
    http(() => qa.createRequirement(db, projectId, { ref: 'R1', title: 'x', kind: 'wishlist' }, 'human'), 400, 'invalid_input');
    http(() => qa.createRequirement(db, projectId, { ref: 'R1', title: 'x', evil: true }, 'human'), 400, 'invalid_input');
    http(() => qa.createRequirement(db, projectId, { ref: 'R'.repeat(41), title: 'x' }, 'human'), 400, 'invalid_input');
    http(() => qa.createRequirement(db, 'proj_missing', { ref: 'R1', title: 'x' }, 'human'), 404, 'project_not_found');
  });

  it('references are unique per project (case-insensitive) but may repeat across projects', () => {
    req('REQ-1');
    http(() => req('req-1'), 409, 'duplicate_ref');
    expect(qa.createRequirement(db, otherProjectId, { ref: 'REQ-1', title: 'Other project' }, 'human').projectId).toBe(otherProjectId);
  });

  it('an agent may propose a requirement (marked agent-authored) but never edit or delete one', () => {
    const r = qa.createRequirement(db, projectId, { ref: 'AG-1', title: 'Proposed by an agent' }, 'agent');
    expect(r.authoredBy).toBe('agent');
    http(() => qa.updateRequirement(db, r.id, { title: 'changed' }, 'agent'), 403, 'human_required');
    http(() => qa.deleteRequirement(db, r.id, 'agent'), 403, 'human_required');
    http(() => qa.createRequirement(db, projectId, { ref: 'SYS-1', title: 'x' }, 'system'), 403, 'human_required');
  });

  it('a human can update review status and text, and delete (links and flags go with it)', () => {
    const r = req('REQ-2');
    const tc = qa.createTestCase(db, projectId, goodCase({ requirementIds: [r.id] }), 'human');
    qa.raiseFlag(db, r.id, { type: 'gap', note: 'What about locked accounts?' }, 'human');
    expect(qa.updateRequirement(db, r.id, { reviewStatus: 'needs_clarification', text: 'New text' }, 'human')).toMatchObject({ reviewStatus: 'needs_clarification', text: 'New text', openFlags: 1, testCaseCount: 1 });
    qa.deleteRequirement(db, r.id, 'human');
    http(() => qa.getRequirement(db, r.id), 404, 'requirement_not_found');
    expect(qa.getTestCase(db, tc.id).requirements).toEqual([]); // the link is gone, the test case remains
    expect(db.prepare('SELECT COUNT(*) AS c FROM requirement_flags').get()).toEqual({ c: 0 });
  });

  describe('flags (ambiguity / gap / conflict) are raised for HUMAN review', () => {
    it('anyone can raise a flag; only a human can resolve or dismiss it', () => {
      const a = req('A-1');
      const b = req('A-2', 'The system shall never lock accounts.');
      const f = qa.raiseFlag(db, a.id, { type: 'conflict', note: 'Contradicts A-2', relatedRequirementId: b.id }, 'agent');
      expect(f).toMatchObject({ status: 'open', raisedBy: 'agent', type: 'conflict', relatedRequirementId: b.id });
      http(() => qa.resolveFlag(db, f.id, { status: 'resolved' }, 'agent'), 403, 'human_required');
      http(() => qa.resolveFlag(db, f.id, { status: 'resolved' }, 'system'), 403, 'human_required');
      expect(qa.resolveFlag(db, f.id, { status: 'resolved', note: 'Clarified with the BA' }, 'human')).toMatchObject({ status: 'resolved', resolvedNote: 'Clarified with the BA' });
      expect(qa.getRequirement(db, a.id).openFlags).toBe(0);
    });
    it('a related requirement must be in the same project', () => {
      const a = req('A-1');
      const foreign = qa.createRequirement(db, otherProjectId, { ref: 'X-1', title: 'x' }, 'human');
      http(() => qa.raiseFlag(db, a.id, { type: 'conflict', note: 'x', relatedRequirementId: foreign.id }, 'human'), 400, 'related_requirement_invalid');
    });
  });

  describe('import from pasted BRD/FSD text', () => {
    const text = 'REQ-1: The system shall sign users in.\nUS-2 - As a user I want to reset my password.\nBRD 3.2) Payments confirm within 5 seconds.';
    it('dry run reports what would be created and writes nothing', () => {
      const r = qa.importRequirements(db, projectId, { text, source: 'BRD v2', kind: 'brd', dryRun: true }, 'human');
      expect(r).toMatchObject({ dryRun: true, wouldCreate: ['REQ-1', 'US-2', 'BRD 3.2'], skippedExisting: [], created: [] });
      expect(qa.listRequirements(db, projectId)).toEqual([]);
    });
    it('creates new requirements with source and kind, and skips references that already exist', () => {
      req('REQ-1', 'Existing text that must not be overwritten.');
      const r = qa.importRequirements(db, projectId, { text, source: 'BRD v2', kind: 'brd' }, 'human');
      expect(r.created).toEqual(['US-2', 'BRD 3.2']);
      expect(r.skippedExisting).toEqual(['REQ-1']);
      const list = qa.listRequirements(db, projectId);
      expect(list.find((x) => x.ref === 'REQ-1')!.text).toBe('Existing text that must not be overwritten.');
      expect(list.find((x) => x.ref === 'US-2')).toMatchObject({ source: 'BRD v2', kind: 'brd', authoredBy: 'human' });
    });
    it('rejects empty or oversized text and non-humans', () => {
      http(() => qa.importRequirements(db, projectId, { text: '   ' }, 'human'), 400, 'nothing_to_import');
      http(() => qa.importRequirements(db, projectId, { text: 'x'.repeat(300_001) }, 'human'), 400, 'invalid_input');
      http(() => qa.importRequirements(db, projectId, { text }, 'agent'), 403, 'human_required');
    });
    it('markdown documents: kind is detected per reference prefix, and a prefix filter limits what is created', () => {
      const md = ['| ID | Business requirement |', '| --- | --- |', '| BR-01 | Visitors can register |', '', '**FR-01 Registration**', '', '1. Page /register shows Email.', '', '| ID | Covers | Given | When | Then |', '| --- | --- | --- | --- | --- |', '| AC-01 | FR-01 | a guest | submits | account exists |'].join('\n');
      const preview = qa.importRequirements(db, projectId, { text: md, dryRun: true, onlyPrefixes: ['FR'] }, 'human');
      expect(preview.byPrefix).toEqual({ BR: 1, FR: 1, AC: 1 });
      expect(preview.wouldCreate).toEqual(['FR-01']);
      qa.importRequirements(db, projectId, { text: md }, 'human');
      const kinds = Object.fromEntries(qa.listRequirements(db, projectId).map((r) => [r.ref, r.kind]));
      expect(kinds).toEqual({ 'BR-01': 'brd', 'FR-01': 'fsd', 'AC-01': 'acceptance_criteria' });
    });
  });

  describe('automatic ambiguity checks', () => {
    it('raise hints as system flags for a human to resolve; each hint once; dismissed hints stay dismissed', () => {
      const r = req('Q-1', 'The page should load quickly and be user-friendly. Limit is TBD.');
      req('Q-2', 'The system shall lock an account after 5 failed sign-ins within 10 minutes.');
      const first = qa.runRequirementChecks(db, projectId);
      expect(first).toMatchObject({ requirementsChecked: 2 });
      expect(first.raised).toBeGreaterThanOrEqual(3);
      const flags = qa.getRequirement(db, r.id).flags;
      expect(flags.every((f) => f.raisedBy === 'system' && f.type === 'ambiguity' && f.status === 'open')).toBe(true);
      expect(flags.map((f) => f.note).join(' ')).toMatch(/TBD/);
      expect(qa.getRequirement(db, qa.listRequirements(db, projectId).find((x) => x.ref === 'Q-2')!.id).flags).toEqual([]); // precise requirement: nothing
      expect(qa.runRequirementChecks(db, projectId).raised).toBe(0); // idempotent
      const tbd = flags.find((f) => /TBD/.test(f.note))!;
      qa.resolveFlag(db, tbd.id, { status: 'dismissed', note: 'Intentional' }, 'human');
      expect(qa.runRequirementChecks(db, projectId).raised).toBe(0); // dismissed is not raised again
      qa.updateRequirement(db, r.id, { text: 'The page should load quickly. Limit is TBD or maybe 5 s.' }, 'human');
      expect(qa.getRequirement(db, r.id).openFlags).toBeGreaterThan(0);
    });
    it('is a human action', () => {
      http(() => qa.runRequirementChecks(db, projectId, 'agent'), 403, 'human_required');
    });
  });
});

describe('test cases', () => {
  it('creates a draft with sequential per-project codes (TC-0001...)', () => {
    const a = qa.createTestCase(db, projectId, goodCase(), 'human');
    const b = qa.createTestCase(db, projectId, goodCase({ title: 'Second' }), 'human');
    const c = qa.createTestCase(db, otherProjectId, goodCase({ title: 'Other project' }), 'human');
    expect([a.code, b.code, c.code]).toEqual(['TC-0001', 'TC-0002', 'TC-0001']);
    expect(a).toMatchObject({ status: 'draft', authoredBy: 'human', version: 1, executionStatus: 'NOT RUN', archived: false, priority: 'medium', testType: 'positive' });
    expect(a.steps).toEqual(goodCase().steps);
  });

  it('stores every specified field', () => {
    const r = req('REQ-5');
    const tc = qa.createTestCase(
      db,
      projectId,
      {
        scenario: 'Authentication',
        title: 'Account locks after five bad passwords',
        description: 'Verifies the lockout rule',
        preconditions: 'User exists and is active',
        steps: ['Enter a wrong password five times', 'Enter the correct password'],
        testData: 'user=qa.user; password=<wrong>',
        expectedResult: 'Account is locked; the correct password is refused',
        priority: 'high',
        testType: 'boundary_value',
        assignedTester: 'Tess',
        requirementIds: [r.id],
      },
      'human',
    );
    expect(tc).toMatchObject({
      scenario: 'Authentication',
      description: 'Verifies the lockout rule',
      preconditions: 'User exists and is active',
      testData: 'user=qa.user; password=<wrong>',
      priority: 'high',
      testType: 'boundary_value',
      assignedTester: 'Tess',
      requirementIds: [r.id],
      requirementRefs: ['REQ-5'],
    });
  });

  it('validates input', () => {
    const bad = (extra: object, code = 'invalid_input') => http(() => qa.createTestCase(db, projectId, goodCase(extra), 'human'), 400, code);
    bad({ title: '' });
    bad({ title: 'x'.repeat(201) });
    bad({ priority: 'urgent' });
    bad({ testType: 'smoke' });
    bad({ steps: 'not an array' });
    bad({ steps: Array.from({ length: 101 }, () => 'step') });
    bad({ steps: ['x'.repeat(2001)] });
    bad({ status: 'approved' }); // status can never be supplied by a client
    bad({ authoredBy: 'human' });
    bad({ requirementIds: ['req_doesnotexist'] }, 'requirement_not_in_project');
    const foreign = qa.createRequirement(db, otherProjectId, { ref: 'F-1', title: 'f' }, 'human');
    bad({ requirementIds: [foreign.id] }, 'requirement_not_in_project');
    http(() => qa.createTestCase(db, 'proj_missing', goodCase(), 'human'), 404, 'project_not_found');
    http(() => qa.createTestCase(db, projectId, goodCase(), 'system'), 403, 'human_required');
  });

  it('an agent can create only a DRAFT marked agent-authored', () => {
    const tc = qa.createTestCase(db, projectId, goodCase(), 'agent');
    expect(tc).toMatchObject({ status: 'draft', authoredBy: 'agent' });
    expect(qa.getTestCase(db, tc.id).history[0]).toMatchObject({ action: 'created', actor: 'agent', toStatus: 'draft' });
  });

  describe('approval workflow: human only', () => {
    let id: string;
    beforeEach(() => {
      id = qa.createTestCase(db, projectId, goodCase(), 'human').id;
    });
    const go = (to: string, note = '', actor: 'human' | 'agent' | 'system' = 'human') => qa.transitionTestCase(db, id, to, note, actor);

    it('draft -> in_review -> approved, recorded as approved by a human, with history', () => {
      expect(go('in_review').status).toBe('in_review');
      const a = go('approved', 'Looks good');
      expect(a).toMatchObject({ status: 'approved', approvedBy: 'human' });
      expect(a.approvedAt).toMatch(/^\d{4}-/);
      const h = qa.getTestCase(db, id).history.map((x) => `${x.action}:${x.fromStatus ?? ''}>${x.toStatus ?? ''}:${x.actor}`);
      expect(h).toEqual(['created:>draft:human', 'transition:draft>in_review:human', 'transition:in_review>approved:human']);
    });

    it('NO non-human can make ANY transition, including approve and reject', () => {
      for (const actor of ['agent', 'system'] as const) {
        http(() => go('in_review', '', actor), 403, 'human_required');
      }
      go('in_review');
      for (const actor of ['agent', 'system'] as const) {
        for (const to of ['approved', 'rejected', 'draft']) http(() => go(to, 'note', actor), 403, 'human_required');
      }
      expect(qa.getTestCase(db, id).status).toBe('in_review');
    });

    it('skipping the review step or inventing a status is refused', () => {
      http(() => go('approved'), 409, 'invalid_transition');
      http(() => go('rejected', 'no'), 409, 'invalid_transition');
      http(() => go('bogus'), 400, 'invalid_status');
      go('in_review');
      http(() => go('in_review'), 409, 'invalid_transition');
    });

    it('approval requires title, a real step and an expected result; the missing items are listed', () => {
      const bare = qa.createTestCase(db, projectId, { title: 'Bare draft' }, 'human');
      qa.transitionTestCase(db, bare.id, 'in_review', '', 'human');
      const e = http(() => qa.transitionTestCase(db, bare.id, 'approved', '', 'human'), 422, 'approval_requirements_missing');
      expect(e.message).toBe('steps_required,expected_result_required');
      expect(qa.getTestCase(db, bare.id).status).toBe('in_review');
    });

    it('rejecting needs a reason, which is kept; a rejected case can go back to draft', () => {
      go('in_review');
      http(() => go('rejected', '   '), 400, 'note_required');
      expect(go('rejected', 'Steps are ambiguous')).toMatchObject({ status: 'rejected', rejectionNote: 'Steps are ambiguous' });
      expect(go('draft').status).toBe('draft');
    });

    it('an approved case can be revoked back to draft (approval details cleared, history kept)', () => {
      go('in_review');
      go('approved');
      const d = go('draft', 'Requirement changed');
      expect(d).toMatchObject({ status: 'draft', approvedBy: null, approvedAt: null });
      expect(qa.getTestCase(db, id).history).toHaveLength(4);
    });

    it('archived test cases cannot be moved through the workflow', () => {
      qa.setArchived(db, id, true, 'human');
      http(() => go('in_review'), 409, 'archived');
    });
  });

  describe('editing', () => {
    it('editing an approved case sends it back to draft, bumps the version and records what changed', () => {
      const tc = qa.createTestCase(db, projectId, goodCase(), 'human');
      qa.transitionTestCase(db, tc.id, 'in_review', '', 'human');
      qa.transitionTestCase(db, tc.id, 'approved', '', 'human');
      const e = qa.updateTestCase(db, tc.id, { expectedResult: 'A different result', priority: 'critical' }, 'human');
      expect(e).toMatchObject({ status: 'draft', version: 2, approvedBy: null, expectedResult: 'A different result', priority: 'critical' });
      const last = qa.getTestCase(db, tc.id).history.at(-1)!;
      expect(last).toMatchObject({ action: 'edited', fromStatus: 'approved', toStatus: 'draft', actor: 'human' });
      expect(Object.keys(last.changes).sort()).toEqual(['expectedResult', 'priority']);
      expect(last.changes.priority).toEqual({ from: 'medium', to: 'critical' }); // short fields keep before/after
      expect(JSON.stringify(last.changes.expectedResult)).not.toContain('A different result'); // long text: field name only
    });
    it('an unchanged save records nothing; a draft edit keeps its version', () => {
      const tc = qa.createTestCase(db, projectId, goodCase(), 'human');
      expect(qa.updateTestCase(db, tc.id, { title: tc.title }, 'human').version).toBe(1);
      expect(qa.getTestCase(db, tc.id).history).toHaveLength(1);
      expect(qa.updateTestCase(db, tc.id, { title: 'Renamed' }, 'human')).toMatchObject({ version: 1, status: 'draft' });
    });
    it('status, code, authorship and approval fields can never be set by an edit', () => {
      const tc = qa.createTestCase(db, projectId, goodCase(), 'human');
      for (const patch of [{ status: 'approved' }, { code: 'TC-9999' }, { authoredBy: 'human' }, { approvedBy: 'human' }, { version: 9 }, { archived: true }]) {
        http(() => qa.updateTestCase(db, tc.id, patch, 'human'), 400, 'invalid_input');
      }
    });
    it('changing requirement links counts as a content change', () => {
      const r1 = req('L-1');
      const r2 = req('L-2');
      const tc = qa.createTestCase(db, projectId, goodCase({ requirementIds: [r1.id] }), 'human');
      qa.transitionTestCase(db, tc.id, 'in_review', '', 'human');
      const e = qa.updateTestCase(db, tc.id, { requirementIds: [r1.id, r2.id] }, 'human');
      expect(e.status).toBe('draft');
      expect(e.requirementRefs.sort()).toEqual(['L-1', 'L-2']);
    });
    it('an agent may edit only its OWN drafts', () => {
      const mine = qa.createTestCase(db, projectId, goodCase(), 'agent');
      const humans = qa.createTestCase(db, projectId, goodCase({ title: 'Human case' }), 'human');
      expect(qa.updateTestCase(db, mine.id, { title: 'Agent revised' }, 'agent').title).toBe('Agent revised');
      http(() => qa.updateTestCase(db, humans.id, { title: 'x' }, 'agent'), 403, 'human_required');
      qa.transitionTestCase(db, mine.id, 'in_review', '', 'human');
      http(() => qa.updateTestCase(db, mine.id, { title: 'sneaky' }, 'agent'), 403, 'human_required'); // no longer a draft
    });
    it('archived cases cannot be edited until restored', () => {
      const tc = qa.createTestCase(db, projectId, goodCase(), 'human');
      qa.setArchived(db, tc.id, true, 'human');
      http(() => qa.updateTestCase(db, tc.id, { title: 'x' }, 'human'), 409, 'archived');
      expect(qa.setArchived(db, tc.id, false, 'human').archived).toBe(false);
      http(() => qa.setArchived(db, tc.id, true, 'agent'), 403, 'human_required');
    });
  });

  describe('listing and filters', () => {
    it('filters by status, type, priority, requirement, author, text and archived', () => {
      const r = req('F-1');
      const a = qa.createTestCase(db, projectId, goodCase({ title: 'Login works', priority: 'high', testType: 'positive', requirementIds: [r.id] }), 'human');
      qa.createTestCase(db, projectId, goodCase({ title: 'Login fails with wrong password', testType: 'negative' }), 'agent');
      const c = qa.createTestCase(db, projectId, goodCase({ title: 'Export CSV', scenario: 'Reporting' }), 'human');
      qa.setArchived(db, c.id, true, 'human');
      qa.transitionTestCase(db, a.id, 'in_review', '', 'human');
      const titles = (f: object) => qa.listTestCases(db, { projectId, ...f }).map((x) => x.title).sort();
      expect(titles({})).toEqual(['Login fails with wrong password', 'Login works']);
      expect(titles({ includeArchived: true })).toHaveLength(3);
      expect(titles({ status: 'in_review' })).toEqual(['Login works']);
      expect(titles({ testType: 'negative' })).toEqual(['Login fails with wrong password']);
      expect(titles({ priority: 'high' })).toEqual(['Login works']);
      expect(titles({ requirementId: r.id })).toEqual(['Login works']);
      expect(titles({ authoredBy: 'agent' })).toEqual(['Login fails with wrong password']);
      expect(titles({ q: 'wrong' })).toEqual(['Login fails with wrong password']);
      expect(titles({ q: 'reporting', includeArchived: true })).toEqual(['Export CSV']);
      expect(qa.listTestCases(db, { projectId: otherProjectId })).toEqual([]);
    });
  });
});

describe('integrity enforced by the database itself', () => {
  it('history is append-only: rows cannot be edited or deleted, even with direct SQL', () => {
    const tc = qa.createTestCase(db, projectId, goodCase(), 'human');
    expect(() => db.prepare("UPDATE test_case_history SET actor = 'human', note = 'tampered' WHERE test_case_id = ?").run(tc.id)).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM test_case_history WHERE test_case_id = ?').run(tc.id)).toThrow(/append-only/);
    expect(qa.getTestCase(db, tc.id).history).toHaveLength(1);
  });
  it('an approval cannot be recorded as made by an agent, even with direct SQL', () => {
    const tc = qa.createTestCase(db, projectId, goodCase(), 'agent');
    expect(() => db.prepare("UPDATE test_cases SET status = 'approved', approved_by = 'agent', approved_at = ? WHERE id = ?").run(new Date().toISOString(), tc.id)).toThrow();
    expect(() => db.prepare("UPDATE test_cases SET status = 'approved' WHERE id = ?").run(tc.id)).toThrow();
  });
  it('a project holding QA records cannot be removed (archive it instead)', () => {
    req('REQ-1');
    const e = http(() => deleteProject(db, projectId), 409, 'project_has_qa_data');
    expect(e.message).toMatch(/archive/i);
    expect(qa.listRequirements(db, projectId)).toHaveLength(1);
    deleteProject(db, otherProjectId); // no QA data: removal still works
  });
});

describe('traceability and coverage', () => {
  it('shows a matrix with numerators, denominators and formulas; no percent without a denominator', () => {
    expect(qa.traceability(db, projectId).summary.requirementsWithApprovedTestCase).toEqual({ numerator: 0, denominator: 0, percent: null });

    const r1 = req('T-1');
    const r2 = req('T-2');
    const r3 = req('T-3');
    const r4 = req('T-4');
    const approved = qa.createTestCase(db, projectId, goodCase({ title: 'Approved case', requirementIds: [r1.id, r2.id] }), 'human');
    qa.transitionTestCase(db, approved.id, 'in_review', '', 'human');
    qa.transitionTestCase(db, approved.id, 'approved', '', 'human');
    qa.createTestCase(db, projectId, goodCase({ title: 'Draft only', requirementIds: [r3.id] }), 'human');
    const archived = qa.createTestCase(db, projectId, goodCase({ title: 'Archived', requirementIds: [r4.id] }), 'human');
    qa.setArchived(db, archived.id, true, 'human');
    qa.createTestCase(db, projectId, goodCase({ title: 'Not traced to anything' }), 'human');

    const t = qa.traceability(db, projectId);
    expect(t.summary.requirements).toBe(4);
    expect(t.summary.requirementsWithApprovedTestCase).toEqual({ numerator: 2, denominator: 4, percent: 50 });
    expect(t.summary.requirementsWithAnyTestCase).toEqual({ numerator: 3, denominator: 4, percent: 75 }); // archived cases do not count
    expect(t.summary.untracedTestCases).toBe(1);
    expect(t.summary.formulas.approved).toMatch(/approved.*divided by.*requirements/i);
    const row = (ref: string) => t.rows.find((r) => r.ref === ref)!;
    expect(row('T-1').testCases.map((c) => c.status)).toEqual(['approved']);
    expect(row('T-3').testCases.map((c) => c.status)).toEqual(['draft']);
    expect(row('T-4').testCases).toEqual([]);
    expect(row('T-4').covered).toBe('none');
    expect(row('T-3').covered).toBe('unapproved');
    expect(row('T-1').covered).toBe('approved');
  });
  it('is per project', () => {
    req('T-1');
    expect(qa.traceability(db, otherProjectId).summary.requirements).toBe(0);
    http(() => qa.traceability(db, 'proj_missing'), 404, 'project_not_found');
  });
  it('counts test cases awaiting review for the overview KPI', () => {
    const tc = qa.createTestCase(db, projectId, goodCase(), 'human');
    expect(qa.qaSummary(db).testCasesAwaitingReview).toBe(0);
    qa.transitionTestCase(db, tc.id, 'in_review', '', 'human');
    expect(qa.qaSummary(db)).toMatchObject({ testCasesAwaitingReview: 1, testCases: 1, requirements: 0 });
  });
});
