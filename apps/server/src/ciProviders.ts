/**
 * CI/CD providers (Pass 3, A3): GitHub Actions and Azure DevOps, READ-ONLY.
 *
 * The network rules live here and nowhere else:
 *  - only the two hosts below, written in code; a host is never taken from input
 *  - HTTPS only, GET only, redirects are never followed, 10 second timeout, 1 MB response cap
 *  - the token only ever goes in the Authorization header of a request to the matching provider's own host
 *  - errors returned to callers are OUR sentences: provider text and the token never appear in them
 */

import { redact } from '@qavo/shared';

export const CI_PROVIDERS = ['github', 'azure_devops'] as const;
export type CiProvider = (typeof CI_PROVIDERS)[number];
export const CI_PROVIDER_LABEL: Record<CiProvider, string> = { github: 'GitHub Actions', azure_devops: 'Azure DevOps' };
/** The ONLY hosts the app will ever contact for CI monitoring. */
export const ALLOWED_HOSTS: Record<CiProvider, string> = { github: 'api.github.com', azure_devops: 'dev.azure.com' };

export const LIMITS = { timeoutMs: 10_000, maxBytes: 1024 * 1024 } as const;

const GH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REPO = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const AZ_ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/;
const AZ_PROJECT = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}[A-Za-z0-9_-]$|^[A-Za-z0-9]$/;
const TOKEN_RE = /^[\x21-\x7e]{20,400}$/;

/** Plain reasons for a bad input, or null when it is fine. Names go into the URL, so these rules are strict. */
export function whyBadTarget(provider: CiProvider, owner: string, name: string): string | null {
  if (provider === 'github') {
    if (!GH_OWNER.test(owner)) return 'the GitHub owner may contain only letters, digits and dashes';
    if (!GH_REPO.test(name)) return 'the repository name may contain only letters, digits, dot, dash and underscore';
    return null;
  }
  if (!AZ_ORG.test(owner)) return 'the Azure DevOps organisation may contain only letters, digits and dashes';
  if (!AZ_PROJECT.test(name)) return 'the project name may contain only letters, digits, space, dot, dash and underscore, and must start and end with a letter, digit, dash or underscore';
  return null;
}
export const whyBadToken = (token: string): string | null => (TOKEN_RE.test(token) ? null : 'a token is 20 to 400 visible characters with no spaces');

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
}

