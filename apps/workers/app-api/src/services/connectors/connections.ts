/**
 * Connection lifecycle and credential storage.
 *
 * Tokens are encrypted at rest with the workspace encryption keyring and only
 * decrypted inside `resolveDriverContext`, immediately before a driver call. No
 * route selects `oauth_tokens` into a response.
 *
 * The refresh lease lives here rather than in `@weldsuite/connectors` because
 * only this layer has the tenant database. The package owns the *policy* — when
 * to refresh, how long to wait when someone else is refreshing — and calls back
 * through `ConnectionTokenStore`.
 */

import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  getDriver,
  getValidAccessToken,
  getConnector,
  resolveClientCredentials,
  signState,
  syncRemoveSyncIndex,
  syncUpsertSyncIndex,
  ConnectorApiError,
  type ConnectionTokenStore,
  type ConnectorDriver,
  type DriverContext,
  type ConnectorDef,
  type SyncIndexSync,
} from '@weldsuite/connectors';
import type { ConnectorAuthMode, ConnectorConnection, OAuthTokens } from '@weldsuite/db/schema';
import {
  encryptField,
  keyringFromEnv,
  maybeDecryptField,
  type EncryptionKeyring,
} from '@weldsuite/db/lib/crypto';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

// ============================================================================
// Encryption
// ============================================================================

/**
 * Columns safe to return to a client.
 *
 * Written as an explicit projection rather than `select()` minus a field,
 * because a `select()` would start leaking any credential column added later.
 */
export const PUBLIC_CONNECTION_COLUMNS = {
  id: schema.connectorConnections.id,
  connectorId: schema.connectorConnections.connectorId,
  authMode: schema.connectorConnections.authMode,
  displayName: schema.connectorConnections.displayName,
  status: schema.connectorConnections.status,
  scopes: schema.connectorConnections.scopes,
  externalAccountId: schema.connectorConnections.externalAccountId,
  enabledEntities: schema.connectorConnections.enabledEntities,
  syncWatermarks: schema.connectorConnections.syncWatermarks,
  syncIntervalHours: schema.connectorConnections.syncIntervalHours,
  lastSyncAt: schema.connectorConnections.lastSyncAt,
  lastSyncStatus: schema.connectorConnections.lastSyncStatus,
  lastError: schema.connectorConnections.lastError,
  lastErrorAt: schema.connectorConnections.lastErrorAt,
  recordsSynced: schema.connectorConnections.recordsSynced,
  connectedAt: schema.connectorConnections.connectedAt,
  connectedBy: schema.connectorConnections.connectedBy,
  createdAt: schema.connectorConnections.createdAt,
  updatedAt: schema.connectorConnections.updatedAt,
} as const;

interface CryptoEnv {
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
}

function hasKeys(keyring: EncryptionKeyring): boolean {
  return Boolean(keyring.v1 || keyring.v2);
}

/**
 * Encrypt the secret-bearing fields of a token bundle.
 *
 * `expiresAt` and `tokenType` stay plaintext: the refresh decision reads
 * `expiresAt` on every call, and encrypting a value we must always decrypt buys
 * nothing while making the expiry unqueryable from SQL.
 */
async function encryptTokens(tokens: OAuthTokens, keyring: EncryptionKeyring): Promise<OAuthTokens> {
  if (!hasKeys(keyring)) return tokens;
  return {
    ...tokens,
    accessToken: await encryptField(tokens.accessToken, keyring),
    refreshToken: tokens.refreshToken ? await encryptField(tokens.refreshToken, keyring) : undefined,
  };
}

async function decryptTokens(
  tokens: OAuthTokens | null,
  keyring: EncryptionKeyring,
): Promise<OAuthTokens | null> {
  if (!tokens) return null;
  if (!hasKeys(keyring)) return tokens;
  return {
    ...tokens,
    accessToken: await maybeDecryptField(tokens.accessToken, keyring),
    refreshToken: tokens.refreshToken ? await maybeDecryptField(tokens.refreshToken, keyring) : undefined,
  };
}

