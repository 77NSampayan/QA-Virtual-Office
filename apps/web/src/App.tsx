import { useEffect, useState } from 'react';
import { api, unauthorizedListeners } from './api.ts';
import { LiveProvider } from './live.tsx';
import { Automation, ApiTesting, Metrics, TestData } from './pages/Placeholders.tsx';
import { ManualQa } from './pages/ManualQa.tsx';
import { Control } from './pages/Control.tsx';
import { Notifications } from './pages/Notifications.tsx';
import { Overview } from './pages/Overview.tsx';
import { ProjectRoomView, RoomsList } from './pages/Rooms.tsx';
import { Sessions } from './pages/Sessions.tsx';
import { SpriteGallery } from './pages/SpriteGallery.tsx';
import { Team } from './pages/Team.tsx';
import { navigate, useRoute } from './router.ts';
import { Settings } from './Settings.tsx';
import { Shell } from './Shell.tsx';

type AuthState = 'checking' | 'ok' | 'denied';

/** Old addresses (Robots, Agents) lead to the Team page. */
function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to), [to]);
  return <div className="page muted">Opening the Team page…</div>;
}

function Routes({ onSignOut }: { onSignOut: () => void }) {
  const route = useRoute();
  const room = /^\/projects\/([^/]+)$/.exec(route);
  if (room) return <ProjectRoomView id={decodeURIComponent(room[1]!)} />;
  switch (route) {
    case '/':
      return <Overview />;
    case '/projects':
      return <RoomsList />;
    case '/control':
      return <Control />;
    case '/team':
      return <Team />;
    case '/robots': // the Robots and Agents pages are now one Team page; old links still work
    case '/agents':
      return <Redirect to="/team" />;
    case '/notifications':
      return <Notifications />;
    case '/sessions':
      return <Sessions />;
    case '/settings':
      return <Settings onSignOut={onSignOut} />;
    case '/sprites':
      return <SpriteGallery />;
    case '/manual':
      return <ManualQa />;
    case '/tasks':
      return <ManualQa key="tasks" initialTab="tasks" />;
    case '/automation':
      return <Automation />;
    case '/api-testing':
      return <ApiTesting />;
    case '/test-data':
      return <TestData />;
    case '/metrics':
      return <Metrics />;
    default:
      return (
        <div className="page">
          <h2>Not found</h2>
          <p>
            <a href="#/">Back to the office</a>
          </p>
        </div>
      );
  }
}

export function App() {
  const [auth, setAuth] = useState<AuthState>('checking');

  useEffect(() => {
    const denied = () => setAuth('denied');
    unauthorizedListeners.add(denied);
    api
      .authStatus()
      .then((a) => setAuth(a.authenticated ? 'ok' : 'denied'))
      .catch(() => setAuth('denied'));
    return () => {
      unauthorizedListeners.delete(denied);
    };
  }, []);

  if (auth === 'checking') return <div className="app muted loading" role="status">Connecting…</div>;
  if (auth === 'denied') {
    return (
      <div className="app">
        <h1>QA Virtual Office</h1>
        <section className="card" style={{ marginTop: 16 }}>
          <h2>This browser is not signed in</h2>
          <p>
            For privacy, the dashboard only opens through a one-time link. Run <code>npm run launch</code> in the project folder (or restart the app) to get a fresh link that signs this browser in.
          </p>
        </section>
      </div>
    );
  }
  return (
    <LiveProvider>
      <Shell>
        <Routes onSignOut={() => setAuth('denied')} />
      </Shell>
    </LiveProvider>
  );
}
