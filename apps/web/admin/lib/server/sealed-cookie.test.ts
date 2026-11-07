import { describe, expect, it } from 'vitest';
import { cookieHeader, open, readCookie, seal } from './sealed-cookie';

const SECRET = 's'.repeat(32);
const NAME = '__Host-admin_session';
const NOW = Date.parse('2026-11-07T12:00:00Z');

describe('seal and open', () => {
  it('opens what it sealed', async () => {
    const value = await seal(SECRET, NAME, { sub: 'u1' }, 60, NOW);
    await expect(open(SECRET, NAME, value, NOW)).resolves.toEqual({ sub: 'u1' });
  });

  it('refuses a value with any byte changed', async () => {
    const value = await seal(SECRET, NAME, { sub: 'u1' }, 60, NOW);
    for (const at of [0, 10, value.length - 1]) {
      const flipped = value.slice(0, at) + (value[at] === 'A' ? 'B' : 'A') + value.slice(at + 1);
      await expect(open(SECRET, NAME, flipped, NOW)).resolves.toBeNull();
    }
  });

  it('refuses a value sealed for another cookie', async () => {
    const flow = await seal(SECRET, '__Host-admin_oidc', { sub: 'u1' }, 60, NOW);
    await expect(open(SECRET, NAME, flow, NOW)).resolves.toBeNull();
  });

  it('refuses a value sealed with another secret', async () => {
    const value = await seal('t'.repeat(32), NAME, { sub: 'u1' }, 60, NOW);
    await expect(open(SECRET, NAME, value, NOW)).resolves.toBeNull();
  });

  it('refuses an expired value, whatever the cookie said', async () => {
    const value = await seal(SECRET, NAME, { sub: 'u1' }, 60, NOW);
    await expect(open(SECRET, NAME, value, NOW + 59_000)).resolves.toEqual({ sub: 'u1' });
    await expect(open(SECRET, NAME, value, NOW + 60_000)).resolves.toBeNull();
  });

  it('refuses missing and malformed values', async () => {
    for (const value of [undefined, '', 'not base64!', 'AAAA', 'eyJzdWIiOiJ1MSJ9']) {
      await expect(open(SECRET, NAME, value, NOW)).resolves.toBeNull();
    }
  });

  it('will not work with a short secret', async () => {
    await expect(seal('short', NAME, {}, 60)).rejects.toThrow(/at least 32/);
    await expect(open('short', NAME, 'x')).rejects.toThrow(/at least 32/);
  });
});

describe('readCookie', () => {
  it('finds a cookie among others', () => {
    expect(readCookie('a=1; __Host-admin_session=abc; b=2', NAME)).toBe('abc');
    expect(readCookie('a=1', NAME)).toBeUndefined();
    expect(readCookie(null, NAME)).toBeUndefined();
  });
});

describe('cookieHeader', () => {
  it('sets the attributes a __Host- cookie needs', () => {
    expect(cookieHeader(NAME, 'v', 60)).toBe('__Host-admin_session=v; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax');
  });
});