// ============================================================================
// Token store
// ============================================================================

/**
 * Persistence for the refresh lease.
 *
 * `claimRefreshLock` is one statement on purpose. A read-then-write version
 * would let two workers both observe a free lease and both refresh, which is the
 * exact race the lease exists to prevent — and against a provider that rotates
 * refresh tokens, the loser's token is already dead by the time it is used.
 */
export function createTokenStore(db: Database, keyring: EncryptionKeyring): ConnectionTokenStore {
  const table = schema.connectorConnections;

  return {
    async claimRefreshLock(connectionId, leaseUntil) {
      const claimed = await db
        .update(table)
        .set({ refreshLockUntil: leaseUntil, updatedAt: new Date() })
        .where(
          and(
            eq(table.id, connectionId),
            or(isNull(table.refreshLockUntil), lt(table.refreshLockUntil, sql`now()`)),
          ),
        )
        .returning({ id: table.id });
      return claimed.length === 1;
    },

    async releaseRefreshLock(connectionId) {
      await db
        .update(table)
        .set({ refreshLockUntil: null, updatedAt: new Date() })
        .where(eq(table.id, connectionId));
    },

    async saveTokens(connectionId, tokens) {
      await db
        .update(table)
        .set({
          oauthTokens: await encryptTokens(tokens, keyring),
          refreshLockUntil: null,
          status: 'active',
          updatedAt: new Date(),
        })
        .where(eq(table.id, connectionId));
    },

    async reloadTokens(connectionId) {
      const [row] = await db
        .select({ oauthTokens: table.oauthTokens })
        .from(table)
        .where(eq(table.id, connectionId))
        .limit(1);
      return decryptTokens(row?.oauthTokens ?? null, keyring);
    },

    async markAuthError(connectionId, message) {
      await db
        .update(table)
        .set({
          status: 'auth_error',
          lastError: message,
          lastErrorAt: new Date(),
          refreshLockUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(table.id, connectionId));
    },
  };
}

// ============================================================================
// Driver context
// ============================================================================

/**
 * Build the context a driver call needs, refreshing the access token first when
 * it is close to expiry. Every driver invocation goes through here, so no driver
 * ever sees a stale token or has to refresh one itself.
 */
export async function resolveDriverContext(args: {
  db: Database;
  connection: ConnectorConnection;
  driver: ConnectorDriver;
  env: CryptoEnv & Record<string, unknown>;
}): Promise<DriverContext> {
  const keyring = keyringFromEnv(args.env);
  const tokens = await decryptTokens(args.connection.oauthTokens, keyring);

  const accessToken = await getValidAccessToken({
    connection: {
      id: args.connection.id,
      connectorId: args.connection.connectorId,
      authMode: args.connection.authMode,
      oauthTokens: tokens,
    },
    driver: args.driver,
    store: createTokenStore(args.db, keyring),
    credentials: resolveClientCredentials(args.connection.connectorId, args.env),
  });

  return {
    accessToken,
    authMode: args.connection.authMode,
    externalAccountId: args.connection.externalAccountId,
    settings: args.connection.settings,
  };
}

// ============================================================================
// Connect lifecycle
// ============================================================================

function requireConnector(connectorId: string): ConnectorDef {
  const connector = getConnector(connectorId);
  if (!connector) {
    throw new ConnectorApiError({
      message: `Unknown connector: ${connectorId}`,
      status: 404,
      kind: 'permanent',
    });
  }
  return connector;
}

/**
 * Reuse the existing row for a connector, or create a fresh pending one.
 *
 * `connector_connections` is unique on `connector_id`, so reconnecting updates
 * rather than inserting. That is what keeps every `integration_entity_mappings`
 * row valid across a reauthorisation — a new row would orphan the mappings and
 * re-import everything as duplicates.
 */
async function upsertPendingConnection(args: {
  db: Database;
  connectorId: string;
  authMode: ConnectorAuthMode;
  userId: string;
}): Promise<ConnectorConnection> {
  const table = schema.connectorConnections;
  const connector = requireConnector(args.connectorId);

  const [existing] = await findConnectionByConnector(args.db, args.connectorId);
  if (existing) {
    const [updated] = await args.db
      .update(table)
      .set({
        authMode: args.authMode,
        status: 'pending',
        deletedAt: null,
        disconnectedAt: null,
        lastError: null,
        lastErrorAt: null,
        updatedAt: new Date(),
      })
      .where(eq(table.id, existing.id))
      .returning();
    if (!updated) {
      throw new ConnectorApiError({
        message: `Failed to reset connection ${existing.id}`,
        status: 500,
        kind: 'transient',
      });
    }
    return updated;
  }

  const [created] = await args.db
    .insert(table)
    .values({
      id: generateId('ccn'),
      connectorId: args.connectorId,
      authMode: args.authMode,
      displayName: connector.label,
      status: 'pending',
      connectedBy: args.userId,
    })
    .returning();

  if (!created) {
    throw new ConnectorApiError({
      message: `Failed to create a connection for ${args.connectorId}`,
      status: 500,
      kind: 'transient',
    });
  }
  return created;
}

/**
 * The connector's row, live or soft-deleted.
 *
 * Deliberately not filtered on `deleted_at`: the unique index covers every row,
 * so a soft-deleted connection still occupies the slot and reconnecting has to
 * revive it rather than insert alongside it.
 */
function findConnectionByConnector(db: Database, connectorId: string) {
  return db
    .select()
    .from(schema.connectorConnections)
    .where(eq(schema.connectorConnections.connectorId, connectorId))
    .limit(1);
}

/**
 * Begin an OAuth connect. Returns the provider URL to send the browser to.
 *
 * The `state` is HMAC-signed and carries the workspace, connector, user and the
 * pending connection id, so the public callback can authenticate itself without
 * server-side session storage.
 */
export async function startOAuthConnect(args: {
  db: Database;
  connectorId: string;
  workspaceId: string;
  userId: string;
  redirectUri: string;
  env: Record<string, unknown> & { CONNECTOR_STATE_SECRET?: string };
}): Promise<{ connection: ConnectorConnection; authorizeUrl: string }> {
  const connector = requireConnector(args.connectorId);
  const credentials = resolveClientCredentials(args.connectorId, args.env);
  if (!credentials) {
    throw new ConnectorApiError({
      message: `No OAuth client credentials configured for ${args.connectorId}`,
      status: 503,
      kind: 'permanent',
    });
  }

  const stateSecret = args.env.CONNECTOR_STATE_SECRET;
  if (!stateSecret) {
    // Fail closed. An unsigned state would let anyone hit the public callback
    // with a connector id and a code of their choosing.
    throw new ConnectorApiError({
      message: 'CONNECTOR_STATE_SECRET is not configured',
      status: 503,
      kind: 'permanent',
    });
  }

  const connection = await upsertPendingConnection({
    db: args.db,
    connectorId: args.connectorId,
    authMode: 'oauth2',
    userId: args.userId,
  });

  const driver = requireDriverOAuth(args.connectorId);
  const state = await signState(
    {
      workspaceId: args.workspaceId,
      connectorId: args.connectorId,
      userId: args.userId,
      connectionId: connection.id,
    },
    stateSecret,
  );

  return {
    connection,
    authorizeUrl: buildAuthorizeUrl({
      config: driver.oauth2,
      clientId: credentials.clientId,
      redirectUri: args.redirectUri,
      scopes: connector.scopes,
      state,
    }),
  };
}

type OAuthCapableDriver = ConnectorDriver & { oauth2: NonNullable<ConnectorDriver['oauth2']> };

function requireDriverOAuth(connectorId: string): OAuthCapableDriver {
  const driver = getDriver(connectorId);
  if (!driver.oauth2) {
    throw new ConnectorApiError({
      message: `Connector ${connectorId} does not support OAuth`,
      status: 400,
      kind: 'permanent',
    });
  }
  return driver as OAuthCapableDriver;
}

/**
 * Finish an OAuth connect: exchange the code, resolve the provider account, and
 * activate the connection.
 */
export async function completeOAuthConnect(args: {
  db: Database;
  driver: ConnectorDriver;
  connectionId: string;
  workspaceId: string;
  code: string;
  redirectUri: string;
  env: CryptoEnv & Record<string, unknown>;
}): Promise<ConnectorConnection> {
  const credentials = resolveClientCredentials(args.driver.connectorId, args.env);
  if (!credentials) {
    throw new ConnectorApiError({
      message: `No OAuth client credentials configured for ${args.driver.connectorId}`,
      status: 503,
      kind: 'permanent',
    });
  }
  if (!args.driver.oauth2) {
    throw new ConnectorApiError({
      message: `Connector ${args.driver.connectorId} does not support OAuth`,
      status: 400,
      kind: 'permanent',
    });
  }

  const tokens = args.driver.exchangeCodeForTokens
    ? await args.driver.exchangeCodeForTokens(credentials, args.code, args.redirectUri)
    : await exchangeAuthorizationCode({
        config: args.driver.oauth2,
        credentials,
        code: args.code,
        redirectUri: args.redirectUri,
        connectorId: args.driver.connectorId,
      });

  return activateConnection({
    db: args.db,
    driver: args.driver,
    connectionId: args.connectionId,
    authMode: 'oauth2',
    tokens,
    workspaceId: args.workspaceId,
    env: args.env,
  });
}

/**
 * Connect with a tenant-supplied API token.
 *
 * The token is validated by actually calling the provider — `fetchAccountIdentity`
 * both proves it works and resolves the account the connection addresses. A
 * pasted token that turns out to be wrong therefore fails at connect time rather
 * than silently producing an empty sync six hours later.
 */
export async function connectWithApiToken(args: {
  db: Database;
  driver: ConnectorDriver;
  workspaceId: string;
  userId: string;
  apiToken: string;
  settings?: Record<string, unknown> | null;
  env: CryptoEnv & Record<string, unknown>;
}): Promise<ConnectorConnection> {
  if (!args.driver.authModes.includes('api_token')) {
    throw new ConnectorApiError({
      message: `Connector ${args.driver.connectorId} does not support API token auth`,
      status: 400,
      kind: 'permanent',
    });
  }

  const connection = await upsertPendingConnection({
    db: args.db,
    connectorId: args.driver.connectorId,
    authMode: 'api_token',
    userId: args.userId,
  });

  if (args.settings) {
    await args.db
      .update(schema.connectorConnections)
      .set({ settings: args.settings, updatedAt: new Date() })
      .where(eq(schema.connectorConnections.id, connection.id));
  }

  return activateConnection({
    db: args.db,
    driver: args.driver,
    connectionId: connection.id,
    authMode: 'api_token',
    tokens: { accessToken: args.apiToken, tokenType: 'Bearer' },
    settings: args.settings ?? null,
    workspaceId: args.workspaceId,
    env: args.env,
  });
}

/**
 * Store credentials, resolve the provider account, mark the connection active.
 *
 * `fetchAccountIdentity` runs before the row is activated because several
 * providers cannot be called at all without the account id — Moneybird addresses
 * every endpoint under an administration. Activating first and resolving later
 * would leave a connection that looks healthy and fails on every sync.
 */
async function activateConnection(args: {
  db: Database;
  driver: ConnectorDriver;
  connectionId: string;
  authMode: ConnectorAuthMode;
  tokens: OAuthTokens;
  settings?: Record<string, unknown> | null;
  /** Clerk org id — stamped on the D1 index rows so dispatch needs no tenant read. */
  workspaceId: string;
  env: CryptoEnv & Record<string, unknown>;
}): Promise<ConnectorConnection> {
  const keyring = keyringFromEnv(args.env);
  const connector = requireConnector(args.driver.connectorId);

  let externalAccountId: string | null = null;
  let displayName: string | null = connector.label;

  if (args.driver.fetchAccountIdentity) {
    const identity = await args.driver.fetchAccountIdentity({
      accessToken: args.tokens.accessToken,
      authMode: args.authMode,
      settings: args.settings ?? null,
    });
    externalAccountId = identity.externalAccountId;
    if (identity.displayName) displayName = `${connector.label} — ${identity.displayName}`;
  }

  const [updated] = await args.db
    .update(schema.connectorConnections)
    .set({
      authMode: args.authMode,
      oauthTokens: await encryptTokens(args.tokens, keyring),
      externalAccountId,
      displayName,
      scopes: connector.scopes,
      status: 'active',
      connectedAt: new Date(),
      lastError: null,
      lastErrorAt: null,
      refreshLockUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.connectorConnections.id, args.connectionId))
    .returning();

  if (!updated) {
    throw new ConnectorApiError({
      message: `Connection ${args.connectionId} disappeared while being activated`,
      status: 404,
      kind: 'permanent',
    });
  }

  // Register the connection with the scheduler's D1 index. One row per entity,
  // because each is dispatched as its own queue message. New rows carry
  // `next_run_at = NULL`, so a freshly connected integration imports on the next
  // tick rather than waiting a full interval.
  //
  // Best-effort by design: a D1 hiccup must not fail an authorisation the provider
  // has already granted. A missing row means no auto-sync until the scheduler's
  // rebuild backfill runs, which is recoverable; a failed connect is not.
  const indexSync: SyncIndexSync = {
    d1: args.env.SYNC_INDEX as SyncIndexSync['d1'],
    workspaceId: args.workspaceId,
  };
  const enabled = updated.enabledEntities ?? connector.entities.map((e) => e.entity);
  for (const entityDef of connector.entities) {
    if (!enabled.includes(entityDef.entity)) continue;
    await syncUpsertSyncIndex(indexSync, {
      engine: 'connector',
      connectionId: updated.id,
      entityType: entityDef.entity,
      provider: updated.connectorId,
      ownerId: updated.connectedBy,
      intervalHours: updated.syncIntervalHours ?? connector.defaultSyncIntervalHours,
      isEnabled: true,
    });
  }

  return updated;
}

/**
 * Disconnect a connector.
 *
 * Soft delete, and imported rows plus their `integration_entity_mappings` are
 * both kept — removing a connector must never delete the customer's data, and
 * keeping the mappings means reconnecting re-links instead of re-importing
 * everything as duplicates. Credentials are cleared, since keeping them would be
 * storing a secret for a connection the tenant asked us to drop.
 */
export async function disconnectConnection(args: {
  db: Database;
  driver: ConnectorDriver;
  connection: ConnectorConnection;
  env: CryptoEnv & Record<string, unknown>;
}): Promise<void> {
  // Best effort: a provider that will not let us remove the webhook must not
  // block the tenant from disconnecting.
  if (args.connection.webhookId && args.driver.deleteWebhooks) {
    try {
      const ctx = await resolveDriverContext({
        db: args.db,
        connection: args.connection,
        driver: args.driver,
        env: args.env,
      });
      const keyring = keyringFromEnv(args.env);
      const secret = args.connection.webhookSecret
        ? await maybeDecryptField(args.connection.webhookSecret, keyring)
        : undefined;
      await args.driver.deleteWebhooks(ctx, args.connection.webhookId, secret);
    } catch (err) {
      console.warn(
        `[connectors] webhook teardown failed for ${args.connection.id}; disconnecting anyway:`,
        err,
      );
    }
  }

  await args.db
    .update(schema.connectorConnections)
    .set({
      status: 'paused',
      oauthTokens: null,
      webhookId: null,
      webhookSecret: null,
      refreshLockUntil: null,
      deletedAt: new Date(),
      disconnectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.connectorConnections.id, args.connection.id));

  // Removed, not disabled: the credentials are gone, so a row left behind would
  // dispatch a sync that can only fail. Reconnecting writes fresh rows.
  await syncRemoveSyncIndex(
    { d1: args.env.SYNC_INDEX as SyncIndexSync['d1'] },
    args.connection.id,
  );
}
