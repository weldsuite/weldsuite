/**
 * `connector-sync` queue consumer — one message is one entity type of one
 * connection.
 *
 * This is the half of the scheduler that replaced Nango's own. The cron in
 * `integration-sync-worker` decides *what* is due and enqueues it; this decides
 * nothing and just runs one bounded pull. Splitting it that way is what keeps a
 * Worker invocation inside its CPU budget no matter how many workspaces exist —
 * the previous serial sweep did every workspace in one invocation.
 *
 * Retry contract, which matters because Cloudflare will redeliver:
 *
 *   - `ack()` for anything `runEntitySync` handled, **including provider
 *     failures**. Those are already recorded on the run row and the connection,
 *     and a redelivery would reproduce them rather than fix anything.
 *   - `retry()` only for infrastructure that could plausibly work next time —
 *     resolving the workspace's database, mainly. A connector that is simply
 *     broken must not occupy the queue.
 *   - `ack()` for messages we can never process (unknown connector, deleted
 *     connection). Retrying those forever is how a dead-letter queue fills up
 *     with work no code will ever accept.
 */

import { eq } from 'drizzle-orm';
import { findDriver, isSyncEntityType } from '@weldsuite/connectors';
import type { SyncEntityType } from '@weldsuite/db/schema';
import type { Env } from '../types';
import { getTenantDbForWorkspace, schema } from '../db';
import { runEntitySync } from '../services/connectors/sync';
// Import for the registration side effect.
import '../services/connectors/drivers';

export interface ConnectorSyncMessage {
  /** Clerk org id — how the tenant database is resolved. */
  workspaceId: string;
  /** Local `connector_connections.id`. */
  connectionId: string;
  entityType: SyncEntityType;
  /** Attributed as the owner of newly imported rows. */
  ownerId: string;
  fullResync?: boolean;
}

function isConnectorSyncMessage(body: unknown): body is ConnectorSyncMessage {
  if (!body || typeof body !== 'object') return false;
  const msg = body as Record<string, unknown>;
  return (
    typeof msg.workspaceId === 'string' &&
    typeof msg.connectionId === 'string' &&
    typeof msg.entityType === 'string' &&
    isSyncEntityType(msg.entityType) &&
    typeof msg.ownerId === 'string'
  );
}

export async function handleConnectorSyncBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    if (!isConnectorSyncMessage(message.body)) {
      console.error('[connector-sync] discarding a malformed message:', message.body);
      message.ack();
      continue;
    }

    const { workspaceId, connectionId, entityType, ownerId, fullResync } = message.body;

    try {
      const db = await getTenantDbForWorkspace(env, workspaceId);

      const [connection] = await db
        .select()
        .from(schema.connectorConnections)
        .where(eq(schema.connectorConnections.id, connectionId))
        .limit(1);

      // Disconnected or deleted between enqueue and delivery. Normal, not an
      // error — the dispatcher's snapshot is always slightly stale.
      if (!connection || connection.deletedAt) {
        message.ack();
        continue;
      }

      // Paused after the message was enqueued. Honour the tenant's choice.
      if (connection.status === 'paused' || connection.status === 'auth_error') {
        message.ack();
        continue;
      }

      const driver = findDriver(connection.connectorId);
      if (!driver) {
        console.error(
          `[connector-sync] no driver registered for ${connection.connectorId}; discarding`,
        );
        message.ack();
        continue;
      }

      const result = await runEntitySync({
        db,
        connection,
        driver,
        entityType,
        trigger: 'schedule',
        ownerId,
        workspaceId,
        env: env as never,
        fullResync: fullResync ?? false,
      });

      if (result.status === 'error') {
        // Recorded on the run row and the connection — surfaced in the UI, not
        // retried here.
        console.warn(
          `[connector-sync] ${connection.connectorId}/${entityType} failed for ${connectionId}: ${result.error}`,
        );
      }

      message.ack();
    } catch (err) {
      // Only infrastructure reaches here; `runEntitySync` absorbs provider
      // failures itself.
      console.error(
        `[connector-sync] infrastructure failure for connection ${connectionId}; retrying:`,
        err,
      );
      message.retry();
    }
  }
}
