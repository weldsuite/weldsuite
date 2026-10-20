import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { timingSafeEqualStr as sharedTimingSafeEqualStr } from '@weldsuite/db/lib/timing-safe';
import { secretMatches, timingSafeEqualStr, verifyWebhookToken } from './webhook-token';
import * as kit from './index';

/** Runs `verifyWebhookToken` against a real request, as a route would. */
async function check(url: string, expected: string | undefined | null): Promise<boolean> {
  const app = new Hono();
  app.get('/hook', (c) => c.json({ ok: verifyWebhookToken(c, expected) }));
  const res = await app.request(url);
  return ((await res.json()) as { ok: boolean }).ok;
}

describe('verifyWebhookToken', () => {
  it('accepts exactly the configured token', async () => {
    expect(await check('/hook?token=s3cret', 's3cret')).toBe(true);
  });

  it('rejects a wrong, truncated, extended or missing token', async () => {
    expect(await check('/hook?token=wrong', 's3cret')).toBe(false);
    expect(await check('/hook?token=s3cre', 's3cret')).toBe(false);
    expect(await check('/hook?token=s3crets', 's3cret')).toBe(false);
    expect(await check('/hook', 's3cret')).toBe(false);
    expect(await check('/hook?token=', 's3cret')).toBe(false);
  });

  it('is fail-closed when no secret is configured', async () => {
    expect(await check('/hook?token=anything', undefined)).toBe(false);
    expect(await check('/hook?token=anything', null)).toBe(false);
    expect(await check('/hook?token=anything', '')).toBe(false);
    expect(await check('/hook', undefined)).toBe(false);
    expect(await check('/hook?token=', '')).toBe(false);
  });
});

describe('the shared constant-time compare', () => {
  it('is the one implementation in @weldsuite/db, re-exported by the kit', () => {
    expect(timingSafeEqualStr).toBe(sharedTimingSafeEqualStr);
    expect(kit.timingSafeEqualStr).toBe(sharedTimingSafeEqualStr);
    expect(kit.secretMatches).toBe(secretMatches);
    expect(kit.verifyWebhookToken).toBe(verifyWebhookToken);
  });

  it('compares strings of any length', () => {
    expect(timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
    expect(timingSafeEqualStr('', 'abc')).toBe(false);
  });
});
