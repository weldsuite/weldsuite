/**
 * One continuous chat per person and agent.
 *
 * Talking to an agent works like a DM with a teammate: one long thread that
 * never resets, carried by one Claude Managed Agents session (compacted by the
 * platform as it grows, see ./executor). Older per-topic threads stay in the
 * database but are no longer shown; a new main chat starts empty.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { ConversationSummary } from '@weldsuite/app-api-client/schemas/weldagent';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { AgentDb } from './agents';

type ConversationRow = typeof schema.weldagentConversations.$inferSelect;

export function serializeConversationSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    name: row.name,
    moduleKey: row.moduleKey,
    agentId: row.agentId,
    isPinned: row.isPinned,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    messageCount: row.messageCount,
    createdAt: row.createdAt.toISOString(),
  };
}

async function findMainConversation(db: AgentDb, userId: string, agentId: string) {
  const { weldagentConversations: conv } = schema;
  const [row] = await db
    .select()
    .from(conv)
    .where(
      and(
        eq(conv.userId, userId),
        eq(conv.agentId, agentId),
        eq(conv.isMain, true),
        isNull(conv.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The person's main chat with the agent, created on first use. A unique
 * index makes concurrent first calls converge on one row.
 */
export async function getOrCreateMainConversation(
  db: AgentDb,
  params: { userId: string; agentId: string; agentName: string },
): Promise<ConversationRow> {
  const existing = await findMainConversation(db, params.userId, params.agentId);
  if (existing) return existing;

  const { weldagentConversations: conv } = schema;
  await db
    .insert(conv)
    .values({
      id: generateId('conv'),
      userId: params.userId,
      agentId: params.agentId,
      name: params.agentName.slice(0, 255) || 'Agent',
      isMain: true,
    })
    .onConflictDoNothing();

  const created = await findMainConversation(db, params.userId, params.agentId);
  if (!created) throw new Error('Could not open the chat with this agent');
  return created;
}
