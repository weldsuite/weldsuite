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
import { findAgentsForEvent, createAgentRun, getAgent } from '@weldsuite/agent-domain/agents';
import {
  findEventRoutines,
  createRoutineRun,
  markRoutineScheduled,
  hasRoutineRunForTrigger,
} from '@weldsuite/agent-domain/parity';
import { enqueueWeldAgentJob, type WeldAgentJob } from '@weldsuite/agent-domain/jobs';
import { memberCanUseAgent } from '@weldsuite/agent-domain/access';

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

/** What an assignment (instead of a subscription) tells the agent to do. */
interface AgentTask {
  userMessage: string;
  extraSystem: string;
}

async function dispatchToAgent(
  ctx: EventDispatchContext,
  agent: Pick<MatchedAgent, 'id' | 'createdBy'>,
  task?: AgentTask,
): Promise<void> {
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
      userMessage: task?.userMessage ?? `${eventPrompt}Follow your instructions and use tools if needed.`,
      extraSystem: task?.extraSystem ?? `Triggered by entity event ${eventKey}.`,
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

/** The event a member assigns a WeldMerge issue to an agent with (merge-api `PATCH /issues/:id {agentId}`). */
export const MERGE_AGENT_ASSIGNED = { entityType: 'merge_issue', action: 'agent_assigned' } as const;

/**
 * An issue assigned to an agent (AGENT-009): that agent, whether or not it
 * subscribes to the event, runs with the issue as its task. The agent works
 * through the `merge_*` tools, so it can only do what its grants and the
 * member who assigned it allow. The member who assigned it must be able to
 * use that agent themselves, as in the chat (`weldagent:use` and access to the
 * agent, checked now): otherwise the run is dropped, so assigning an issue
 * never runs an agent the assigner could not.
 */
async function dispatchAssignedIssue(ctx: EventDispatchContext): Promise<void> {
  const { db, message } = ctx;
  const agentId = typeof message.data.agentId === 'string' ? message.data.agentId : null;
  if (!agentId) return;
  const agent = await getAgent(db, agentId).catch(() => null);
  if (!agent || agent.status !== 'active') return;
  const allowed = await memberCanUseAgent(db, agent, message.userId).catch((err: unknown) => {
    console.error('[weldagent/dispatch] could not check the member who assigned the issue:', err);
    return false;
  });
  if (!allowed) {
    console.warn(
      `[weldagent/dispatch] Dropped the assignment of ${message.entityId} to agent ${agent.id}: the member who assigned it cannot use that agent`,
    );
    return;
  }
  const key = typeof message.data.key === 'string' ? message.data.key : message.entityId;
  const title = typeof message.data.title === 'string' && message.data.title ? ` "${message.data.title}"` : '';
  const userMessage =
    `A WeldMerge issue has been assigned to you: ${key}${title} (issue id ${message.entityId}).\n` +
    'Read it with merge_get_issue, do the work it asks for with your tools, and report what you did with ' +
    'merge_comment_on_issue. Move it to in_review or done with merge_update_issue when you are finished.';
  await dispatchToAgent(ctx, agent, {
    userMessage,
    extraSystem: `You were assigned WeldMerge issue ${key}. Triggered by entity event merge_issue.agent_assigned.`,
  });
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
  const { agents, routines } = subscribers ?? { agents: [], routines: [] };
  const assigned =
    message.entityType === MERGE_AGENT_ASSIGNED.entityType && message.action === MERGE_AGENT_ASSIGNED.action;

  if (agents.length === 0 && routines.length === 0 && !assigned) return;

  const payload = JSON.stringify(message.data, null, 2);
  const shownPayload = payload.length > 8000 ? `${payload.slice(0, 8000)}…` : payload;
  const eventPrompt =
    `A platform event occurred: ${eventKey} on entity ${message.entityId}.\n` +
    `Payload:\n${shownPayload}\n\n`;
  const baseTrigger = {
    eventKey,
    entityType: message.entityType,
    action: message.action,
    entityId: message.entityId,
    ...(message.eventId ? { eventId: message.eventId } : {}),
  };
  const ctx: EventDispatchContext = { db, schedule, message, eventKey, eventPrompt, baseTrigger };

  if (assigned) await dispatchAssignedIssue(ctx);
  for (const agent of agents) {
    await dispatchToAgent(ctx, agent);
  }
  for (const routine of routines) {
    await dispatchToRoutine(ctx, routine);
  }
}
