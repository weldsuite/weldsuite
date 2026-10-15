/**
 * Where a routine's result lands: one chat thread per routine, owned by the
 * person who created it, next to their other chats with the agent. A routine
 * that "sends a digest" therefore shows up where they talk to the agent.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { sendWeldAgentReplyNotification } from '@weldsuite/notifications';
import type { Database as NotificationDatabase, NotificationEnv } from '@weldsuite/notifications/types';
import { getAgent, type AgentDb } from './agents';
import { persistAssistantMessage } from './complete-turn';
import type { WeldAgentEnv as Env } from './env';

/** `metadata.kind` of an assistant message posted by a routine run. */
export const ROUTINE_RESULT_KIND = 'routine_result';

async function routineConversationId(
  db: AgentDb,
  params: { routineId: string; routineName: string; agentId: string; userId: string },
): Promise<string> {
  const conv = schema.weldagentConversations;
  const [existing] = await db
    .select({ id: conv.id })
    .from(conv)
    .where(
      and(
        eq(conv.userId, params.userId),
        eq(conv.agentId, params.agentId),
        sql`${conv.metadata}->>'routineId' = ${params.routineId}`,
        isNull(conv.deletedAt),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const id = generateId('conv');
  await db.insert(conv).values({
    id,
    userId: params.userId,
    agentId: params.agentId,
    name: params.routineName.slice(0, 255),
    metadata: { routineId: params.routineId },
  });
  return id;
}

/**
 * Post a routine run's outcome into the routine's thread and notify its owner
 * (the notification opens that thread). Returns the thread id, or null when
 * there is nobody to deliver to. Never throws: the run itself already
 * succeeded or failed on its own.
 */
export async function deliverRoutineResult(
  db: AgentDb,
  env: Env,
  params: {
    workspaceId: string;
    routine: { id: string; name: string };
    /** Who gets the thread: the routine creator, or whoever ran a test. */
    userId: string | null;
    agentId: string;
    runId?: string;
    success: boolean;
    text: string;
    error?: string;
  },
): Promise<string | null> {
  const userId = params.userId;
  if (!userId || userId === 'system') return null;
  try {
    const conversationId = await routineConversationId(db, {
      routineId: params.routine.id,
      routineName: params.routine.name,
      agentId: params.agentId,
      userId,
    });
    const content = params.success
      ? params.text
      : `The routine "${params.routine.name}" did not finish: ${params.error ?? 'unknown error'}`;
    const message = await persistAssistantMessage({
      db,
      conversationId,
      content,
      metadata: {
        kind: ROUTINE_RESULT_KIND,
        routineId: params.routine.id,
        routineName: params.routine.name,
        ...(params.runId ? { runId: params.runId } : {}),
        success: params.success,
      },
    });
    try {
      const agent = await getAgent(db, params.agentId);
      await sendWeldAgentReplyNotification({
        db: db as unknown as NotificationDatabase,
        env: env as unknown as NotificationEnv,
        workspaceId: params.workspaceId,
        userId,
        conversationId,
        agentName: agent?.name ?? null,
        previewText: message.content,
      });
    } catch (err) {
      console.error('[weldagent/routine] notify failed:', err);
    }
    return conversationId;
  } catch (err) {
    console.error('[weldagent/routine] delivering the result failed:', err);
    return null;
  }
}
