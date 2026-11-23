import { describe, expect, it } from 'vitest';
import { maskPath, safeToolName, summarizeToolInput, SUMMARY_MAX } from '../src/permissionSummary.ts';

const roots = ['C:\\work\\Shop'];

describe('maskPath', () => {
  it('shows paths relative to the project, home-masked, or just the file name', () => {
    expect(maskPath('C:\\work\\Shop\\src\\app.ts', roots)).toBe('<project>\\src\\app.ts');
    expect(maskPath('c:/WORK/shop/src/app.ts', roots)).toBe('<project>\\src\\app.ts');
    expect(maskPath('C:\\Users\\jane\\Documents\\notes.txt', roots)).toBe('~\\Documents\\notes.txt');
    expect(maskPath('/home/jane/x/y.txt', [])).toBe('~\\x\\y.txt');
    expect(maskPath('D:\\other\\place\\secret.pem', roots)).toBe('…\\secret.pem');
    expect(maskPath('C:\\work\\ShopEvil\\x.ts', roots)).toBe('…\\x.ts'); // a sibling folder is not "inside the project"
  });
  it('never leaks a user name', () => {
    for (const p of ['C:\\Users\\jane.doe\\a.txt', 'C:/Users/Jane/b.txt']) expect(maskPath(p, roots)).not.toMatch(/jane/i);
  });
});

describe('summarizeToolInput', () => {
  it('Bash: the command on one line, redacted and truncated', () => {
    expect(summarizeToolInput('Bash', { command: 'npm test\n  --silent' }, roots)).toBe('npm test --silent');
    const secret = summarizeToolInput('Bash', { command: 'curl -H "Authorization: Bearer abcdefghijklmnop1234567890" https://x.example && echo jane.doe@example.com' }, roots)!;
    expect(secret).not.toContain('abcdefghijklmnop1234567890');
    expect(secret).not.toContain('jane.doe@example.com');
    const long = summarizeToolInput('Bash', { command: 'echo ' + 'a'.repeat(2000) }, roots)!;
    expect(long.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
  it('file tools: the verb and a masked path, never the contents', () => {
    expect(summarizeToolInput('Edit', { file_path: 'C:\\work\\Shop\\src\\a.ts', old_string: 'SECRET-OLD', new_string: 'SECRET-NEW' }, roots)).toBe('edit <project>\\src\\a.ts');
    expect(summarizeToolInput('Write', { file_path: 'C:\\Users\\jane\\x.txt', content: 'TOP-SECRET' }, roots)).toBe('write ~\\x.txt');
    expect(summarizeToolInput('Read', { file_path: 'E:\\z\\key.pem' }, roots)).toBe('read …\\key.pem');
    expect(summarizeToolInput('Edit', {}, roots)).toBe('edit a file');
  });
  it('web and agent tools are described briefly', () => {
    expect(summarizeToolInput('WebFetch', { url: 'https://docs.example.com/page' }, roots)).toBe('fetch https://docs.example.com/page');
    expect(summarizeToolInput('WebSearch', { query: 'node test runner' }, roots)).toBe('search the web for "node test runner"');
    expect(summarizeToolInput('Task', { description: 'explore the repo' }, roots)).toBe('start a subagent: explore the repo');
  });
  it('MCP and unknown tools show field NAMES only, never values', () => {
    const s = summarizeToolInput('mcp__server__do_thing', { target: 'SECRET-VALUE', count: 3 }, roots)!;
    expect(s).toBe('with fields: target, count');
    expect(s).not.toContain('SECRET-VALUE');
    expect(summarizeToolInput('mcp__x__y', { 'bad key!': 1, ['x'.repeat(80)]: 2 }, roots)).toBeNull();
  });
  it('returns null for empty or non-object input', () => {
    expect(summarizeToolInput('Bash', {}, roots)).toBeNull();
    expect(summarizeToolInput('Bash', null, roots)).toBeNull();
    expect(summarizeToolInput('Bash', 'rm -rf /', roots)).toBeNull();
    expect(summarizeToolInput('Bash', [1, 2], roots)).toBeNull();
  });
});

describe('safeToolName', () => {
  it('lets a plain identifier through and replaces anything else', () => {
    expect(safeToolName('Bash')).toBe('Bash');
    expect(safeToolName('mcp__qa-office__qa_list_projects')).toBe('mcp__qa-office__qa_list_projects');
    expect(safeToolName('Bash; rm -rf /')).toBe('tool');
    expect(safeToolName('C:\\Users\\jane')).toBe('tool');
    expect(safeToolName(7)).toBe('tool');
    expect(safeToolName('x'.repeat(200))).toBe('tool');
  });
});
