/**
 * Integration Sync Scheduler Worker
 *
 * Cron-triggered timing layer for both sync engines: the WeldConnect connector
 * framework and the legacy integration engine.
 *
 * **It does not touch a tenant database.** It used to: every tick loaded all
 * workspaces from the master DB, opened each tenant's Neon database, and queried
 * it to ask whether anything was due. A tenant with no integrations at all was
 * woken 48 times a day for nothing. Neon's idle timeout is 5 minutes so a
 * 30-minute cron does not *pin* a database awake, but it paid a cold start and a
 * query per tenant per tick, forever.
 *
 * Now the sweep reads the always-on D1 `sync_index` and dispatches only what is
 * due. A tenant database is opened downstream, where there is real work:
 *
 *   - `connector` rows → one message per (connection, entity) onto the
 *     `connector-sync` queue; app-api's consumer does the pull.
 *   - `legacy` rows    → app-api's internal `/sync` route over the service
 *     binding, unchanged from before.
 *
 * `schedule_index` in workflow-worker solved this first for scheduled workflow
 * triggers; this is deliberately the same shape.
 *
 * The one remaining all-tenant fan-out is `POST /internal/sync-index/rebuild`,
 * which backfills the index. It is invoked by hand after a deploy, never on a
 * timer — that distinction is the whole point of this file.
 */

import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { eq, and, isNull } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import * as schema from '@weldsuite/db/schema';
import type { SyncEntityType } from '@weldsuite/db/schema';
import {
  dueSyncRows,
  dueWatchRenewals,
  getConnector,
  markSyncDispatched,
  markWatchRenewed,
  parseWatchExpiry,
  upsertSyncIndex,
  LEGACY_SYNCABLE_PROVIDERS,
  type SyncIndexRow,
} from '@weldsuite/connectors';

export interface Env {
  /** Master DB. Used ONLY by the rebuild backfill, never by the sweep. */
  HYPERDRIVE_MASTER: Hyperdrive;
  /** app-api service binding — internal routes only. */
  APP_API: Fetcher;
  /** Always-on timing store. Shares a database with `schedule_index`. */
  SYNC_INDEX?: D1Database;
  /**
   * `connector-sync` queue. One message is one (connection, entity type), so a
   * slow tenant cannot consume the whole invocation and a growing workspace count
   * adds messages rather than latency.
   */
  CONNECTOR_SYNC?: Queue<ConnectorSyncMessage>;
  ENVIRONMENT: string;
  /**
   * Must match the target app-api env's INTERNAL_API_SECRET. app-api's internal
   * integrations router fails closed with 401 on a missing/wrong secret, and the
   * dispatch branches below only log — a mismatch silently stops all auto-sync.
   */
  INTERNAL_API_SECRET?: string;
}

/** Must stay in step with app-api's `queue/connector-sync.ts`. */
interface ConnectorSyncMessage {
  workspaceId: string;
  connectionId: string;
  entityType: SyncEntityType;
  ownerId: string;
  fullResync?: boolean;
}

/** Fallback when a legacy connection has no configured interval. */
const DEFAULT_INTERVAL_HOURS = 6;

function getMasterDb(env: Env) {
  const sql = neon(env.HYPERDRIVE_MASTER.connectionString);
  return drizzleNeonHttp({ client: sql, schema: masterSchema });
}

function getTenantDb(connectionString: string) {
  const sql = neon(connectionString);
  return drizzleNeonHttp({ client: sql, schema });
}

interface SyncSettings {
  syncIntervalHours?: number;
}

// ============================================================================
// Dispatch
// ============================================================================

/** Ask app-api to run a legacy connection's sync. */
async function dispatchLegacy(env: Env, row: SyncIndexRow): Promise<boolean> {
  try {
    const response = await env.APP_API.fetch(
      `https://internal/api/integrations/connections/${row.connection_id}/sync`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Id': row.workspace_id,
          'X-Internal-Secret': env.INTERNAL_API_SECRET || '',
        },
      },
    );
    if (!response.ok) {
      console.error(
        `[SyncScheduler] legacy sync for ${row.connection_id} failed: ${response.status}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[SyncScheduler] legacy sync for ${row.connection_id} errored:`, err);
    return false;
  }
}

