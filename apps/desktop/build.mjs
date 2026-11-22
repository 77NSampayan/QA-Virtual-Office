// Bundles the Electron main process and preload into single CommonJS files (electron stays external).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const name of ['main', 'preload']) {
  await build({
    entryPoints: [path.join(here, `src/${name}.ts`)],
    outfile: path.join(here, `dist/${name}.cjs`),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron', 'bufferutil', 'utf-8-validate'],
    legalComments: 'none',
    logLevel: 'warning',
  });
  console.log('built', path.join(here, `dist/${name}.cjs`));
}
