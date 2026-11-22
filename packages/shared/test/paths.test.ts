import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeWinPath,
  lexicalForm,
  canonicalForm,
  isWithin,
  ancestors,
  matchProject,
  pathForms,
} from '../src/paths.ts';

describe('normalizeWinPath', () => {
  it('lowercases and unifies separators', () => {
    expect(normalizeWinPath('C:/Work/Proj')).toBe('c:\\work\\proj');
    expect(normalizeWinPath('C:\\Work\\Proj')).toBe('c:\\work\\proj');
  });
  it('drops trailing separators but keeps a bare drive root', () => {
    expect(normalizeWinPath('C:\\Work\\Proj\\')).toBe('c:\\work\\proj');
    expect(normalizeWinPath('C:\\Work\\Proj\\\\')).toBe('c:\\work\\proj');
    expect(normalizeWinPath('C:\\')).toBe('c:\\');
    expect(normalizeWinPath('C:')).toBe('c:\\');
  });
  it('collapses duplicate separators', () => {
    expect(normalizeWinPath('C:\\\\Work//Proj')).toBe('c:\\work\\proj');
  });
  it('strips long-path prefixes', () => {
    expect(normalizeWinPath('\\\\?\\C:\\Work\\Proj')).toBe('c:\\work\\proj');
    expect(normalizeWinPath('\\\\?\\UNC\\server\\share\\dir')).toBe('\\\\server\\share\\dir');
  });
  it('keeps UNC prefix', () => {
    expect(normalizeWinPath('\\\\Server\\Share\\Dir\\')).toBe('\\\\server\\share\\dir');
    expect(normalizeWinPath('//Server/Share/Dir')).toBe('\\\\server\\share\\dir');
  });
});

describe('lexicalForm', () => {
  it('resolves dot segments without touching the filesystem', () => {
    expect(lexicalForm('C:\\Work\\Proj\\sub\\..\\other\\.')).toBe('c:\\work\\proj\\other');
  });
  it('handles prefixed paths', () => {
    expect(lexicalForm('\\\\?\\C:\\Work\\Proj')).toBe('c:\\work\\proj');
  });
});

describe('isWithin (directory-boundary aware)', () => {
  it('matches the root itself and descendants', () => {
    expect(isWithin('c:\\proj', 'c:\\proj')).toBe(true);
    expect(isWithin('c:\\proj\\a\\b', 'c:\\proj')).toBe(true);
  });
  it('does not match sibling prefixes', () => {
    expect(isWithin('c:\\project2', 'c:\\proj')).toBe(false);
    expect(isWithin('c:\\proj-old\\x', 'c:\\proj')).toBe(false);
  });
  it('treats a drive root as a root', () => {
    expect(isWithin('c:\\anything', 'c:\\')).toBe(true);
    expect(isWithin('d:\\anything', 'c:\\')).toBe(false);
  });
});

describe('ancestors', () => {
  it('lists the path and up to 8 ancestors, excluding the drive root', () => {
    expect(ancestors('c:\\a\\b\\c')).toEqual(['c:\\a\\b\\c', 'c:\\a\\b', 'c:\\a']);
  });
  it('caps depth at 8 ancestors (9 entries including self)', () => {
    const deep = 'c:\\' + Array.from({ length: 12 }, (_, i) => `d${i}`).join('\\');
    const list = ancestors(deep);
    expect(list).toHaveLength(9);
    expect(list[0]).toBe(deep);
  });
  it('excludes a UNC share root', () => {
    expect(ancestors('\\\\srv\\share\\x\\y')).toEqual(['\\\\srv\\share\\x\\y', '\\\\srv\\share\\x']);
  });
});

describe('matchProject', () => {
  const projects = [
    { id: 'p-root', lexical: 'c:\\work', canonical: 'c:\\work' },
    { id: 'p-proj', lexical: 'c:\\work\\proj', canonical: 'd:\\real\\proj' },
    { id: 'p-missing', lexical: 'c:\\gone\\proj', canonical: null },
  ];
  it('longest root wins', () => {
    expect(matchProject({ lexical: 'c:\\work\\proj\\src', canonical: null }, projects)?.id).toBe(
      'p-proj',
    );
    expect(matchProject({ lexical: 'c:\\work\\other', canonical: null }, projects)?.id).toBe(
      'p-root',
    );
  });
  it('matches via canonical form (junction target -> registered junction)', () => {
    expect(matchProject({ lexical: 'd:\\real\\proj\\tests', canonical: null }, projects)?.id).toBe(
      'p-proj',
    );
  });
  it('matches via cwd canonical form (cwd is a junction into a project)', () => {
    expect(
      matchProject({ lexical: 'e:\\link\\x', canonical: 'c:\\work\\proj\\x' }, projects)?.id,
    ).toBe('p-proj');
  });
  it('matches a project whose path no longer exists lexically only', () => {
    expect(matchProject({ lexical: 'c:\\gone\\proj\\a', canonical: null }, projects)?.id).toBe(
      'p-missing',
    );
  });
  it('returns null when nothing matches, respecting boundaries', () => {
    expect(matchProject({ lexical: 'c:\\workspace', canonical: null }, projects)).toBeNull();
  });
  it('prefers canonical-to-canonical match on a tie', () => {
    const tie = [
      { id: 'lex', lexical: 'c:\\x\\y', canonical: null },
      { id: 'can', lexical: 'q:\\other', canonical: 'c:\\x\\y' },
    ];
    expect(matchProject({ lexical: 'c:\\x\\y\\z', canonical: 'c:\\x\\y\\z' }, tie)?.id).toBe('can');
  });
});

describe('filesystem forms (junctions and symlinks)', () => {
  let tmp: string;
  let target: string;
  let junction: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-paths-'));
    target = path.join(tmp, 'RealTarget');
    fs.mkdirSync(path.join(target, 'Sub'), { recursive: true });
    junction = path.join(tmp, 'JunctionLink');
    fs.symlinkSync(target, junction, 'junction');
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('canonicalForm resolves a junction to its target', () => {
    expect(canonicalForm(junction)).toBe(canonicalForm(target));
    expect(canonicalForm(path.join(junction, 'Sub'))).toBe(canonicalForm(path.join(target, 'Sub')));
  });

  it('canonicalForm returns null for a deleted directory', () => {
    expect(canonicalForm(path.join(tmp, 'does-not-exist'))).toBeNull();
  });

  it('junction -> target: project registered at junction matches cwd inside target', () => {
    const proj = { id: 'j', ...pathForms(junction) };
    const cwd = pathForms(path.join(target, 'Sub'));
    expect(matchProject(cwd, [proj])?.id).toBe('j');
  });

  it('target -> junction: project registered at target matches cwd inside junction', () => {
    const proj = { id: 't', ...pathForms(target) };
    const cwd = pathForms(path.join(junction, 'Sub'));
    expect(matchProject(cwd, [proj])?.id).toBe('t');
  });

  it('directory symlink in both directions (skips if symlink privilege unavailable)', (ctx) => {
    const link = path.join(tmp, 'DirSymlink');
    try {
      fs.symlinkSync(target, link, 'dir');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM') {
        console.warn('[skip-report] directory symlink requires privilege (EPERM) - skipped');
        ctx.skip();
        return;
      }
      throw err;
    }
    expect(matchProject(pathForms(path.join(link, 'Sub')), [{ id: 't', ...pathForms(target) }])?.id).toBe('t');
    expect(matchProject(pathForms(path.join(target, 'Sub')), [{ id: 'l', ...pathForms(link) }])?.id).toBe('l');
  });
});
