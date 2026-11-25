/**
 * CI/CD providers (Pass 3, A3): GitHub Actions and Azure DevOps, READ-ONLY.
 *
 * The network rules live here and nowhere else:
 *  - only the two hosts below, written in code; a host is never taken from input
 *  - HTTPS only, GET only, redirects are never followed, 10 second timeout, 1 MB response cap
 *  - the token only ever goes in the Authorization header of a request to the matching provider's own host
 *  - errors returned to callers are OUR sentences: provider text and the token never appear in them
 */

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
  rateLimited: boolean;
  /** A redirect was returned (never followed). */
  redirected: boolean;
  tooLarge: boolean;
}

export async function callProvider(provider: CiProvider, req: ProviderRequest, fetchFn: typeof fetch = fetch): Promise<ProviderResponse> {
  const u = new URL(req.url);
  if (u.protocol !== 'https:' || u.hostname !== ALLOWED_HOSTS[provider] || u.username || u.password) throw new Error('refused: not the provider host');
  const empty: ProviderResponse = { status: 0, json: null, rateLimited: false, redirected: false, tooLarge: false };
  let res: Response;
  try {
    res = await fetchFn(req.url, { method: 'GET', headers: req.headers, redirect: 'manual', signal: AbortSignal.timeout(LIMITS.timeoutMs) });
  } catch {
    return empty; // offline, DNS, timeout, TLS failure: one answer, no details (they could carry the URL)
  }
  const out: ProviderResponse = { ...empty, status: res.status, rateLimited: res.headers.get('x-ratelimit-remaining') === '0' || res.status === 429 };
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
