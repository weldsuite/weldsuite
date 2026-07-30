import { describe, expect, it, vi } from 'vitest';
import type { OAuthTokens } from '@weldsuite/db/schema';
import { ConnectorApiError } from './errors';
import { getValidAccessToken, REFRESH_LOCK_TTL_MS, type ConnectionTokenStore } from './token';
import type { ConnectorDriver } from './types';

/**
 * The point of these tests is the concurrency behaviour, not the happy path.
 *
 * The failure they exist to catch: two workers refreshing the same connection at
 * once against a provider that rotates refresh tokens. The second call presents a
 * token the first one just invalidated, the provider rejects it, and the
 * connection is flagged `auth_error` even though nothing was wrong.
 */

function makeDriver(overrides: Partial<ConnectorDriver> = {}): ConnectorDriver {
  return {
    connectorId: 'test',
    supportedEntities: ['customer'],
    authModes: ['oauth2'],
    oauth2: {
      authorizeUrl: 'https://provider.example/oauth/authorize',
      tokenUrl: 'https://provider.example/oauth/token',
    },
    fetchEntities: vi.fn(),
    fetchEntity: vi.fn(),
    ...overrides,
  };
}

/**
 * In-memory store with a genuinely atomic lease claim, mirroring the single
 * conditional UPDATE the real implementation uses. A test double that read then
 * wrote would pass even if production had the race.
 */
