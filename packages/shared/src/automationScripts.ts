/** Automation script drafts (Pass 3, A4): constants shared by the server and the browser. */
export const SCRIPT_MAX_CHARS = 50_000;
export const SCRIPT_STATUSES = ['draft', 'approved', 'rejected'] as const;
export type ScriptStatus = (typeof SCRIPT_STATUSES)[number];
export const SCRIPT_STATUS_LABEL: Record<ScriptStatus, string> = { draft: 'Draft', approved: 'Approved', rejected: 'Rejected' };
export const SCRIPT_FRAMEWORKS = ['playwright', 'cypress', 'selenium', 'webdriverio', 'testcafe', 'jest', 'vitest', 'mocha', 'pytest', 'robot', 'junit', 'testng', 'other'] as const;
export type ScriptFramework = (typeof SCRIPT_FRAMEWORKS)[number];
