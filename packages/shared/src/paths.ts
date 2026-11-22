/**
 * Windows path handling shared by the forwarder and the server (Node-only module).
 *
 * Rules (see docs/privacy.md):
 *  - normalize: strip \\?\ and \\?\UNC\ prefixes, `/` -> `\`, collapse duplicate separators,
 *    drop trailing separators (except bare drive root `c:\`), lowercase.
 *    NTFS per-directory case sensitivity is NOT supported.
 *  - lexical form  = normalize(path.win32.resolve(p))      (no filesystem access)
 *  - canonical form = normalize(fs.realpathSync.native(p))  (resolves junctions/symlinks; null if missing)
 *  - matching is directory-boundary aware; longest root wins; canonical<->canonical wins ties.
 *  - mapped drive letters and `subst` drives are compared as written (not expanded).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface PathForms {
  lexical: string;
  canonical: string | null;
}

export interface ProjectRoot extends PathForms {
  id: string;
}

function stripLongPrefix(p: string): string {
  const s = p.replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(s)) return '\\\\' + s.slice(8);
  if (s.startsWith('\\\\?\\') || s.startsWith('\\\\.\\')) return s.slice(4);
  return s;
}

export function normalizeWinPath(input: string): string {
  let s = stripLongPrefix(input.trim());
  const isUnc = s.startsWith('\\\\');
  const body = (isUnc ? s.slice(2) : s).replace(/\\{2,}/g, '\\');
  s = isUnc ? '\\\\' + body : body;
  if (/^[a-z]:$/i.test(s)) s += '\\';
  if (!/^[a-z]:\\$/i.test(s)) s = s.replace(/\\+$/, '');
  return s.toLowerCase();
}

export function lexicalForm(p: string): string {
  return normalizeWinPath(path.win32.resolve(stripLongPrefix(p)));
}

export function canonicalForm(
  p: string,
  realpath: (p: string) => string = fs.realpathSync.native,
): string | null {
  try {
    return normalizeWinPath(realpath(stripLongPrefix(p)));
  } catch {
    return null;
  }
}

export function pathForms(p: string): PathForms {
  return { lexical: lexicalForm(p), canonical: canonicalForm(p) };
}

function isRootLike(p: string): boolean {
  return /^[a-z]:\\$/.test(p) || /^\\\\[^\\]+\\[^\\]+$/.test(p) || /^\\\\[^\\]+$/.test(p);
}

/** True when `child` equals `root` or is inside it (both already normalized). */
export function isWithin(child: string, root: string): boolean {
  if (root.endsWith('\\')) return child.startsWith(root);
  return child === root || child.startsWith(root + '\\');
}

/** The path itself plus up to `max` ancestors, excluding drive roots and UNC share roots. */
export function ancestors(p: string, max = 8): string[] {
  const out: string[] = [];
  let cur = normalizeWinPath(p);
  while (out.length < max + 1 && !isRootLike(cur)) {
    out.push(cur);
    const idx = cur.lastIndexOf('\\');
    if (idx <= 0) break;
    let parent = cur.slice(0, idx);
    if (/^[a-z]:$/.test(parent)) parent += '\\';
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

export interface MatchResult {
  id: string;
  root: string;
  canonicalPair: boolean;
}

/** Longest matching root wins; on equal length, a canonical-to-canonical match wins. */
export function matchProject(cwd: PathForms, roots: readonly ProjectRoot[]): MatchResult | null {
  let best: MatchResult | null = null;
  for (const r of roots) {
    const pairs: Array<[string | null, string | null, boolean]> = [
      [cwd.lexical, r.lexical, false],
      [cwd.lexical, r.canonical, false],
      [cwd.canonical, r.lexical, false],
      [cwd.canonical, r.canonical, true],
    ];
    for (const [c, root, canonicalPair] of pairs) {
      if (!c || !root || !isWithin(c, root)) continue;
      const better =
        !best ||
        root.length > best.root.length ||
        (root.length === best.root.length && canonicalPair && !best.canonicalPair);
      if (better) best = { id: r.id, root, canonicalPair };
    }
  }
  return best;
}

export function isExcluded(cwd: PathForms, excludes: readonly PathForms[]): boolean {
  return matchProject(
    cwd,
    excludes.map((e, i) => ({ id: String(i), ...e })),
  ) !== null;
}
