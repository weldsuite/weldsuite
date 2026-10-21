import { describe, expect, it } from 'vitest';
import { CALL_RING_TOKEN_TTL_MS, signCallRingToken, verifyCallRingToken } from './call-ring-token';

const claims = { orgId: 'org_1', userId: 'user_bob', callId: 'call_1' };

describe('call ring token', () => {
  it('round-trips its claims', async () => {
    const token = await signCallRingToken('secret', claims);
    expect(await verifyCallRingToken('secret', token)).toEqual(claims);
  });

  it('expires after the TTL', async () => {
    const token = await signCallRingToken('secret', claims, 0);
    expect(await verifyCallRingToken('secret', token, CALL_RING_TOKEN_TTL_MS - 1)).toEqual(claims);
    expect(await verifyCallRingToken('secret', token, CALL_RING_TOKEN_TTL_MS + 1)).toBeNull();
  });

  it('rejects another secret, a missing secret and tampered claims', async () => {
    const token = await signCallRingToken('secret', claims);
    expect(await verifyCallRingToken('other', token)).toBeNull();
    expect(await verifyCallRingToken(undefined, token)).toBeNull();

    const [, sig] = token.split('.');
    const forged = btoa(JSON.stringify({ o: 'org_1', u: 'user_mallory', c: 'call_1', e: Date.now() + 60_000 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await verifyCallRingToken('secret', `${forged}.${sig}`)).toBeNull();
  });

  it('rejects garbage', async () => {
    expect(await verifyCallRingToken('secret', '')).toBeNull();
    expect(await verifyCallRingToken('secret', 'a.b.c')).toBeNull();
    expect(await verifyCallRingToken('secret', 'not-a-token')).toBeNull();
  });
});