/** Runs kept per connection, and how old they may be. */
export const RUNS_KEPT = 30;
export const RUNS_MAX_AGE_DAYS = 30;
/** The request that checks a connection works and has the permission monitoring will need (read recent runs). */
export function testRequest(provider: CiProvider, owner: string, name: string, token: string): ProviderRequest {
  const bad = whyBadTarget(provider, owner, name);
  if (bad) throw new Error(bad);
  if (provider === 'github') {
    return {
      url: `https://${ALLOWED_HOSTS.github}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs?per_page=1`,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}`, 'User-Agent': 'qa-virtual-office' },
    };
  }
  return {
    url: `https://${ALLOWED_HOSTS.azure_devops}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/_apis/build/builds?%24top=1&api-version=7.1`,
    headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`, 'User-Agent': 'qa-virtual-office' },
  };
}

export interface ProviderResponse {
  /** 0 when the provider could not be reached. */
  status: number;
  json: unknown;
  /** The provider's validator for this answer (GitHub), used to ask "has anything changed?" next time. */
  etag: string | null;
  /** 304: nothing changed since the last answer. */
  notModified: boolean;
  /** How long the provider asked us to wait, when it said (rate limiting). */
  retryAfterMs: number | null;
  rateLimited: boolean;
  /** A redirect was returned (never followed). */
  redirected: boolean;
  tooLarge: boolean;
}

export async function callProvider(provider: CiProvider, req: ProviderRequest, fetchFn: typeof fetch = fetch): Promise<ProviderResponse> {
  const u = new URL(req.url);
  if (u.protocol !== 'https:' || u.hostname !== ALLOWED_HOSTS[provider] || u.username || u.password) throw new Error('refused: not the provider host');
  const empty: ProviderResponse = { status: 0, json: null, etag: null, notModified: false, retryAfterMs: null, rateLimited: false, redirected: false, tooLarge: false };
  let res: Response;
  try {
    res = await fetchFn(req.url, { method: 'GET', headers: req.headers, redirect: 'manual', signal: AbortSignal.timeout(LIMITS.timeoutMs) });
  } catch {
    return empty; // offline, DNS, timeout, TLS failure: one answer, no details (they could carry the URL)
  }
  const retryAfter = Number(res.headers.get('retry-after'));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const out: ProviderResponse = {
    ...empty,
    status: res.status,
    etag: (res.headers.get('etag') ?? '').slice(0, 200) || null,
    rateLimited: res.headers.get('x-ratelimit-remaining') === '0' || res.status === 429,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 3_600_000) : Number.isFinite(reset) && reset > 0 ? Math.max(0, Math.min(reset * 1000 - Date.now(), 3_600_000)) : null,
  };
  if (res.status === 304) return { ...out, notModified: true };
  if (res.status >= 300 && res.status < 400) return { ...out, redirected: true };
  // read at most maxBytes
  const reader = res.body?.getReader();
  if (!reader) return out;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITS.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ...out, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { ...out, status: 0 };
  }
  try {
    return { ...out, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return out; // not JSON (for example a sign-in page)
  }
}

export interface TestOutcome {
  ok: boolean;
  /** Our own sentence; never provider text, never the token. */
  message: string;
}

/** Turn a provider response into a plain-language outcome for the connection test. */
export function interpretTest(provider: CiProvider, r: ProviderResponse): TestOutcome {
  const name = CI_PROVIDER_LABEL[provider];
  if (r.status === 0) return { ok: false, message: `Could not reach ${name}. Check the internet connection and try again.` };
  if (r.tooLarge) return { ok: false, message: `${name} sent an unexpectedly large answer, so it was ignored.` };
  if (r.redirected) return { ok: false, message: provider === 'azure_devops' ? 'Azure DevOps did not accept the token (it asked to sign in). Create a personal access token for this organisation with Build: Read.' : `${name} redirected the request, which is not allowed.` };
  if (r.rateLimited) return { ok: false, message: `${name} says too many requests were made. Wait a few minutes and test again.` };
  const looksRight = provider === 'github' ? Array.isArray((r.json as { workflow_runs?: unknown } | null)?.workflow_runs) : Array.isArray((r.json as { value?: unknown } | null)?.value);
  if (r.status === 200 && looksRight) return { ok: true, message: `Connected. ${name} answered and the token can read recent runs.` };
  if (r.status === 200 || r.status === 203) {
    return { ok: false, message: provider === 'azure_devops' ? 'Azure DevOps did not accept the token. Create a personal access token for this organisation with Build: Read.' : `${name} answered, but not in the expected form.` };
  }
  if (r.status === 401) return { ok: false, message: `${name} rejected the token. It may be wrong, expired or revoked.` };
  if (r.status === 403) return { ok: false, message: provider === 'github' ? 'GitHub refused access. The token needs “Actions: Read” for this repository.' : 'Azure DevOps refused access. The token needs “Build: Read”.' };
  if (r.status === 404) return { ok: false, message: provider === 'github' ? 'Repository not found, or the token cannot see it.' : 'Organisation or project not found, or the token cannot see it.' };
  return { ok: false, message: `${name} answered with an unexpected status (${r.status}).` };
}

// ---------------------------------------------------------------------------- reading runs (A3b)
export type CiRunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'other';
export interface CiRunInput {
  externalId: string;
  name: string;
  branch: string;
  status: CiRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  sha7: string;
  /** A link on the provider's own site, or '' when it is not one. */
  url: string;
}

/** The request that reads the most recent runs. `etag` asks the provider whether anything changed (GitHub). */
export function runsRequest(provider: CiProvider, owner: string, name: string, token: string, etag?: string | null): ProviderRequest {
  const req = testRequest(provider, owner, name, token);
  const url = provider === 'github' ? req.url.replace('per_page=1', `per_page=${RUNS_KEPT}`) : req.url.replace('%24top=1', `%24top=${RUNS_KEPT}&queryOrder=queueTimeDescending`);
  return { url, headers: provider === 'github' && etag ? { ...req.headers, 'If-None-Match': etag } : req.headers };
}

// Personal data in CI metadata: the person who triggered a run, commit messages and pull request titles are NEVER read
// from the answer, so they cannot be stored. Only the fields named below are looked at.
const ctrl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const text = (v: unknown, max: number): string => (typeof v === 'string' ? redact(v.replace(ctrl, '').trim()).slice(0, max) : '');
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 0 && t < Date.now() + 86_400_000 * 2 ? new Date(t).toISOString() : null;
};
/** A link is kept only when it is https on the provider's own web host. */
const ownLink = (provider: CiProvider, v: unknown): string => {
  if (typeof v !== 'string' || v.length > 500) return '';
  try {
    const u = new URL(v);
    const okHost = provider === 'github' ? u.hostname === 'github.com' : u.hostname === ALLOWED_HOSTS.azure_devops;
    return u.protocol === 'https:' && okHost && !u.username && !u.password ? u.toString() : '';
  } catch {
    return '';
  }
};
const sha = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{7,64}$/i.test(v) ? v.slice(0, 7).toLowerCase() : '');

export function parseRuns(provider: CiProvider, json: unknown): CiRunInput[] {
  const out: CiRunInput[] = [];
  if (provider === 'github') {
    const list = (json as { workflow_runs?: unknown } | null)?.workflow_runs;
    if (!Array.isArray(list)) return out;
    for (const r of list.slice(0, RUNS_KEPT) as Array<Record<string, unknown>>) {
      if (!r || (typeof r.id !== 'number' && typeof r.id !== 'string')) continue;
      const st = String(r.status ?? '');
      const cc = String(r.conclusion ?? '');
      const status: CiRunStatus =
        st === 'queued' || st === 'requested' || st === 'waiting' || st === 'pending'
          ? 'queued'
          : st === 'in_progress'
            ? 'running'
            : st === 'completed'
              ? cc === 'success'
                ? 'passed'
                : cc === 'failure' || cc === 'timed_out' || cc === 'startup_failure' || cc === 'action_required'
                  ? 'failed'
                  : cc === 'cancelled'
                    ? 'cancelled'
                    : 'other'
              : 'other';
      const done = status === 'passed' || status === 'failed' || status === 'cancelled' || status === 'other';
      out.push({
        externalId: String(r.id).slice(0, 40),
        name: text(r.name, 200) || '(unnamed)',
        branch: text(r.head_branch, 200),
        status,
        startedAt: iso(r.run_started_at) ?? iso(r.created_at),
        finishedAt: done ? iso(r.updated_at) : null,
        sha7: sha(r.head_sha),
        url: ownLink('github', r.html_url),
      });
    }
    return out;
  }
  const list = (json as { value?: unknown } | null)?.value;
  if (!Array.isArray(list)) return out;
  for (const r of list.slice(0, RUNS_KEPT) as Array<Record<string, unknown>>) {
    if (!r || (typeof r.id !== 'number' && typeof r.id !== 'string')) continue;
    const st = String(r.status ?? '');
    const rs = String(r.result ?? '');
    const status: CiRunStatus =
      st === 'notStarted' || st === 'postponed'
        ? 'queued'
        : st === 'inProgress' || st === 'cancelling'
          ? 'running'
          : st === 'completed'
            ? rs === 'succeeded'
              ? 'passed'
              : rs === 'failed'
                ? 'failed'
                : rs === 'canceled'
                  ? 'cancelled'
                  : 'other'
            : 'other';
    const done = status === 'passed' || status === 'failed' || status === 'cancelled' || status === 'other';
    const def = (r.definition as { name?: unknown } | undefined)?.name;
    const link = (r._links as { web?: { href?: unknown } } | undefined)?.web?.href;
    out.push({
      externalId: String(r.id).slice(0, 40),
      name: text(def, 200) || text(r.buildNumber, 200) || '(unnamed)',
      branch: text(typeof r.sourceBranch === 'string' ? r.sourceBranch.replace(/^refs\/(heads|tags)\//, '') : '', 200),
      status,
      startedAt: iso(r.startTime) ?? iso(r.queueTime),
      finishedAt: done ? iso(r.finishTime) : null,
      sha7: sha(r.sourceVersion),
      url: ownLink('azure_devops', link),
    });
  }
  return out;
}

export interface RefreshOutcome {
  kind: 'ok' | 'not_modified' | 'error';
  /** Our own sentence for the error case; never provider text, never the token. */
  message: string;
  /** Wait this long before asking again (rate limiting). */
  backoffMs: number | null;
}
export function interpretRefresh(provider: CiProvider, r: ProviderResponse): RefreshOutcome {
  if (r.notModified) return { kind: 'not_modified', message: '', backoffMs: null };
  const looksRight = provider === 'github' ? Array.isArray((r.json as { workflow_runs?: unknown } | null)?.workflow_runs) : Array.isArray((r.json as { value?: unknown } | null)?.value);
  if (r.status === 200 && looksRight && !r.rateLimited) return { kind: 'ok', message: '', backoffMs: null };
  const t = interpretTest(provider, r);
  return { kind: 'error', message: t.message, backoffMs: r.rateLimited ? (r.retryAfterMs ?? 15 * 60_000) : null };
}
