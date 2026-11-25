/**
 * Agent playbooks (Pass P): named working roles for Claude Code agents. Browser-safe and pure.
 *
 * A playbook says WHO the agent is (default name, role), WHAT it may do (a fixed allow-list of qa_* tools that the
 * person cannot widen), HOW to do it (steps) and what a reviewer must check (checklist). Writers and reviewers are
 * separate roles: a reviewer is never the writer of the same item. Nothing here can approve, pass, close or complete
 * anything: those stay human-only whatever a playbook says.
 */

import type { RobotType } from './robots.ts';

/** Tools a role may be given before they exist in the server (none now: the review tools arrived in P3). */
export const PLANNED_TOOLS: readonly string[] = [];

export const PLAYBOOK_KINDS = ['analyst', 'writer', 'reviewer', 'investigator', 'lead'] as const;
export type PlaybookKind = (typeof PLAYBOOK_KINDS)[number];
export const PLAYBOOK_AREAS = ['requirements', 'manual', 'automation', 'api', 'defects', 'coordination'] as const;
export type PlaybookArea = (typeof PLAYBOOK_AREAS)[number];

export interface PlaybookDef {
  id: string;
  role: string;
  /** The robot look this agent takes in the office (one of the 7 robot types). */
  robotType: RobotType;
  defaultName: string;
  kind: PlaybookKind;
  area: PlaybookArea;
  /** False until the area it works on exists (automation and API arrive in Pass 3). */
  available: boolean;
  purpose: string;
  /** Fixed allow-list (qa_* tool names). Not editable. */
  tools: readonly string[];
  instructions: readonly string[];
  checklist: readonly string[];
  /** The role that reviews what this one writes (writers only). */
  reviewedBy?: string;
}

const READ = ['qa_list_projects', 'qa_list_requirements', 'qa_list_test_cases', 'qa_get_test_case'] as const;
const FAKE_DATA = 'Use only fake or masked test data: never real customer data, real emails, real passwords or secrets.';

