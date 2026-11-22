/** Copies the bundled qa-office MCP server into the data directory so `claude mcp add` can point at a stable path. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataDirPaths } from './dataDir.ts';

export const MCP_BUNDLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../mcp/dist/qa-office-mcp.mjs');

export function installMcpScript(paths: DataDirPaths, source = MCP_BUNDLE): boolean {
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(paths.mcpDir, { recursive: true });
  fs.copyFileSync(source, paths.mcpScript);
  return true;
}
