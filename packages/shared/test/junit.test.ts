import { describe, expect, it } from 'vitest';
import { automationDenominator, countStatuses, parseJunit } from '../src/junit.ts';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="login suite" tests="5">
    <testcase classname="auth.Login" name="TC-0001 valid sign in" time="1.25"/>
    <testcase classname="auth.Login" name="locks after 5 tries" time="0.5">
      <failure message="expected locked but got open&#10;second line" type="AssertionError"><![CDATA[Traceback (most recent call last):
  File "C:\\Users\\someone\\secret\\test.py", line 3
AssertionError]]></failure>
      <system-out><![CDATA[token=abcdef123456 log text]]></system-out>
    </testcase>
    <testcase classname="auth.Login" name="boom" time="0"><error message="TimeoutError: 30000ms exceeded"/></testcase>
    <testcase classname="auth.Login" name="later"><skipped message="not ready"/></testcase>
    <testcase classname="auth.Login" name="a &amp; b &lt;c&gt; &quot;q&quot;"/>
  </testsuite>
</testsuites>`;

describe('parseJunit', () => {
  const r = parseJunit(SAMPLE);
  it('reads statuses, names, suite and durations', () => {
    expect(r.problems).toEqual([]);
    expect(r.cases.map((c) => c.status)).toEqual(['passed', 'failed', 'error', 'skipped', 'passed']);
    expect(r.cases[0]).toMatchObject({ suite: 'login suite', className: 'auth.Login', name: 'TC-0001 valid sign in', durationMs: 1250 });
    expect(r.cases[4]!.name).toBe('a & b <c> "q"');
  });
  it('keeps only the first line of the message and never a stack trace, log or path', () => {
    const all = JSON.stringify(r);
    expect(r.cases[1]!.message).toBe('expected locked but got open');
    expect(all).not.toMatch(/Traceback|someone|secret|abcdef123456|log text/);
  });
  it('counts with a visible denominator that leaves skipped tests out', () => {
    const c = countStatuses(r.cases);
    expect(c).toEqual({ total: 5, passed: 2, failed: 1, errored: 1, skipped: 1 });
    expect(automationDenominator(c)).toBe(4);
  });
  it('handles a bare testsuite root, pytest-style and Playwright-style files', () => {
    const x = parseJunit('<testsuite name="pytest" tests="2"><testcase classname="t" name="a" time="0.01"/><testcase classname="t" name="b"><failure message="x">y</failure></testcase></testsuite>');
    expect(x.cases.map((c) => c.status)).toEqual(['passed', 'failed']);
  });
  it('a ">" inside an attribute value does not break reading', () => {
    const x = parseJunit('<testsuite name="s"><testcase name="a" classname="c"><failure message="1 > 0 is true"/></testcase></testsuite>');
    expect(x.cases[0]).toMatchObject({ status: 'failed', message: '1 > 0 is true' });
  });
  it('never expands entities or reads DOCTYPE content (no XXE, no entity bomb)', () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY x SYSTEM "file:///C:/Windows/win.ini">]><testsuite name="&b;"><testcase name="&x;&b;"/></testsuite>';
    const x = parseJunit(bomb);
    expect(x.cases).toHaveLength(1);
    expect(x.cases[0]!.name).toBe('&x;&b;'); // unknown entities stay as written
    expect(x.cases[0]!.name.length).toBeLessThan(20);
  });
  it('redacts secrets in names and messages', () => {
    const x = parseJunit('<testsuite name="s"><testcase name="login as bob@example.com" classname="c"><failure message="Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"/></testcase></testsuite>');
    expect(JSON.stringify(x)).not.toMatch(/bob@example\.com|abcdefghijklmnopqrstuvwxyz123456/);
  });
  it('says plainly when the file is not JUnit or empty', () => {
    expect(parseJunit('').problems[0]).toMatch(/empty/i);
    expect(parseJunit('<html><body>hi</body></html>').problems[0]).toMatch(/does not look like JUnit/);
    expect(parseJunit('<testsuite name="x"></testsuite>').problems[0]).toMatch(/no test cases/);
  });
  it('caps very large files', () => {
    const many = '<testsuite name="s">' + '<testcase name="t"/>'.repeat(20_050) + '</testsuite>';
    const x = parseJunit(many);
    expect(x.cases).toHaveLength(20_000);
    expect(x.truncated).toBe(true);
  });
});
