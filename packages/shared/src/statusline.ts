/**
 * Status-line snapshot schema + sanitizer (browser-safe). Numbers and a model id/name only:
 * no cwd, no transcript path, no session name, no PR/worktree/vim details.
 * Usage numbers come ONLY from what Claude Code reports; billing/subscription spend is not available.
 */
import { z } from 'zod';
import { FOLDER_KEY_RE, ID_RE, MODEL_RE } from './events.ts';

const MODEL_NAME_RE = /^[A-Za-z0-9_.:()/[\] -]{1,60}$/;

export const StatusLineSnapshotSchema = z
  .object({
    v: z.literal(1),
    ts: z.string().datetime(),
    sessionId: z.string().regex(ID_RE),
    projectId: z.string().regex(ID_RE).nullable(),
    folderKeys: z.array(z.string().regex(FOLDER_KEY_RE)).max(18),
    modelId: z.string().regex(MODEL_RE).optional(),
    modelName: z.string().regex(MODEL_NAME_RE).optional(),
    costUsd: z.number().min(0).max(1_000_000).optional(),
    durationMs: z.number().int().min(0).max(31_536_000_000).optional(),
    apiDurationMs: z.number().int().min(0).max(31_536_000_000).optional(),
    contextUsedPct: z.number().min(0).max(100).optional(),
    contextWindowSize: z.number().int().min(0).max(100_000_000).optional(),
    fiveHourPct: z.number().min(0).max(100).optional(),
    fiveHourResetsAt: z.string().datetime().optional(),
    sevenDayPct: z.number().min(0).max(100).optional(),
    sevenDayResetsAt: z.string().datetime().optional(),
  })
  .strict();
export type StatusLineSnapshot = z.infer<typeof StatusLineSnapshotSchema>;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const clamp = (v: number | undefined, lo: number, hi: number) => (v === undefined ? undefined : Math.min(hi, Math.max(lo, v)));

/** Accepts epoch seconds, epoch milliseconds or an ISO string; returns ISO or undefined. */
function toIso(v: unknown): string | undefined {
  let ms: number | undefined;
  if (typeof v === 'number' && Number.isFinite(v)) ms = v < 1e12 ? v * 1000 : v;
  else if (typeof v === 'string') ms = Date.parse(v);
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return d.getUTCFullYear() >= 2020 && d.getUTCFullYear() <= 2100 ? d.toISOString() : undefined;
}

export function sanitizeStatusLine(
  raw: unknown,
  resolution: { kind: 'project'; projectId: string } | { kind: 'unregistered'; folderKeys: string[] },
  now: () => Date = () => new Date(),
): StatusLineSnapshot | null {
  const r = obj(raw);
  if (!r || typeof r.session_id !== 'string' || !ID_RE.test(r.session_id)) return null;
  const snap: StatusLineSnapshot = {
    v: 1,
    ts: now().toISOString(),
    sessionId: r.session_id,
    projectId: resolution.kind === 'project' ? resolution.projectId : null,
    folderKeys: resolution.kind === 'unregistered' ? resolution.folderKeys.slice(0, 18) : [],
  };
  const model = obj(r.model);
  if (typeof model?.id === 'string' && MODEL_RE.test(model.id)) snap.modelId = model.id;
  if (typeof model?.display_name === 'string' && MODEL_NAME_RE.test(model.display_name)) snap.modelName = model.display_name;
  const cost = obj(r.cost);
  const costUsd = clamp(num(cost?.total_cost_usd), 0, 1_000_000);
  if (costUsd !== undefined) snap.costUsd = costUsd;
  const dur = clamp(num(cost?.total_duration_ms), 0, 31_536_000_000);
  if (dur !== undefined) snap.durationMs = Math.round(dur);
  const api = clamp(num(cost?.total_api_duration_ms), 0, 31_536_000_000);
  if (api !== undefined) snap.apiDurationMs = Math.round(api);
  const ctx = obj(r.context_window);
  const used = clamp(num(ctx?.used_percentage), 0, 100);
  if (used !== undefined) snap.contextUsedPct = used;
  const size = clamp(num(ctx?.context_window_size), 0, 100_000_000);
  if (size !== undefined) snap.contextWindowSize = Math.round(size);
  const rl = obj(r.rate_limits);
  for (const [key, pctKey, resetKey] of [
    ['five_hour', 'fiveHourPct', 'fiveHourResetsAt'],
    ['seven_day', 'sevenDayPct', 'sevenDayResetsAt'],
  ] as const) {
    const w = obj(rl?.[key]);
    const pct = clamp(num(w?.used_percentage), 0, 100);
    if (pct !== undefined) snap[pctKey] = pct;
    const reset = toIso(w?.resets_at);
    if (reset) snap[resetKey] = reset;
  }
  return snap;
}

/** Compact line printed by our status line when nothing is wrapped. */
export function formatStatusLine(snap: StatusLineSnapshot): string {
  const parts = ['QA Office'];
  if (snap.modelName ?? snap.modelId) parts.push((snap.modelName ?? snap.modelId)!);
  if (snap.contextUsedPct !== undefined) parts.push(`ctx ${Math.round(snap.contextUsedPct)}%`);
  return parts.join(' · ');
}
