/**
 * Token refresh on use (services/credentials.ts), on a real tenant schema
 * (pglite) with the providers' token endpoints stubbed. What must not regress:
 *   1. A token that expires within five minutes is refreshed first and the new
 *      credentials replace the stored ones; a token with time left is not.
 *   2. A refresh the provider refuses marks the connection `needs_attention`
 *      (an account loses its credentials and its `verified_at`).
 *   3. A rotated refresh token is kept; an unchanged one stays.
 *   4. An Azure DevOps account is found by member and provider alone.
 *   5. Concurrent refreshes: a refused refresh only drops a link (or flags a
 *      connection) whose credentials are still the ones it read; otherwise it
 *      uses what the other request stored.
 *   6. A refresh does not make an Azure DevOps connection that still waits for
 *      its organisation active.
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

  it('uses the credentials a concurrent refresh stored when its own refresh is refused, and leaves the status alone', async () => {
    const connection = await seedConnection(db, {
      provider: 'gitlab',
      credentials: await sealCredentials(env, { accessToken: 'old', refreshToken: 'r1', expiresAt: inMinutes(1) }),
    });
    const winner = await sealCredentials(env, { accessToken: 'winner', refreshToken: 'r2', expiresAt: inMinutes(120) });
    stubHttp({
      // The other request rotated r1 first and stored its credentials; GitLab refuses this one.
      'POST gitlab.com/oauth/token': async () => {
        await db.update(schema.mergeConnections).set({ credentials: winner }).where(eq(schema.mergeConnections.id, connection.id));
        return failure(400, { error: 'invalid_grant' });
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getConnectionToken(db, env, connection, NOW)).toEqual({ accessToken: 'winner', tokenType: null });
    const [row] = await db.select().from(schema.mergeConnections).where(eq(schema.mergeConnections.id, connection.id));
    expect(row).toMatchObject({ status: 'active', credentials: winner });
  });

  it('keeps a multi-organisation Azure DevOps connection that has no organisation yet needs_attention after a refresh', async () => {
    stubHttp({ 'POST login.microsoftonline.com/organizations/oauth2/v2.0/token': { access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 } });
    const connection = await seedConnection(db, {
      provider: 'azure_devops',
      externalAccountId: 'pending:profile-1',
      accountType: 'user',
      host: null,
      status: 'needs_attention',
      credentials: await sealCredentials(env, { accessToken: 'old', refreshToken: 'r1', expiresAt: inMinutes(1) }),
    });
    expect((await getConnectionToken(db, env, connection, NOW))!.accessToken).toBe('fresh');
    const [row] = await db.select().from(schema.mergeConnections).where(eq(schema.mergeConnections.id, connection.id));
    expect(row!.status).toBe('needs_attention');
    expect(await openStored(row!.credentials)).toMatchObject({ accessToken: 'fresh' });
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

  it('keeps the link a concurrent refresh renewed, and uses its token, when its own refresh is refused', async () => {
    await account();
    const winner = await sealCredentials(env, { accessToken: 'bob-winner', refreshToken: 'br2', expiresAt: inMinutes(120) });
    stubHttp({
      'POST gitlab.com/oauth/token': async () => {
        await db.update(schema.mergeProviderAccounts).set({ credentials: winner }).where(eq(schema.mergeProviderAccounts.id, 'mpa_bob'));
        return failure(400, { error: 'invalid_grant' });
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getMemberToken(db, env, BOB, 'gitlab', null, NOW)).toEqual({ accessToken: 'bob-winner', tokenType: null, login: 'bob-gl' });
    const [row] = await db.select().from(schema.mergeProviderAccounts);
    expect(row).toMatchObject({ credentials: winner, verifiedAt: NOW });
  });

  it('puts the link back when its refresh succeeds after a concurrent, refused one dropped it', async () => {
    await account();
    stubHttp({
      'POST gitlab.com/oauth/token': async () => {
        // The other request's refresh was refused first and dropped the link.
        await db
          .update(schema.mergeProviderAccounts)
          .set({ credentials: null, credentialsExpireAt: null, verifiedAt: null })
          .where(eq(schema.mergeProviderAccounts.id, 'mpa_bob'));
        return { access_token: 'bob-fresh', refresh_token: 'br2', expires_in: 7200 };
      },
    });
    expect((await getMemberToken(db, env, BOB, 'gitlab', null, NOW))!.accessToken).toBe('bob-fresh');
    const [row] = await db.select().from(schema.mergeProviderAccounts);
    expect(row!.verifiedAt).toEqual(NOW);
    expect(await openStored(row!.credentials)).toMatchObject({ accessToken: 'bob-fresh', refreshToken: 'br2' });
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
