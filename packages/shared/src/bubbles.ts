/**
 * Activity bubbles: what a robot is doing, in a few words, from METADATA ONLY (the tool's name and the
 * file/command category the forwarder derived locally). Never file names, commands, prompts or content.
 */
export const BUBBLE_FRESH_MS = 120_000;

/** Statuses in which a robot is working and a tool bubble makes sense. */
export const WORKING_STATUSES: readonly string[] = ['analyzing', 'writing_tests', 'executing_tests', 'debugging'];

const READ = new Set(['read', 'glob', 'grep', 'ls', 'notebookread']);
const WEB = new Set(['websearch', 'webfetch']);
const EDIT = new Set(['edit', 'write', 'multiedit', 'notebookedit']);

const FILE_TEXT: Record<string, string> = { test: 'writing tests', source: 'editing code', doc: 'writing docs', config: 'editing config' };
const COMMAND_TEXT: Record<string, string> = { test_run: 'running tests', build: 'building', git: 'using git', install: 'installing' };

export function toolBubble(tool: string | null | undefined, fileCategory?: string | null, commandCategory?: string | null): string | null {
  if (!tool) return null;
  const t = tool.toLowerCase();
  if (READ.has(t)) return 'reading';
  if (WEB.has(t)) return 'searching the web';
  if (EDIT.has(t)) return FILE_TEXT[fileCategory ?? ''] ?? 'editing';
  if (t === 'bash') return COMMAND_TEXT[commandCategory ?? ''] ?? 'in the terminal';
  if (t === 'task' || t === 'agent') return 'delegating';
  if (t === 'todowrite') return 'planning';
  if (t.startsWith('mcp__')) return 'using a tool';
  return 'working';
}

/** The bubble to show for a session right now, or null (not working, nothing recent, or no tool seen yet). */
export function currentBubble(
  status: string,
  activity: { tool: string; fileCategory: string | null; commandCategory: string | null; at: number } | null | undefined,
  now: number,
): string | null {
  if (!WORKING_STATUSES.includes(status) || !activity || now - activity.at > BUBBLE_FRESH_MS) return null;
  return toolBubble(activity.tool, activity.fileCategory, activity.commandCategory);
}
