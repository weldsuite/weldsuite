/**
 * Where a routine's result lands: in the main chat of the person who created
 * the routine, the one continuous chat they have with the agent (./main-chat).
 * A routine that "sends a digest" therefore reports back like a teammate
 * would, in the conversation you already have, and the agent sees its own
 * report the next time you talk to it.
 */

import { sendWeldAgentReplyNotification } from '@weldsuite/notifications';
import type { Database as NotificationDatabase, NotificationEnv } from '@weldsuite/notifications/types';
import { getAgent, type AgentDb } from './agents';
import { persistAssistantMessage, ROUTINE_RESULT_KIND } from './complete-turn';
import { getOrCreateMainConversation } from './main-chat';
import type { WeldAgentEnv as Env } from './env';

export { ROUTINE_RESULT_KIND };

/**
 * Post a routine run's outcome into its owner's main chat with the agent and
 * notify them (the notification opens that chat). Returns the chat id, or
 * null when there is nobody to deliver to. Never throws: the run itself
 * already succeeded or failed on its own.
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
    const agent = await getAgent(db, params.agentId);
    const conversation = await getOrCreateMainConversation(db, {
      userId,
      agentId: params.agentId,
      agentName: agent?.name ?? params.routine.name,
    });
    const conversationId = conversation.id;
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