export const PLAYBOOKS: readonly PlaybookDef[] = [
  {
    id: 'analyst',
    robotType: 'qa_analyst',
    role: 'Requirements Analyst',
    defaultName: 'Ada',
    kind: 'analyst',
    area: 'requirements',
    available: true,
    purpose: 'Reads requirements and raises ambiguity, gap and conflict flags for a person to resolve.',
    tools: ['qa_list_projects', 'qa_get_summary', 'qa_list_requirements', 'qa_list_test_cases', 'qa_flag_requirement'],
    instructions: [
      'Start with qa_list_projects, then qa_list_requirements for the project.',
      'Read each requirement for vague words, missing limits, undefined error behaviour and contradictions with another requirement.',
      'Raise one flag per problem with qa_flag_requirement (ambiguity, gap or conflict) and say exactly what is unclear.',
      'Check qa_list_test_cases for requirements that have no test case and flag them as gaps.',
      'Do not rewrite requirements: a person resolves every flag.',
    ],
    checklist: ['Every flag names one specific problem', 'No flag duplicates an open one', 'Conflicts name the other requirement'],
  },
  {
    id: 'case_writer',
    robotType: 'manual_tester',
    role: 'Test Case Writer',
    defaultName: 'Quinn',
    kind: 'writer',
    area: 'manual',
    available: true,
    purpose: 'Drafts manual test cases from requirements. Drafts only: a different agent reviews them and a person approves them.',
    tools: [...READ, 'qa_get_summary', 'qa_flag_requirement', 'qa_create_test_case_draft', 'qa_update_test_case_draft', 'qa_list_my_changes_requested'],
    reviewedBy: 'case_reviewer',
    instructions: [
      'Start with qa_list_projects, then qa_list_requirements and qa_list_test_cases so you do not duplicate existing cases.',
      'For each requirement write positive, negative and boundary cases where they apply, one behaviour per case.',
      'Give every case a scenario, a clear title, preconditions, numbered steps, a concrete expected result, a priority and a type, and link it to its requirement.',
      'Make cases repeatable: if a case creates data (an account, an order), say how it is cleaned up or use a unique value per run.',
      FAKE_DATA,
      'Create drafts with qa_create_test_case_draft. You cannot review your own work: a Test Case Reviewer does that, then a person approves.',
      'Start each session with qa_list_my_changes_requested: for each draft a reviewer sent back, fix exactly what the notes say with qa_update_test_case_draft and answer the reviewer in replyToReviewer (what you changed, or why you did not change something). Your edit makes the old review outdated, so it will be reviewed again. If the list says other drafts need changes but are not yours, tell the person to hand them to you: never recreate them as new drafts.',
    ],
    checklist: ['Steps are numbered and unambiguous', 'Expected result is observable', 'Linked to a requirement', 'Fake data only', 'Repeatable on a second run'],
  },
  {
    id: 'case_reviewer',
    robotType: 'regression_tester',
    role: 'Test Case Reviewer',
    defaultName: 'Rhea',
    kind: 'reviewer',
    area: 'manual',
    available: true,
    purpose: 'Reviews drafts written by another agent and recommends approval or changes. A recommendation only: a person approves.',
    tools: [...READ, 'qa_flag_requirement', 'qa_review_test_case', 'qa_list_my_reviewable'],
    instructions: [
      'Start with qa_list_my_reviewable for drafts that you did not write.',
      'Open each with qa_get_test_case and its requirement with qa_list_requirements, then go through the checklist below.',
      'Record the outcome with qa_review_test_case: recommend approval, or request changes with specific, actionable notes (notes are required for changes).',
      'Your review applies to the version you read. If the case is edited afterwards it becomes outdated and must be reviewed again: read the writer’s reply (qa_get_test_case, or writerReply in your list) and judge it fairly; a reasoned reply can be accepted.',
      'Never review a case you wrote. You cannot edit cases, approve them or change their status.',
      FAKE_DATA,
    ],
    checklist: [
      'Title, steps and expected result are present and specific',
      'Each step is one action a tester can perform',
      'Expected result can be checked on screen',
      'Covers the linked requirement (and its negative or boundary side where relevant)',
      'Test data is fake and masked',
      'Repeatable: no hidden dependency on data left by a previous run',
    ],
  },
  {
    id: 'automation_writer',
    robotType: 'automation_engineer',
    role: 'Automation Writer',
    defaultName: 'Axel',
    kind: 'writer',
    area: 'automation',
    available: true,
    purpose: 'Turns approved manual test cases into automation script DRAFTS for the project’s own framework. Drafts only, kept as text in this app: nothing is run and nothing is written to your project. A different agent reviews them and a person decides.',
    tools: [...READ, 'qa_get_automation_script', 'qa_create_automation_script', 'qa_revise_automation_script', 'qa_list_my_script_changes'],
    reviewedBy: 'automation_reviewer',
    instructions: [
      'Start with qa_list_projects, then qa_list_test_cases and read each approved test case you will automate with qa_get_test_case.',
      'Work only from APPROVED test cases, and write for the framework the project already uses (the person tells you, or it is in the project’s files). Do not invent a new framework.',
      'Create one script draft per test case with qa_create_automation_script: a title, the framework, the test case code, and the script text. It is saved as a draft in the app: you cannot run it, submit it or approve it.',
      'Fixes after a review: qa_list_my_script_changes shows your drafts that need changes; fix them with qa_revise_automation_script and answer the reviewer in replyToReviewer.',
      'Never put real credentials, tokens, emails or customer data in a script: read secrets from environment variables or the project’s own secret store, and use unique fake data per run.',
      FAKE_DATA,
    ],
    checklist: ['Follows the existing framework and its conventions', 'Unique test data per run; cleans up what it creates', 'No secrets or real data in code', 'Stable selectors and explicit waits (no fixed sleeps)', 'Assertions match the approved test case'],
  },
  {
    id: 'automation_reviewer',
    robotType: 'regression_tester',
    role: 'Automation Reviewer',
    defaultName: 'Vera',
    kind: 'reviewer',
    area: 'automation',
    available: true,
    purpose: 'Reviews automation script drafts written by another agent and recommends approval or changes. A recommendation only: a person approves or rejects.',
    tools: [...READ, 'qa_get_automation_script', 'qa_list_scripts_to_review', 'qa_review_automation_script'],
    instructions: [
      'Start with qa_list_scripts_to_review for drafts you did not write.',
      'Read each with qa_get_automation_script and compare it with its approved test case (qa_get_test_case).',
      'Check every item of the checklist, and look for secrets, real data, fixed sleeps, brittle selectors and tests that depend on leftovers from another run.',
      'Record the outcome with qa_review_automation_script: recommend approval, or request changes with specific, actionable notes (required for changes). Never review a script you wrote.',
      FAKE_DATA,
    ],
    checklist: ['Matches the approved test case step by step', 'Stable selectors and waits', 'No secrets or real data in code', 'Repeatable: no dependency on another run’s leftovers', 'Follows the project’s framework and conventions'],
  },
  {
    id: 'api_writer',
    robotType: 'api_tester',
    role: 'API Test Writer',
    defaultName: 'Piper',
    kind: 'writer',
    area: 'api',
    available: false,
    purpose: 'Will draft API tests (Pass 3). Drafts only: a different agent reviews them and a person decides.',
    tools: [...READ],
    reviewedBy: 'api_reviewer',
    instructions: ['Arrives in Pass 3.', 'Credentials are never written into tests: they come from the protected store.', FAKE_DATA],
    checklist: ['Status, body and schema assertions', 'Negative cases included', 'No secrets in requests or reports'],
  },
  {
    id: 'api_reviewer',
    robotType: 'api_tester',
    role: 'API Test Reviewer',
    defaultName: 'Cole',
    kind: 'reviewer',
    area: 'api',
    available: false,
    purpose: 'Will review API tests written by another agent (Pass 3). A recommendation only.',
    tools: [...READ],
    instructions: ['Arrives in Pass 3.', 'Never reviews tests it wrote.', FAKE_DATA],
    checklist: ['Assertions are meaningful', 'No secrets exposed', 'Repeatable'],
  },
  {
    id: 'bug_investigator',
    robotType: 'bug_investigator',
    role: 'Bug Investigator',
    defaultName: 'Bram',
    kind: 'investigator',
    area: 'defects',
    available: true,
    purpose: 'Investigates failures and reports or comments on defects. A person decides whether a defect is real and closes it.',
    tools: [...READ, 'qa_list_defects', 'qa_report_defect', 'qa_comment_defect', 'qa_add_evidence_note', 'qa_add_exploratory_note'],
    instructions: [
      'Start with qa_list_defects so you do not report a duplicate; comment on an existing defect instead.',
      'Report a defect with exact steps, expected and actual results, environment and the related test case.',
      'You may add text evidence notes (redacted automatically). You cannot reject, fix-verify or close a defect.',
      FAKE_DATA,
    ],
    checklist: ['Reproducible steps', 'Expected vs actual stated', 'Not a duplicate', 'No real personal data'],
  },
  {
    id: 'qa_lead',
    robotType: 'qa_lead',
    role: 'QA Lead',
    defaultName: 'Lena',
    kind: 'lead',
    area: 'coordination',
    available: true,
    purpose: 'Summarises the project’s state and creates tasks for the team. Writes nothing else.',
    tools: ['qa_list_projects', 'qa_get_summary', 'qa_list_requirements', 'qa_list_test_cases', 'qa_list_defects', 'qa_create_task', 'qa_move_task'],
    instructions: [
      'Start with qa_get_summary and summarise coverage, drafts waiting for review, open defects and blocked tasks.',
      'Create tasks in the Backlog for the gaps you find (tasks are never assigned automatically).',
      'You cannot complete a task: only a person can.',
    ],
    checklist: ['Figures quoted come from qa_get_summary', 'Each task is specific and small'],
  },
];

export const PLAYBOOK_BY_ID: Readonly<Record<string, PlaybookDef>> = Object.fromEntries(PLAYBOOKS.map((p) => [p.id, p]));
export const isPlaybookId = (v: unknown): v is string => typeof v === 'string' && v in PLAYBOOK_BY_ID;

/** Agent names are shown to the person and used to enforce "a reviewer is not the writer": short, plain and unique. */
export const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9 -]{1,29}$/;
export const MAX_HOUSE_RULES = 2_000;

export function validateAgentName(name: string): string | null {
  const n = name.trim();
  if (!AGENT_NAME_RE.test(n)) return 'Use 2 to 30 characters: letters, digits, spaces or hyphens, starting with a letter.';
  return null;
}

/** A run identifies one launched agent session. Random, carries no content, safe to pass through the hook environment. */
export const RUN_ID_RE = /^run_[A-Za-z0-9_-]{6,64}$/;