/** Renew a Google Calendar watch channel that is about to lapse. */
async function renewWatch(env: Env, row: SyncIndexRow): Promise<void> {
  try {
    const response = await env.APP_API.fetch(
      `https://internal/api/integrations/connections/${row.connection_id}/renew-watch`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Id': row.workspace_id,
          'X-Internal-Secret': env.INTERNAL_API_SECRET || '',
        },
      },
    );

    if (!response.ok) {
      console.error(
        `[SyncScheduler] watch renewal for ${row.connection_id} failed: ${response.status}`,
      );
      return;
    }

    if (!env.SYNC_INDEX) return;

    // app-api answers `{ data: { message, expiration } }`.
    const body = (await response.json().catch(() => null)) as {
      data?: { expiration?: number | string | null };
    } | null;
    const reported = body?.data?.expiration;
    const expiry = reported === null || reported === undefined ? NaN : Number(reported);

    // Never write null here: null means "this row needs no renewal", so a
    // response we could not parse would silently retire the channel and inbound
    // calendar webhooks would stop a week later with nothing failing loudly.
    // Fall back to just under Google's ~7-day channel ceiling so the next attempt
    // is scheduled either way rather than retried every tick.
    await markWatchRenewed(
      env.SYNC_INDEX,
      row.row_id,
      Number.isFinite(expiry) ? expiry : Date.now() + 6 * 24 * 60 * 60 * 1000,
    );
  } catch (err) {
    console.error(`[SyncScheduler] watch renewal for ${row.connection_id} errored:`, err);
  }
}

/**
 * The sweep: one D1 read, then dispatch.
 *
 * `next_run_at` is advanced at dispatch rather than on completion, because
 * connector rows only get queued here and a permanently failing sync must not
 * stay due on every tick.
 */
export async function runSweep(env: Env, now: number = Date.now()): Promise<{
  enqueued: number;
  legacyDispatched: number;
  watchRenewals: number;
}> {
  if (!env.SYNC_INDEX) {
    console.error('[SyncScheduler] SYNC_INDEX D1 binding is not configured — nothing will sync');
    return { enqueued: 0, legacyDispatched: 0, watchRenewals: 0 };
  }

  const rows = await dueSyncRows(env.SYNC_INDEX, now);
  const messages: Array<{ body: ConnectorSyncMessage }> = [];
  const dispatched: SyncIndexRow[] = [];
  let legacyDispatched = 0;

  for (const row of rows) {
    if (row.engine === 'connector') {
      // Dropped from the catalog since the row was written. Leave it be: the
      // tenant can still see and disconnect the connection.
      if (!getConnector(row.provider)) continue;
      if (!row.entity_type) continue;
      if (!env.CONNECTOR_SYNC) {
        console.error('[SyncScheduler] CONNECTOR_SYNC queue is not bound — skipping connectors');
        continue;
      }
      messages.push({
        body: {
          workspaceId: row.workspace_id,
          connectionId: row.connection_id,
          entityType: row.entity_type as SyncEntityType,
          // 'system' keeps a connection syncing after its author leaves the
          // workspace rather than failing on a null owner.
          ownerId: row.owner_id ?? 'system',
        },
      });
      dispatched.push(row);
      continue;
    }

    if (!LEGACY_SYNCABLE_PROVIDERS.has(row.provider)) continue;
    if (await dispatchLegacy(env, row)) {
      legacyDispatched++;
      dispatched.push(row);
    } else {
      // Still advance: a provider that is down should be retried next cycle, not
      // on every tick for the rest of the outage.
      dispatched.push(row);
    }
  }

  if (messages.length > 0 && env.CONNECTOR_SYNC) {
    // One sendBatch rather than N sends — the invocation's subrequest budget is
    // the scarce resource once many connections come due at once.
    await env.CONNECTOR_SYNC.sendBatch(messages);
  }

  for (const row of dispatched) {
    await markSyncDispatched(env.SYNC_INDEX, row.row_id, row.interval_hours, now);
  }

  const renewals = await dueWatchRenewals(env.SYNC_INDEX, now);
  for (const row of renewals) {
    await renewWatch(env, row);
  }

  return { enqueued: messages.length, legacyDispatched, watchRenewals: renewals.length };
}

// ============================================================================
// Rebuild
// ============================================================================

/**
 * Backfill the index from tenant state.
 *
 * The ONLY code path here that still fans out across every workspace. Run it once
 * after deploying the index — existing connections have no rows and would
 * silently stop syncing otherwise — and again if the index is ever suspected of
 * having drifted. Never on a timer.
 */
