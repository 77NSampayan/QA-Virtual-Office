/** npm run folder-key:rotate — deletes the old folder-key secret (old-kid sessions can no longer be re-linked). */
import { bootstrapDataDir, defaultDataDir, rotateFolderKeySecret } from '../dataDir.ts';

if (process.argv[2] !== 'rotate') {
  console.error('usage: folderKey.ts rotate');
  process.exit(1);
}
const { paths } = bootstrapDataDir(defaultDataDir());
const next = rotateFolderKeySecret(paths);
console.log(`Rotated folder-key secret. New kid: ${next.kid}. Previous key deleted.`);
