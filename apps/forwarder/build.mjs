// Bundles the forwarders into single self-contained ESM files (no node_modules at runtime).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const banner = {
  js: '// QA Virtual Office forwarder - generated file, do not edit.\n// Metadata-only: sanitizes payloads locally before anything leaves this process.',
};
for (const name of ['forward', 'statusline', 'permission']) {
  await build({
    entryPoints: [path.join(here, `src/${name}.ts`)],
    outfile: path.join(here, `dist/${name}.mjs`),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: false,
    legalComments: 'none',
    banner,
  });
  console.log('built', path.join(here, `dist/${name}.mjs`));
}
