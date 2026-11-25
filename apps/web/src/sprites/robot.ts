/**
 * Code-drawn pixel robots: 24x24 logical pixels, 4 animation frames per status.
 * A robot sprite is a PURE function of (type, status, palette, frame): it never uses randomness or
 * time, so what it shows can only follow real status changes (acceptance criterion C2).
 */
import { STATUS_COLOR, type RobotPalette, type RobotStatus, type RobotType } from '@qavo/shared';
import { box, darken, lighten, makeGrid, OUTLINE, powerOff, put, puts, rect, SCREEN_DARK, stamp, WHITE, type Grid } from './grid.ts';

export const ROBOT_W = 24;
export const ROBOT_H = 24;
export const FRAME_COUNT = 4;

/** Layout constants (also used by tests to locate parts). */
export const LAYOUT = {
  head: { x: 7, y: 7, w: 10, h: 7 },
  face: { x: 8, y: 8, w: 8, h: 5 },
  torso: { x: 7, y: 15, w: 10, h: 6 },
  chestLed: { x: 11, y: 16, w: 2, h: 1 },
  beacon: { x: 11, y: 0, w: 2, h: 2 },
  leftArmX: 5,
  rightArmX: 17,
  /** Rows above the head reserved for effects (bubbles, sparkles, beacon). */
  effectRows: 7,
} as const;

type Pts = ReadonlyArray<readonly [number, number]>;

// ---------------------------------------------------------------------------- face (LED pixels)
const EYE_L = [[9, 9], [10, 9], [9, 10], [10, 10]] as const;
const EYE_R = [[13, 9], [14, 9], [13, 10], [14, 10]] as const;
const MOUTH_FLAT: Pts = [[11, 12], [12, 12]];

const shift = (pts: Pts, dx: number, dy = 0): Pts => pts.map(([x, y]) => [x + dx, y + dy] as const);

export function facePixels(status: RobotStatus, frame: number): Pts {
  const f = frame % FRAME_COUNT;
  switch (status) {
    case 'idle': {
      // standing and blinking: eyes close on the last frame
      const eyes = f === 3 ? ([[9, 10], [10, 10], [13, 10], [14, 10]] as Pts) : [...EYE_L, ...EYE_R];
      return [...eyes, ...MOUTH_FLAT];
    }
    case 'analyzing': {
      // eyes sweep left-right while scanning
      const dx = [-1, 0, 1, 0][f]!;
      return [...shift(EYE_L, dx), ...shift(EYE_R, dx), ...MOUTH_FLAT];
    }
    case 'writing_tests':
      return [[9, 10], [10, 10], [13, 10], [14, 10], ...MOUTH_FLAT]; // looking down at the keys
    case 'executing_tests':
      return [[9, 9], [10, 9], [9, 10], [10, 10], [9, 11], [10, 11], [13, 9], [14, 9], [13, 10], [14, 10], [13, 11], [14, 11], [11, 12], [12, 12]];
    case 'debugging':
      return [[9, 10], [10, 10], ...EYE_R, [11, 12], [12, 12], [13, 12]]; // one eye squinting
    case 'awaiting_permission':
      return [...EYE_L, ...EYE_R, [10, 12], [11, 12], [12, 12], [13, 12], [11, 11], [12, 11]];
    case 'awaiting_input':
      return [...EYE_L, ...EYE_R, [10, 12], [11, 11], [12, 12], [13, 11]];
    case 'completed':
      // happy arc eyes + smile
      return [[9, 10], [10, 9], [11, 10], [12, 10], [13, 9], [14, 10], [10, 11], [11, 12], [12, 12], [13, 11]];
    case 'failed':
      // X eyes + zigzag mouth
      return [[9, 9], [11, 9], [10, 10], [9, 11], [11, 11], [12, 9], [14, 9], [13, 10], [12, 11], [14, 11], [10, 12], [11, 11], [12, 12], [13, 11]];
    case 'disconnected':
      return f % 2 === 0 ? [[9, 10], [10, 10], [13, 10], [14, 10]] : [];
  }
}

// ---------------------------------------------------------------------------- silhouette (shape, not colour)
/**
 * Each type has its own outline, so types can be told apart in greyscale: the head shape, the shoulders, what the robot
 * stands on and an optional belt. Face, arms and status effects are the same for every type (they carry the real state).
 */