export async function rebuildSyncIndex(env: Env): Promise<{ legacy: number; connector: number }> {
  const d1 = env.SYNC_INDEX;
  if (!d1) throw new Error('SYNC_INDEX D1 binding not configured');

  const masterDb = getMasterDb(env);
  const workspaces = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
      databaseUrl: masterSchema.workspaces.databaseUrl,
    })
    .from(masterSchema.workspaces)
    .where(isNull(masterSchema.workspaces.deletedAt));

  let legacy = 0;
  let connector = 0;

  for (const workspace of workspaces) {
    if (!workspace.clerkOrgId || !workspace.databaseUrl) continue;

    try {
      const db = getTenantDb(workspace.databaseUrl);

      // --- Legacy connections ---
      const legacyRows = await db
        .select()
        .from(schema.integrationConnections)
        .where(
          and(
            eq(schema.integrationConnections.status, 'active'),
            isNull(schema.integrationConnections.deletedAt),
          ),
        );

      for (const row of legacyRows) {
        if (!LEGACY_SYNCABLE_PROVIDERS.has(row.provider)) continue;
        const tokens = row.oauthTokens as { accessToken?: string } | null;
        if (!tokens?.accessToken) continue;

        const settings = row.syncSettings as SyncSettings | null;
        // Google Calendar stashes its watch-channel JSON in `webhookSecret`; every
        // other provider puts a plain HMAC secret there, so a parse failure is
        // expected and yields null (no renewal scheduled).
        const watchExpiresAt =
          row.provider === 'google_calendar' ? parseWatchExpiry(row.webhookSecret) : null;

        await upsertSyncIndex(d1, {
          engine: 'legacy',
          workspaceId: workspace.clerkOrgId,
          connectionId: row.id,
          provider: row.provider,
          ownerId: row.connectedBy,
          intervalHours: settings?.syncIntervalHours ?? DEFAULT_INTERVAL_HOURS,
          watchExpiresAt,
          isEnabled: true,
        });
        legacy++;
      }

      // --- Connector connections ---
      const connectorRows = await db
        .select()
        .from(schema.connectorConnections)
        .where(
          and(
            eq(schema.connectorConnections.status, 'active'),
            isNull(schema.connectorConnections.deletedAt),
          ),
        );

      for (const row of connectorRows) {
        const def = getConnector(row.connectorId);
        if (!def) continue;

        const declared = def.entities.map((e) => e.entity);
        const enabled = row.enabledEntities ?? declared;

        for (const entityType of declared.filter((e) => enabled.includes(e))) {
          await upsertSyncIndex(d1, {
            engine: 'connector',
            workspaceId: workspace.clerkOrgId,
            connectionId: row.id,
            entityType,
            provider: row.connectorId,
            ownerId: row.connectedBy,
            intervalHours: row.syncIntervalHours ?? def.defaultSyncIntervalHours,
            isEnabled: true,
          });
          connector++;
        }
      }
    } catch (err) {
      console.warn(`[SyncScheduler] rebuild: workspace ${workspace.id} failed:`, err);
    }
  }

  return { legacy, connector };
}

// ============================================================================
// Worker
// ============================================================================

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runSweep(env)
        .then((result) => {
          console.log(
            `[SyncScheduler] Done (${env.ENVIRONMENT}). Connector messages: ${result.enqueued}, legacy dispatched: ${result.legacyDispatched}, watch renewals: ${result.watchRenewals}`,
          );
        })
        .catch((err) => {
          console.error('[SyncScheduler] sweep failed:', err);
        }),
    );
  },

  /**
   * Internal-only. Authenticated on `X-Internal-Secret` and fails closed — the
   * rebuild reads every tenant database, so it must not be reachable publicly.
   */
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'POST' && url.pathname === '/internal/sync-index/rebuild') {
      const secret = req.headers.get('X-Internal-Secret');
      if (!env.INTERNAL_API_SECRET || secret !== env.INTERNAL_API_SECRET) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
      try {
        const result = await rebuildSyncIndex(env);
        return Response.json({ ok: true, indexed: result });
      } catch (err) {
        console.error('[SyncScheduler] rebuild failed:', err);
        return Response.json({ error: 'Rebuild failed' }, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  },
};
