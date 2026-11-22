/**
 * Redaction engine (browser-safe). Applied to opted-in content, log lines and export output.
 * Replacement format: typed placeholders, e.g. `[REDACTED:email]`.
 *
 * Order matters: structured secrets first (so their pieces are not half-matched by PII rules),
 * then key/value secrets, then PII, then the high-entropy fallback.
 */

export interface RedactOptions {
  /** Redact IPv4/IPv6 addresses (default true). */
  ipAddresses?: boolean;
  /** Extra user-defined regex sources (applied with flags 'gi'). */
  extraPatterns?: string[];
  /** Literal strings that must never be redacted (e.g. 'localhost'). */
  allowlist?: string[];
  /** Run the high-entropy fallback (default true). */
  highEntropy?: boolean;
}

type Rule = { type: string; re: RegExp; replace?: (m: string, ...g: string[]) => string | null };

const R = (type: string, re: RegExp, replace?: Rule['replace']): Rule => ({ type, re, replace });
const tag = (t: string) => `[REDACTED:${t}]`;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const SECRET_KEY_NAMES =
  String.raw`(?:pass(?:word|wd|phrase)?|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|x[_-]?api[_-]?key|auth(?:orization)?|credentials?|cookie|set-cookie|session(?:[_-]?id)?|private[_-]?key|account[_-]?key|sas|signature)`;

