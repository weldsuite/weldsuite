/**
 * Entity-event → WeldAgent dispatch.
 *
 * Phase 5: invoked from the entity-agents queue consumer on app-api (via the
 * registered runner hook). Hub retries re-deliver the same evt_ id — skip
 * agents that already have a run for that eventId. Runs execute in the durable
 * WeldAgent job workflow, so a slow agent never stalls the queue batch.
 */

import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { findAgentsForEvent, createAgentRun } from '@weldsuite/agent-domain/agents';
import {
  findEventRoutines,
  createRoutineRun,
  markRoutineScheduled,
  hasRoutineRunForTrigger,
} from '@weldsuite/agent-domain/parity';
import { enqueueWeldAgentJob, type WeldAgentJob } from '@weldsuite/agent-domain/jobs';

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
type MatchedAgent = Awaited<ReturnType<typeof findAgentsForEvent>>[number];
type MatchedRoutine = Awaited<ReturnType<typeof findEventRoutines>>[number];

/** What every run scheduled for one entity event has in common. */
interface EventDispatchContext {
  db: AgentDb;
  schedule: Schedule;
  message: WeldAgentDispatchMessage;
  eventKey: string;
  eventPrompt: string;
  baseTrigger: Record<string, unknown>;
}

/**
 * Look up the agents (falling back to the `type:action` key) and event
 * routines subscribed to an event. Returns null when the lookup fails.
 */
async function findEventSubscribers(
  db: AgentDb,
  eventKey: string,
  altKey: string,
): Promise<{ agents: MatchedAgent[]; routines: MatchedRoutine[] } | null> {
  try {
    let agents = await findAgentsForEvent(db, eventKey);
    if (agents.length === 0) {
      agents = await findAgentsForEvent(db, altKey);
    }
    const routines = await findEventRoutines(db, eventKey);
    return { agents, routines };
  } catch (err) {
    console.error('[weldagent/dispatch] find agents failed:', err);
    return null;
  }
}

async function dispatchToAgent(ctx: EventDispatchContext, agent: MatchedAgent): Promise<void> {
  const { db, schedule, message, eventKey, eventPrompt, baseTrigger } = ctx;
  try {
    if (message.eventId) {
      const exists = await hasExistingAgentRunForEvent(db, agent.id, message.eventId);
      if (exists) {
        console.log(
          `[weldagent/dispatch] Skipping duplicate event ${message.eventId} for agent ${agent.id}`,
        );
        return;
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

async function dispatchToRoutine(ctx: EventDispatchContext, routine: MatchedRoutine): Promise<void> {
  const { db, schedule, message, eventKey, eventPrompt, baseTrigger } = ctx;
  try {
    // Hub retries re-deliver the same evt_ id: key the run on it so a
    // redelivery never starts the routine twice.
    const trigger = message.eventId ? `evt:${message.eventId}` : `event:${eventKey}`;
    if (message.eventId && (await hasRoutineRunForTrigger(db, routine.id, trigger))) {
      return;
    }
    const routineRunId = await createRoutineRun(db, {
      routineId: routine.id,
      agentId: routine.agentId,
      trigger,
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
      routineRunId,
      skipApprovals: !routine.requireApproval,
    });
  } catch (err) {
    console.error(`[weldagent/dispatch] routine ${routine.id} failed:`, err);
  }
}

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

  const subscribers = await findEventSubscribers(db, eventKey, altKey);
  if (!subscribers) return;
  const { agents, routines } = subscribers;

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
  const ctx: EventDispatchContext = { db, schedule, message, eventKey, eventPrompt, baseTrigger };

  for (const agent of agents) {
    await dispatchToAgent(ctx, agent);
  }
  for (const routine of routines) {
    await dispatchToRoutine(ctx, routine);
  }
}
