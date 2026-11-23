/**
 * What a person sees before approving a permission request from the office. Built LOCALLY by the permission
 * hook from the tool input, and ONLY when the person turned on tool-input capture. It is a short, redacted,
 * path-masked, truncated description; never the full input, never file contents.
 */
import { redact } from './redact.ts';

export const SUMMARY_MAX = 400;

const homeMask = (p: string) => p.replace(/^[A-Za-z]:[\\/]+Users[\\/]+[^\\/]+/i, '~').replace(/^\/(?:home|Users)\/[^/]+/i, '~');

/** A path shown relative to the project, home-masked, or just its file name when it is somewhere else. */
export function maskPath(p: string, roots: readonly string[]): string {
  const norm = (s: string) => s.replace(/\//g, '\\').toLowerCase();
  const n = norm(p);
  for (const root of roots) {
    const r = norm(root).replace(/\\+$/, '');
    if (r && (n === r || n.startsWith(r + '\\'))) return '<project>' + p.slice(r.length).replace(/\//g, '\\');
  }
  const masked = homeMask(p);
  if (masked.startsWith('~')) return masked.replace(/\//g, '\\');
  const base = p.split(/[\\/]/).filter(Boolean).pop();
  return base ? '…\\' + base : '(a file)';
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const keysOf = (o: Record<string, unknown>) => Object.keys(o).filter((k) => /^[A-Za-z0-9_]{1,40}$/.test(k)).slice(0, 8);

export function summarizeToolInput(toolName: string, toolInput: unknown, roots: readonly string[]): string | null {
  const input = toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput) ? (toolInput as Record<string, unknown>) : {};
  const t = toolName.toLowerCase();
  let text = '';
  if (t === 'bash') {
    text = oneLine(str(input.command, 600));
  } else if (['edit', 'multiedit', 'write', 'notebookedit', 'read'].includes(t)) {
    const file = str(input.file_path ?? input.notebook_path, 1000);
    const verb = t === 'read' ? 'read' : t === 'write' ? 'write' : 'edit';
    text = file ? verb + ' ' + maskPath(file, roots) : verb + ' a file';
  } else if (t === 'webfetch') {
    text = 'fetch ' + oneLine(str(input.url, 300));
  } else if (t === 'websearch') {
    text = 'search the web for "' + oneLine(str(input.query, 200)) + '"';
  } else if (t === 'task' || t === 'agent') {
    text = 'start a subagent: ' + oneLine(str(input.description, 200));
  } else {
    // anything else (including MCP tools): the names of the fields only, never their values
    const keys = keysOf(input);
    text = keys.length ? 'with fields: ' + keys.join(', ') : '';
  }
  const safe = redact(text).trim();
  if (!safe) return null;
  return safe.length > SUMMARY_MAX ? safe.slice(0, SUMMARY_MAX - 1).trimEnd() + '…' : safe;
}

/** The tool name as it is allowed to travel to the server: a plain identifier or a fixed fallback. */
export const safeToolName = (name: unknown): string => (typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(name) ? name : 'tool');
