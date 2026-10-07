/**
 * Token resolution + refresh — exercised through a Google-typed integration
 * (google_sheets), the first provider in the catalog whose access token
 * actually expires (Slack bot tokens never do). See "Provider pattern" in
 * docs/plans/weldconnect.md.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getValidIntegrationToken } from './token';
import { makeActionContext } from '../../../test/ctx';
import { createPgliteDb } from '../../../test/pglite';
import { schema, type Database } from '../../../db';
import { generateId } from '../../../lib/id';
import { NonRetryableStepError } from '../../errors';

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getValidIntegrationToken: Google OAuth refresh', () => {
  let db: Database;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    await db.insert(schema.workspaceMembers).values({ id: 'wm_owner_1', userId: 'owner_1' });
  });

  async function seedGoogleSheets(overrides: { expiresAt?: string; refreshToken?: string } = {}): Promise<string> {
    const id = generateId('win');
    await db.insert(schema.workflowIntegrations).values({
      id,
      name: 'Google Sheets',
      type: 'google_sheets',
      status: 'connected',
      oauthTokens: {
        accessToken: 'ya29-old',
        refreshToken: overrides.refreshToken ?? 'refresh-token-1',
        expiresAt: overrides.expiresAt,
      },
    });
    return id;
  }

  const env = { GOOGLE_CLIENT_ID: 'google-client-id', GOOGLE_CLIENT_SECRET: 'google-client-secret' };

  it('returns the stored token unchanged when it is not near expiry', async () => {
    const id = await seedGoogleSheets({ expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const { mock } = stubFetch(() => new Response('{}'));
    const result = await getValidIntegrationToken(makeActionContext({ db, env }), { integrationId: id });
    expect(result.accessToken).toBe('ya29-old');
    expect(mock).not.toHaveBeenCalled();
  });

  it('refreshes a token that is within the refresh window and persists the new one', async () => {
    const id = await seedGoogleSheets({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const { calls } = stubFetch((url) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      return new Response(JSON.stringify({ access_token: 'ya29-new', expires_in: 3600 }), { status: 200 });
    });

    const result = await getValidIntegrationToken(makeActionContext({ db, env }), { integrationId: id });
    expect(result.accessToken).toBe('ya29-new');
    const body = new URLSearchParams(String(calls[0].init?.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-token-1');
    expect(body.get('client_id')).toBe('google-client-id');
    expect(body.get('client_secret')).toBe('google-client-secret');

    const [row] = await db.select().from(schema.workflowIntegrations).where(eq(schema.workflowIntegrations.id, id));
    const tokens = row.oauthTokens as { accessToken: string; refreshToken: string };
    expect(tokens.accessToken).toBe('ya29-new');
    expect(tokens.refreshToken).toBe('refresh-token-1');
  });

  it('does not refresh when no expiresAt is stored at all (unknown expiry, not treated as expiring)', async () => {
    const id = await seedGoogleSheets({ expiresAt: undefined });
    const { mock } = stubFetch(() => new Response('{}'));
    const result = await getValidIntegrationToken(makeActionContext({ db, env }), { integrationId: id });
    expect(result.accessToken).toBe('ya29-old');
    expect(mock).not.toHaveBeenCalled();
  });

  it('maps a revoked refresh token (invalid_grant) to a non-retryable reconnect error', async () => {
    const id = await seedGoogleSheets({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    stubFetch(() => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    const promise = getValidIntegrationToken(makeActionContext({ db, env }), { integrationId: id });
    await expect(promise).rejects.toThrow(NonRetryableStepError);
    await expect(promise).rejects.toThrow(/reconnect/i);
  });

  it('leaves a transient refresh failure retryable', async () => {
    const id = await seedGoogleSheets({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    stubFetch(() => new Response(JSON.stringify({ error: 'server_error' }), { status: 500 }));
    const promise = getValidIntegrationToken(makeActionContext({ db, env }), { integrationId: id });
    await expect(promise).rejects.not.toThrow(NonRetryableStepError);
  });
});
