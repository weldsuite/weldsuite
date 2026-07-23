/**
 * SLA Breach Checker
 *
 * Runs every minute via cron. Queries conversations with active SLAs
 * whose deadlines have passed and marks them as breached.
 */

import { eq, and, isNull, lt, sql } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { generateId } from './id';

type TenantDb = NeonHttpDatabase<typeof schema>;

export async function checkSlaBreaches(
  db: TenantDb,
  workspaceId: string,
): Promise<number> {
  const now = new Date();
  let breachCount = 0;

  // Find conversations with active SLA and passed deadlines
  const breached = await db
    .select({
      id: schema.helpdeskConversations.id,
      slaId: schema.helpdeskConversations.slaId,
      responseDeadline: schema.helpdeskConversations.responseDeadline,
      resolutionDeadline: schema.helpdeskConversations.resolutionDeadline,
      firstResponseAt: schema.helpdeskConversations.firstResponseAt,
    })
    .from(schema.helpdeskConversations)
    .where(
      and(
        eq(schema.helpdeskConversations.slaStatus, 'active'),
        isNull(schema.helpdeskConversations.deletedAt),
        // At least one deadline has passed
        sql`(
          (${schema.helpdeskConversations.responseDeadline} IS NOT NULL
           AND ${schema.helpdeskConversations.responseDeadline} < ${now}
           AND ${schema.helpdeskConversations.firstResponseAt} IS NULL)
          OR
          (${schema.helpdeskConversations.resolutionDeadline} IS NOT NULL
           AND ${schema.helpdeskConversations.resolutionDeadline} < ${now})
        )`,
      ),
    )
    .limit(100);

  for (const conv of breached) {
    try {
      await db
        .update(schema.helpdeskConversations)
        .set({
          slaStatus: 'breached',
          breachedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.helpdeskConversations.id, conv.id));

      // Record event
      await db.insert(schema.helpdeskConversationEvents).values({
        id: generateId('evt'),
        conversationId: conv.id,
        eventType: 'sla.breached',
        initiator: 'system',
        description: 'SLA policy breached',
        data: {
          slaId: conv.slaId,
          responseDeadline: conv.responseDeadline?.toISOString(),
          resolutionDeadline: conv.resolutionDeadline?.toISOString(),
        },
        isPublic: false,
        createdAt: now,
      });

      breachCount++;
    } catch (err) {
      console.error(`[SLA] Failed to breach conversation ${conv.id}:`, err);
    }
  }

  return breachCount;
}
