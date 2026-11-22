/**
 * Folder keys (Node-only): opaque, non-reversible identifiers for unregistered folders, used ONLY
 * in "All sessions" scope. key = `${kid}:${HMAC-SHA256(secret, normalizedForm)[0..128 bits]}`.
 * The secret lives in `folder-key.secret` (current-user ACL). See docs/privacy.md.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { ancestors, type PathForms } from './paths.ts';

export const FolderKeySecretSchema = z.object({
  kid: z.string().regex(/^[a-f0-9]{8}$/),
  key: z.string().min(40),
  createdAt: z.string(),
});
export type FolderKeySecret = z.infer<typeof FolderKeySecretSchema>;

export function generateFolderKeySecret(): FolderKeySecret {
  return {
    kid: crypto.randomBytes(4).toString('hex'),
    key: crypto.randomBytes(32).toString('base64'),
    createdAt: new Date().toISOString(),
  };
}

export function parseFolderKeySecret(text: string | null | undefined): FolderKeySecret | null {
  if (!text) return null;
  try {
    const r = FolderKeySecretSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function folderKey(secret: FolderKeySecret, normalizedForm: string): string {
  const mac = crypto
    .createHmac('sha256', Buffer.from(secret.key, 'base64'))
    .update(normalizedForm, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `${secret.kid}:${mac}`;
}

export interface DepthKey {
  key: string;
  depth: number;
}

/** Keys for the cwd (lexical + canonical) and each ancestor up to 8 levels; deduplicated. */
export function folderKeysWithDepth(secret: FolderKeySecret, cwd: PathForms): DepthKey[] {
  const seen = new Set<string>();
  const out: DepthKey[] = [];
  for (const form of [cwd.lexical, cwd.canonical]) {
    if (!form) continue;
    ancestors(form).forEach((p, depth) => {
      const key = folderKey(secret, p);
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ key, depth });
      }
    });
  }
  return out;
}

/** Keys identifying a registered project root (its lexical and canonical forms). */
export function projectRootKeys(secret: FolderKeySecret, root: PathForms): string[] {
  const keys = [folderKey(secret, root.lexical)];
  if (root.canonical && root.canonical !== root.lexical) keys.push(folderKey(secret, root.canonical));
  return keys;
}
