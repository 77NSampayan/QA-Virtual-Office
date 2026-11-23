/**
 * Lounge furniture (32x16 logical pixels per nook): a couch, a coffee corner, an arcade cabinet, a TV and a ping-pong table.
 * Each nook is drawn in two layers so a robot can sit "in" it: a BACK layer behind the robot and a FRONT
 * layer over its lower body (couch seat and arms, counter). Pure functions of (kind, palette, frame):
 * no randomness, no clocks. The frame only animates the furniture (steam, arcade screen); which robot is
 * resting is decided elsewhere, from its real status.
 */
import type { RobotPalette } from '@qavo/shared';
import { darken, lighten, makeGrid, OUTLINE, put, rect, SCREEN_DARK, WHITE, type Grid } from './grid.ts';
import { FRAME_COUNT } from './robot.ts';

export const NOOK_W = 32;
export const NOOK_H = 16;
export const NOOK_KINDS = ['couch', 'coffee', 'arcade', 'tv', 'pingpong'] as const;
export type NookKind = (typeof NOOK_KINDS)[number];
export const NOOK_LABEL: Record<NookKind, string> = { couch: 'Couch', coffee: 'Coffee corner', arcade: 'Arcade', tv: 'TV corner', pingpong: 'Ping-pong' };
export const NOOK_VERB: Record<NookKind, string> = {
  couch: 'relaxing on the couch',
  coffee: 'having a coffee',
  arcade: 'playing the arcade',
  tv: 'watching TV',
  pingpong: 'playing ping-pong',
};

export interface NookInput {
  kind: NookKind;
  palette: RobotPalette;
  frame: number;
}

const COUCH = '#7a4b8f';
const COUCH_D = '#58346a';
const COUCH_L = '#9c66b4';
const METAL = '#3a4560';
const METAL_D = '#2b3247';
const METAL_L = '#56648a';
const WOOD = '#8a5a3b';
const WOOD_L = '#a77450';
const STEAM = '#c9d3ea';

/**
 * A stable, boring pick of furniture for a robot: the same robot always rests in the same kind of nook.
 * This is cosmetic only (where the robot sits); WHETHER it is in the lounge follows its real status.
 */
export function nookForRobot(robotId: string): NookKind {
  let h = 0;
  for (const ch of robotId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return NOOK_KINDS[h % NOOK_KINDS.length]!;
}

const wrap = (frame: number) => ((frame % FRAME_COUNT) + FRAME_COUNT) % FRAME_COUNT;

// ---------------------------------------------------------------------------- couch
function couchBack(g: Grid, palette: RobotPalette): void {
  rect(g, 2, 0, 28, 8, OUTLINE); // backrest
  rect(g, 3, 1, 26, 6, COUCH);
  rect(g, 3, 1, 26, 1, COUCH_L);
  rect(g, 11, 2, 1, 5, COUCH_D); // cushion splits
  rect(g, 20, 2, 1, 5, COUCH_D);
  rect(g, 4, 3, 4, 4, OUTLINE); // pillow in the robot's accent colour
  rect(g, 5, 4, 2, 2, palette.accent);
  rect(g, 3, 8, 26, 3, OUTLINE); // seat base
  rect(g, 4, 9, 24, 1, COUCH_L);
  rect(g, 4, 11, 3, 5, OUTLINE); // legs
  rect(g, 25, 11, 3, 5, OUTLINE);
}
function couchFront(g: Grid): void {
  rect(g, 3, 5, 26, 5, OUTLINE); // seat cushion in front of the robot's lower body
  rect(g, 4, 6, 24, 3, COUCH);
  rect(g, 4, 6, 24, 1, COUCH_L);
  rect(g, 15, 6, 1, 3, COUCH_D);
  rect(g, 0, 3, 4, 9, OUTLINE); // armrests
  rect(g, 1, 4, 2, 7, COUCH_D);
  rect(g, 28, 3, 4, 9, OUTLINE);
  rect(g, 29, 4, 2, 7, COUCH_D);
}

// ---------------------------------------------------------------------------- coffee corner
function coffeeBack(g: Grid, frame: number): void {
  rect(g, 20, 0, 10, 11, OUTLINE); // machine
  rect(g, 21, 1, 8, 9, METAL);
  rect(g, 21, 1, 8, 1, METAL_L);
  rect(g, 22, 2, 6, 3, SCREEN_DARK);
  put(g, 23, 3, frame < 2 ? '#4be37c' : '#2f7a4a'); // status light blinks
  put(g, 25, 3, '#ffd54a');
  rect(g, 23, 6, 4, 3, METAL_D); // spout alcove
  rect(g, 24, 6, 2, 1, METAL_L);
  rect(g, 22, 10, 6, 1, METAL_D); // drip tray
}
function coffeeFront(g: Grid, frame: number): void {
  const f = wrap(frame);
  rect(g, 0, 7, 32, 6, OUTLINE); // counter
  rect(g, 1, 8, 30, 4, WOOD);
  rect(g, 1, 8, 30, 1, WOOD_L);
  rect(g, 2, 13, 3, 3, OUTLINE);
  rect(g, 27, 13, 3, 3, OUTLINE);
  rect(g, 15, 5, 4, 3, OUTLINE); // cup on the counter
  rect(g, 16, 5, 2, 2, WHITE);
  put(g, 19, 6, WHITE);
  rect(g, 24, 5, 3, 3, OUTLINE); // cup under the spout
  rect(g, 25, 5, 1, 2, WHITE);
  for (let i = 0; i < 3; i++) put(g, 16 + (i % 2) * 2, 4 - ((f + i) % 3), STEAM); // steam rising
}

// ---------------------------------------------------------------------------- arcade cabinet
const INVADER_A = [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]] as const;
const INVADER_B = [[1, 0], [0, 1], [2, 1], [1, 2]] as const;
function arcadeBack(g: Grid, palette: RobotPalette, frame: number): void {
  const f = wrap(frame);
  rect(g, 18, 0, 12, 16, OUTLINE); // cabinet
  rect(g, 19, 1, 10, 14, '#2c3a7a');
  rect(g, 19, 1, 10, 2, f % 2 === 0 ? palette.accent : lighten(palette.accent, 0.4)); // blinking marquee
  rect(g, 20, 3, 8, 6, OUTLINE); // screen
  rect(g, 21, 4, 6, 4, SCREEN_DARK);
  for (const [x, y] of f % 2 === 0 ? INVADER_A : INVADER_B) put(g, 22 + x + (f >> 1), 4 + y, '#4be37c'); // invader shuffling
  put(g, 21 + ((f * 2) % 5), 7, '#2fe0e6'); // player ship
  if (f === 2) put(g, 21 + ((f * 2) % 5), 6, '#ffd54a'); // shot
  rect(g, 19, 10, 10, 3, darken('#2c3a7a', 0.3)); // control panel
  rect(g, 21, 10, 1, 2, '#e8eef9'); // joystick
  put(g, 21, 9, '#ff5d6c');
  put(g, 25, 11, '#ff5d6c');
  put(g, 27, 11, '#ffd54a');
  rect(g, 19, 13, 10, 2, '#1c2552');
}

