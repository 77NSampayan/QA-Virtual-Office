import { ComingSoon } from '../ui.tsx';

/** Modules that are specified but not built yet. They say so plainly and show no fake data. */
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
