/**
 * Test data profiles (Pass 3, D1): browser-safe rules. The app keeps only FAKE or masked test data and references to
 * secrets, never the secrets or real personal data themselves.
 *
 * A profile field is one of:
 *  - fixed:      a literal fake value (checked: it must not look like real personal data or a secret)
 *  - placeholder: a token the test framework fills in at run time, e.g. {{random_email}} or ${RUN_ID}
 *  - secret_ref: the NAME of an environment variable that holds a secret (e.g. SHOP_ADMIN_PASSWORD); the value is never stored
 */
import { redact } from './redact.ts';

export const TEST_DATA_KINDS = ['fixed', 'placeholder', 'secret_ref'] as const;
export type TestDataKind = (typeof TEST_DATA_KINDS)[number];
export const TEST_DATA_KIND_LABEL: Record<TestDataKind, string> = {
  fixed: 'Fixed fake value',
  placeholder: 'Placeholder (filled in at run time)',
  secret_ref: 'Secret reference (environment variable name)',
};
export const TEST_DATA_ENVIRONMENTS = ['dev', 'qa', 'staging', 'uat', 'demo'] as const;
export const TEST_DATA_LIMITS = { fields: 100, keyLen: 64, valueLen: 500, nameLen: 80, descLen: 1000, envLen: 40 } as const;

export const KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Field names that look like they hold a secret: such a field may only be a placeholder or a secret reference. */
export const SECRET_KEY_RE = /pass(word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|credential|private[_-]?key|cookie|session|auth|signature|otp|pin\b|cvv|cvc/i;

/** Values that are clearly fictional and therefore fine (documented test values). */
const SAFE_PATTERNS: RegExp[] = [
  /\{\{[^{}]{1,80}\}\}/g, // {{random_email}}
  /\$\{[A-Za-z_][A-Za-z0-9_]{0,63}\}/g, // ${RUN_ID}
  /<[A-Za-z_][A-Za-z0-9_ -]{0,40}>/g, // <user-email>
  /%[A-Za-z_][A-Za-z0-9_]{0,40}%/g, // %RUN_ID%
  /[A-Za-z0-9._%+-]{1,64}@(?:example\.(?:com|org|net)|[A-Za-z0-9-]{1,63}\.(?:test|invalid|example|localhost))\b/gi, // reserved domains (RFC 2606)
  /\(?\b\d{3}\)?[\s.-]?555[\s.-]?01\d\d\b/g, // the fictional US 555-01xx range
  /\b(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}\b/g, // documentation IPs (RFC 5737)
  /\b(?:4111111111111111|4242424242424242|5555555555554444|378282246310005|6011111111111117)\b/g, // published test card numbers
];

/** Mask personal data and secrets in a text. The same engine the rest of the app uses. */
export function maskText(text: string): { masked: string; findings: Array<{ type: string; count: number }> } {
  const masked = redact(text);
  const counts = new Map<string, number>();
  for (const m of masked.matchAll(/\[REDACTED:([a-z_]+)\]/g)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  return { masked, findings: [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count) };
}

/** Why a value cannot be stored as fake data, or null when it is fine. */
export function whyNotFake(key: string, kind: TestDataKind, value: string): string | null {
  if (!KEY_RE.test(key)) return 'the name must start with a letter and use only letters, digits, dot, dash and underscore';
  if (kind === 'secret_ref') {
    return ENV_NAME_RE.test(value) ? null : 'a secret reference is the NAME of an environment variable, in capitals, e.g. SHOP_ADMIN_PASSWORD (never the secret itself)';
  }
  if (value.length > TEST_DATA_LIMITS.valueLen) return `longer than ${TEST_DATA_LIMITS.valueLen} characters`;
  if (kind === 'placeholder') {
    return /^(?:\{\{[^{}]{1,80}\}\}|\$\{[A-Za-z_][A-Za-z0-9_]{0,63}\}|<[A-Za-z_][A-Za-z0-9_ -]{0,40}>|%[A-Za-z_][A-Za-z0-9_]{0,40}%)$/.test(value.trim())
      ? null
      : 'a placeholder looks like {{random_email}}, ${RUN_ID}, <user-email> or %RUN_ID%';
  }
  if (SECRET_KEY_RE.test(key)) return 'a field named like a secret must be a secret reference or a placeholder, never a fixed value';
  let rest = value;
  for (const re of SAFE_PATTERNS) rest = rest.replace(re, ' ');
  if (redact(rest) !== rest || redact(`${key}: ${rest}`) !== `${key}: ${rest}`) {
    const found = maskText(rest).findings.map((f) => f.type.replace(/_/g, ' '));
    return `looks like real data (${found.join(', ') || 'a secret or personal detail'}). Use a fake value (for example name@example.test) or a placeholder`;
  }
  return null;
}
