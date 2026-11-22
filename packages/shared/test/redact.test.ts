import { describe, it, expect } from 'vitest';
import { redact, redactObject } from '../src/redact.ts';

// All values below are synthetic and invalid. Pieces are concatenated so secret scanners
// don't flag this file.
const fake = {
  anthropic: 'sk-' + 'ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0KLMNOPQRST',
  openai: 'sk-' + 'proj-' + 'abcdEFGH1234ijklMNOP5678qrst',
  github: 'gh' + 'p_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  githubPat: 'github' + '_pat_' + '11ABCDEFG0123456789_abcdefghijklmnop',
  gitlab: 'gl' + 'pat-' + 'abcdefghij1234567890',
  slack: 'xo' + 'xb-' + '123456789012-abcdefghijkl',
  google: 'AI' + 'za' + 'SyA1234567890abcdefghijklmnopqrstuv',
  stripe: 'sk' + '_live_' + 'abcdefghijklmnop1234',
  npm: 'np' + 'm_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
  aws: 'AK' + 'IA' + 'IOSFODNN7EXAMPLE',
  awsSecret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  jwt:
    'eyJ' +
    'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
    '.eyJ' +
    'zdWIiOiIxMjM0NTY3ODkwIn0' +
    '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
};

const cases: Array<[string, string, string]> = [
  ['anthropic key', `key ${fake.anthropic} end`, 'anthropic_key'],
  ['openai key', `OPENAI ${fake.openai}`, 'openai_key'],
  ['github token', `token is ${fake.github}`, 'github_token'],
  ['github fine-grained pat', fake.githubPat, 'github_token'],
  ['gitlab token', fake.gitlab, 'gitlab_token'],
  ['slack token', fake.slack, 'slack_token'],
  ['google api key', fake.google, 'google_api_key'],
  ['stripe key', fake.stripe, 'stripe_key'],
  ['npm token', fake.npm, 'npm_token'],
  ['aws access key', fake.aws, 'aws_access_key'],
  ['aws secret key', `aws_secret_access_key = ${fake.awsSecret}`, 'aws_secret_key'],
  ['jwt', `Cookie value ${fake.jwt}`, 'jwt'],
  [
    'private key block',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    'private_key',
  ],
  ['bearer header', 'Authorization: Bearer abc.def-123_456ghijkl', 'auth'],
  ['basic header', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'auth'],
  ['url credentials', 'postgres://admin:hunter2@db.local:5432/x', 'credentials'],
  ['connection string password', 'Server=x;User Id=sa;Password=Sup3rS3cret;', 'password'],
  [
    'azure connection string',
    'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=abcdEFGHijklMNOPqrstUVWXyz0123456789abcd==;EndpointSuffix=core.windows.net',
    'azure_connection_string',
  ],
  ['sas signature', 'https://x.blob.core.windows.net/c?sv=2020&sig=abcdEFGH1234ijklMNOP%3D', 'sas_signature'],
  ['json password', '{"password": "letmein123"}', 'secret'],
  ['json api key', '{"x-api-key":"zzzz-yyyy-xxxx"}', 'secret'],
  ['env secret', 'DB_PASSWORD=letmein123', 'secret'],
  ['yaml token', 'access_token: abcdef123456', 'secret'],
  ['query string token', 'https://api.local/x?token=abcdef123456&y=1', 'secret'],
  ['cli flag password', 'login --password hunter22', 'secret'],
  ['email', 'contact jane.doe@example.com today', 'email'],
  ['intl phone', 'call +1 415 555 0134 now', 'phone'],
  ['ph mobile', 'text 0917 123 4567', 'phone'],
  ['ph mobile intl', 'text +63 917 123 4567', 'phone'],
  ['us phone', 'call (415) 555-0134', 'phone'],
  ['card number (luhn)', 'card 4111 1111 1111 1111 ok', 'card_number'],
  ['iban', 'IBAN GB82 WEST 1234 5698 7654 32', 'iban'],
  ['us ssn', 'SSN 123-45-6789', 'ssn'],
  ['ph tin', 'TIN 123-456-789-000', 'ph_tin'],
  ['ph sss', 'SSS 34-1234567-8', 'ph_sss'],
  ['ph umid', 'CRN 0111-1234567-8', 'ph_umid'],
  ['date of birth', 'DOB: 1990-04-12', 'date_of_birth'],
  ['ipv4', 'host 10.20.30.40 down', 'ipv4'],
  ['ipv6', 'addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334', 'ipv6'],
  ['mac address', 'mac 00:1A:2B:3C:4D:5E', 'mac_address'],
  ['high entropy', 'blob Zx9Qw3Er7Ty1Ui5Op2As8Df4Gh6Jk0LzXcVbNm', 'high_entropy'],
];

describe('redact corpus', () => {
  it.each(cases)('%s', (_name, input, type) => {
    const out = redact(input);
    expect(out).toContain(`[REDACTED:${type}]`);
  });

  it('removes the secret material itself', () => {
    for (const v of Object.values(fake)) {
      expect(redact(`value: ${v}`)).not.toContain(v);
    }
  });

  it('masks Windows user profile names', () => {
    expect(redact('C:\\Users\\SomeUser\\proj\\a.ts')).toBe('~\\proj\\a.ts');
    expect(redact('c:/Users/SomeUser/proj')).toBe('~/proj');
  });

  it('does not mangle ordinary prose or code', () => {
    const benign = 'Run npm test then open the report. Version 1.2.3, port 8080, count 42.';
    expect(redact(benign)).toBe(benign);
  });

  it('does not redact a non-luhn digit run as a card', () => {
    expect(redact('order 1234 5678 9012 3456')).not.toContain('card_number');
  });

  it('keeps loopback addresses', () => {
    expect(redact('http://127.0.0.1:47821')).toBe('http://127.0.0.1:47821');
  });

  it('respects the allowlist', () => {
    expect(redact('mail qa@example.com', { allowlist: ['qa@example.com'] })).toBe(
      'mail qa@example.com',
    );
  });

  it('applies user-defined patterns', () => {
    expect(redact('customer ACME-000123', { extraPatterns: ['ACME-\\d{6}'] })).toBe(
      'customer [REDACTED:custom]',
    );
  });

  it('can disable IP redaction', () => {
    expect(redact('10.0.0.1', { ipAddresses: false })).toBe('10.0.0.1');
  });
});

describe('redactObject', () => {
  it('redacts nested strings and drops path-like keys', () => {
    const out = redactObject({
      cwd: 'C:\\secret\\folder',
      transcript_path: 'C:\\x.jsonl',
      filePath: 'C:\\a',
      nested: { note: 'mail jane.doe@example.com', list: ['ok', fake.github] },
    });
    expect(out).toEqual({
      nested: { note: 'mail [REDACTED:email]', list: ['ok', '[REDACTED:github_token]'] },
    });
  });
});
