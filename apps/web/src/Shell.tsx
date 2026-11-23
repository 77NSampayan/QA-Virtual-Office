import { useEffect, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { useLive } from './live.tsx';
import { useRoute } from './router.ts';
import { needsAttention } from './ui.tsx';

interface NavItem {
  to: string;
  label: string;
  soon?: string;
  badge?: number;
}

/** App shell: sidebar on desktop, a menu button on narrow screens. */
export function Shell({ children }: { children: ReactNode }) {
  const { wsState, unread, integration, sessions } = useLive();
  const route = useRoute();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [route]);

  const attention = sessions.filter((s) => needsAttention(s) && Date.now() - s.lastEventAt <= 24 * 3600_000).length;
  const [demo, setDemo] = useState<{ demo: boolean; banner: string }>({ demo: false, banner: '' });
  useEffect(() => {
    void api.demo().then(setDemo).catch(() => undefined);
  }, []);
  useEffect(() => {
    document.title = `${demo.demo ? 'DEMO · ' : ''}${attention > 0 ? `(${attention}) ` : ''}QA Virtual Office`;
  }, [attention, demo.demo]);

  const groups: Array<{ title: string; items: NavItem[] }> = [
    {
      title: 'Office',
      items: [
        { to: '/', label: 'Overview' },
        { to: '/projects', label: 'Project Rooms' },
        { to: '/control', label: 'QA Control Room', badge: attention },
      ],
    },
    {
      title: 'Departments',
      items: [
        { to: '/manual', label: 'Manual QA' },
        { to: '/automation', label: 'Test Automation', soon: 'Pass 3' },
        { to: '/api-testing', label: 'API Testing', soon: 'Pass 3' },
        { to: '/test-data', label: 'Test Data', soon: 'Pass 3' },
        { to: '/tasks', label: 'Task Board' },
        { to: '/metrics', label: 'Metrics', soon: 'Pass 4' },
      ],
    },
    {
      title: 'Team and system',
      items: [
        { to: '/robots', label: 'Robots' },
        { to: '/agents', label: 'Agents' },
        { to: '/notifications', label: 'Notifications', badge: unread },
        { to: '/sessions', label: 'Sessions' },
        { to: '/settings', label: 'Settings' },
        { to: '/sprites', label: 'Sprite gallery' },
      ],
    },
  ];
  const isOn = (to: string) => (to === '/' ? route === '/' : route === to || route.startsWith(`${to}/`));

  return (
    <div className="shell">
      <header className="topbar">
        <button className="menu-btn ghost" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          ☰
        </button>
        <h1>QA Virtual Office</h1>
        {demo.demo && (
          <span className="pill demo-pill" data-demo-pill>
            DEMO DATA
          </span>
        )}
        <span className={`pill ws ${wsState}`} data-ws={wsState}>
          {wsState === 'live' ? 'live' : wsState}
        </span>
        {integration && !demo.demo && (
          <span className="muted hide-narrow">
            hooks: {integration.hooks.state.replace('_', ' ')} · scope: {integration.scope === 'registered' ? 'registered projects only' : 'all sessions'}
          </span>
        )}
      </header>
      <div className="body">
        <nav className={`sidenav ${open ? 'open' : ''}`} aria-label="Main">
          {groups.map((g) => (
            <div key={g.title} className="navgroup">
              <h4>{g.title}</h4>
              {g.items.map((i) => (
                <a key={i.to} href={`#${i.to}`} className={`navlink ${isOn(i.to) ? 'on' : ''}`} data-nav={i.to}>
                  {i.label}
                  {i.soon && <span className="soon-tag">{i.soon}</span>}
                  {i.badge ? <span className="badge">{i.badge}</span> : null}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <main className="content">
          {demo.demo && (
            <p className="demo-banner" role="status" data-demo-banner>
              <strong>DEMO DATA.</strong> {demo.banner.replace(/^DEMO DATA:?\s*/, '')}
            </p>
          )}
          {children}
        </main>
      </div>
      <footer className="muted">
        {demo.demo
          ? 'DEMO MODE · fictional data in a separate folder · hooks and Claude settings are not used'
          : 'Local only · metadata-only capture by default · “~” marks statuses inferred from tool activity · robots show real events only'}
      </footer>
    </div>
  );
}
