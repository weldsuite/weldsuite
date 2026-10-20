import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { parseFactorVerificationAge } from './clerk';
import { checkSecondFactor, requireSecondFactor } from './second-factor';

describe('parseFactorVerificationAge', () => {
  it('keeps a well-formed fva claim and drops anything else', () => {
    expect(parseFactorVerificationAge([3, -1])).toEqual([3, -1]);
    expect(parseFactorVerificationAge([0, 0])).toEqual([0, 0]);
    expect(parseFactorVerificationAge(undefined)).toBeNull();
    expect(parseFactorVerificationAge([1])).toBeNull();
    expect(parseFactorVerificationAge([1, '2'])).toBeNull();
    expect(parseFactorVerificationAge([1, -2])).toBeNull();
  });
});

describe('checkSecondFactor', () => {
  it('passes a second factor verified within the window', () => {
    expect(checkSecondFactor([30, 0])).toBe('pass');
    expect(checkSecondFactor([30, 9])).toBe('pass');
  });

  it('asks to confirm a stale second factor, or one it cannot read', () => {
    expect(checkSecondFactor([30, 10])).toBe('REVERIFICATION_REQUIRED');
    expect(checkSecondFactor(null)).toBe('REVERIFICATION_REQUIRED');
    expect(checkSecondFactor([0, 45], 60)).toBe('pass');
  });

  it('never falls back to the first factor for a user without a second one', () => {
    expect(checkSecondFactor([0, -1])).toBe('MFA_REQUIRED');
  });
});

describe('requireSecondFactor', () => {
  function app(fva: readonly [number, number] | null) {
    const hono = new Hono<{ Variables: { factorVerificationAge?: readonly [number, number] | null } }>();
    hono.use('*', async (c, next) => {
      c.set('factorVerificationAge', fva);
      await next();
    });
    hono.post('/sensitive', requireSecondFactor(), (c) => c.json({ data: 'ok' }));
    return hono;
  }

  it('lets a fresh second factor through', async () => {
    expect((await app([5, 2]).request('/sensitive', { method: 'POST' })).status).toBe(200);
  });

  it('answers 403 with a code the client can act on', async () => {
    const noMfa = await app([1, -1]).request('/sensitive', { method: 'POST' });
    expect(noMfa.status).toBe(403);
    expect((await noMfa.json()) as unknown).toMatchObject({ error: { code: 'MFA_REQUIRED' } });

    const stale = await app([1, 25]).request('/sensitive', { method: 'POST' });
    expect(stale.status).toBe(403);
    expect((await stale.json()) as unknown).toMatchObject({
      error: { code: 'REVERIFICATION_REQUIRED', details: { level: 'second_factor', afterMinutes: 10 } },
    });
  });
});
