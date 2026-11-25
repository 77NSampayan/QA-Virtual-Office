/**
 * Robot identity constants (browser-safe): the 8 robot types/roles, departments, workstations
 * and the status colour/animation specification. Roles are LOGICAL application roles, not claims
 * that Claude Code has specialised agent types.
 */
import type { RobotStatus } from './statusMachine.ts';

export const ROBOT_TYPES = [
  'qa_analyst',
  'manual_tester',
  'automation_engineer',
  'api_tester',
  'regression_tester',
  'bug_investigator',
  'qa_lead',
  'ci_operator',
] as const;
export type RobotType = (typeof ROBOT_TYPES)[number];

/** Logical QA role; a robot's role decides its department and station. */
export const ROBOT_ROLES = ROBOT_TYPES;
export type RobotRole = RobotType;

export type Department = 'manual' | 'automation' | 'lead';

export interface RobotTypeInfo {
  label: string;
  specialty: string;
  workstation: string;
  department: Department;
  defaultPalette: RobotPalette;
}

export interface RobotPalette {
  primary: string;
  accent: string;
}

export const ROBOT_TYPE_INFO: Record<RobotType, RobotTypeInfo> = {
  qa_analyst: {
    label: 'QA Analyst',
    specialty: 'Requirements and test analysis',
    workstation: 'Requirements terminal',
    department: 'manual',
    defaultPalette: { primary: '#6f7fe8', accent: '#ffd54a' },
  },
  manual_tester: {
    label: 'Manual Tester',
    specialty: 'Manual and exploratory testing',
    workstation: 'Testing workstation',
    department: 'manual',
    defaultPalette: { primary: '#3fbf9a', accent: '#ff9f43' },
  },
  bug_investigator: {
    label: 'Bug Investigator',
    specialty: 'Defect investigation',
    workstation: 'Debugging workstation',
    department: 'manual',
    defaultPalette: { primary: '#c25b5b', accent: '#2fe0e6' },
  },
  automation_engineer: {
    label: 'Automation Engineer',
    specialty: 'UI automation and frameworks',
    workstation: 'Development workstation',
    department: 'automation',
    defaultPalette: { primary: '#2f9fd8', accent: '#a77bff' },
  },
  api_tester: {
    label: 'API Tester',
    specialty: 'API validation',
    workstation: 'API monitoring terminal',
    department: 'automation',
    defaultPalette: { primary: '#9a6fe0', accent: '#4be37c' },
  },
  regression_tester: {
    label: 'Regression Tester',
    specialty: 'Regression execution',
    workstation: 'Test execution station',
    department: 'automation',
    defaultPalette: { primary: '#d98a3d', accent: '#4ea1ff' },
  },
  qa_lead: {
    label: 'QA Lead',
    specialty: 'QA coordination and reporting',
    workstation: 'Central control desk',
    department: 'lead',
    defaultPalette: { primary: '#e2b93b', accent: '#ff5d6c' },
  },
  ci_operator: {
    label: 'CI/CD Operator',
    specialty: 'Pipelines, builds and releases',
    workstation: 'Pipeline console',
    department: 'automation',
    defaultPalette: { primary: '#5b8fa8', accent: '#ff7a1a' },
  },
};

export const DEPARTMENT_LABEL: Record<Department, string> = {
  manual: 'Manual QA Department',
  automation: 'Automation QA Department',
  lead: 'QA Control Desk',
};

export const isRobotType = (v: unknown): v is RobotType => typeof v === 'string' && (ROBOT_TYPES as readonly string[]).includes(v);
export const departmentOf = (role: string): Department => (isRobotType(role) ? ROBOT_TYPE_INFO[role].department : 'manual');

export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX_COLOR_RE.test(v);

/** Parses stored palette JSON, falling back to the type's default for anything invalid. */
export function parsePalette(json: string | null | undefined, type: string): RobotPalette {
  const fallback = isRobotType(type) ? ROBOT_TYPE_INFO[type].defaultPalette : ROBOT_TYPE_INFO.qa_analyst.defaultPalette;
  try {
    const p = JSON.parse(json ?? '{}') as Partial<RobotPalette>;
    return { primary: isHexColor(p.primary) ? p.primary : fallback.primary, accent: isHexColor(p.accent) ? p.accent : fallback.accent };
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------- status specification
export const STATUS_COLOR: Record<RobotStatus, string> = {
  idle: '#9aa3b5', // gray
  analyzing: '#a77bff', // purple
  writing_tests: '#4ea1ff', // blue
  executing_tests: '#2fe0e6', // cyan
  debugging: '#ff9f43', // orange
  awaiting_permission: '#ff7a1a', // orange (with a flashing light)
  awaiting_input: '#ffd54a', // yellow
  completed: '#4be37c', // green
  failed: '#ff5d6c', // red
  disconnected: '#4a5266', // dark gray
};

export const STATUS_LABEL: Record<RobotStatus, string> = {
  idle: 'Idle',
  analyzing: 'Analyzing',
  writing_tests: 'Writing test cases',
  executing_tests: 'Executing tests',
  debugging: 'Debugging',
  awaiting_permission: 'Awaiting permission',
  awaiting_input: 'Awaiting input',
  completed: 'Completed',
  failed: 'Failed',
  disconnected: 'Disconnected',
};

/** The animation each status must show (from the product specification). */
export const STATUS_ANIMATION: Record<RobotStatus, string> = {
  idle: 'Standing and blinking',
  analyzing: 'Scanning documents',
  writing_tests: 'Typing on workstation',
  executing_tests: 'Operating testing equipment',
  debugging: 'Inspecting a computer',
  awaiting_permission: 'Raising hand with flashing light',
  awaiting_input: 'Question bubble',
  completed: 'Celebration animation',
  failed: 'Error expression',
  disconnected: 'Powered-off animation',
};

export const ALL_STATUSES: readonly RobotStatus[] = [
  'idle',
  'analyzing',
  'writing_tests',
  'executing_tests',
  'debugging',
  'awaiting_permission',
  'awaiting_input',
  'completed',
  'failed',
  'disconnected',
];
