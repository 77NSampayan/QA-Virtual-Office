// Bundles the qa-office MCP server into one self-contained ESM file (no node_modules at runtime).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(here, 'src/main.ts')],
  outfile: path.join(here, 'dist/qa-office-mcp.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: false,
  legalComments: 'none',
  banner: { js: '// QA Virtual Office - qa-office MCP server (generated file, do not edit).\n// A thin stdio proxy: every rule is enforced by the local QA Virtual Office server.' },
});
console.log('built', path.join(here, 'dist/qa-office-mcp.mjs'));
