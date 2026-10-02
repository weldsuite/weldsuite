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
 */

import { eq, and, isNull } from 'drizzle-orm';
import { schema } from '../../../db';
import { generateId } from '../../id';
import { GoogleCalendarSyncAdapter } from '../adapters/google-calendar';
import type { OAuthTokens } from '@weldsuite/db/schema';
import type { Database } from '../../../db';

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

type CalendarEnv = { GOOGLE_CALENDAR_CLIENT_ID?: string; GOOGLE_CALENDAR_CLIENT_SECRET?: string };
type CalendarConnection = typeof schema.integrationConnections.$inferSelect;
type EntityMapping = typeof schema.integrationEntityMappings.$inferSelect;

/**
 * Return a usable access token for the connection, refreshing (and persisting)
 * it when expired. Returns null when the connection cannot be used.
 */
async function getUsableAccessToken(
  db: Database,
  connection: CalendarConnection,
  env: CalendarEnv,
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

/** Delete the mapped Google event (if any) and touch the mapping on success. */
async function deleteMappedEvent(
  db: Database,
  accessToken: string,
  mapping: EntityMapping | undefined,
): Promise<void> {
  if (!mapping) return;
  const result = await adapter.deleteEntity(accessToken, 'calendar_event', mapping.externalEntityId);
  if (result.success) {
    await db
      .update(schema.integrationEntityMappings)
      .set({ updatedAt: new Date() })
      .where(eq(schema.integrationEntityMappings.id, mapping.id));
  }
}

/** Log a failed push; a 403 likely means a read-only token, so flag the connection for re-auth. */
async function handlePushFailure(
  db: Database,
  connection: CalendarConnection,
  eventId: string,
  error: string | undefined,
): Promise<void> {
  console.error(`[OutboundCalSync] Push failed for event ${eventId}: ${error}`);
  if (!error?.startsWith('403')) return;
  await db
    .update(schema.integrationConnections)
    .set({
      status: 'error',
      lastError: 'Write access denied. Please reconnect Google Calendar.',
      lastErrorAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.integrationConnections.id, connection.id));
}

/** Update the existing entity mapping, or create one when the event was not yet mapped. */
async function upsertEntityMapping(
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

/** Push (or delete) one calendar event on a single Google Calendar connection. */
async function pushToConnection(
  db: Database,
  connection: CalendarConnection,
  eventId: string,
  action: 'created' | 'updated' | 'deleted',
  data: Record<string, unknown>,
  env: CalendarEnv,
): Promise<void> {
  const accessToken = await getUsableAccessToken(db, connection, env);
  if (!accessToken) return;

  // Look up existing entity mapping
  const [mapping] = await db
    .select()
    .from(schema.integrationEntityMappings)
    .where(
      and(
        eq(schema.integrationEntityMappings.connectionId, connection.id),
        eq(schema.integrationEntityMappings.internalEntityType, 'calendar_event'),
        eq(schema.integrationEntityMappings.internalEntityId, eventId),
      )
    )
    .limit(1);

  if (action === 'deleted') {
    await deleteMappedEvent(db, accessToken, mapping);
    return;
  }

  // Create or update
  const result = await adapter.pushEntity(accessToken, 'calendar_event', data, mapping?.externalEntityId);

  if (!result.success) {
    await handlePushFailure(db, connection, eventId, result.error);
    return;
  }

  const checksum = await computeChecksum(data);
  await upsertEntityMapping(db, connection.id, eventId, mapping, result.externalId, checksum);
}

/**
 * Push a calendar event to all connected Google Calendar accounts.
 */
export async function pushCalendarEventToGoogle(
  db: Database,
  eventId: string,
  action: 'created' | 'updated' | 'deleted',
  data: Record<string, unknown>,
  env: CalendarEnv,
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

    if (connections.length === 0) return;

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
