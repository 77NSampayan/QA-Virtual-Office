import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLAYBOOKS, PLANNED_TOOLS } from '@qavo/shared';
import { AGENT_TOOL_NAMES } from '../src/agent.ts';
import { openDb, type DB } from '../src/db/index.ts';
import { getPlaybook, listPlaybooks, resetPlaybook, updatePlaybook } from '../src/playbooks.ts';
import { HttpError } from '../src/store.ts';

let db: DB;
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-pb-'));
  db = openDb(path.join(root, 'test.db'));
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function http(fn: () => unknown, status: number, code?: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(status);
    if (code) expect((e as HttpError).code).toBe(code);
    return;
  }
  throw new Error('expected an HttpError');
}

describe('playbooks', () => {
  it('only allows tools that exist or are explicitly planned', () => {
    const known = new Set<string>([...AGENT_TOOL_NAMES, ...PLANNED_TOOLS]);
    for (const p of PLAYBOOKS) for (const t of p.tools) expect(known.has(t), `${p.id}: ${t}`).toBe(true);
  });

  it('lists the full roster with default names, splitting live tools from planned ones', () => {
    const list = listPlaybooks(db);
    expect(list.map((p) => p.agentName)).toEqual(['Ada', 'Quinn', 'Rhea', 'Axel', 'Vera', 'Piper', 'Cole', 'Bram', 'Lena']);
    const rhea = list.find((p) => p.id === 'case_reviewer')!;
    expect(rhea.plannedTools).toEqual([]); // the review tools are live since P3
    expect(rhea.tools).toEqual(expect.arrayContaining(['qa_review_test_case', 'qa_list_my_reviewable']));
    expect(rhea.tools).not.toContain('qa_create_test_case_draft');
    expect(list.find((p) => p.id === 'case_writer')!).toMatchObject({ reviewedBy: 'case_reviewer', available: true });
    expect(list.find((p) => p.id === 'automation_writer')!.available).toBe(false);
    expect(listPlaybooks(db)).toHaveLength(9); // calling again adds nothing
  });

  it('renames an agent and edits house rules; reset restores the defaults', () => {
    const r = updatePlaybook(db, 'case_writer', { agentName: ' Nova ', houseRules: ' Always include a negative case. ' }, 'human');
    expect(r).toMatchObject({ agentName: 'Nova', houseRules: 'Always include a negative case.' });
    expect(getPlaybook(db, 'case_writer').agentName).toBe('Nova');
    expect(updatePlaybook(db, 'case_writer', { houseRules: '' }, 'human').agentName).toBe('Nova'); // name kept
    expect(resetPlaybook(db, 'case_writer', 'human')).toMatchObject({ agentName: 'Quinn', houseRules: '' });
  });

  it('keeps names unique, case-insensitively, including the defaults of agents that were never renamed', () => {
    http(() => updatePlaybook(db, 'case_writer', { agentName: 'Rhea' }, 'human'), 409, 'name_taken');
    http(() => updatePlaybook(db, 'case_writer', { agentName: ' rHEA ' }, 'human'), 409, 'name_taken');
    updatePlaybook(db, 'case_reviewer', { agentName: 'Mira' }, 'human');
    expect(updatePlaybook(db, 'case_writer', { agentName: 'Rhea' }, 'human').agentName).toBe('Rhea'); // freed
    http(() => resetPlaybook(db, 'case_reviewer', 'human'), 409, 'name_taken'); // Rhea is now taken by the writer
    expect(updatePlaybook(db, 'case_writer', { agentName: 'Quinn' }, 'human').agentName).toBe('Quinn');
    expect(resetPlaybook(db, 'case_reviewer', 'human').agentName).toBe('Rhea');
  });

  it('the database itself refuses two agents with the same name', () => {
    listPlaybooks(db);
    expect(() => db.prepare("UPDATE playbooks SET agent_name = 'QUINN' WHERE id = 'case_reviewer'").run()).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE playbooks SET agent_name = ' ' WHERE id = 'case_reviewer'").run()).toThrow(/CHECK/);
  });

  it('only a person can change an agent; bad input is refused and changes nothing', () => {
    http(() => updatePlaybook(db, 'case_writer', { agentName: 'Nova' }, 'agent'), 403, 'human_required');
    http(() => updatePlaybook(db, 'case_writer', { agentName: 'Nova' }, 'system'), 403, 'human_required');
    http(() => resetPlaybook(db, 'case_writer', 'agent'), 403, 'human_required');
    http(() => updatePlaybook(db, 'nope', { agentName: 'Nova' }, 'human'), 404, 'playbook_not_found');
    http(() => updatePlaybook(db, 'case_writer', { agentName: '1' }, 'human'), 400, 'invalid_name');
    http(() => updatePlaybook(db, 'case_writer', { agentName: '<b>x</b>' }, 'human'), 400, 'invalid_name');
    http(() => updatePlaybook(db, 'case_writer', {}, 'human'), 400, 'invalid_input');
    http(() => updatePlaybook(db, 'case_writer', { houseRules: 'x'.repeat(2001) }, 'human'), 400, 'invalid_input');
    http(() => updatePlaybook(db, 'case_writer', { tools: ['qa_approve'] }, 'human'), 400, 'invalid_input'); // tools can never be edited
    http(() => updatePlaybook(db, 'case_writer', { role: 'Admin' }, 'human'), 400, 'invalid_input');
    expect(getPlaybook(db, 'case_writer')).toMatchObject({ agentName: 'Quinn', houseRules: '' });
  });
});
