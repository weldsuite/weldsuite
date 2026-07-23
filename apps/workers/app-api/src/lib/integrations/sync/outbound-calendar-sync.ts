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

/**
 * Push a calendar event to all connected Google Calendar accounts.
 */
export async function pushCalendarEventToGoogle(
  db: Database,
  eventId: string,
  action: 'created' | 'updated' | 'deleted',
  data: Record<string, unknown>,
  env: { GOOGLE_CALENDAR_CLIENT_ID?: string; GOOGLE_CALENDAR_CLIENT_SECRET?: string },
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
        const tokens = connection.oauthTokens as OAuthTokens | null;
        if (!tokens?.accessToken) continue;

        // Refresh token if expired
        let accessToken = tokens.accessToken;
        if (tokens.expiresAt && new Date(tokens.expiresAt) < new Date()) {
          if (!tokens.refreshToken || !env.GOOGLE_CALENDAR_CLIENT_ID || !env.GOOGLE_CALENDAR_CLIENT_SECRET) continue;
          const newTokens = await adapter.refreshAccessToken(
            env.GOOGLE_CALENDAR_CLIENT_ID,
            env.GOOGLE_CALENDAR_CLIENT_SECRET,
            tokens.refreshToken,
          );
          accessToken = newTokens.accessToken;
          await db
            .update(schema.integrationConnections)
            .set({ oauthTokens: newTokens, updatedAt: new Date() })
            .where(eq(schema.integrationConnections.id, connection.id));
        }

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
          if (mapping) {
            const result = await adapter.deleteEntity(accessToken, 'calendar_event', mapping.externalEntityId);
            if (result.success) {
              await db
                .update(schema.integrationEntityMappings)
                .set({ updatedAt: new Date() })
                .where(eq(schema.integrationEntityMappings.id, mapping.id));
            }
          }
          continue;
        }

        // Create or update
        const externalId = mapping?.externalEntityId;
        const result = await adapter.pushEntity(accessToken, 'calendar_event', data, externalId);

        if (!result.success) {
          console.error(`[OutboundCalSync] Push failed for event ${eventId}: ${result.error}`);
          // If 403, likely read-only token — mark connection for re-auth
          if (result.error?.startsWith('403')) {
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
          continue;
        }

        const checksum = await computeChecksum(data);

        if (mapping) {
          // Update existing mapping
          await db
            .update(schema.integrationEntityMappings)
            .set({
              externalEntityId: result.externalId,
              syncChecksum: checksum,
              lastSyncedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.integrationEntityMappings.id, mapping.id));
        } else {
          // Create new mapping
          await db.insert(schema.integrationEntityMappings).values({
            id: generateId('iem'),
            connectionId: connection.id,
            externalEntityType: 'calendar_event',
            externalEntityId: result.externalId,
            internalEntityType: 'calendar_event',
            internalEntityId: eventId,
            syncChecksum: checksum,
            lastSyncedAt: new Date(),
          });
        }
      } catch (err) {
        console.error(`[OutboundCalSync] Error for connection ${connection.id}:`, err);
      }
    }
  } catch (err) {
    console.error(`[OutboundCalSync] Failed to push event ${eventId}:`, err);
  }
}