function makeStore(initial: OAuthTokens | null) {
  let tokens = initial;
  let lockUntil: number | null = null;
  const calls = { claims: 0, saves: 0, reloads: 0, authErrors: 0, releases: 0 };
  let now = 1_000_000;

  const store: ConnectionTokenStore = {
    async claimRefreshLock(_id, leaseUntil) {
      calls.claims++;
      if (lockUntil !== null && lockUntil > now) return false;
      lockUntil = leaseUntil.getTime();
      return true;
    },
    async releaseRefreshLock() {
      calls.releases++;
      lockUntil = null;
    },
    async saveTokens(_id, next) {
      calls.saves++;
      tokens = next;
      lockUntil = null;
    },
    async reloadTokens() {
      calls.reloads++;
      return tokens;
    },
    async markAuthError() {
      calls.authErrors++;
    },
  };

  return {
    store,
    calls,
    get tokens() {
      return tokens;
    },
    get lockUntil() {
      return lockUntil;
    },
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

const EXPIRED: OAuthTokens = {
  accessToken: 'stale-access',
  refreshToken: 'refresh-1',
  expiresAt: new Date(1_000_000 - 10_000).toISOString(),
  tokenType: 'Bearer',
};

const CREDENTIALS = { clientId: 'id', clientSecret: 'secret' };

describe('getValidAccessToken', () => {
  it('returns the stored token untouched when it is not close to expiry', async () => {
    const harness = makeStore({
      accessToken: 'fresh',
      refreshToken: 'r',
      expiresAt: new Date(harnessNow() + 60 * 60 * 1000).toISOString(),
    });

    const token = await getValidAccessToken({
      connection: { id: 'c1', connectorId: 'test', authMode: 'oauth2', oauthTokens: harness.tokens },
      driver: makeDriver(),
      store: harness.store,
      credentials: CREDENTIALS,
      now: harness.now,
    });

    expect(token).toBe('fresh');
    // No lease taken: refreshing a valid token would be pure provider load.
    expect(harness.calls.claims).toBe(0);
  });

  it('never refreshes an api_token connection', async () => {
    // A pasted token has no expiry and no refresh grant. Attempting one would
    // fail against every provider.
    const harness = makeStore({ accessToken: 'pasted', expiresAt: undefined });
    const refresh = vi.fn();

    const token = await getValidAccessToken({
      connection: {
        id: 'c1',
        connectorId: 'test',
        authMode: 'api_token',
        oauthTokens: harness.tokens,
      },
      driver: makeDriver({ refreshAccessToken: refresh, authModes: ['api_token'] }),
      store: harness.store,
      now: harness.now,
    });

    expect(token).toBe('pasted');
    expect(refresh).not.toHaveBeenCalled();
    expect(harness.calls.claims).toBe(0);
  });

  it('refreshes once and persists the rotated pair', async () => {
    const harness = makeStore(EXPIRED);
    const refresh = vi.fn(async () => ({
      accessToken: 'new-access',
      refreshToken: 'refresh-2',
      expiresAt: new Date(harness.now() + 3600_000).toISOString(),
      tokenType: 'Bearer',
    }));

    const token = await getValidAccessToken({
      connection: { id: 'c1', connectorId: 'test', authMode: 'oauth2', oauthTokens: EXPIRED },
      driver: makeDriver({ refreshAccessToken: refresh }),
      store: harness.store,
      credentials: CREDENTIALS,
      now: harness.now,
    });

    expect(token).toBe('new-access');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(harness.tokens?.refreshToken).toBe('refresh-2');
    // Lease released as part of the save, not left dangling.
    expect(harness.lockUntil).toBeNull();
  });

  it('keeps the old refresh token when the provider does not rotate', async () => {
    // Persisting `undefined` here would strand the connection at the next expiry
    // with no way to refresh again.
    const harness = makeStore(EXPIRED);
    const refresh = vi.fn(async () => ({
      accessToken: 'new-access',
      refreshToken: undefined,
      expiresAt: new Date(harness.now() + 3600_000).toISOString(),
    }));

    await getValidAccessToken({
      connection: { id: 'c1', connectorId: 'test', authMode: 'oauth2', oauthTokens: EXPIRED },
      driver: makeDriver({ refreshAccessToken: refresh }),
      store: harness.store,
      credentials: CREDENTIALS,
      now: harness.now,
    });

    expect(harness.tokens?.refreshToken).toBe('refresh-1');
  });

  it('serialises concurrent refreshes — exactly one provider call', async () => {
    // The regression this file exists for.
    const harness = makeStore(EXPIRED);
    let inFlight = 0;
    let maxInFlight = 0;

    const refresh = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return {
        accessToken: 'new-access',
        refreshToken: 'refresh-2',
        expiresAt: new Date(harness.now() + 3600_000).toISOString(),
      };
    });

    const driver = makeDriver({ refreshAccessToken: refresh });
    const args = {
      connection: {
        id: 'c1',
        connectorId: 'test',
        authMode: 'oauth2' as const,
        oauthTokens: EXPIRED,
      },
      driver,
      store: harness.store,
      credentials: CREDENTIALS,
      now: harness.now,
      // Shortened, but a real timer: the losers have to actually yield past the
      // winner's in-flight refresh. A no-op sleep would burn all six polls in
      // microtasks and time out before the winner ever resolved.
      sleep: (_ms: number) => new Promise<void>((resolve) => setTimeout(resolve, 5)),
    };

    const results = await Promise.all([
      getValidAccessToken(args),
      getValidAccessToken(args),
      getValidAccessToken(args),
    ]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBe(1);
    // Every caller ends up with the winner's token rather than a stale one.
    expect(results).toEqual(['new-access', 'new-access', 'new-access']);
  });

  it('gives up rather than refreshing in parallel when the lease holder stalls', async () => {
    const harness = makeStore(EXPIRED);
    // Someone else holds the lease and never finishes.
    await harness.store.claimRefreshLock('c1', new Date(harness.now() + REFRESH_LOCK_TTL_MS));
    const refresh = vi.fn();

    await expect(
      getValidAccessToken({
        connection: { id: 'c1', connectorId: 'test', authMode: 'oauth2', oauthTokens: EXPIRED },
        driver: makeDriver({ refreshAccessToken: refresh }),
        store: harness.store,
        credentials: CREDENTIALS,
        now: harness.now,
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ kind: 'transient' });

    // The whole point: it waited and then failed instead of racing.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('takes over an abandoned lease once its TTL has passed', async () => {
    // A worker that died mid-refresh must not wedge the connection forever.
    const harness = makeStore(EXPIRED);
    await harness.store.claimRefreshLock('c1', new Date(harness.now() + REFRESH_LOCK_TTL_MS));
    harness.advance(REFRESH_LOCK_TTL_MS + 1);

    const refresh = vi.fn(async () => ({
      accessToken: 'recovered',
      refreshToken: 'refresh-2',
      expiresAt: new Date(harness.now() + 3600_000).toISOString(),
    }));

    const token = await getValidAccessToken({
      connection: { id: 'c1', connectorId: 'test', authMode: 'oauth2', oauthTokens: EXPIRED },
      driver: makeDriver({ refreshAccessToken: refresh }),
      store: harness.store,
      credentials: CREDENTIALS,
      now: harness.now,
    });

    expect(token).toBe('recovered');
  });

  it('flags the connection and releases the lease when a refresh is rejected', async () => {
    const harness = makeStore(EXPIRED);
    const refresh = vi.fn(async () => {
      throw new ConnectorApiError({
        message: 'invalid_grant',
        status: 400,
        kind: 'auth',
      });
    });

    await expect(
      getValidAccessToken({
        connection: { id: 'c1', connectorId: 'test', authMode: 'oauth2', oauthTokens: EXPIRED },
        driver: makeDriver({ refreshAccessToken: refresh }),
        store: harness.store,
        credentials: CREDENTIALS,
        now: harness.now,
      }),
    ).rejects.toMatchObject({ kind: 'auth' });

    expect(harness.calls.authErrors).toBe(1);
    // A held lease after a failure would block every later attempt for the TTL.
    expect(harness.lockUntil).toBeNull();
  });

  it('throws auth rather than returning a stale token when there is nothing to refresh with', async () => {
    // The previous implementation returned the expired token "so the caller can
    // still try", which turned one clear error into an opaque 401 per record.
    const harness = makeStore({ accessToken: 'stale', expiresAt: EXPIRED.expiresAt });

    await expect(
      getValidAccessToken({
        connection: {
          id: 'c1',
          connectorId: 'test',
          authMode: 'oauth2',
          oauthTokens: harness.tokens,
        },
        driver: makeDriver(),
        store: harness.store,
        credentials: CREDENTIALS,
        now: harness.now,
      }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('reports missing client credentials as our problem, not the tenant’s', async () => {
    // `permanent`, not `auth` — telling the tenant to reauthorise because our own
    // Worker secret is unset sends them chasing a fault they cannot fix.
    const harness = makeStore(EXPIRED);

    await expect(
      getValidAccessToken({
        connection: { id: 'c1', connectorId: 'test', authMode: 'oauth2', oauthTokens: EXPIRED },
        driver: makeDriver(),
        store: harness.store,
        credentials: null,
        now: harness.now,
      }),
    ).rejects.toMatchObject({ kind: 'permanent' });

    expect(harness.calls.authErrors).toBe(0);
  });
});

function harnessNow(): number {
  return 1_000_000;
}
