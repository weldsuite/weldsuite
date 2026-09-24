/**
 * Entity-event → WeldAgent dispatch.
 *
 * Phase 5: invoked from the entity-agents queue consumer on app-api (via the
 * registered runner hook). Hub retries re-deliver the same evt_ id — skip
 * agents that already have a run for that eventId. Runs execute in the durable
 * WeldAgent job workflow, so a slow agent never stalls the queue batch.
 */

import { and, eq, sql } from 'drizzle-orm';
import { schema } from '../../db';
import type { Env, Variables } from '../../types';
import { findAgentsForEvent, createAgentRun } from './agents';
import { findEventRoutines, createRoutineRun, markRoutineScheduled } from './parity';
import { enqueueWeldAgentJob, type WeldAgentJob } from './jobs';

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
 * Key stamped into entity-event `data` by agent tools. Events an agent caused
 * never trigger agents again — otherwise an agent subscribed to
 * `ticket.created` that creates tickets would loop forever.
 */
export const AGENT_ORIGIN_KEY = 'triggeredByAgentId';

type Schedule = (job: WeldAgentJob) => Promise<void>;

/**
 * Match active agents (and event routines) for an entity event, queue a run
 * row for each and hand the run to the durable job workflow.
 * Safe to call fire-and-forget — never throws to the publisher / queue ack.
 */
export async function dispatchWeldAgentsForEvent(
  env: Env,
  db: AgentDb,
  message: WeldAgentDispatchMessage,
  schedule: Schedule = (job) => enqueueWeldAgentJob(env, undefined, job, db),
): Promise<void> {
  if (message.data && typeof message.data[AGENT_ORIGIN_KEY] === 'string') return;

  const eventKey = `${message.entityType}.${message.action}`;
  const altKey = `${message.entityType}:${message.action}`;

  let agents;
  let routines: Awaited<ReturnType<typeof findEventRoutines>> = [];
  try {
    agents = await findAgentsForEvent(db, eventKey);
    if (agents.length === 0) {
      agents = await findAgentsForEvent(db, altKey);
    }
    routines = await findEventRoutines(db, eventKey);
  } catch (err) {
    console.error('[weldagent/dispatch] find agents failed:', err);
    return;
  }

  if (agents.length === 0 && routines.length === 0) return;

  const payload = JSON.stringify(message.data, null, 2);
  const eventPrompt =
    `A platform event occurred: ${eventKey} on entity ${message.entityId}.\n` +
    `Payload:\n${payload.length > 8000 ? `${payload.slice(0, 8000)}…` : payload}\n\n`;
  const baseTrigger = {
    eventKey,
    entityType: message.entityType,
    action: message.action,
    entityId: message.entityId,
    ...(message.eventId ? { eventId: message.eventId } : {}),
  };

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
        triggerData: { ...baseTrigger, data: message.data },
      });

      await schedule({
        kind: 'agent-run',
        workspaceId: message.workspaceId,
        actorUserId: message.userId || agent.createdBy || 'system',
        agentId: agent.id,
        triggerType: 'event',
        triggerData: baseTrigger,
        userMessage: `${eventPrompt}Follow your instructions and use tools if needed.`,
        extraSystem: `Triggered by entity event ${eventKey}.`,
        runId,
      });
    } catch (err) {
      console.error(`[weldagent/dispatch] agent ${agent.id} failed:`, err);
    }
  }

  for (const routine of routines) {
    try {
      const routineRunId = await createRoutineRun(db, {
        routineId: routine.id,
        agentId: routine.agentId,
        trigger: `event:${eventKey}`,
      });
      await markRoutineScheduled(db, routine);
      await schedule({
        kind: 'agent-run',
        workspaceId: message.workspaceId,
        actorUserId: message.userId || routine.createdBy || 'system',
        agentId: routine.agentId,
        triggerType: 'event',
        triggerData: { ...baseTrigger, routineId: routine.id },
        userMessage:
          `${eventPrompt}Follow routine "${routine.name}":\n${routine.instructions}`,
        extraSystem: routine.requireApproval
          ? 'Require approval before consequential outbound actions.'
          : undefined,
        routineRunId,
      });
    } catch (err) {
      console.error(`[weldagent/dispatch] routine ${routine.id} failed:`, err);
    }
  }
}
