/**
 * The server is the ONLY writer of capture-policy.json. It regenerates the file atomically on
 * startup and after every project/privacy change. The forwarder re-reads it on every invocation.
 */
import { CapturePolicySchema, type CapturePolicy, type MonitoringScope } from '@qavo/shared';
import type { PathForms } from '@qavo/shared/paths';
import { writeFileAtomic } from './dataDir.ts';
import type { DB } from './db/index.ts';
import { getSetting, projectRoots, setSetting } from './store.ts';

export const DEFAULT_CAPTURE: CapturePolicy['capture'] = {
  prompts: false,
  toolInputs: false,
  toolOutputs: false,
  notificationText: false,
};

export function currentScope(db: DB): MonitoringScope {
  return getSetting<MonitoringScope>(db, 'scope', 'registered') === 'all' ? 'all' : 'registered';
}

export function currentCapture(db: DB): CapturePolicy['capture'] {
  return { ...DEFAULT_CAPTURE, ...getSetting<Partial<CapturePolicy['capture']>>(db, 'capture', {}) };
}

export function buildPolicy(db: DB, port: number, version: number): CapturePolicy {
  return CapturePolicySchema.parse({
    schema: 1,
    version,
    generatedAt: new Date().toISOString(),
    scope: currentScope(db),
    capture: currentCapture(db),
    projects: projectRoots(db),
    excludes: getSetting<PathForms[]>(db, 'excludes', []),
    collector: { port },
  });
}

export function writePolicy(db: DB, policyFile: string, port: number): CapturePolicy {
  const version = getSetting<number>(db, 'policy_version', 0) + 1;
  const policy = buildPolicy(db, port, version);
  writeFileAtomic(policyFile, JSON.stringify(policy, null, 2));
  setSetting(db, 'policy_version', version);
  return policy;
}
