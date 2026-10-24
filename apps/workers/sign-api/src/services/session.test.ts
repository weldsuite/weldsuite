import { describe, expect, it } from 'vitest';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { SESSION_TTL_MS, signSession, verifySession } from './session';
import { checkCode, emailHint, isLocked, issueEmailCode, MAX_TRIES } from './codes';
import { sha256Hex } from './hash';

const SECRET = 'test-secret-that-is-long-enough';
const who = { orgId: 'org_1', envelopeId: 'sgn_1', recipientId: 'sgr_1' };

describe('signer sessions', () => {
  it('round-trips and expires', async () => {
    const now = 1_000_000;
    const { token, expiresAt } = await signSession(SECRET, who, now);
    expect(expiresAt.getTime()).toBe(now + SESSION_TTL_MS);
    expect(await verifySession(SECRET, token, now + 1000)).toMatchObject(who);
    expect(await verifySession(SECRET, token, now + SESSION_TTL_MS + 1)).toBeNull();
  });

  it('rejects a forged, altered or foreign token', async () => {
    const { token } = await signSession(SECRET, who);
    const [body, sig] = token.split('.');
    expect(await verifySession('another-secret', token)).toBeNull();
    const tampered = btoa(JSON.stringify({ ...who, recipientId: 'sgr_2', exp: Date.now() + 60_000 })).replace(/=+$/, '');
    expect(await verifySession(SECRET, `${tampered}.${sig}`)).toBeNull();
    expect(await verifySession(SECRET, `${body}`)).toBeNull();
    expect(await verifySession(SECRET, 'garbage')).toBeNull();
  });
});

describe('identity codes', () => {
  it('accepts the right code once, and locks after too many wrong ones', async () => {
    const kv = createMemoryKv();
    expect(await issueEmailCode(kv, 'h1', '123456')).toBe(true);
    // A second request within the minute is throttled.
    expect(await issueEmailCode(kv, 'h1', '654321')).toBe(false);
    const expected = await sha256Hex('123456');
    expect(await checkCode(kv, 'h1', expected, '000000')).toEqual({ ok: false, locked: false, attemptsLeft: MAX_TRIES - 1 });
    expect(await checkCode(kv, 'h1', expected, ' 123456 ')).toEqual({ ok: true });

    for (let i = 0; i < MAX_TRIES - 1; i++) await checkCode(kv, 'h2', expected, 'wrong');
    expect(await checkCode(kv, 'h2', expected, 'wrong')).toEqual({ ok: false, locked: true, attemptsLeft: 0 });
    expect(await isLocked(kv, 'h2')).toBe(true);
    expect(await checkCode(kv, 'h2', expected, '123456')).toMatchObject({ ok: false, locked: true });
  });

  it('hints where the code went without showing the address', () => {
    expect(emailHint('ann@example.com')).toBe('a••@example.com');
    expect(emailHint('bartholomew@example.com')).toBe('b••••••@example.com');
    expect(emailHint(null)).toBeNull();
  });
});
