/**
 * capture-policy.json schema (browser-safe). The server is the ONLY writer; the forwarder reads it
 * on every invocation. Missing or corrupt => FAIL_CLOSED_POLICY (nothing is sent).
 */
import { z } from 'zod';

const FormsSchema = z.object({
  lexical: z.string().min(1).max(4096),
  canonical: z.string().min(1).max(4096).nullable(),
});

export const CapturePolicySchema = z.object({
  schema: z.literal(1),
  version: z.number().int().nonnegative(),
  generatedAt: z.string(),
  scope: z.enum(['registered', 'all']),
  capture: z.object({
    prompts: z.boolean(),
    toolInputs: z.boolean(),
    toolOutputs: z.boolean(),
    notificationText: z.boolean(),
  }),
  projects: z.array(FormsSchema.extend({ id: z.string().min(1).max(128) })),
  excludes: z.array(FormsSchema),
  collector: z.object({ port: z.number().int().min(1).max(65535) }),
  /** Approve/deny permission requests from the office (V4b). OFF unless a person turned it on; absent in older files. */
  permissionBridge: z.object({ enabled: z.boolean(), waitSeconds: z.number().int().min(10).max(300) }).default({ enabled: false, waitSeconds: 110 }),
});

export type CapturePolicy = z.infer<typeof CapturePolicySchema>;
export type MonitoringScope = CapturePolicy['scope'];

export const FAIL_CLOSED_POLICY: CapturePolicy = Object.freeze({
  schema: 1,
  version: 0,
  generatedAt: new Date(0).toISOString(),
  scope: 'registered',
  capture: { prompts: false, toolInputs: false, toolOutputs: false, notificationText: false },
  projects: [],
  excludes: [],
  collector: { port: 47821 },
  permissionBridge: { enabled: false, waitSeconds: 110 },
}) as CapturePolicy;

export function parsePolicy(text: string | null | undefined): {
  policy: CapturePolicy;
  failClosed: boolean;
} {
  if (!text) return { policy: FAIL_CLOSED_POLICY, failClosed: true };
  try {
    const parsed = CapturePolicySchema.safeParse(JSON.parse(text));
    if (parsed.success) return { policy: parsed.data, failClosed: false };
  } catch {
    /* fall through */
  }
  return { policy: FAIL_CLOSED_POLICY, failClosed: true };
}
