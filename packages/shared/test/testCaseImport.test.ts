import { describe, expect, it } from 'vitest';
import { parseTestCaseTable, splitSteps, MAX_IMPORT_ROWS } from '../src/testCaseImport.ts';

const HEADER =
  'Module\tSub Module\tTest Case ID\tTest Case Description\tTest Case Type\tPre-Condition\tExpected Result\tActual Result\tTest Data\tDE Exception Message\tStatus\tTest Execution Status\tExecution Date - PRE PROD\tDefect ID\tProposed Solution\tAction Owner\tAction Item\tAutomation Feasibility\tAutomation Script\tAutomation Remarks\tAssigned Tester\tTest Evidence Link\tTest Inclusion\tDefect History\tRemarks';

describe('parseTestCaseTable: the team template columns', () => {
  it('maps a Markdown table and ignores execution/automation columns', () => {
    const md = [
      '# Login',
      '',
      '| Module | Sub Module | Test Case ID | Test Case Description | Test Case Type | Pre-Condition | Expected Result | Actual Result | Status | Test Execution Status | Defect ID | Priority |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
      '| Auth | Login | TC_001 | Sign in with valid credentials | Positive | Account exists | Dashboard is shown | Dashboard shown | Passed | Passed | DEF-1 | High |',
      '| Auth | Login | TC_002 | Sign in with a wrong password | Negative | | Error is shown | | | | | P2 |',
    ].join('\n');
    const r = parseTestCaseTable(md);
    expect(r.format).toBe('markdown');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ row: 1, externalId: 'TC_001', module: 'Auth', subModule: 'Login', title: 'Sign in with valid credentials', testType: 'positive', priority: 'high', preconditions: 'Account exists', expectedResult: 'Dashboard is shown' });
    expect(r.rows[1]).toMatchObject({ externalId: 'TC_002', testType: 'negative', priority: 'high' });
    expect(r.columns.ignored.sort()).toEqual(['Actual Result', 'Defect ID', 'Status', 'Test Execution Status'].sort());
    // results are never read: nothing about Passed/DEF-1 reaches a row
    expect(JSON.stringify(r.rows)).not.toMatch(/Passed|DEF-1|Dashboard shown/);
  });

  it('reads cells pasted from a spreadsheet (tab separated, quoted multi-line cells)', () => {
    const cols = HEADER.split('\t');
    const row = (over: Record<string, string>) => cols.map((c) => over[c] ?? '').join('\t');
    const tsv = [
      HEADER,
      row({ Module: 'Cart', 'Sub Module': 'Add', 'Test Case ID': 'C1', 'Test Case Description': 'Add a product', 'Test Case Type': 'Regression', 'Expected Result': '"Cart shows 1 item,\nand the total is updated"', 'Assigned Tester': 'Alex', Remarks: 'Smoke', Status: 'Passed', 'Test Evidence Link': 'http://x/y', 'Automation Feasibility': 'Yes' }),
    ].join('\r\n');
    const r = parseTestCaseTable(tsv);
    expect(r.format).toBe('tsv');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ externalId: 'C1', testType: 'regression', assignedTester: 'Alex', expectedResult: 'Cart shows 1 item,\nand the total is updated', description: 'Remarks: Smoke' });
    expect(r.columns.ignored).toEqual(expect.arrayContaining(['Status', 'Test Evidence Link', 'Automation Feasibility', 'Execution Date - PRE PROD', 'Defect History', 'Test Inclusion']));
    expect(r.columns.unknown).toEqual([]);
  });

  it('splits steps from <br>, lines and inline numbering, and strips numbering', () => {
    expect(splitSteps('1. Open the site<br>2. Click Login\n3) Enter data')).toEqual(['Open the site', 'Click Login', 'Enter data']);
    expect(splitSteps('Step 1: Open 2. Click 3. Type')).toEqual(['Open', 'Click', 'Type']);
    expect(splitSteps('- one\n- two')).toEqual(['one', 'two']);
    expect(splitSteps('Open version 2. then close')).toEqual(['Open version 2. then close']);
    expect(splitSteps('')).toEqual([]);
  });

  it('uses <br>, escaped pipes and a long description sensibly', () => {
    const long = 'x'.repeat(250);
    const md = ['| Test Case Description | Steps | Test Data |', '| --- | --- | --- |', `| ${long} | 1. a<br>2. b | a \\| b |`, '| Short title<br>second line | | |'].join('\n');
    const r = parseTestCaseTable(md);
    expect(r.rows[0]!.title.length).toBeLessThanOrEqual(200);
    expect(r.rows[0]!.description).toBe(long); // the full text is kept when it did not fit the title
    expect(r.rows[0]!.steps).toEqual(['a', 'b']);
    expect(r.rows[0]!.testData).toBe('a | b');
    expect(r.rows[1]).toMatchObject({ title: 'Short title', description: 'Short title\nsecond line' });
  });

  it('warns and falls back for unknown type/priority instead of guessing', () => {
    const md = ['| Test Case Description | Test Case Type | Priority |', '|---|---|---|', '| A | Smoke | Urgent |', '| B | BVA | critical |'].join('\n');
    const r = parseTestCaseTable(md);
    expect(r.rows[0]).toMatchObject({ testType: 'positive', priority: 'medium' });
    expect(r.rows[0]!.warnings).toHaveLength(2);
    expect(r.rows[1]).toMatchObject({ testType: 'boundary_value', priority: 'critical', warnings: [] });
  });

  it('reports rows without a description, missing columns, unknown headers and no table', () => {
    const md = ['| Test Case ID | Test Case Description | Weird Column |', '|---|---|---|', '| 1 | ok | z |', '| 2 | | z |', '| | | |'].join('\n');
    const r = parseTestCaseTable(md);
    expect(r.rows).toHaveLength(1);
    expect(r.rowErrors).toEqual([{ row: 2, reason: 'The test case description is empty' }]);
    expect(r.columns.unknown).toEqual(['Weird Column']);
    expect(parseTestCaseTable('| Test Case ID | Module |\n|---|---|\n| 1 | a |').missingDescriptionColumn).toBe(true);
    expect(parseTestCaseTable('just some prose, no table')).toMatchObject({ format: 'none', rows: [] });
  });

  it('parses several tables (e.g. one per module) and numbers rows across them', () => {
    const md = ['## A', '| Test Case ID | Test Case Description |', '|---|---|', '| 1 | one |', '', '## B', '| Test Case ID | Test Case Description |', '|---|---|', '| 2 | two |'].join('\n');
    const r = parseTestCaseTable(md);
    expect(r.rows.map((x) => [x.row, x.externalId])).toEqual([[1, '1'], [2, '2']]);
  });

  it('caps the number of rows', () => {
    const body = Array.from({ length: MAX_IMPORT_ROWS + 5 }, (_, i) => `| T${i} | t |`).join('\n');
    const r = parseTestCaseTable(`| Test Case ID | Test Case Description |\n|---|---|\n${body}`);
    expect(r.rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(r.truncated).toBe(true);
  });

  it('splits requirement references', () => {
    const md = ['| Test Case Description | Requirement Refs |', '|---|---|', '| a | FR-1, FR-2; FR-1 |'].join('\n');
    expect(parseTestCaseTable(md).rows[0]!.requirementRefs).toEqual(['FR-1', 'FR-2']);
  });
});
