/**
 * Token refresh on use (services/credentials.ts), on a real tenant schema
 * (pglite) with the providers' token endpoints stubbed. What must not regress:
 *   1. A token that expires within five minutes is refreshed first and the new
 *      credentials replace the stored ones; a token with time left is not.
 *   2. A refresh the provider refuses marks the connection `needs_attention`
 *      (an account loses its credentials and its `verified_at`).
 *   3. A rotated refresh token is kept; an unchanged one stays.
 *   4. An Azure DevOps account is found by member and provider alone.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../types';
import { getConnectionToken, getMemberToken, needsRefresh, openCredentials, sealCredentials } from './credentials';
import { BOB, openDb, resetTables } from '../test/helpers';
import { failure, stubHttp } from '../test/fake-http';
import { ENCRYPTION_KEY, PROVIDER_ENV } from '../test/provider-env';
import { seedConnection } from '../test/seed';

let db: Database;
const env = PROVIDER_ENV as unknown as Env;
const NOW = new Date('2026-11-05T12:00:00Z');
const inMinutes = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

beforeAll(async () => {
  db = await openDb();
}, 120_000);

beforeEach(async () => {
  await resetTables(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const openStored = (sealed: string | null) => openCredentials({ DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY }, sealed);

describe('needsRefresh', () => {
  it('is true only inside the five-minute window and only with a refresh token', () => {
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: inMinutes(4) }, NOW)).toBe(true);
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: inMinutes(-1) }, NOW)).toBe(true);
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: inMinutes(6) }, NOW)).toBe(false);
    expect(needsRefresh({ accessToken: 'a', expiresAt: inMinutes(1) }, NOW)).toBe(false);
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r' }, NOW)).toBe(false);
  });
});

describe('getConnectionToken', () => {
  it('leaves a token with time left alone', async () => {
    const calls = stubHttp({});
    const connection = await seedConnection(db, {
      provider: 'gitlab',
      credentials: await sealCredentials(env, { accessToken: 'still-good', refreshToken: 'r', expiresAt: inMinutes(60) }),
    });
    expect(await getConnectionToken(db, env, connection, NOW)).toEqual({ accessToken: 'still-good', tokenType: null });
    expect(calls).toEqual([]);
  });

  it('refreshes a GitLab token that is about to expire and stores the new credentials', async () => {
    const calls = stubHttp({
      'POST gitlab.com/oauth/token': { access_token: 'fresh', refresh_token: 'rotated', expires_in: 7200, token_type: 'Bearer' },
    });
    const connection = await seedConnection(db, {
      provider: 'gitlab',
      status: 'needs_attention',
      credentials: await sealCredentials(env, { accessToken: 'old', refreshToken: 'r1', expiresAt: inMinutes(2) }),
    });

    const token = await getConnectionToken(db, env, connection, NOW);
    expect(token).toEqual({ accessToken: 'fresh', tokenType: 'Bearer' });
    expect(calls).toEqual([
      {
        method: 'POST',
        url: 'gitlab.com/oauth/token',
        body: {
          client_id: 'gl-client',
          client_secret: 'gl-secret',
          refresh_token: 'r1',
          grant_type: 'refresh_token',
          redirect_uri: 'https://app.test/weldmerge/oauth/callback',
        },
        auth: undefined,
      },
    ]);

    const [row] = await db.select().from(schema.mergeConnections).where(eq(schema.mergeConnections.id, connection.id));
    expect(row!.status).toBe('active');
    expect(row!.credentialsExpireAt!.getTime()).toBeGreaterThan(Date.now() + 7000 * 1000);
    expect(await openStored(row!.credentials)).toMatchObject({ accessToken: 'fresh', refreshToken: 'rotated' });
  });

  it('keeps the refresh token when the provider does not rotate it (Bitbucket)', async () => {
    stubHttp({ 'POST bitbucket.org/site/oauth2/access_token': { access_token: 'fresh', expires_in: 7200, token_type: 'bearer' } });
    const connection = await seedConnection(db, {
      provider: 'bitbucket',
      credentials: await sealCredentials(env, { accessToken: 'old', refreshToken: 'keep-me', expiresAt: inMinutes(1) }),
    });
    expect((await getConnectionToken(db, env, connection, NOW))!.accessToken).toBe('fresh');
    const [row] = await db.select().from(schema.mergeConnections).where(eq(schema.mergeConnections.id, connection.id));
    expect(await openStored(row!.credentials)).toMatchObject({ accessToken: 'fresh', refreshToken: 'keep-me' });
  });

  it('marks the connection needs_attention and answers null when the refresh is refused', async () => {
    stubHttp({ 'POST login.microsoftonline.com/organizations/oauth2/v2.0/token': failure(400, { error: 'invalid_grant', error_description: 'revoked' }) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const connection = await seedConnection(db, {
      provider: 'azure_devops',
      host: 'https://dev.azure.com/acme',
      credentials: await sealCredentials(env, { accessToken: 'old', refreshToken: 'r1', expiresAt: inMinutes(1) }),
    });
    expect(await getConnectionToken(db, env, connection, NOW)).toBeNull();
    const [row] = await db.select().from(schema.mergeConnections).where(eq(schema.mergeConnections.id, connection.id));
    expect(row!.status).toBe('needs_attention');
    // The old credentials stay: a later retry may still work.
    expect(await openStored(row!.credentials)).toMatchObject({ accessToken: 'old' });
  });

  it('answers null for a connection without credentials (GitHub)', async () => {
    const connection = await seedConnection(db, { provider: 'github' });
    expect(await getConnectionToken(db, env, connection, NOW)).toBeNull();
  });
});

describe('getMemberToken', () => {
  const account = async (overrides: Partial<typeof schema.mergeProviderAccounts.$inferInsert> = {}) => {
    await db.insert(schema.mergeProviderAccounts).values({
      id: 'mpa_bob',
      userId: BOB,
      provider: 'gitlab',
      login: 'bob-gl',
      verifiedAt: NOW,
      credentials: await sealCredentials(env, { accessToken: 'bob-old', refreshToken: 'br1', expiresAt: inMinutes(2) }),
      ...overrides,
    });
  };

  it('refreshes the member\'s token and stores it', async () => {
    stubHttp({ 'POST gitlab.com/oauth/token': { access_token: 'bob-fresh', refresh_token: 'br2', expires_in: 7200 } });
    await account();
    expect(await getMemberToken(db, env, BOB, 'gitlab', null, NOW)).toEqual({ accessToken: 'bob-fresh', tokenType: null, login: 'bob-gl' });
    const [row] = await db.select().from(schema.mergeProviderAccounts);
    expect(await openStored(row!.credentials)).toMatchObject({ accessToken: 'bob-fresh', refreshToken: 'br2' });
    expect(row!.credentialsExpireAt).not.toBeNull();
  });

  it('drops the credentials and the verification when the refresh is refused: the member links again', async () => {
    stubHttp({ 'POST gitlab.com/oauth/token': failure(401, { error: 'invalid_grant' }) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await account();
    expect(await getMemberToken(db, env, BOB, 'gitlab', null, NOW)).toBeNull();
    const [row] = await db.select().from(schema.mergeProviderAccounts);
    expect(row).toMatchObject({ credentials: null, verifiedAt: null, login: 'bob-gl' });
    expect(await getMemberToken(db, env, BOB, 'gitlab', null, NOW)).toBeNull();
  });

  it('answers null for a typed (unverified) login and for no account', async () => {
    await account({ verifiedAt: null });
    expect(await getMemberToken(db, env, BOB, 'gitlab', null, NOW)).toBeNull();
    expect(await getMemberToken(db, env, 'user_nobody', 'gitlab', null, NOW)).toBeNull();
  });

  it('matches a self-managed GitLab account by host, and an Azure DevOps account by member alone', async () => {
    await account({ host: 'https://git.example.com', credentials: await sealCredentials(env, { accessToken: 'self' }) });
    expect(await getMemberToken(db, env, BOB, 'gitlab', null, NOW)).toBeNull();
    expect((await getMemberToken(db, env, BOB, 'gitlab', 'https://git.example.com', NOW))!.accessToken).toBe('self');

    await db.insert(schema.mergeProviderAccounts).values({
      id: 'mpa_az',
      userId: BOB,
      provider: 'azure_devops',
      login: 'bob@acme.com',
      verifiedAt: NOW,
      credentials: await sealCredentials(env, { accessToken: 'az-bob' }),
    });
    expect((await getMemberToken(db, env, BOB, 'azure_devops', 'https://dev.azure.com/acme', NOW))!.accessToken).toBe('az-bob');
  });
});
