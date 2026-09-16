/**
 * Entity-event → WeldAgent dispatch.
 *
 * Phase 5: invoked from the entity-agents queue consumer on app-api (via the
 * registered runner hook). Hub retries re-deliver the same evt_ id — skip
 * agents that already have a run for that eventId.
 */

import { and, eq, sql } from 'drizzle-orm';
import { schema } from '../../db';
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
  /** Entity-event id (`evt_…`) for hub-retry idempotency. */
  eventId?: string;
}

/**
 * True when this agent already has a run whose triggerData.eventId matches.
 */
export async function hasExistingAgentRunForEvent(
  db: AgentDb,
  agentId: string,
  eventId: string,
): Promise<boolean> {
  const { weldagentAgentRuns: r } = schema;
  const [existing] = await db
    .select({ id: r.id })
    .from(r)
    .where(and(eq(r.agentId, agentId), sql`${r.triggerData}->>'eventId' = ${eventId}`))
    .limit(1);
  return Boolean(existing);
}

/**
 * Match active agents for an entity event, queue runs, and execute them.
 * Safe to call fire-and-forget — never throws to the publisher / queue ack.
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
      if (message.eventId) {
        const exists = await hasExistingAgentRunForEvent(db, agent.id, message.eventId);
        if (exists) {
          console.log(
            `[weldagent/dispatch] Skipping duplicate event ${message.eventId} for agent ${agent.id}`,
          );
          continue;
        }
      }

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
          ...(message.eventId ? { eventId: message.eventId } : {}),
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
        triggerData: {
          eventKey,
          entityId: message.entityId,
          ...(message.eventId ? { eventId: message.eventId } : {}),
        },
        userMessage: prompt,
        extraSystem: `Triggered by entity event ${eventKey}.`,
        runId,
      });
    } catch (err) {
      console.error(`[weldagent/dispatch] agent ${agent.id} failed:`, err);
    }
  }
}
