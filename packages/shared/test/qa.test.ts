import { describe, expect, it } from 'vitest';
import {
  analyzeRequirement,
  canTransition,
  coverageRatio,
  parseRequirements,
  TEST_CASE_STATUSES,
  TEST_TYPES,
  validateForApproval,
} from '../src/qa.ts';

describe('test case approval workflow rules', () => {
  it('allows only the documented transitions', () => {
    const ok: Array<[string, string]> = [
      ['draft', 'in_review'],
      ['in_review', 'approved'],
      ['in_review', 'rejected'],
      ['in_review', 'draft'],
      ['rejected', 'draft'],
      ['approved', 'draft'],
    ];
    for (const from of TEST_CASE_STATUSES) {
      for (const to of TEST_CASE_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(ok.some(([f, t]) => f === from && t === to));
      }
    }
  });
  it('draft cannot jump straight to approved (a review step is mandatory)', () => {
    expect(canTransition('draft', 'approved')).toBe(false);
  });
  it('lists the ten supported test types', () => {
    expect(TEST_TYPES).toEqual([
      'positive',
      'negative',
      'boundary_value',
      'equivalence_partitioning',
      'decision_table',
      'state_transition',
      'exploratory',
      'regression',
      'integration',
      'end_to_end',
    ]);
  });
  it('approval requires a title, at least one non-empty step and an expected result', () => {
    expect(validateForApproval({ title: 'Login', steps: ['Open page'], expectedResult: 'Logged in' })).toEqual([]);
    expect(validateForApproval({ title: ' ', steps: [], expectedResult: '' })).toEqual(['title_required', 'steps_required', 'expected_result_required']);
    expect(validateForApproval({ title: 'x', steps: ['  ', ''], expectedResult: 'y' })).toEqual(['steps_required']);
  });
});

describe('coverage ratios never hide the denominator', () => {
  it('returns numerator, denominator and a percent only when the denominator is valid', () => {
    expect(coverageRatio(3, 4)).toEqual({ numerator: 3, denominator: 4, percent: 75 });
    expect(coverageRatio(1, 3)).toEqual({ numerator: 1, denominator: 3, percent: 33.3 });
    expect(coverageRatio(0, 5)).toEqual({ numerator: 0, denominator: 5, percent: 0 });
    expect(coverageRatio(0, 0)).toEqual({ numerator: 0, denominator: 0, percent: null });
  });
  it('clamps impossible numerators', () => {
    expect(coverageRatio(9, 4).percent).toBe(100);
    expect(coverageRatio(-1, 4).percent).toBe(0);
  });
});

describe('parseRequirements', () => {
  it('reads reference-prefixed requirements in common styles', () => {
    const text = [
      'REQ-1: The system shall let a user sign in with email and password.',
      'US-12 - As a user I want to reset my password so that I can regain access.',
      'BRD 3.2) Payments must be confirmed within 5 seconds.',
      '4.1 Orders over 100 require manager approval.',
      '- FR-7. Export is available as CSV.',
    ].join('\n');
    const r = parseRequirements(text);
    expect(r.items.map((i) => i.ref)).toEqual(['REQ-1', 'US-12', 'BRD 3.2', '4.1', 'FR-7']);
    expect(r.items[0]).toMatchObject({ ref: 'REQ-1', title: 'The system shall let a user sign in with email and password.' });
    expect(r.unparsed).toEqual([]);
  });
  it('joins continuation lines, reports unparsed text and duplicate references', () => {
    const text = ['Introduction text before any requirement', 'REQ-1: First line', 'continues here', '', 'REQ-2: Second', 'REQ-1: Duplicate reference'].join('\n');
    const r = parseRequirements(text);
    expect(r.unparsed).toEqual(['Introduction text before any requirement']);
    expect(r.items[0]!.text).toBe('First line\ncontinues here');
    expect(r.duplicates).toEqual(['REQ-1']);
  });
  it('truncates long titles and ignores empty input', () => {
    const long = 'REQ-9: ' + 'word '.repeat(60);
    expect(parseRequirements(long).items[0]!.title.length).toBeLessThanOrEqual(120);
    expect(parseRequirements('').items).toEqual([]);
    expect(parseRequirements('   \n\n  ').items).toEqual([]);
  });
});

describe('analyzeRequirement: deterministic ambiguity hints for human review', () => {
  const terms = (t: string) => analyzeRequirement(t).map((f) => `${f.kind}:${f.term}`);
  it('flags vague wording', () => {
    expect(terms('The page should load quickly and be user-friendly.')).toEqual(expect.arrayContaining(['vague:user-friendly', 'unmeasurable:quickly']));
  });
  it('flags placeholders and weak modals', () => {
    expect(terms('Limit is TBD. The system may notify users, etc.')).toEqual(expect.arrayContaining(['placeholder:TBD', 'weak_modal:may', 'vague:etc']));
  });
  it('does not call a performance requirement unmeasurable when it has a number', () => {
    expect(terms('Search results are returned quickly, within 2 seconds.')).not.toContain('unmeasurable:quickly');
  });
  it('a precise requirement produces no hints', () => {
    expect(analyzeRequirement('The system shall lock an account after 5 failed sign-in attempts within 10 minutes.')).toEqual([]);
  });
  it('findings are unique per term and carry an explanation', () => {
    const f = analyzeRequirement('easy easy EASY');
    expect(f).toHaveLength(1);
    expect(f[0]!.note.length).toBeGreaterThan(10);
  });
});
