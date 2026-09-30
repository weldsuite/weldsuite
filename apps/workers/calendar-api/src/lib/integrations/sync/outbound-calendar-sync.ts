/**
 * Outbound Calendar Sync — Push WeldSuite calendar events to Google Calendar
 *
 * Called from calendar event routes after create/update/delete.
 * Runs via waitUntil() so it doesn't block the API response.
 *
 * Sync loop prevention:
 * - Inbound sync (Google → WeldSuite) writes directly via the orchestrator, never
 *   touching API routes, so this function is never called for inbound changes.
 * - After outbound push, Google fires a webhook → incremental sync → orchestrator
 *   finds the entity already mapped with matching checksum → skips.
 *
 * Ported verbatim from api-worker (`src/lib/integrations/sync/outbound-calendar-sync.ts`)
 * as part of W5b. The relative import paths resolve identically under app-api
 * (`../../../db` → src/db, `../../id` → src/lib/id), so nothing here is adapted.
 *
 * Why this exists: api-worker fired this on every calendar-event mutation. When
 * the platform's calendar moved to app-api the dispatch was not carried over, so
 * workspaces with an active `google_calendar` connection silently stopped having
 * events pushed to Google. Restoring it closes that regression.
 *
 * Every failure path is best-effort and swallowed: a Google outage, an expired
 * refresh token or a revoked scope must never surface to the caller mutating
 * their own calendar.
 */

import { eq, and, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { GoogleCalendarSyncAdapter } from '../adapters/google-calendar';
import type { OAuthTokens } from '@weldsuite/db/schema';
import type { Database } from '@weldsuite/worker-kit/db';

const adapter = new GoogleCalendarSyncAdapter();

/**
 * Compute SHA-256 checksum of data for entity mapping.
 */
async function computeChecksum(data: unknown): Promise<string> {
  const json = JSON.stringify(data);
  const encoded = new TextEncoder().encode(json);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

type Connection = typeof schema.integrationConnections.$inferSelect;
type EntityMapping = typeof schema.integrationEntityMappings.$inferSelect;
type SyncEnv = { GOOGLE_CALENDAR_CLIENT_ID?: string; GOOGLE_CALENDAR_CLIENT_SECRET?: string };

/**
 * Resolve a usable access token for the connection, refreshing (and persisting)
 * it when expired. Returns null when the connection cannot be used.
 */
async function resolveAccessToken(
  db: Database,
  connection: Connection,
  env: SyncEnv,
): Promise<string | null> {
  const tokens = connection.oauthTokens as OAuthTokens | null;
  if (!tokens?.accessToken) return null;

  const isExpired = !!tokens.expiresAt && new Date(tokens.expiresAt) < new Date();
  if (!isExpired) return tokens.accessToken;

  if (!tokens.refreshToken || !env.GOOGLE_CALENDAR_CLIENT_ID || !env.GOOGLE_CALENDAR_CLIENT_SECRET) return null;
  const newTokens = await adapter.refreshAccessToken(
    env.GOOGLE_CALENDAR_CLIENT_ID,
    env.GOOGLE_CALENDAR_CLIENT_SECRET,
    tokens.refreshToken,
  );
  await db
    .update(schema.integrationConnections)
    .set({ oauthTokens: newTokens, updatedAt: new Date() })
    .where(eq(schema.integrationConnections.id, connection.id));
  return newTokens.accessToken;
}

/** Look up the existing entity mapping for an event on a connection. */
async function findEventMapping(
  db: Database,
  connectionId: string,
  eventId: string,
): Promise<EntityMapping | undefined> {
  const [mapping] = await db
    .select()
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, connectionId),
        eq(schema.integrationEntityMappings.internalEntityType, 'calendar_event'),
        eq(schema.integrationEntityMappings.internalEntityId, eventId),
      )
    )
    .limit(1);
  return mapping;
}

/** Delete the mapped external event and touch the mapping on success. */
async function deleteMappedEvent(db: Database, accessToken: string, mapping: EntityMapping | undefined): Promise<void> {
  if (!mapping) return;
  const result = await adapter.deleteEntity(accessToken, 'calendar_event', mapping.externalEntityId);
  if (!result.success) return;
  await db
    .update(schema.integrationEntityMappings)
    .set({ updatedAt: new Date() })
    .where(eq(schema.integrationEntityMappings.id, mapping.id));
}

/** Flag the connection for re-auth after Google denied write access. */
async function markWriteAccessDenied(db: Database, connectionId: string): Promise<void> {
  await db
    .update(schema.integrationConnections)
    .set({
      status: 'error',
      lastError: 'Write access denied. Please reconnect Google Calendar.',
      lastErrorAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.integrationConnections.id, connectionId));
}

/** Update the existing mapping, or create one when the event was not mapped yet. */
async function upsertEventMapping(
  db: Database,
  connectionId: string,
  eventId: string,
  mapping: EntityMapping | undefined,
  externalId: string,
  checksum: string,
): Promise<void> {
  if (mapping) {
    await db
      .update(schema.integrationEntityMappings)
      .set({
        externalEntityId: externalId,
        syncChecksum: checksum,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.integrationEntityMappings.id, mapping.id));
    return;
  }
  await db.insert(schema.integrationEntityMappings).values({
    id: generateId('iem'),
    connectionId,
    externalEntityType: 'calendar_event',
    externalEntityId: externalId,
    internalEntityType: 'calendar_event',
    internalEntityId: eventId,
    syncChecksum: checksum,
    lastSyncedAt: new Date(),
  });
}

/** Push a single event to a single connection. Throws on unexpected failure. */
async function pushToConnection(
  db: Database,
  connection: Connection,
  eventId: string,
  action: 'created' | 'updated' | 'deleted',
  data: Record<string, unknown>,
  env: SyncEnv,
): Promise<void> {
  const accessToken = await resolveAccessToken(db, connection, env);
  if (!accessToken) return;

  const mapping = await findEventMapping(db, connection.id, eventId);

  if (action === 'deleted') {
    await deleteMappedEvent(db, accessToken, mapping);
    return;
  }

  // Create or update
  const result = await adapter.pushEntity(accessToken, 'calendar_event', data, mapping?.externalEntityId);

  if (!result.success) {
    console.error(`[OutboundCalSync] Push failed for event ${eventId}: ${result.error}`);
    // If 403, likely read-only token — mark connection for re-auth
    if (result.error?.startsWith('403')) {
      await markWriteAccessDenied(db, connection.id);
    }
    return;
  }

  const checksum = await computeChecksum(data);
  await upsertEventMapping(db, connection.id, eventId, mapping, result.externalId, checksum);
}

/**
 * Push a calendar event to all connected Google Calendar accounts.
 */
export async function pushCalendarEventToGoogle(
  db: Database,
  eventId: string,
  action: 'created' | 'updated' | 'deleted',
  data: Record<string, unknown>,
  env: SyncEnv,
): Promise<void> {
  try {
    // Find active Google Calendar connections with bidirectional direction
    const connections = await db
      .select()
      .from(schema.integrationConnections)
      .where(
        and(
          eq(schema.integrationConnections.provider, 'google_calendar'),
          eq(schema.integrationConnections.status, 'active'),
          isNull(schema.integrationConnections.deletedAt),
        )
      );

    for (const connection of connections) {
      try {
        await pushToConnection(db, connection, eventId, action, data, env);
      } catch (err) {
        console.error(`[OutboundCalSync] Error for connection ${connection.id}:`, err);
      }
    }
  } catch (err) {
    console.error(`[OutboundCalSync] Failed to push event ${eventId}:`, err);
  }
}
