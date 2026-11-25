import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { useLive } from './live.tsx';
import { useRoute } from './router.ts';
import { needsAttention } from './ui.tsx';

interface NavItem {
  to: string;
  label: string;
  badge?: number;
}

const COLLAPSE_KEY = 'qavo.nav.collapsed';
const PRIVACY_LINE = 'Local only. Metadata-only capture by default. “~” marks statuses inferred from tool activity. Robots show real events only.';
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

/** App shell: a sidebar on desktop (it can be hidden to give the page the full width), a drawer on narrow screens. */
export function Shell({ children }: { children: ReactNode }) {
  const { wsState, unread, integration, sessions } = useLive();
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const firstRoute = useRef(true);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* a blocked store only means the choice is not remembered */
      }
      return !c;
    });
  useEffect(() => setOpen(false), [route]);

  const attention = sessions.filter((s) => needsAttention(s) && Date.now() - s.lastEventAt <= 24 * 3600_000).length;
  const [demo, setDemo] = useState<{ demo: boolean; banner: string }>({ demo: false, banner: '' });
  useEffect(() => {
    void api.demo().then(setDemo).catch(() => undefined);
  }, []);

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
        { to: '/automation', label: 'Test Automation' },
        { to: '/api-testing', label: 'API Testing' },
        { to: '/test-data', label: 'Test Data' },
        { to: '/tasks', label: 'Task Board' },
        { to: '/metrics', label: 'Metrics' },
      ],
    },
    {
      title: 'Team and system',
      items: [
        { to: '/team', label: 'Team' },
        { to: '/notifications', label: 'Notifications', badge: unread },
        { to: '/sessions', label: 'Sessions' },
        { to: '/settings', label: 'Settings' },
      ],
    },
  ];
  const isOn = (to: string) => (to === '/' ? route === '/' : route === to || route.startsWith(`${to}/`));
  const pageName = groups.flatMap((g) => g.items).find((i) => isOn(i.to))?.label ?? (route.startsWith('/sprites') ? 'Sprite gallery' : 'QA Virtual Office');

  // the title names the page; after a navigation the focus moves to the page so keyboard and screen reader users start there
  useEffect(() => {
    document.title = `${demo.demo ? 'DEMO · ' : ''}${attention > 0 ? `(${attention}) ` : ''}${pageName === 'QA Virtual Office' ? '' : `${pageName} · `}QA Virtual Office`;
  }, [attention, demo.demo, pageName]);
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [route]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main" onClick={(e) => (e.preventDefault(), mainRef.current?.focus())}>
        Skip to content
      </a>
      <header className="topbar">
        <button className="menu-btn ghost" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          ☰
        </button>
        <button className="nav-toggle ghost" aria-label={collapsed ? 'Show the menu' : 'Hide the menu'} aria-pressed={collapsed} onClick={toggleCollapsed} data-nav-toggle>
          ☰
        </button>
        <h1 className="brand">QA Virtual Office</h1>
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
        <span className="spacer" />
        <span className="info-chip hide-narrow" title={demo.demo ? 'Demo mode: fictional data in a separate folder. Hooks and Claude settings are not used.' : PRIVACY_LINE} data-privacy-chip>
          {demo.demo ? 'Demo mode' : 'Local only'}
        </span>
      </header>
      <p className="sr-only" role="status" aria-live="polite" data-attention-live>
        {attention > 0 ? `${attention} session${attention === 1 ? ' needs' : 's need'} your attention` : ''}
      </p>
      <div className={`body ${collapsed ? 'collapsed' : ''}`}>
        <nav className={`sidenav ${open ? 'open' : ''}`} aria-label="Main">
          {groups.map((g) => (
            <div key={g.title} className="navgroup">
              <h4>{g.title}</h4>
              {g.items.map((i) => (
                <a key={i.to} href={`#${i.to}`} className={`navlink ${isOn(i.to) ? 'on' : ''}`} data-nav={i.to} {...(isOn(i.to) ? { 'aria-current': 'page' as const } : {})}>
                  {i.label}
                  {i.badge ? <span className="badge">{i.badge}</span> : null}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <main className="content" id="main" tabIndex={-1} ref={mainRef}>
          {demo.demo && (
            <p className="demo-banner" role="status" data-demo-banner>
              <strong>DEMO DATA.</strong> {demo.banner.replace(/^DEMO DATA:?\s*/, '')}
            </p>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
