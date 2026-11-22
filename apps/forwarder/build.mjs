// Bundles the forwarder into a single self-contained ESM file (no node_modules at runtime).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(here, 'src/forward.ts')],
  outfile: path.join(here, 'dist/forward.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: false,
  legalComments: 'none',
  banner: { js: '// QA Virtual Office hook forwarder - generated file, do not edit.\n// Metadata-only: sanitizes hook payloads locally before anything leaves this process.' },
});
console.log('built', path.join(here, 'dist/forward.mjs'));