export type HeadShape = 'round' | 'box' | 'notch';
export type Shoulders = 'none' | 'pads' | 'wide' | 'spikes';
export type Base = 'feet' | 'treads' | 'hover';
export interface Chassis {
  head: HeadShape;
  shoulders: Shoulders;
  base: Base;
  belt: boolean;
}
export const CHASSIS: Record<RobotType, Chassis> = {
  qa_analyst: { head: 'round', shoulders: 'none', base: 'feet', belt: false },
  manual_tester: { head: 'box', shoulders: 'pads', base: 'feet', belt: true },
  automation_engineer: { head: 'notch', shoulders: 'wide', base: 'feet', belt: false },
  api_tester: { head: 'round', shoulders: 'spikes', base: 'treads', belt: false },
  regression_tester: { head: 'box', shoulders: 'none', base: 'treads', belt: true },
  bug_investigator: { head: 'notch', shoulders: 'pads', base: 'feet', belt: true },
  qa_lead: { head: 'box', shoulders: 'wide', base: 'hover', belt: false },
};

// ---------------------------------------------------------------------------- type decoration
const HEAD_TOP: Record<RobotType, (g: Grid, accent: string, oy: number) => void> = {
  qa_analyst: (g, a, oy) => {
    rect(g, 11, 5 + oy, 2, 2, OUTLINE);
    rect(g, 11, 3 + oy, 2, 2, a);
  },
  manual_tester: (g, a, oy) => {
    rect(g, 11, 5 + oy, 2, 2, OUTLINE);
    rect(g, 10, 3 + oy, 4, 2, a);
    rect(g, 6, 9 + oy, 1, 3, a);
    rect(g, 17, 9 + oy, 1, 3, a);
  },
  automation_engineer: (g, a, oy) => {
    // cog
    puts(g, [[12, 2], [11, 2], [10, 3], [13, 3], [9, 4], [14, 4], [10, 5], [13, 5], [11, 6], [12, 6], [11, 3], [12, 3], [11, 4], [12, 4], [10, 4], [13, 4]], a, 0, oy);
    puts(g, [[11, 4], [12, 4]], OUTLINE, 0, oy);
  },
  api_tester: (g, a, oy) => {
    rect(g, 9, 4 + oy, 1, 3, OUTLINE);
    rect(g, 14, 4 + oy, 1, 3, OUTLINE);
    rect(g, 8, 2 + oy, 3, 2, a);
    rect(g, 13, 2 + oy, 3, 2, a);
  },
  regression_tester: (g, a, oy) => {
    // loop arrow
    puts(g, [[9, 5], [10, 4], [11, 4], [12, 4], [13, 4], [14, 5], [14, 6], [9, 6]], a, 0, oy);
    puts(g, [[13, 3], [15, 3], [14, 2]], a, 0, oy);
  },
  bug_investigator: (g, a, oy) => {
    rect(g, 6, 6 + oy, 12, 1, a); // cap brim
    puts(g, [[10, 5], [9, 4], [8, 3], [13, 5], [14, 4], [15, 3]], OUTLINE, 0, oy);
  },
  qa_lead: (g, a, oy) => {
    // crown
    puts(g, [[8, 3], [11, 3], [12, 3], [15, 3], [8, 4], [9, 4], [11, 4], [12, 4], [14, 4], [15, 4], [8, 5], [9, 5], [10, 5], [11, 5], [12, 5], [13, 5], [14, 5], [15, 5], [8, 6], [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6], [15, 6]], a, 0, oy);
  },
};

/** 4x3 chest icons: pixel offsets inside the chest panel at (10,17). */
const CHEST_ICON: Record<RobotType, { white: Pts; accent: Pts }> = {
  qa_analyst: { white: [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [3, 1], [0, 2], [1, 2], [2, 2], [3, 2]], accent: [[1, 1], [2, 1]] },
  manual_tester: { white: [], accent: [[0, 1], [1, 2], [2, 1], [3, 0]] },
  automation_engineer: { white: [], accent: [[1, 0], [0, 1], [1, 2], [2, 0], [3, 1], [2, 2]] },
  api_tester: { white: [], accent: [[0, 2], [1, 1], [1, 2], [2, 1], [2, 2], [3, 0], [3, 1], [3, 2]] },
  regression_tester: { white: [[3, 0]], accent: [[1, 0], [2, 0], [0, 1], [3, 1], [1, 2], [2, 2]] },
  bug_investigator: { white: [[1, 0], [2, 0]], accent: [[0, 0], [3, 0], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2], [3, 2]] },
  qa_lead: { white: [], accent: [[1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [3, 1], [1, 2], [2, 2]] },
};

// ---------------------------------------------------------------------------- props and effects
const BUBBLE = [
  '.wwwwwww.',
  'w.......w',
  'w.......w',
  'w.......w',
  'w.......w',
  'w.......w',
  '.wwwwwww.',
] as const;
const QUESTION: Pts = [[0, 0], [1, 0], [2, 0], [2, 1], [1, 2], [2, 2], [1, 4]];

