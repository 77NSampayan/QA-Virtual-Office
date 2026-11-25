import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { currentBubble, ROBOT_TYPE_INFO, STATUS_COLOR, STATUS_LABEL } from '@qavo/shared';
import type { Project, Robot, Session } from '../api.ts';
import { useFrame } from '../sprites/ticker.ts';
import { PermissionPanel } from '../PermissionPanel.tsx';
import { StatusPill, typeOf } from '../ui.tsx';
import { clampCamera, clampZoom, fitCamera, fitRect, followStep, MAX_ZOOM, MIN_ZOOM, panBy, zoomAt, type Camera } from './camera.ts';
import { buildOffice, ROOM_DEFS, roomKeyForType, TILE, type RoomSpec } from './map.ts';
import { api, type Playbook } from '../api.ts';
import { useLive } from '../live.tsx';
import { drawFrame, hitRobot, paintStatic } from './paint.ts';
import { lightFor } from './light.ts';
import { useOfficePrefs } from './prefs.ts';
import { OfficeScene, type RobotInput } from './scene.ts';
import { browserAudio, OfficeSound } from './sound.ts';
import { themeFor } from './theme.ts';

const DAY_MS = 24 * 3600_000;
const INITIAL_MS = 2500; // robots present when the page opens are placed in place, not walked in

