/**
 * Entity-event → WeldAgent dispatch.
 *
 * Registered into `@weldsuite/entity-events` so publishEntityEvent can fan out
 * to active agents without a dedicated Cloudflare queue.
 */

import type { Env, Variables } from '../../types';
import { findAgentsForEvent, createAgentRun } from './agents';
import { executeAgentRun } from './run';

type AgentDb = Variables['tenantDb'];

export interface WeldAgentDispatchMessage {
  workspaceId: string;
  userId: string;
  entityType: string;
  action: string;
  entityId: string;
  data: Record<string, unknown>;
}

/**
 * Match active agents for an entity event, queue runs, and execute them.
 * Safe to call fire-and-forget — never throws to the publisher.
 */
export async function dispatchWeldAgentsForEvent(
  env: Env,
  db: AgentDb,
  message: WeldAgentDispatchMessage,
): Promise<void> {
  const eventKey = `${message.entityType}.${message.action}`;
  const altKey = `${message.entityType}:${message.action}`;

  let agents;
  try {
    agents = await findAgentsForEvent(db, eventKey);
    if (agents.length === 0) {
      agents = await findAgentsForEvent(db, altKey);
    }
  } catch (err) {
    console.error('[weldagent/dispatch] find agents failed:', err);
    return;
  }

  if (agents.length === 0) return;

  for (const agent of agents) {
    try {
      const runId = await createAgentRun(db, {
        agentId: agent.id,
        status: 'queued',
        triggerType: 'event',
        triggerData: {
          eventKey,
          entityType: message.entityType,
          action: message.action,
          entityId: message.entityId,
          data: message.data,
        },
      });

      const prompt =
        `A platform event occurred: ${eventKey} on entity ${message.entityId}.\n` +
        `Payload:\n${JSON.stringify(message.data, null, 2)}\n\n` +
        `Follow your instructions and use tools if needed.`;

      await executeAgentRun({
        db,
        env,
        workspaceId: message.workspaceId,
        actorUserId: message.userId || agent.createdBy || 'system',
        agentId: agent.id,
        triggerType: 'event',
        triggerData: { eventKey, entityId: message.entityId },
        userMessage: prompt,
        extraSystem: `Triggered by entity event ${eventKey}.`,
        runId,
      });
    } catch (err) {
      console.error(`[weldagent/dispatch] agent ${agent.id} failed:`, err);
    }
  }
}