const SPARKLES: ReadonlyArray<Pts> = [
  [[3, 3], [19, 2], [6, 0], [21, 5]],
  [[2, 1], [20, 4], [5, 4], [22, 1]],
  [[4, 5], [18, 0], [7, 2], [21, 3]],
  [[1, 4], [21, 1], [4, 1], [20, 5]],
];
const SPARKS: ReadonlyArray<Pts> = [
  [[5, 8], [18, 9], [4, 11]],
  [[6, 10], [19, 7], [18, 12]],
  [[4, 9], [17, 6], [19, 10]],
  [[5, 6], [18, 11], [3, 8]],
];

export interface RobotSpriteInput {
  type: RobotType;
  status: RobotStatus;
  palette: RobotPalette;
  frame: number;
}

export function renderRobot({ type, status, palette, frame }: RobotSpriteInput): Grid {
  const f = ((frame % FRAME_COUNT) + FRAME_COUNT) % FRAME_COUNT;
  const off = status === 'disconnected';
  const tone = (c: string) => (off ? powerOff(c) : c);
  const body = tone(palette.primary);
  const shade = darken(body, 0.28);
  const light = lighten(body, 0.22);
  const edge = darken(body, 0.5); // tinted outline: reads as a coloured chassis, not a black box
  const accent = tone(palette.accent);
  const led = off ? '#2a3042' : STATUS_COLOR[status];
  const oy = status === 'completed' && f % 2 === 1 ? -1 : 0; // celebration hop
  const g = makeGrid(ROBOT_W, ROBOT_H);

  // what the robot stands on (legs, treads or a hover pad)
  const chassis = CHASSIS[type];
  if (chassis.base === 'feet') {
    rect(g, 7, 21 + oy, 4, 3, edge);
    rect(g, 13, 21 + oy, 4, 3, edge);
    rect(g, 8, 21 + oy, 2, 2, shade);
    rect(g, 14, 21 + oy, 2, 2, shade);
  } else if (chassis.base === 'treads') {
    rect(g, 5, 21 + oy, 14, 3, edge);
    rect(g, 6, 22 + oy, 12, 1, shade);
    for (const x of [7, 10, 13, 16]) put(g, x, 22 + oy, f % 2 === 0 ? light : accent); // the wheels turn
  } else {
    rect(g, 9, 21 + oy, 6, 1, edge);
    rect(g, 7, 22 + oy, 10, 1, edge);
    rect(g, 8, 23 + oy, 8, 1, shade);
    rect(g, 10, 23 + oy, 4, 1, f % 2 === 0 ? accent : light); // the thruster glows
  }

  // torso + chest panel + icon + status LED
  box(g, 7, 15 + oy, 10, 6, body, edge);
  rect(g, 8, 16 + oy, 8, 1, light);
  rect(g, 9, 17 + oy, 6, 3, shade);
  const icon = CHEST_ICON[type];
  puts(g, icon.white, off ? powerOff(WHITE) : WHITE, 10, 17 + oy);
  puts(g, icon.accent, accent, 10, 17 + oy);
  const standby = off ? (f === 0 ? '#5d667b' : null) : led;
  if (standby) rect(g, 11, 16 + oy, 2, 1, standby);

  // arms (status specific)
  const arm = (x: number, y: number, h: number, hand = accent) => {
    rect(g, x - 1, y - 1 + oy, 4, h + 2, edge);
    rect(g, x, y + oy, 2, h, body);
    rect(g, x, y + h - 1 + oy, 2, 1, hand);
  };
  const leftX = LAYOUT.leftArmX;
  const rightX = LAYOUT.rightArmX;
  switch (status) {
    case 'writing_tests': {
      const leftUp = f % 2 === 0;
      arm(leftX, 15, leftUp ? 4 : 5);
      arm(rightX, 15, leftUp ? 5 : 4);
      put(g, leftUp ? rightX : leftX, 20, led); // key press under the lower hand
      break;
    }
    case 'analyzing':
      arm(leftX, 14, 4);
      arm(rightX, 15, 5);
      break;
    case 'executing_tests':
      arm(leftX, 15, 5);
      rect(g, rightX - 1, 16, 4, 4, edge);
      rect(g, rightX, 17, 3, 2, body);
      break;
    case 'debugging':
      arm(leftX, 15, 5);
      arm(rightX, 15, 3);
      break;
    case 'awaiting_permission': {
      arm(leftX, 15, 5);
      rect(g, rightX - 1, 7, 4, 8, edge);
      rect(g, rightX, 8, 2, 7, body);
      const hx = f % 2 === 0 ? 17 : 16; // the wave is out of phase with the flashing light
      rect(g, hx - 1, 5, 4, 4, edge);
      rect(g, hx, 6, 2, 2, accent);
      break;
    }
    case 'completed':
      for (const x of [leftX, rightX]) {
        rect(g, x - 1, 7 + oy, 4, 8, edge);
        rect(g, x, 8 + oy, 2, 6, body);
        rect(g, x, 8 + oy, 2, 2, accent);
      }
      break;
    default:
      arm(leftX, 15, 5);
      arm(rightX, 15, 5);
  }

  // belt stripe along the bottom of the torso
  if (chassis.belt) for (const x of [8, 10, 12, 14]) put(g, x, 20 + oy, accent);
  // shoulders
  const pad = (x: number, w: number, withAccent: boolean) => {
    rect(g, x, 14 + oy, w, 2, edge);
    rect(g, x + 1, 14 + oy, w - 2, 1, withAccent ? accent : light);
  };
  if (chassis.shoulders === 'pads') {
    pad(4, 4, false);
    pad(16, 4, false);
  } else if (chassis.shoulders === 'wide') {
    pad(3, 5, true);
    pad(16, 5, true);
  } else if (chassis.shoulders === 'spikes') {
    for (const x of [5, 18]) {
      rect(g, x, 14 + oy, 2, 1, edge);
      put(g, x, 13 + oy, accent);
      put(g, x + 1, 12 + oy, accent);
    }
  }

  // neck + head + face screen
  rect(g, 11, 14 + oy, 2, 1, edge);
  box(g, LAYOUT.head.x, LAYOUT.head.y + oy, LAYOUT.head.w, LAYOUT.head.h, body, edge);
  rect(g, 8, 7 + oy, 8, 1, light);
  const hx0 = LAYOUT.head.x;
  const hx1 = LAYOUT.head.x + LAYOUT.head.w - 1;
  const hy1 = LAYOUT.head.y + LAYOUT.head.h - 1;
  if (chassis.head === 'round') {
    for (const [x, y] of [[hx0, LAYOUT.head.y], [hx1, LAYOUT.head.y], [hx0, hy1], [hx1, hy1]] as const) put(g, x, y + oy, null);
  } else if (chassis.head === 'notch') {
    for (const [x, y] of [[hx0, LAYOUT.head.y], [hx1, LAYOUT.head.y], [hx0 + 1, LAYOUT.head.y], [hx1 - 1, LAYOUT.head.y]] as const) put(g, x, y + oy, null); // flat top with bitten corners
  }
  rect(g, LAYOUT.face.x, LAYOUT.face.y + oy, LAYOUT.face.w, LAYOUT.face.h, SCREEN_DARK);

  HEAD_TOP[type](g, accent, oy);
  if (type === 'qa_analyst') {
    rect(g, 8, 8 + oy, 4, 1, accent); // glasses rims
    rect(g, 12, 8 + oy, 4, 1, accent);
    rect(g, 11, 9 + oy, 2, 1, accent);
  }
  puts(g, facePixels(status, f), led, 0, oy);

  // props and effects
  switch (status) {
    case 'analyzing': {
      // a document held in the left hand, scanned top to bottom
      box(g, 0, 11, 5, 8, WHITE);
      for (const y of [13, 15, 17]) rect(g, 1, y, 3, 1, '#9aa3b5');
      rect(g, 1, 12 + [0, 2, 4, 2][f]!, 3, 1, led);
      break;
    }
    case 'executing_tests': {
      box(g, 19, 12, 5, 9, '#222a3d');
      puts(g, [[20, 19], [22, 19]], f % 2 ? led : darken(led, 0.6));
      const hx = [20, 21, 22, 21][f]!;
      rect(g, 21, 16, 1, 3, '#9aa3b5');
      rect(g, hx, 13, 1, 3, led);
      break;
    }
    case 'debugging': {
      const dy = [0, -1, 0, 1][f]!;
      stamp(g, ['.www.', 'wLLLw', 'wLLLw', 'wLLLw', '.www.'], 18, 10 + dy, { w: WHITE, L: mixLens(led) });
      puts(g, [[17, 15 + dy], [18, 14 + dy]], WHITE);
      break;
    }
    case 'awaiting_permission': {
      const on = f < 2;
      rect(g, LAYOUT.beacon.x, LAYOUT.beacon.y, 2, 2, on ? led : '#4a2a14');
      if (on) puts(g, [[10, 1], [13, 1], [11, 2], [12, 2]], lighten(led, 0.35));
      break;
    }
    case 'awaiting_input': {
      const by = f % 2;
      stamp(g, BUBBLE, 14, by, { w: WHITE });
      rect(g, 15, by + 1, 7, 5, SCREEN_DARK);
      puts(g, QUESTION, led, 17, by + 1);
      break;
    }
    case 'completed':
      puts(g, SPARKLES[f]!, f % 2 ? WHITE : led);
      puts(g, SPARKLES[(f + 2) % 4]!, accent);
      break;
    case 'failed':
      puts(g, SPARKS[f]!, f % 2 ? WHITE : led);
      break;
    default:
      break;
  }
  return g;
}

/** A dim fill for the magnifier lens derived from the LED colour. */
function mixLens(led: string): string {
  return darken(led, 0.45);
}
