import { useEffect, useState } from 'react';
import { useLive } from '../live.tsx';
import { ExecutionPanel } from './qa/Execution.tsx';
import { RequirementsPanel } from './qa/Requirements.tsx';
import { TestCasesPanel } from './qa/TestCases.tsx';
import { TraceabilityPanel } from './qa/Traceability.tsx';

type Tab = 'requirements' | 'test-cases' | 'execution' | 'traceability';
const TABS: Array<[Tab, string]> = [
  ['requirements', 'Requirements'],
  ['test-cases', 'Test cases'],
  ['execution', 'Execution'],
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
export function ManualQa() {
  const { projects } = useLive();
  const active = projects.filter((p) => !p.archived);
  const [pid, setPid] = useState(readSaved);
  const [tab, setTab] = useState<Tab>('requirements');
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
          <div className="row toolbar">
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
            <nav className="row" aria-label="Manual QA sections">
              {TABS.map(([k, label]) => (
                <button key={k} className={tab === k ? 'tab on' : 'tab'} onClick={() => setTab(k)} data-tab={k}>
                  {label}
                </button>
              ))}
            </nav>
          </div>
          {tab === 'requirements' && <RequirementsPanel projectId={current.id} />}
          {tab === 'test-cases' && <TestCasesPanel projectId={current.id} />}
          {tab === 'execution' && <ExecutionPanel projectId={current.id} />}
          {tab === 'traceability' && <TraceabilityPanel projectId={current.id} />}
          <section className="card nodata-panel" data-coming-next>
            <h3>Coming next in the Manual QA department</h3>
            <p className="muted">
              Defects, exploratory sessions and the task board (Pass 2C) · agent assistance that creates drafts only (Pass 2D).
            </p>
          </section>
        </>
      )}
    </div>
  );
}