const ago = (ms: number, now: number) => {
  const sec = Math.max(0, Math.round((now - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86_400)}d ago`;
};

/** The room that holds one named desk per agent (and the manual testers). */
export const TEAM_ROOM = 'qa';

function deskLabelOf(roomKey: string, index: number, playbooks: readonly Playbook[], scene: OfficeScene | null): { text: string; dim: boolean } | null {
  if (roomKey !== TEAM_ROOM) return null;
  const p = playbooks[index];
  if (!p) return null;
  const seated = scene?.deskOwner(TEAM_ROOM, index)?.zone === 'desk';
  return { text: p.available ? p.agentName : `${p.agentName} · later`, dim: !seated };
}

export interface OfficeViewProps {
  robots: Robot[];
  sessions: Session[];
  projects: Project[];
  now: number;
  showAll: boolean;
  onShowAll?: (v: boolean) => void;
  onClassic: () => void;
}

const PANEL_KEY = 'qavo.office.panel';
const readPanel = (): boolean => {
  try {
    return localStorage.getItem(PANEL_KEY) !== 'closed';
  } catch {
    return true;
  }
};
const NEEDS_YOU = new Set(['awaiting_permission', 'awaiting_input']);
/** Order of the session list: people are needed first, then failures, then work, then everything else (newest first). */
const rank = (s: string) => (NEEDS_YOU.has(s) ? 0 : s === 'failed' ? 1 : ['analyzing', 'writing_tests', 'executing_tests', 'debugging'].includes(s) ? 2 : s === 'disconnected' ? 4 : 3);

/** Latest session per robot. */
function latestByRobot(sessions: Session[]): Map<string, Session> {
  const m = new Map<string, Session>();
  for (const s of [...sessions].sort((a, b) => b.lastEventAt - a.lastEventAt)) if (s.robot && !m.has(s.robot.id)) m.set(s.robot.id, s);
  return m;
}

/** The walkable office: one canvas, a camera (drag, wheel, keys, follow), and a hidden list that mirrors every robot for assistive tech and tests. */
export function OfficeView({ robots, sessions, now, showAll, onShowAll, onClassic }: OfficeViewProps) {
  const frame = useFrame();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [big, setBig] = useState(false);
  const [panelOpen, setPanelOpen] = useState(readPanel);
  const togglePanel = () =>
    setPanelOpen((o) => {
      try {
        localStorage.setItem(PANEL_KEY, o ? 'closed' : 'open');
      } catch {
        /* the choice is just not remembered */
      }
      return !o;
    });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [followId, setFollowId] = useState<string | null>(null);
  const [ver, setVer] = useState(0);
  const mountedAt = useRef(Date.now());
  const prefs = useOfficePrefs();
  // the agents' desks: one per role, in roster order (names follow renames)
  const { qaVersion } = useLive();
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  useEffect(() => void api.playbooks().then(setPlaybooks).catch(() => undefined), [qaVersion]);
  const playbooksRef = useRef(playbooks);
  playbooksRef.current = playbooks;
  // the viewer's local clock, refreshed every 30 s (light and seasons change slowly)
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const light = useMemo(() => lightFor(new Date(clock), prefs.light), [clock, prefs.light]);
  const theme = useMemo(() => themeFor(new Date(clock), prefs.theme), [clock, prefs.theme]);

  // ---------------------------------------------------------------- what is on the floor (real data only)
  const latest = useMemo(() => latestByRobot(sessions), [sessions]);
  const inputs: RobotInput[] = useMemo(() => {
    const out: RobotInput[] = [];
    for (const r of robots) {
      const s = latest.get(r.id);
      if (!s || (!showAll && now - s.lastEventAt > DAY_MS)) continue;
      const deskIndex = r.playbookId ? playbooks.findIndex((p) => p.id === r.playbookId) : -1;
      // an agent's robot sits at its own named desk in the QA Team room; any other robot goes to the room of the type its owner chose
      const roomKey = deskIndex >= 0 ? TEAM_ROOM : roomKeyForType(typeOf(r));
      out.push({
        id: r.id,
        name: r.name,
        status: s.status,
        roomKey,
        ...(deskIndex >= 0 ? { deskIndex } : {}),
        type: typeOf(r),
        palette: r.palette,
        activity: s.activity,
        drones: s.drones.slice(0, 3).map((d) => ({ agentId: d.agentId, agentType: d.agentType, status: d.status })),
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
    // `now` only matters for the 24 h cut-off; recompute at most once a minute
  }, [robots, latest, showAll, playbooks, Math.floor(now / 60_000)]);
  const specs: RoomSpec[] = useMemo(
    () =>
      ROOM_DEFS.map((d) => {
        const own = inputs.filter((i) => i.roomKey === d.key && i.deskIndex === undefined).length;
        const named = d.key === TEAM_ROOM ? playbooks.length : 0;
        return { key: d.key, label: d.label, robots: own + named, reserved: named };
      }),
    [inputs, playbooks.length],
  );
  const labelOf = useMemo(() => new Map(specs.map((s) => [s.key, s.label])), [specs]);

  const specsKey = JSON.stringify(specs.map((s) => [s.key, s.label, s.robots, s.reserved]));
  const map = useMemo(() => buildOffice(specs), [specsKey]);
  const staticLayer = useMemo(() => paintStatic(map, theme), [map, theme]);
  const sceneRef = useRef<OfficeScene | null>(null);
  if (!sceneRef.current) sceneRef.current = new OfficeScene(map);
  const world = useMemo(() => ({ w: map.w * TILE, h: map.h * TILE }), [map]);

  // ---------------------------------------------------------------- camera + draw state (refs: no re-render per frame)
  const cam = useRef<Camera>({ x: 0, y: 0, zoom: 2 });
  const view = useRef({ w: 800, h: 520 });
  const dprRef = useRef(1);
  const dirty = useRef(true);
  const userMoved = useRef(false);
  const followRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const frameRef = useRef(frame);
  const staticRef = useRef(staticLayer);
  const worldRef = useRef(world);
  const labelRef = useRef(labelOf);
  const lightRef = useRef(light);
  const themeRef = useRef(theme);
  const prefsRef = useRef(prefs);
  const soundRef = useRef<OfficeSound | null>(null);
  if (!soundRef.current) soundRef.current = new OfficeSound(browserAudio);
  lightRef.current = light;
  themeRef.current = theme;
  prefsRef.current = prefs;
  staticRef.current = staticLayer;
  worldRef.current = world;
  labelRef.current = labelOf;
  frameRef.current = frame;
  followRef.current = followId;
  selectedRef.current = selectedId;

  const writeAttrs = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.dataset.zoom = cam.current.zoom.toFixed(2);
    el.dataset.camX = cam.current.x.toFixed(1);
    el.dataset.camY = cam.current.y.toFixed(1);
    el.dataset.following = followRef.current ?? '';
    el.dataset.selected = selectedRef.current ?? '';
    const scene = sceneRef.current;
    if (scene) {
      el.dataset.doorsOpen = scene.doorsOpen().join(',');
      el.dataset.effects = scene.effects.map((e) => `${e.kind}:${e.actorId}`).join(',');
      el.dataset.lift = scene.lift.open > 0.05 ? 'open' : 'closed';
      el.dataset.light = lightRef.current.phase;
      el.dataset.darkness = lightRef.current.darkness.toFixed(3);
      el.dataset.theme = themeRef.current;
      el.dataset.sound = prefsRef.current.sound ? 'on' : 'off';
    }
  }, []);
  const touch = useCallback(() => {
    dirty.current = true;
    writeAttrs();
  }, [writeAttrs]);

  /** Frames what is in use (the entrance, the occupied rooms, the lounge if someone is there); the whole building when nobody is, or on request. */
  const framing = useRef<'focus' | 'whole'>('focus');
  const autoFrame = useCallback(() => {
    const scene = sceneRef.current!;
    const m = scene.map;
    const occ = scene.occupancy();
    if (framing.current === 'whole' || (occ.rooms.size === 0 && !occ.lounge)) {
      cam.current = fitCamera(view.current, worldRef.current);
      return;
    }
    let x0 = m.lobby.x0;
    let y0 = m.lobby.y0;
    let x1 = m.lobby.x0 + m.lobby.w;
    let y1 = m.lobby.y0 + m.lobby.h;
    const take = (bx: number, by: number, bw: number, bh: number) => {
      x0 = Math.min(x0, bx);
      y0 = Math.min(y0, by);
      x1 = Math.max(x1, bx + bw);
      y1 = Math.max(y1, by + bh);
    };
    for (const r of m.rooms) if (occ.rooms.has(r.key)) take(r.x0, r.y0, r.w, r.h);
    if (occ.lounge) take(m.lounge.x0, m.lounge.y0, m.lounge.w, m.lounge.h);
    cam.current = fitRect(view.current, { x: x0 * TILE, y: y0 * TILE, w: (x1 - x0) * TILE, h: (y1 - y0) * TILE }, worldRef.current);
  }, []);
  const fit = useCallback(() => {
    framing.current = 'whole';
    autoFrame();
    userMoved.current = false;
    setFollowId(null);
    touch();
  }, [autoFrame, touch]);
  const focus = useCallback(() => {
    framing.current = 'focus';
    autoFrame();
    userMoved.current = false;
    setFollowId(null);
    touch();
  }, [autoFrame, touch]);

  // sync the model with real data: layout first, then robots (only changed targets make robots walk)
  useEffect(() => {
    const scene = sceneRef.current!;
    if (scene.map !== map) scene.setMap(map);
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    scene.sync(inputs, { reducedMotion: reduced, initial: Date.now() - mountedAt.current < INITIAL_MS });
    if (!userMoved.current) autoFrame();
    touch();
  }, [map, inputs, world, touch, autoFrame]);
  useEffect(touch, [frame, selectedId, followId, light, theme, prefs.sound, touch]);

  // sound: off by default; only real events (drained from the scene) ever play, and only while the page is visible
  useEffect(() => {
    const s = soundRef.current!;
    s.setEnabled(prefs.sound);
    s.setVolume(prefs.volume);
    if (!prefs.sound) return;
    const unlock = () => s.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [prefs.sound, prefs.volume]);

  // size the canvas to its box (and keep it crisp on high-DPI screens)
  useEffect(() => {
    const el = wrapRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;
    const resize = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      view.current = { w: Math.max(200, r.width), h: Math.max(200, r.height) };
      dprRef.current = dpr;
      canvas.width = Math.round(view.current.w * dpr);
      canvas.height = Math.round(view.current.h * dpr);
      canvas.style.width = `${view.current.w}px`;
      canvas.style.height = `${view.current.h}px`;
      if (!userMoved.current) autoFrame();
      else cam.current = clampCamera(cam.current, worldRef.current);
      touch();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [big, touch, autoFrame]);

  // the frame loop: ticks walking, eases the follow camera, draws only when something changed
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastVer = -1;
    const loop = (t: number) => {
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      const scene = sceneRef.current!;
      scene.tick(dt);
      const pending = scene.drainSounds();
      if (prefsRef.current.sound && !document.hidden) {
        for (const kind of pending) {
          if (soundRef.current!.play(kind) > 0 && wrapRef.current) wrapRef.current.dataset.soundPlays = String(Number(wrapRef.current.dataset.soundPlays ?? '0') + 1);
        }
      }
      const fid = followRef.current;
      if (fid) {
        const a = scene.actors.get(fid);
        if (a) {
          const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
          cam.current = clampCamera(followStep(cam.current, { x: a.x, y: a.y - 12 }, dt, reduced), worldRef.current);
          dirty.current = true;
        }
      }
      if (dirty.current || scene.isAnimating()) {
        const ctx = canvasRef.current?.getContext('2d');
        if (ctx) drawFrame(ctx, scene, staticRef.current, cam.current, view.current, { frame: frameRef.current, selectedId: selectedRef.current, dpr: dprRef.current, now: Date.now(), roomLabel: (k) => labelRef.current.get(k) ?? k, deskLabel: (k, i) => deskLabelOf(k, i, playbooksRef.current, sceneRef.current), light: lightRef.current, theme: themeRef.current });
        dirty.current = false;
        writeAttrs();
      }
      const walking = scene.isWalking();
      if (wrapRef.current && wrapRef.current.dataset.walking !== String(walking)) wrapRef.current.dataset.walking = String(walking);
      if (scene.version !== lastVer) {
        lastVer = scene.version;
        setVer(scene.version);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [writeAttrs]);

  // ---------------------------------------------------------------- input: drag, wheel, click, double-click, keys
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      cam.current = zoomAt(cam.current, view.current, worldRef.current, Math.exp(-e.deltaY * 0.0015), p.x, p.y);
      userMoved.current = true;
      touch();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [touch]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    d.moved += Math.abs(dx) + Math.abs(dy);
    if (d.moved > 4) {
      cam.current = panBy(cam.current, worldRef.current, dx, dy);
      userMoved.current = true;
      if (followRef.current) setFollowId(null);
      touch();
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved > 4) return;
    const p = local(e);
    const hit = hitRobot(sceneRef.current!, cam.current, view.current, p.x, p.y);
    setSelectedId(hit ? hit.id : null);
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const p = local(e);
    const hit = hitRobot(sceneRef.current!, cam.current, view.current, p.x, p.y);
    if (hit) {
      setSelectedId(hit.id);
      setFollowId(hit.id);
      userMoved.current = true;
    }
  };
  const zoomBy = (factor: number) => {
    cam.current = { ...cam.current, zoom: clampZoom(cam.current.zoom * factor) };
    userMoved.current = true;
    touch();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = 48;
    const c = cam.current;
    const move = (dx: number, dy: number) => {
      cam.current = panBy(c, worldRef.current, dx, dy);
      userMoved.current = true;
      if (followRef.current) setFollowId(null);
      touch();
      e.preventDefault();
    };
    if (e.key === 'ArrowLeft') move(step, 0);
    else if (e.key === 'ArrowRight') move(-step, 0);
    else if (e.key === 'ArrowUp') move(0, step);
    else if (e.key === 'ArrowDown') move(0, -step);
    else if (e.key === '+' || e.key === '=') {
      zoomBy(1.25);
      e.preventDefault();
    } else if (e.key === '-' || e.key === '_') {
      zoomBy(0.8);
      e.preventDefault();
    } else if (e.key === '0') {
      fit();
      e.preventDefault();
    } else if (e.key.toLowerCase() === 'f' && selectedRef.current) {
      setFollowId(selectedRef.current);
      e.preventDefault();
    }
    else if (e.key === 'Escape') {
      setFollowId(null);
      setSelectedId(null);
    }
  };

  // ---------------------------------------------------------------- details card + mirror list
  const rows = inputs
    .map((i) => {
      const s = latest.get(i.id);
      return { id: i.id, name: i.name, status: i.status, room: labelOf.get(i.roomKey) ?? i.roomKey, project: s?.projectAlias ?? null, last: s?.lastEventAt ?? 0 };
    })
    .sort((a, b) => rank(a.status) - rank(b.status) || b.last - a.last || a.name.localeCompare(b.name));
  const pick = (id: string) => {
    setSelectedId(id);
    setFollowId(id);
    userMoved.current = true;
  };
  const selected = selectedId ? robots.find((r) => r.id === selectedId) : undefined;
  const selSession = selected ? latest.get(selected.id) : undefined;
  const scene = sceneRef.current;
  const mirror = scene.snapshot();
  const chatting = scene.chatting();
  const drones = scene.droneSnapshot();
  const wall = Date.now();
  void ver;
  const zoneText = { desk: 'at their desk', lounge: 'in the lounge', walking: 'walking' } as const;

  return (
    <div className={`office-view ${big ? 'office-big' : ''}`} data-office>
      <div className={`office-stage ${panelOpen ? '' : 'no-panel'}`}>
      <div className="office-canvas-wrap" ref={wrapRef} data-office-ready="true" data-walking="false" data-zoom="2.00">
        <canvas
          ref={canvasRef}
          className="office-canvas"
          tabIndex={0}
          role="application"
          aria-label="Virtual office map. Arrow keys move the view, plus and minus zoom, 0 shows the whole office, F follows the selected robot, Escape clears."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={onDoubleClick}
          onKeyDown={onKeyDown}
        />
        <div className="office-hud" role="group" aria-label="Office view controls">
          <button className="ghost" onClick={() => zoomBy(1.25)} aria-label="Zoom in" data-office-zoom-in disabled={cam.current.zoom >= MAX_ZOOM}>
            +
          </button>
          <button className="ghost" onClick={() => zoomBy(0.8)} aria-label="Zoom out" data-office-zoom-out disabled={cam.current.zoom <= MIN_ZOOM}>
            −
          </button>
          <button className="ghost" onClick={focus} data-office-focus title="Frame the rooms that are in use">
            Focus
          </button>
          <button className="ghost" onClick={fit} data-office-fit title="Show the whole building">
            Fit
          </button>
          <button className="ghost" onClick={togglePanel} aria-pressed={panelOpen} data-office-panel-toggle>
            Sessions
          </button>
          <button className="ghost" onClick={() => setBig((b) => !b)} aria-pressed={big} data-office-enlarge>
            {big ? 'Shrink' : 'Enlarge'}
          </button>
          <button className="ghost" onClick={onClassic} data-office-classic>
            Classic view
          </button>
        </div>
        <p className="office-help muted">Drag to pan · scroll to zoom · click a robot for details · double-click to follow</p>
        {selected && (
          <div className="office-card" data-office-card={selected.id}>
            <strong>{selected.name}</strong> <span className="muted">{ROBOT_TYPE_INFO[typeOf(selected)].label}</span>
            {selSession && (
              <>
                <div>
                  <StatusPill status={selSession.status} source={selSession.statusSource} />
                </div>
                <div className="muted">
                  {selSession.projectAlias ?? 'unregistered folder'} · seen {ago(selSession.lastEventAt, now)}
                </div>
              </>
            )}
            {selSession && <PermissionPanel sessionId={selSession.sessionId} compact />}
            <div className="row">
              {followId === selected.id ? (
                <button className="ghost" onClick={() => setFollowId(null)} data-office-unfollow>
                  Stop following
                </button>
              ) : (
                <button className="ghost" onClick={() => setFollowId(selected.id)} data-office-follow>
                  Follow
                </button>
              )}
              <button className="ghost" onClick={() => setSelectedId(null)}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
      {panelOpen && (
        <aside className="session-panel" aria-label="Sessions in the office" data-session-panel>
          <div className="panel-head">
            <strong>Sessions</strong>
            <span className="muted">{rows.length}</span>
          </div>
          {rows.length === 0 ? (
            <div className="empty-state" data-session-empty>
              <p>No sessions to show.</p>
              <p className="hint">Start Claude Code in a registered project and its robot appears here and in the office. Nothing is simulated.</p>
              <a className="btnlink" href="#/settings">
                Connect Claude Code
              </a>
            </div>
          ) : (
            <ul className="session-list">
              {rows.map((r) => (
                <li key={r.id}>
                  <button className={`session-row ${selectedId === r.id ? 'on' : ''}`} onClick={() => pick(r.id)} data-session-row={r.id} data-status={r.status} aria-pressed={selectedId === r.id}>
                    <span className="dot" style={{ background: STATUS_COLOR[r.status as keyof typeof STATUS_COLOR] }} aria-hidden="true" />
                    <span className="who">
                      <strong>{r.name}</strong>
                      <span className="muted">
                        {STATUS_LABEL[r.status as keyof typeof STATUS_LABEL]} · {r.room}
                      </span>
                      <span className="muted">
                        {r.project ?? 'unregistered folder'} · {r.last ? ago(r.last, now) : 'no events'}
                      </span>
                    </span>
                    {NEEDS_YOU.has(r.status) && <span className="needs">needs you</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {onShowAll && (
            <label className="check">
              <input type="checkbox" checked={showAll} onChange={(e) => onShowAll(e.target.checked)} />
              <span>Also show robots idle for more than 24 hours</span>
            </label>
          )}
        </aside>
      )}
      </div>
      <ul className="sr-only" data-office-robots aria-label="Robots in the office">
        {mirror.map((m) => (
          <li
            key={m.id}
            data-robot={m.id}
            data-name={m.name}
            data-status={m.status}
            data-zone={m.zone}
            data-room={m.room}
            data-wx={m.x}
            data-wy={m.y}
            data-bubble={currentBubble(m.status, scene.actors.get(m.id)?.input.activity, wall) ?? ''}
            data-alert={m.status === 'awaiting_permission' ? 'permission' : m.status === 'awaiting_input' ? 'input' : ''}
            data-wait={m.status === 'executing_tests' ? 'hourglass' : ''}
            data-chat={chatting.has(m.id) ? 'true' : ''}
          >
            {m.name}: {STATUS_LABEL[m.status]}, {zoneText[m.zone]}
          </li>
        ))}
      </ul>
      <ul className="sr-only" data-office-team aria-label="Agent desks in the QA Team room">
        {playbooks.map((p, i) => {
          const owner = scene.deskOwner(TEAM_ROOM, i);
          const state = !p.available ? 'later' : owner?.zone === 'desk' ? 'at-desk' : owner ? 'away' : 'empty';
          return (
            <li key={p.id} data-desk-index={i} data-agent={p.agentName} data-role={p.role} data-state={state} data-robot={owner?.id ?? ''}>
              {p.agentName} ({p.role}): {state === 'at-desk' ? 'at the desk' : state === 'away' ? 'running, away from the desk' : state === 'later' ? 'arrives in Pass 3' : 'not running'}
            </li>
          );
        })}
      </ul>
      <ul className="sr-only" data-office-drones aria-label="Subagent drones">
        {drones.map((d) => (
          <li key={d.key} data-drone={d.key} data-parent={d.parent} data-agent={d.agentId} data-status={d.status} data-state={d.state}>
            Subagent of {mirror.find((m) => m.id === d.parent)?.name ?? 'a robot'}: {d.state === 'flying' ? 'arriving' : 'hovering'}
          </li>
        ))}
      </ul>
    </div>
  );
}

