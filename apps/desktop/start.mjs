// Builds and launches the desktop app. ELECTRON_RUN_AS_NODE is cleared on purpose: VS Code (and some
// other Electron hosts) set it for their child processes, which would make Electron start as plain
// Node and crash with "Cannot read properties of undefined (reading 'setPath')".
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
await import('./build.mjs');
const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [here, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: false });
child.on('exit', (code) => process.exit(code ?? 0));