// ---------------------------------------------------------------------------- TV corner
const TV_BARS = ['#ff5d6c', '#ffd54a', '#4be37c', '#2fe0e6', '#a77bff'] as const;
function tvBack(g: Grid, frame: number): void {
  const f = wrap(frame);
  rect(g, 17, 1, 14, 11, OUTLINE); // set
  rect(g, 18, 2, 12, 8, METAL_D);
  rect(g, 19, 3, 10, 6, SCREEN_DARK);
  for (let i = 0; i < 5; i++) rect(g, 19 + ((i * 2 + f * 2) % 10), 3, 2, 3, TV_BARS[i]!); // colour bars scrolling
  rect(g, 19, 6, 10, 3, '#1f6b3a'); // pitch
  put(g, 20 + ((f * 3) % 8), 7 + (f % 2), WHITE); // ball
  put(g, 29, 10, f < 2 ? '#4be37c' : '#2f7a4a'); // power light
  rect(g, 20, 12, 8, 2, OUTLINE); // stand
  rect(g, 18, 14, 12, 2, METAL);
}

// ---------------------------------------------------------------------------- ping-pong table
function pingpongBack(g: Grid): void {
  rect(g, 4, 12, 2, 4, OUTLINE); // legs
  rect(g, 26, 12, 2, 4, OUTLINE);
}
function pingpongFront(g: Grid, frame: number): void {
  const f = wrap(frame);
  rect(g, 1, 6, 30, 7, OUTLINE); // table
  rect(g, 2, 7, 28, 5, '#1f7a45');
  rect(g, 2, 7, 28, 1, '#2fa05f');
  rect(g, 15, 7, 2, 5, WHITE); // centre line / net post
  rect(g, 2, 9, 28, 1, '#e8eef9'); // long line
  rect(g, 15, 5, 2, 4, '#c9d3ea'); // net
  rect(g, 3, 13, 26, 1, '#0b3a1f');
  const bx = [5, 11, 21, 26][f]!; // ball travels across the net
  put(g, bx, 6 - (f % 2), WHITE);
  rect(g, 1, 4 + (f % 2), 2, 3, '#ff5d6c'); // paddles
  rect(g, 29, 4 + ((f + 1) % 2), 2, 3, '#2fe0e6');
}

export function renderNookBack({ kind, palette, frame }: NookInput): Grid {
  const g = makeGrid(NOOK_W, NOOK_H);
  if (kind === 'couch') couchBack(g, palette);
  else if (kind === 'coffee') coffeeBack(g, wrap(frame));
  else if (kind === 'tv') tvBack(g, frame);
  else if (kind === 'pingpong') pingpongBack(g);
  else arcadeBack(g, palette, frame);
  return g;
}

export function renderNookFront({ kind, frame }: NookInput): Grid {
  const g = makeGrid(NOOK_W, NOOK_H);
  if (kind === 'couch') couchFront(g);
  else if (kind === 'coffee') coffeeFront(g, frame);
  else if (kind === 'pingpong') pingpongFront(g, frame);
  return g; // the arcade cabinet and the TV need no foreground
}
