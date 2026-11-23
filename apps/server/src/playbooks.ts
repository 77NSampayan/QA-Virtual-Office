/**
 * Agent playbooks service (P1). The roster itself is code (`@qavo/shared` playbooks.ts); the database holds only what
 * a person may change (display name, house rules). Changing a name or house rules is HUMAN only, and never widens
 * what an agent may do: the allowed tools are fixed in code.
 */
import { z } from 'zod';
import { PLAYBOOK_BY_ID, PLAYBOOKS, MAX_HOUSE_RULES, validateAgentName, type Actor, type PlaybookDef } from '@qavo/shared';
import { AGENT_TOOL_NAMES } from './agent.ts';
import type { RunIdentity } from './runs.ts';
import type { DB } from './db/index.ts';
import { HttpError } from './store.ts';

const nowIso = () => new Date().toISOString();

export interface PlaybookDTO {
  id: string;
  role: string;
  kind: PlaybookDef['kind'];
  area: PlaybookDef['area'];
  available: boolean;
  purpose: string;
  agentName: string;
  defaultName: string;
  houseRules: string;
  /** Tools the agent may use that exist today. */
  tools: string[];
  /** Tools it will get later (the review checkpoint). Shown so the person sees the full picture. */
  plannedTools: string[];
  instructions: string[];
  checklist: string[];
  reviewedBy: string | null;
}

/** Makes sure every playbook has a row (inserts the defaults that are missing). Safe to call repeatedly. */
export function ensurePlaybooks(db: DB): void {
  const have = new Set((db.prepare('SELECT id FROM playbooks').all() as Array<{ id: string }>).map((r) => r.id));
  const ins = db.prepare('INSERT OR IGNORE INTO playbooks (id, agent_name, house_rules, updated_at) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    for (const p of PLAYBOOKS) if (!have.has(p.id)) ins.run(p.id, p.defaultName, '', nowIso());
  })();
}

const live = new Set<string>(AGENT_TOOL_NAMES);

function dto(p: PlaybookDef, r: { agent_name: string; house_rules: string }): PlaybookDTO {
  return {
    id: p.id,
    role: p.role,
    kind: p.kind,
    area: p.area,
    available: p.available,
    purpose: p.purpose,
    agentName: r.agent_name,
    defaultName: p.defaultName,
    houseRules: r.house_rules,
    tools: p.tools.filter((t) => live.has(t)),
    plannedTools: p.tools.filter((t) => !live.has(t)),
    instructions: [...p.instructions],
    checklist: [...p.checklist],
    reviewedBy: p.reviewedBy ?? null,
  };
}

export function listPlaybooks(db: DB): PlaybookDTO[] {
  ensurePlaybooks(db);
  const rows = new Map((db.prepare('SELECT id, agent_name, house_rules FROM playbooks').all() as Array<{ id: string; agent_name: string; house_rules: string }>).map((r) => [r.id, r]));
  return PLAYBOOKS.map((p) => dto(p, rows.get(p.id) ?? { agent_name: p.defaultName, house_rules: '' }));
}

export function getPlaybook(db: DB, id: string): PlaybookDTO {
  const found = listPlaybooks(db).find((p) => p.id === id);
  if (!found) throw new HttpError(404, 'playbook_not_found');
  return found;
}

const Patch = z.object({ agentName: z.string().max(60).optional(), houseRules: z.string().max(MAX_HOUSE_RULES).optional() }).strict();

export function updatePlaybook(db: DB, id: string, input: unknown, actor: Actor): PlaybookDTO {
  if (actor !== 'human') throw new HttpError(403, 'human_required', 'Only a person can change an agent');
  if (!PLAYBOOK_BY_ID[id]) throw new HttpError(404, 'playbook_not_found');
  const r = Patch.safeParse(input);
  if (!r.success) throw new HttpError(400, 'invalid_input', `Invalid fields: ${[...new Set(r.error.issues.map((i) => i.path.join('.') || '(root)'))].join(', ')}`);
  const v = r.data;
  if (v.agentName === undefined && v.houseRules === undefined) throw new HttpError(400, 'invalid_input', 'Nothing to change');
  ensurePlaybooks(db);
  const cur = db.prepare('SELECT agent_name, house_rules FROM playbooks WHERE id = ?').get(id) as { agent_name: string; house_rules: string };
  let name = cur.agent_name;
  if (v.agentName !== undefined) {
    const bad = validateAgentName(v.agentName);
    if (bad) throw new HttpError(400, 'invalid_name', bad);
    name = v.agentName.trim();
    const clash = db.prepare('SELECT id FROM playbooks WHERE lower(trim(agent_name)) = lower(?) AND id <> ?').get(name, id);
    if (clash) throw new HttpError(409, 'name_taken', 'Another agent already has that name. Names must be different so a reviewer is never the writer.');
  }
  db.prepare('UPDATE playbooks SET agent_name = ?, house_rules = ?, updated_at = ? WHERE id = ?').run(name, v.houseRules?.trim() ?? cur.house_rules, nowIso(), id);
  return getPlaybook(db, id);
}

/** Back to the default name and no house rules. Refused if another agent now uses the default name. */
export function resetPlaybook(db: DB, id: string, actor: Actor): PlaybookDTO {
  const def = PLAYBOOK_BY_ID[id];
  if (!def) throw new HttpError(404, 'playbook_not_found');
  if (actor !== 'human') throw new HttpError(403, 'human_required', 'Only a person can change an agent');
  ensurePlaybooks(db);
  const clash = db.prepare('SELECT id FROM playbooks WHERE lower(trim(agent_name)) = lower(?) AND id <> ?').get(def.defaultName, id);
  if (clash) throw new HttpError(409, 'name_taken', `Another agent is now called ${def.defaultName}. Rename it first.`);
  db.prepare("UPDATE playbooks SET agent_name = ?, house_rules = '', updated_at = ? WHERE id = ?").run(def.defaultName, nowIso(), id);
  return getPlaybook(db, id);
}

/** What a launched agent is told about itself. House rules come from the person and are labelled as such; they cannot add tools. */
export function playbookBrief(db: DB, who: RunIdentity): { text: string; project: string } {
  const pb = getPlaybook(db, who.playbookId);
  const proj = (db.prepare('SELECT alias FROM projects WHERE id = ?').get(who.projectId) as { alias: string } | undefined)?.alias ?? '';
  const lines = [
    `You are ${who.agentName}, the ${who.role}, working in QA Virtual Office on the project "${proj}". ${pb.purpose}`,
    'You may only use these qa-office tools: ' + (pb.tools.length ? pb.tools.join(', ') : 'none') + '. You work on this one project only.',
    'You can never approve or reject a test case, mark a test passed, close a defect or complete a task: a person decides.',
    '',
    'Your playbook:',
    ...pb.instructions.map((i, n) => `${n + 1}. ${i}`),
    '',
    'Checklist you work to:',
    ...pb.checklist.map((c) => `- ${c}`),
  ];
  if (pb.houseRules) lines.push('', 'Extra rules from the person (they cannot give you more tools):', pb.houseRules);
  return { text: lines.join('\n'), project: proj };
}
