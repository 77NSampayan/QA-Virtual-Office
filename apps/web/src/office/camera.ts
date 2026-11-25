/**
 * Camera math (pure). `x`,`y` is the world point (logical pixels) at the centre of the view; `zoom` is
 * screen pixels per logical pixel. Dragging pans, the wheel zooms around the cursor, and following eases the
 * camera towards a moving target.
 */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}
export interface View {
  w: number;
  h: number;
}
export const MIN_ZOOM = 0.5; // low enough for the whole building to fit a small window
export const MAX_ZOOM = 8;

export const clampZoom = (z: number): number => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

/** Keeps the camera centre inside the world so the office never scrolls out of sight. */
export function clampCamera(c: Camera, world: View): Camera {
  return { zoom: c.zoom, x: Math.max(0, Math.min(world.w, c.x)), y: Math.max(0, Math.min(world.h, c.y)) };
}

export const worldToScreen = (c: Camera, view: View, wx: number, wy: number) => ({ x: (wx - c.x) * c.zoom + view.w / 2, y: (wy - c.y) * c.zoom + view.h / 2 });
export const screenToWorld = (c: Camera, view: View, sx: number, sy: number) => ({ x: (sx - view.w / 2) / c.zoom + c.x, y: (sy - view.h / 2) / c.zoom + c.y });

/** Zooms by `factor` keeping the world point under the cursor fixed. */
export function zoomAt(c: Camera, view: View, world: View, factor: number, sx: number, sy: number): Camera {
  const before = screenToWorld(c, view, sx, sy);
  const zoom = clampZoom(c.zoom * factor);
  const next = { ...c, zoom };
  const after = screenToWorld(next, view, sx, sy);
  return clampCamera({ zoom, x: c.x + (before.x - after.x), y: c.y + (before.y - after.y) }, world);
}

/** Pans by a screen-space drag distance. */
export const panBy = (c: Camera, world: View, dxScreen: number, dyScreen: number): Camera => clampCamera({ zoom: c.zoom, x: c.x - dxScreen / c.zoom, y: c.y - dyScreen / c.zoom }, world);

/** The zoom (and centre) that shows the whole office with a margin. */
export function fitCamera(view: View, world: View, margin = 16): Camera {
  const zoom = clampZoom(Math.min((view.w - margin * 2) / world.w, (view.h - margin * 2) / world.h));
  return { x: world.w / 2, y: world.h / 2, zoom };
}

/** The zoom (and centre) that shows a world rectangle (for example the occupied rooms) with a margin. */
export function fitRect(view: View, rect: { x: number; y: number; w: number; h: number }, world: View, margin = 16): Camera {
  const zoom = clampZoom(Math.min((view.w - margin * 2) / rect.w, (view.h - margin * 2) / rect.h));
  return clampCamera({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, zoom }, world);
}

/** Eases towards a target (frame-rate independent). */
export function followStep(c: Camera, target: { x: number; y: number }, dt: number, instant: boolean): Camera {
  const k = instant ? 1 : 1 - Math.exp(-dt * 6);
  return { zoom: c.zoom, x: c.x + (target.x - c.x) * k, y: c.y + (target.y - c.y) * k };
}
