import { ComingSoon } from '../ui.tsx';

/** Modules that are specified but not built yet. They say so plainly and show no fake data. */
export const ManualQa = () => (
  <ComingSoon
    title="Manual QA Department"
    pass="Pass 2"
    intro="Requirements analysis, test case management, manual execution tracking, exploratory testing and defect management."
    items={[
      'Requirements: BRD/FSD/user-story review with ambiguity and gap flags for human review',
      'Test cases with techniques (BVA, equivalence partitioning, decision tables, state transition…) and a human-only approval step',
      'Execution board: NOT RUN, IN PROGRESS, PASSED, FAILED, BLOCKED, NOT APPLICABLE, NEEDS REVIEW — human vs agent-assisted clearly distinguished',
      'Defects with a validated state flow (no automatic closing)',
    ]}
  />
);
export const TaskBoard = () => (
  <ComingSoon
    title="QA Task Board"
    pass="Pass 2"
    intro="Backlog, Ready, In Progress, Waiting for Review, Blocked and Completed, with tasks assignable to a QA role or a Claude Code session."
    items={['Tasks are never auto-assigned to an agent unless you configure that behaviour']}
  />
);
export const Automation = () => (
  <ComingSoon
    title="Test Automation Department"
    pass="Pass 3"
    intro="Framework detection, automation execution monitoring, failure investigation and CI/CD monitoring."
    items={[
      'Detect Playwright, Selenium, Robot Framework, pytest and respect the existing architecture',
      'Import JUnit XML, Playwright, pytest, Robot and Allure results; failures default to "unknown" classification',
      'Read-only GitHub Actions / Azure DevOps / Jenkins monitoring',
    ]}
  />
);
export const ApiTesting = () => (
  <ComingSoon
    title="API Testing Workspace"
    pass="Pass 3"
    intro="Requests, assertions, schema validation and timing, with credentials kept in Windows-protected local storage."
    items={['Secrets are never shown in logs or reports']}
  />
);
export const TestData = () => (
  <ComingSoon
    title="Test Data Management"
    pass="Pass 3"
    intro="Test data profiles per environment with masking and redaction."
    items={['Production personal information is not exposed']}
  />
);
export const Metrics = () => (
  <ComingSoon
    title="QA Metrics and Reporting"
    pass="Pass 4"
    intro="Manual, automation and quality metrics with a visible formula and denominator for every figure."
    items={['No coverage or pass-rate percentage is shown without a valid denominator', 'Filters by project, environment, suite and date range']}
  />
);
