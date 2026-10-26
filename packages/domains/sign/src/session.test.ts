import { describe, expect, it } from 'vitest';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { SESSION_TTL_MS, signSession, verifySession } from './session';
import { AttemptCounter, checkCode, emailCodeHash, emailHint, isLocked, issueEmailCode, LOCK_SECONDS, MAX_TRIES } from './codes';
import { codeAttemptsFor, SignCodeAttempts } from './code-attempts';
import { memoryCodeAttempts, memoryStore } from './code-attempts.memory';
import { codeHash, sha256Hex } from './hash';

const SECRET = 'test-secret-that-is-long-enough';
const who = { orgId: 'org_1', envelopeId: 'sgn_1', recipientId: 'sgr_1', tokenHash: 'h'.repeat(64) };

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
  const hash = (code: string) => codeHash(SECRET, 'sgr_1', code);

  it('accepts the right code once, and locks after too many wrong ones', async () => {
    const kv = createMemoryKv();
    expect(await issueEmailCode(kv, 'h1', '123456', hash)).toBe(true);
    // A second request within the minute is throttled.
    expect(await issueEmailCode(kv, 'h1', '654321', hash)).toBe(false);
    const expected = await hash('123456');
    expect(await emailCodeHash(kv, 'h1')).toBe(expected);
    const ns = memoryCodeAttempts();
    const h1 = codeAttemptsFor(ns, 'h1');
    expect(await checkCode(kv, h1, 'h1', expected, '000000', hash)).toEqual({ ok: false, locked: false, attemptsLeft: MAX_TRIES - 1 });
    expect(await checkCode(kv, h1, 'h1', expected, ' 123456 ', hash)).toEqual({ ok: true });
    // A used emailed code is gone, and the count starts over.
    expect(await emailCodeHash(kv, 'h1')).toBeNull();
    expect(await h1.tries()).toBe(0);

    const h2 = codeAttemptsFor(ns, 'h2');
    for (let i = 0; i < MAX_TRIES - 1; i++) await checkCode(kv, h2, 'h2', expected, 'wrong', hash);
    expect(await checkCode(kv, h2, 'h2', expected, 'wrong', hash)).toEqual({ ok: false, locked: true, attemptsLeft: 0 });
    expect(await isLocked(h2)).toBe(true);
    expect(await checkCode(kv, h2, 'h2', expected, '123456', hash)).toMatchObject({ ok: false, locked: true });
    // Another link is not affected.
    expect(await isLocked(codeAttemptsFor(ns, 'h3'))).toBe(false);
  });

  it('gives a burst of parallel guesses no more than the allowed tries', async () => {
    const kv = createMemoryKv();
    const attempts = codeAttemptsFor(memoryCodeAttempts(), 'h1');
    const expected = await hash('4821');
    const guesses = Array.from({ length: 50 }, (_, i) => String(1000 + i));
    const results = await Promise.all(guesses.map((g) => checkCode(kv, attempts, 'h1', expected, g, hash)));
    expect(results.filter((r) => !r.ok && !r.locked)).toHaveLength(MAX_TRIES - 1);
    expect(results.filter((r) => !r.ok && r.locked)).toHaveLength(50 - (MAX_TRIES - 1));
    // Locked now, so even the right code is refused.
    expect(await checkCode(kv, attempts, 'h1', expected, '4821', hash)).toMatchObject({ ok: false, locked: true });
  });

  it('forgets wrong answers once the lock window has passed', async () => {
    let now = 1_000_000;
    const counter = new AttemptCounter(memoryStore(), () => now);
    for (let i = 0; i < MAX_TRIES; i++) await counter.attempt(false);
    expect(await isLocked(counter)).toBe(true);
    now += LOCK_SECONDS * 1000 - 1;
    expect(await isLocked(counter)).toBe(true);
    now += 2;
    expect(await counter.tries()).toBe(0);
    expect(await counter.attempt(false)).toEqual({ ok: false, locked: false, attemptsLeft: MAX_TRIES - 1 });
  });

  it('the Durable Object sets an alarm for the window and clears it on a match', async () => {
    const store = memoryStore();
    let alarm: number | null = null;
    const storage = {
      ...store,
      setAlarm: async (at: number) => {
        alarm = at;
      },
      deleteAlarm: async () => {
        alarm = null;
      },
      deleteAll: async () => store.data.clear(),
    };
    const durable = new SignCodeAttempts({ storage } as unknown as DurableObjectState, {} as never);
    await durable.attempt(false);
    expect(alarm).toBeGreaterThan(Date.now());
    expect(await durable.tries()).toBe(1);
    await durable.attempt(true);
    expect(alarm).toBeNull();
    expect(await durable.tries()).toBe(0);
    await durable.attempt(false);
    await durable.alarm();
    expect(store.data.size).toBe(0);
  });

  it('stores codes as a keyed hash bound to the recipient, not a plain hash', async () => {
    const stored = await codeHash(SECRET, 'sgr_1', '4821');
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    // A plain SHA-256 of a short code is a lookup away; the stored form is not.
    expect(stored).not.toBe(await sha256Hex('4821'));
    expect(await codeHash('another-secret', 'sgr_1', '4821')).not.toBe(stored);
    expect(await codeHash(SECRET, 'sgr_2', '4821')).not.toBe(stored);
    expect(await codeHash(SECRET, 'sgr_1', ' 4821 ')).toBe(stored);
  });

  it('hints where the code went without showing the address', () => {
    expect(emailHint('ann@example.com')).toBe('a••@example.com');
    expect(emailHint('bartholomew@example.com')).toBe('b••••••@example.com');
    expect(emailHint(null)).toBeNull();
  });
});