const STRUCTURED_SECRETS: Rule[] = [
  R(
    'private_key',
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  ),
  R('anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{10,}/g),
  R('openai_key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g),
  R('github_token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g),
  R('github_token', /\bgithub_pat_[A-Za-z0-9_]{20,}/g),
  R('gitlab_token', /\bglpat-[A-Za-z0-9_-]{16,}/g),
  R('slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g),
  R('slack_webhook', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g),
  R('google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/g),
  R('stripe_key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g),
  R('npm_token', /\bnpm_[A-Za-z0-9]{30,}/g),
  R('pypi_token', /\bpypi-[A-Za-z0-9_-]{30,}/g),
  R('aws_access_key', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g),
  R(
    'aws_secret_key',
    /(aws_?secret_?access_?key|aws_?secret)(["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{30,}/gi,
    (_m, k, sep) => `${k}${sep}${tag('aws_secret_key')}`,
  ),
  R('jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g),
  R(
    'azure_connection_string',
    /DefaultEndpointsProtocol=[^;\s]+;AccountName=[^;\s]+;AccountKey=[^;\s]+(?:;[^\s"']*)?/gi,
  ),
  R(
    'azure_account_key',
    /(AccountKey|SharedAccessKey)=([A-Za-z0-9+/=]{20,})/gi,
    (_m, k) => `${k}=${tag('azure_key')}`,
  ),
  R('sas_signature', /([?&]sig=)[A-Za-z0-9%+/=]{16,}/gi, (_m, k) => `${k}${tag('sas_signature')}`),
  R(
    'auth_header',
    /\b(Authorization|Proxy-Authorization)(\s*[:=]\s*["']?)(Bearer|Basic|Token|Digest|Negotiate)\s+[A-Za-z0-9._~+/=-]+/gi,
    (_m, h, sep, scheme) => `${h}${sep}${scheme} ${tag('auth')}`,
  ),
  R('bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, () => `Bearer ${tag('auth')}`),
  R(
    'url_credentials',
    /\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s:/@"']{1,128}):([^\s@"']{1,256})@/gi,
    (_m, scheme) => `${scheme}${tag('credentials')}@`,
  ),
  R(
    'connection_string_password',
    /\b(Password|Pwd)(\s*=\s*)([^;"'\s]+)/gi,
    (_m, k, sep) => `${k}${sep}${tag('password')}`,
  ),
];

const KEY_VALUE_SECRETS: Rule[] = [
  // JSON:  "password": "value"
  R(
    'kv_secret',
    new RegExp(String.raw`("(?:[\w-]*?)${SECRET_KEY_NAMES}(?:[\w-]*?)"\s*:\s*)"((?:[^"\\]|\\.)*)"`, 'gi'),
    (_m, prefix, value) => (value.length === 0 ? null : `${prefix}"${tag('secret')}"`),
  ),
  // env / yaml / ini / cli:  PASSWORD=value   password: value   --password value
  R(
    'kv_secret',
    new RegExp(
      String.raw`(^|[\s,;{(?&])((?:[\w.-]*?)${SECRET_KEY_NAMES}(?:[\w.-]*?))(\s*[:=]\s*|\s+)(["']?)([^\s"',;&)}]{3,})\4`,
      'gim',
    ),
    (m, lead, key, sep, quote, value) => {
      if (value.startsWith('[REDACTED:')) return null;
      if (/^\s+$/.test(sep) && !/^--?/.test(key)) return null; // bare "token value" prose is ignored
      return `${lead}${key}${sep}${quote}${tag('secret')}${quote}`;
    },
  ),
];

const PII: Rule[] = [
  R('email', /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g),
  R(
    'card_number',
    /\b(?:\d[ -]?){12,18}\d\b/g,
    (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? tag('card_number') : null;
    },
  ),
  R('iban', /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g),
  R('ssn', /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g),
  // Philippine identifiers: TIN 123-456-789(-000), SSS 12-3456789-0, UMID/CRN 1234-5678901-2
  R('ph_tin', /\b\d{3}-\d{3}-\d{3}(?:-\d{3,5})?\b/g),
  R('ph_sss', /\b\d{2}-\d{7}-\d\b/g),
  R('ph_umid', /\b\d{4}-\d{7}-\d\b/g),
  R(
    'date_of_birth',
    /\b(dob|date[\s_-]?of[\s_-]?birth|birth[\s_-]?date|birthday)(\s*[:=]?\s*)(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4})/gi,
    (_m, k, sep) => `${k}${sep}${tag('date_of_birth')}`,
  ),
  R('phone', /(?<![\w/.-])\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?![\w/-])/g),
  R('phone', /(?<![\w/.-])(?:\+?63|0)9\d{2}[\s.-]?\d{3}[\s.-]?\d{4}(?![\w/-])/g),
  R('phone', /(?<![\w/.-])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w/-])/g),
  R('mac_address', /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g),
  R(
    'user_path',
    /\b([A-Za-z]:[\\/]+Users[\\/]+)([^\\/\s"'<>|:*?]+)/gi,
    () => '~',
  ),
  R('user_path', /(\/(?:home|Users)\/)([^/\s"']+)/g, () => '~'),
];

const IP_RULES: Rule[] = [
  R(
    'ipv4',
    /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    (m) => (m === '127.0.0.1' || m === '0.0.0.0' ? null : tag('ipv4')),
  ),
  R(
    'ipv6',
    /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){0,6})?\b/g,
    (m) => (m === '::1' || !/[0-9a-f]{1,4}:[0-9a-f]{0,4}:/i.test(m) ? null : tag('ipv6')),
  ),
];

const HIGH_ENTROPY: Rule = R('high_entropy', /[A-Za-z0-9+/_=-]{32,}/g, (m) => {
  if (m.startsWith('REDACTED')) return null;
  const isHex = /^[a-f0-9]+$/i.test(m);
  const threshold = isHex ? 3.0 : 4.0;
  if (!/\d/.test(m) || !/[A-Za-z]/.test(m)) return null;
  return shannonEntropy(m) >= threshold ? tag('high_entropy') : null;
});

function applyRule(text: string, rule: Rule, allow: Set<string>): string {
  return text.replace(rule.re, (...args) => {
    const m = args[0] as string;
    if (allow.has(m)) return m;
    const groups = args.slice(1, -2) as string[];
    if (!rule.replace) return tag(rule.type);
    const out = rule.replace(m, ...groups);
    return out === null ? m : out;
  });
}

export function redact(input: string, opts: RedactOptions = {}): string {
  if (!input) return input;
  const allow = new Set(opts.allowlist ?? []);
  let out = input;
  for (const rule of STRUCTURED_SECRETS) out = applyRule(out, rule, allow);
  for (const rule of KEY_VALUE_SECRETS) out = applyRule(out, rule, allow);
  for (const src of opts.extraPatterns ?? []) {
    try {
      out = applyRule(out, R('custom', new RegExp(src, 'gi')), allow);
    } catch {
      /* invalid user pattern: ignored, validated at config time */
    }
  }
  for (const rule of PII) out = applyRule(out, rule, allow);
  if (opts.ipAddresses !== false) for (const rule of IP_RULES) out = applyRule(out, rule, allow);
  if (opts.highEntropy !== false) out = applyRule(out, HIGH_ENTROPY, allow);
  return out;
}

/** Recursively redact all string values; drops keys that look like filesystem paths/cwd. */
export function redactObject<T>(value: T, opts: RedactOptions = {}, depth = 0): T {
  if (depth > 8) return '[TRUNCATED]' as T;
  if (typeof value === 'string') return redact(value, opts) as T;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, opts, depth + 1)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isPathLikeKey(k)) continue;
      out[k] = redactObject(v, opts, depth + 1);
    }
    return out as T;
  }
  return value;
}

export function isPathLikeKey(key: string): boolean {
  return /^(cwd|path|.*_?path|.*Path|.*_?dir|.*Dir|transcript.*)$/i.test(key);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…[truncated]';
}
