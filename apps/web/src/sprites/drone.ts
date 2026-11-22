/** Subagent "drone": a tiny hovering bot (10x8) shown next to its parent robot. */
import { STATUS_COLOR, type RobotStatus } from '@qavo/shared';
import { FRAME_COUNT } from './robot.ts';
import { box, makeGrid, OUTLINE, powerOff, put, rect, SCREEN_DARK, type Grid } from './grid.ts';

export const DRONE_W = 10;
export const DRONE_H = 8;

export function renderDrone({ status, frame }: { status: RobotStatus; frame: number }): Grid {
  const f = ((frame % FRAME_COUNT) + FRAME_COUNT) % FRAME_COUNT;
  const off = status === 'disconnected' || status === 'completed';
  const led = status === 'disconnected' ? '#2a3042' : STATUS_COLOR[status];
  const body = off ? powerOff('#6a7390') : '#8a95b8';
  const hover = f % 2; // bobbing
  const g = makeGrid(DRONE_W, DRONE_H);
  // rotors
  rect(g, f < 2 ? 0 : 1, 1 + hover, 3, 1, OUTLINE);
  rect(g, f < 2 ? 7 : 6, 1 + hover, 3, 1, OUTLINE);
  rect(g, 2, 2 + hover, 1, 1, OUTLINE);
  rect(g, 7, 2 + hover, 1, 1, OUTLINE);
  // body
  box(g, 2, 3 + hover, 6, 4, body);
  rect(g, 3, 4 + hover, 4, 2, SCREEN_DARK);
  put(g, 4, 4 + hover, led);
  put(g, 5, 4 + hover, led);
  if (status !== 'disconnected') put(g, f % 2 ? 4 : 5, 5 + hover, led);
  return g;
}
