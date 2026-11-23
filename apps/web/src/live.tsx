/**
 * Live data store: everything the office shows comes from the real API and WebSocket.
 * Robot STATE is derived from sessions (real hook events); robots carry only identity.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type ActivityItem, type IntegrationStatus, type Notification, type Project, type Robot, type Session } from './api.ts';

export type WsState = 'connecting' | 'live' | 'offline';

export interface Live {
  projects: Project[];
  sessions: Session[];
  robots: Robot[];
  notifications: Notification[];
  unread: number;
  integration: IntegrationStatus | null;
  activity: ActivityItem[];
  wsState: WsState;
  eventVersion: number;
  /** Increments whenever any Manual QA record changes (here or in another window). */
  qaVersion: number;
  /** Bumps whenever a permission request arrives, is answered or expires. */
  permissionVersion: number;
  refresh: () => Promise<void>;
  refreshActivity: () => void;
  /** The most recent session of a robot (its current state), if any. */
  sessionOf: (robotId: string) => Session | undefined;
}

const Ctx = createContext<Live | null>(null);
export const useLive = (): Live => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLive outside LiveProvider');
  return v;
};

const byRecent = (a: Session, b: Session) => b.lastEventAt - a.lastEventAt;

export function LiveProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [robots, setRobots] = useState<Robot[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [integration, setIntegration] = useState<IntegrationStatus | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [wsState, setWsState] = useState<WsState>('connecting');
  const [eventVersion, setEventVersion] = useState(0);
  const [qaVersion, setQaVersion] = useState(0);
  const [permissionVersion, setPermissionVersion] = useState(0);
  const activityTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refreshActivity = useCallback(() => {
    clearTimeout(activityTimer.current);
    activityTimer.current = setTimeout(() => void api.activity(40).then(setActivity).catch(() => undefined), 250);
  }, []);

  const refresh = useCallback(async () => {
    const [p, s, r, n, i, a] = await Promise.all([api.projects(), api.sessions(), api.robots(), api.notifications(), api.integration(), api.activity(40)]);
    setProjects(p);
    setSessions(s);
    setRobots(r);
    setNotifications(n);
    setUnread(n.filter((x) => x.readAt === null).length);
    setIntegration(i);
    setActivity(a);
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
    const poll = setInterval(() => void api.integration().then(setIntegration).catch(() => undefined), 15_000);
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => {
        setWsState('live');
        void refresh().catch(() => undefined);
      };
      ws.onclose = () => {
        setWsState('offline');
        retry = setTimeout(connect, 2000);
      };
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data as string) as { type: string; [k: string]: unknown };
        switch (msg.type) {
          case 'session.updated': {
            const s = msg.session as Session | null;
            if (s) setSessions((prev) => [s, ...prev.filter((x) => x.sessionId !== s.sessionId)].sort(byRecent));
            // a new session may have created a robot we have not seen yet
            if (s?.robot) setRobots((prev) => (prev.some((r) => r.id === s.robot!.id) ? prev : [...prev, s.robot!]));
            break;
          }
          case 'permission.changed':
            setPermissionVersion((v) => v + 1);
            break;
          case 'qa.changed':
            setQaVersion((v) => v + 1);
            break;
          case 'event.created':
            setEventVersion((v) => v + 1);
            refreshActivity();
            break;
          case 'notification.created': {
            const n = msg.notification as Notification;
            setNotifications((prev) => [n, ...prev].slice(0, 200));
            setUnread((u) => u + 1);
            break;
          }
          case 'notifications.read':
            setUnread(msg.unread as number);
            void api.notifications().then(setNotifications).catch(() => undefined);
            break;
          case 'robot.updated': {
            const r = msg.robot as Robot;
            setRobots((prev) => prev.map((x) => (x.id === r.id ? r : x)));
            break;
          }
          case 'project.updated':
          case 'project.deleted':
            void api.projects().then(setProjects).catch(() => undefined);
            break;
          default:
            break;
        }
      };
    };
    connect();
    return () => {
      clearInterval(poll);
      clearTimeout(retry);
      clearTimeout(activityTimer.current);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [refresh, refreshActivity]);

  const sessionOf = useCallback((robotId: string) => sessions.find((s) => s.robot?.id === robotId), [sessions]);

  const value = useMemo<Live>(
    () => ({ projects, sessions, robots, notifications, unread, integration, activity, wsState, eventVersion, qaVersion, permissionVersion, refresh, refreshActivity, sessionOf }),
    [projects, sessions, robots, notifications, unread, integration, activity, wsState, eventVersion, qaVersion, permissionVersion, refresh, refreshActivity, sessionOf],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
