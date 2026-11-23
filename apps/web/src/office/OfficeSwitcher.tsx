import { useEffect, useState } from 'react';
import type { Robot, Session } from '../api.ts';
import { Floor } from '../Floor.tsx';
import { useLive } from '../live.tsx';
import { OfficeView } from './OfficeView.tsx';

const KEY = 'qavo.view';
type Mode = 'office' | 'classic';
const read = (): Mode => {
  try {
    return localStorage.getItem(KEY) === 'classic' ? 'classic' : 'office';
  } catch {
    return 'office';
  }
};
const narrowQuery = '(max-width: 760px)';

/** The walkable office by default; the classic floor on request, and automatically on narrow screens (status cards). */
export function OfficeSwitcher({ robots, sessions, now }: { robots: Robot[]; sessions: Session[]; now: number }) {
  const { projects } = useLive();
  const [mode, setMode] = useState<Mode>(read);
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(narrowQuery).matches);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(narrowQuery);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const choose = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* storage unavailable: the choice just is not remembered */
    }
  };

  if (narrow || mode === 'classic') {
    return (
      <div data-view="classic">
        {!narrow && (
          <p className="row view-switch">
            <button className="ghost" onClick={() => choose('office')} data-switch-office>
              Office view
            </button>
            <span className="muted">You are looking at the classic floor.</span>
          </p>
        )}
        <Floor robots={robots} sessions={sessions} now={now} />
      </div>
    );
  }
  return (
    <div data-view="office">
      <label className="check floor-toggle">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        Show robots idle for more than 24 hours
      </label>
      <OfficeView robots={robots} sessions={sessions} projects={projects} now={now} showAll={showAll} onClassic={() => choose('classic')} />
    </div>
  );
}
