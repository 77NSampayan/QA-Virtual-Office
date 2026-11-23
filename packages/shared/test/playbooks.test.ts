import { describe, expect, it } from 'vitest';
import { AGENT_NAME_RE, PLAYBOOKS, PLAYBOOK_BY_ID, PLANNED_TOOLS, validateAgentName } from '../src/playbooks.ts';

const FORBIDDEN = /approve|reject|close|complete|archive|delete|passed|set_execution|transition|resolve/i;
const WRITE_TOOLS = ['qa_create_test_case_draft', 'qa_update_test_case_draft', 'qa_create_requirement'];
const REVIEW_TOOLS = ['qa_review_test_case', 'qa_list_my_reviewable'];

describe('playbook roster', () => {
  it('has unique ids and unique, valid default names', () => {
    expect(new Set(PLAYBOOKS.map((p) => p.id)).size).toBe(PLAYBOOKS.length);
    expect(new Set(PLAYBOOKS.map((p) => p.defaultName.toLowerCase())).size).toBe(PLAYBOOKS.length);
    for (const p of PLAYBOOKS) expect(AGENT_NAME_RE.test(p.defaultName), p.defaultName).toBe(true);
    expect(PLAYBOOKS.map((p) => p.defaultName)).toEqual(['Ada', 'Quinn', 'Rhea', 'Axel', 'Vera', 'Piper', 'Cole', 'Bram', 'Lena']);
  });

  it('pairs every writer with a reviewer of the same area, and reviewers are never writers', () => {
    for (const p of PLAYBOOKS.filter((x) => x.kind === 'writer')) {
      const r = PLAYBOOK_BY_ID[p.reviewedBy ?? ''];
      expect(r, `${p.id} needs a reviewer`).toBeDefined();
      expect(r!.kind).toBe('reviewer');
      expect(r!.area).toBe(p.area);
      expect(r!.id).not.toBe(p.id);
    }
    for (const p of PLAYBOOKS.filter((x) => x.kind === 'reviewer')) {
      expect(p.reviewedBy).toBeUndefined();
      for (const t of p.tools) expect(WRITE_TOOLS, `${p.id} must not write`).not.toContain(t);
    }
  });

  it('only reviewers have review tools, and only writers/investigators write cases', () => {
    for (const p of PLAYBOOKS) {
      const hasReview = p.tools.some((t) => REVIEW_TOOLS.includes(t));
      expect(hasReview, p.id).toBe(p.kind === 'reviewer' && p.available);
    }
    for (const p of PLAYBOOKS.filter((x) => x.tools.some((t) => WRITE_TOOLS.includes(t)))) expect(p.id).toBe('case_writer');
  });

  it('gives no role any approve / pass / close / complete / reject / archive / delete capability', () => {
    for (const p of PLAYBOOKS) for (const t of p.tools) expect(FORBIDDEN.test(t), `${p.id}: ${t}`).toBe(false);
    expect([...PLANNED_TOOLS].some((t) => FORBIDDEN.test(t))).toBe(false);
  });

  it('every role has a purpose, instructions and a checklist, and the unavailable ones say so', () => {
    for (const p of PLAYBOOKS) {
      expect(p.purpose.length).toBeGreaterThan(10);
      expect(p.instructions.length).toBeGreaterThan(0);
      expect(p.checklist.length).toBeGreaterThan(0);
      expect(p.tools.length).toBeGreaterThan(0);
    }
    for (const p of PLAYBOOKS.filter((x) => x.area === 'automation' || x.area === 'api')) {
      expect(p.available).toBe(false);
      expect(p.instructions[0]).toMatch(/Pass 3/);
    }
    // anything that writes test data repeats the fake-data rule
    for (const p of PLAYBOOKS.filter((x) => x.kind !== 'analyst' && x.kind !== 'lead')) expect(p.instructions.join(' ')).toMatch(/fake or masked/i);
  });

  it('validates agent names', () => {
    expect(validateAgentName('Nova')).toBeNull();
    expect(validateAgentName('QA Bot-2')).toBeNull();
    for (const bad of ['', 'A', '1Nova', 'x'.repeat(31), 'Nova!', '<b>x</b>', 'a\nb']) expect(validateAgentName(bad), bad).not.toBeNull();
  });
});
