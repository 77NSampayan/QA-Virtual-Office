import { useEffect, useState } from 'react';
import { useLive } from '../live.tsx';
import { DefectsPanel } from './qa/Defects.tsx';
import { ExecutionPanel } from './qa/Execution.tsx';
import { ExploratoryPanel } from './qa/Exploratory.tsx';
import { RequirementsPanel } from './qa/Requirements.tsx';
import { TaskBoardPanel } from './qa/TaskBoard.tsx';
import { TestCasesPanel } from './qa/TestCases.tsx';
import { TraceabilityPanel } from './qa/Traceability.tsx';

export type Tab = 'requirements' | 'test-cases' | 'execution' | 'defects' | 'exploratory' | 'tasks' | 'traceability';
const TABS: Array<[Tab, string]> = [
  ['requirements', 'Requirements'],
  ['test-cases', 'Test cases'],
  ['execution', 'Execution'],
  ['defects', 'Defects'],
  ['exploratory', 'Exploratory'],
  ['tasks', 'Task board'],
  ['traceability', 'Traceability'],
];
const KEY = 'qavo.manual.project';
const readSaved = () => {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
};

/** Manual QA Department: requirements, test cases, execution with evidence, traceability (Pass 2A/2B). */
export function ManualQa({ initialTab = 'requirements' }: { initialTab?: Tab } = {}) {
  const { projects } = useLive();
  const active = projects.filter((p) => !p.archived);
  const [pid, setPid] = useState(readSaved);
  const [tab, setTab] = useState<Tab>(initialTab);
  const current = active.find((p) => p.id === pid) ?? active[0];

  useEffect(() => {
    if (current && current.id !== pid) setPid(current.id);
  }, [current, pid]);
  useEffect(() => {
    try {
      if (pid) localStorage.setItem(KEY, pid);
    } catch {
      /* storage unavailable: fine */
    }
  }, [pid]);

  return (
    <div className="page" data-page="manual-qa">
      <h2>Manual QA Department</h2>
      {!current ? (
        <section className="card">
          <p>
            Register a project first (<a href="#/projects">Project Rooms</a>): requirements and test cases belong to a project.
          </p>
        </section>
      ) : (
        <>
          <div className="qa-head">
            <label>
              Project
              <select value={current.id} onChange={(e) => setPid(e.target.value)} data-project-select>
                {active.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.alias}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <nav className="tabbar" aria-label="Manual QA sections">
              {TABS.map(([k, label]) => (
                <button key={k} className={tab === k ? 'tab on' : 'tab'} onClick={() => setTab(k)} data-tab={k}>
                  {label}
                </button>
              ))}
          </nav>
          {tab === 'requirements' && <RequirementsPanel projectId={current.id} />}
          {tab === 'test-cases' && <TestCasesPanel projectId={current.id} />}
          {tab === 'execution' && <ExecutionPanel projectId={current.id} />}
          {tab === 'defects' && <DefectsPanel projectId={current.id} />}
          {tab === 'exploratory' && <ExploratoryPanel projectId={current.id} />}
          {tab === 'tasks' && <TaskBoardPanel projectId={current.id} />}
          {tab === 'traceability' && <TraceabilityPanel projectId={current.id} />}
        </>
      )}
    </div>
  );
}
