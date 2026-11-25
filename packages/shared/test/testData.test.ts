import { describe, expect, it } from 'vitest';
import { maskText, whyNotFake } from '../src/testData.ts';

describe('whyNotFake: only fake data, placeholders and secret references are accepted', () => {
  it('accepts fictional values', () => {
    for (const [k, v] of [
      ['email', 'jane.tester@example.test'],
      ['email2', 'a@example.com'],
      ['phone', '(212) 555-0123'],
      ['phone2', '555-0142'],
      ['server', '192.0.2.10'],
      ['card', '4242424242424242'],
      ['fullName', 'Jane Tester'],
      ['country', 'Philippines'],
      ['qty', '3'],
    ] as const) expect(whyNotFake(k, 'fixed', v), `${k}=${v}`).toBeNull();
  });

  it('refuses values that look like real personal data or secrets, with a reason', () => {
    for (const [k, v] of [
      ['email', 'maria.santos@gmail.com'],
      ['contact', 'call +63 917 123 4567'],
      ['ssn', '123-45-6789'],
      ['card', '4539578763621486'],
      ['note', 'Bearer abcdefghijklmnopqrstuvwxyz123456'],
      ['key', 'AKIAIOSFODNN7EXAMPLE'],
      ['host', '10.20.30.40'],
    ] as const) {
      const why = whyNotFake(k, 'fixed', v);
      expect(why, `${k}=${v}`).toMatch(/looks like real data/);
    }
  });

  it('a field named like a secret can never be a fixed value', () => {
    for (const k of ['password', 'adminPassword', 'api_key', 'authToken', 'client-secret', 'sessionCookie']) expect(whyNotFake(k, 'fixed', 'hunter2'), k).toMatch(/secret reference or a placeholder/);
    expect(whyNotFake('password', 'secret_ref', 'SHOP_ADMIN_PASSWORD')).toBeNull();
    expect(whyNotFake('password', 'placeholder', '{{random_password}}')).toBeNull();
  });

  it('a secret reference is only an environment variable NAME, never the secret', () => {
    expect(whyNotFake('apiKey', 'secret_ref', 'SHOP_API_KEY')).toBeNull();
    for (const v of ['hunter2', 'sk-abcdefghijklmnopqrstuvwxyz', 'shop api key', 'lowercase_name', '']) expect(whyNotFake('apiKey', 'secret_ref', v), v).toMatch(/NAME of an environment variable/);
  });

  it('placeholders must look like placeholders', () => {
    for (const v of ['{{random_email}}', '${RUN_ID}', '<user-email>', '%RUN_ID%']) expect(whyNotFake('x', 'placeholder', v), v).toBeNull();
    expect(whyNotFake('x', 'placeholder', 'maria@gmail.com')).toMatch(/looks like/);
  });

  it('checks the name and the length', () => {
    expect(whyNotFake('1bad', 'fixed', 'x')).toMatch(/must start with a letter/);
    expect(whyNotFake('has space', 'fixed', 'x')).toMatch(/must start with a letter/);
    expect(whyNotFake('big', 'fixed', 'x'.repeat(501))).toMatch(/longer than/);
  });

  it('a real value hidden next to safe ones is still caught', () => {
    expect(whyNotFake('mix', 'fixed', 'a@example.test and real.person@yahoo.com')).toMatch(/looks like real data/);
  });
});

describe('maskText', () => {
  it('masks personal data and secrets and counts them by type', () => {
    const r = maskText('Contact maria@gmail.com or pedro@gmail.com, token=abcdefghijklmnopqrstuvwxyz123456');
    expect(r.masked).not.toMatch(/maria|pedro|abcdefghijklmnop/);
    expect(r.findings.find((f) => f.type === 'email')).toMatchObject({ count: 2 });
    expect(maskText('nothing sensitive here')).toEqual({ masked: 'nothing sensitive here', findings: [] });
  });
});
