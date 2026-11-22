/**
 * Forwarder-side project resolution (Node-only). The cwd never leaves this function: the result is
 * a projectId, an opaque folder-key list (All sessions scope only), or a drop decision.
 */
import { folderKeysWithDepth, type FolderKeySecret } from './folderKeys.ts';
import { isExcluded, matchProject, pathForms, type PathForms } from './paths.ts';
import type { CapturePolicy } from './policy.ts';

export type Resolution =
  | { kind: 'project'; projectId: string }
  | { kind: 'unregistered'; folderKeys: string[] }
  | { kind: 'drop'; reason: 'no_cwd' | 'excluded' | 'unregistered' };

export function resolveProject(
  cwd: unknown,
  policy: CapturePolicy,
  loadSecret: () => FolderKeySecret | null,
  forms: (p: string) => PathForms = pathForms,
): Resolution {
  if (typeof cwd !== 'string' || cwd.trim() === '' || cwd.length > 4096) {
    return { kind: 'drop', reason: 'no_cwd' };
  }
  const cwdForms = forms(cwd);
  if (isExcluded(cwdForms, policy.excludes)) return { kind: 'drop', reason: 'excluded' };
  const match = matchProject(cwdForms, policy.projects);
  if (match) return { kind: 'project', projectId: match.id };
  if (policy.scope !== 'all') return { kind: 'drop', reason: 'unregistered' };
  const secret = loadSecret();
  if (!secret) return { kind: 'unregistered', folderKeys: [] };
  return { kind: 'unregistered', folderKeys: folderKeysWithDepth(secret, cwdForms).map((k) => k.key) };
}
