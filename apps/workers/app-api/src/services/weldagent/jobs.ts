/**
 * Durable WeldAgent background jobs.
 *
 * Agent work (a tool loop that may take minutes: several model calls, sandbox
 * commands, browser steps) must not run in `executionCtx.waitUntil` after the
 * HTTP response — Cloudflare cancels that work ~30s after the response is sent,
 * which silently dropped replies (no assistant row, client polls until it
 * times out). Jobs run in the `WeldAgentJobWorkflow` instead; when the binding
 * is missing (older local configs) they fall back to `waitUntil`.
 *
 * Payloads stay small and serializable: each job reloads its state from the
 * tenant DB when it runs.
 */

import type { Env } from '../../types';
import { getTenantDbForWorkspace } from '../../db';
import type { AgentDb } from './agents';
import {
  finishAcceptedTurn,
  loadAcceptedTurn,
  type AcceptedTurnRef,
} from './complete-turn';
import { BACKGROUND_RUN_TIMEOUT_MS } from './executor';
import { executeAgentRun } from './run';

export type WeldAgentJob =
  | ({ kind: 'chat-turn' } & AcceptedTurnRef)
  | {
      kind: 'agent-run';
      workspaceId: string;
      actorUserId: string;
      agentId: string;
      triggerType: 'manual' | 'event' | 'chat';
      triggerData?: Record<string, unknown>;
      userMessage: string;
      extraSystem?: string;
      /** Existing queued agent run row to reuse (event idempotency). */
      runId?: string;
      /** Routine run to close out with the agent result. */
      routineRunId?: string;
      /** Routine with "ask for approval" off — see AgentExecutorInput.skipApprovals. */
      skipApprovals?: boolean;
    }
  | {
      kind: 'chat-room';
      workspaceId: string;
      invokerUserId: string;
      agentMentionIds: string[];
      channelId: string;
      messageId: string;
      messageContent: string;
    };

/**
 * Run a job to completion in the current invocation. Throws on failure so the
 * workflow step is marked errored (visible in the dashboard); user-facing
 * failure state (error reply, failed run row) is persisted before that.
 */
export async function runWeldAgentJob(env: Env, job: WeldAgentJob, db?: AgentDb): Promise<void> {
  try {
    const tenantDb = db ?? ((await getTenantDbForWorkspace(env, job.workspaceId)) as AgentDb);
    switch (job.kind) {
      case 'chat-turn': {
        const accepted = await loadAcceptedTurn(tenantDb, job);
        if (!accepted) return;
        await finishAcceptedTurn({
          db: tenantDb,
          env,
          accepted,
          timeoutMs: BACKGROUND_RUN_TIMEOUT_MS,
        });
        return;
      }
      case 'agent-run': {
        const { completeRoutineRun } = await import('./parity');
        try {
          const result = await executeAgentRun({
            db: tenantDb,
            env,
            workspaceId: job.workspaceId,
            actorUserId: job.actorUserId,
            agentId: job.agentId,
            triggerType: job.triggerType,
            triggerData: job.triggerData,
            userMessage: job.userMessage,
            extraSystem: job.extraSystem,
            runId: job.runId,
            timeoutMs: BACKGROUND_RUN_TIMEOUT_MS,
            skipApprovals: job.skipApprovals,
          });
          if (job.routineRunId) {
            await completeRoutineRun(tenantDb, job.routineRunId, {
              status: result.success ? 'succeeded' : 'failed',
              summary: result.text,
              error: result.error,
              agentRunId: result.runId,
            });
          }
        } catch (err) {
          if (job.routineRunId) {
            await completeRoutineRun(tenantDb, job.routineRunId, {
              status: 'failed',
              error: err instanceof Error ? err.message : 'Agent run failed',
            });
          }
          throw err;
        }
        return;
      }
      case 'chat-room': {
        const { dispatchAgentMentions } = await import('../chat/agent-mention-dispatch');
        await dispatchAgentMentions(
          {
            db: tenantDb as never,
            env,
            orgId: job.workspaceId,
            invokerUserId: job.invokerUserId,
            timeoutMs: BACKGROUND_RUN_TIMEOUT_MS,
          },
          {
            agentMentionIds: job.agentMentionIds,
            channelId: job.channelId,
            messageId: job.messageId,
            messageContent: job.messageContent,
          },
        );
        return;
      }
    }
  } catch (err) {
    console.error(`[weldagent/jobs] ${job.kind} job failed:`, err);
    throw err;
  }
}

async function instanceExists(binding: Workflow<WeldAgentJob>, id: string): Promise<boolean> {
  try {
    await binding.get(id);
    return true;
  } catch {
    return false;
  }
}

function instanceIdFor(job: WeldAgentJob): string | undefined {
  // One instance per user turn, so a retried request can't answer twice.
  if (job.kind === 'chat-turn') return `turn-${job.userMessageId}`;
  return undefined;
}

/**
 * Hand a job to the durable workflow. Falls back to `waitUntil` (best effort,
 * ~30s budget) when the WELDAGENT_JOB binding is not configured.
 */
export async function enqueueWeldAgentJob(
  env: Env,
  waitUntil: ((p: Promise<unknown>) => void) | undefined,
  job: WeldAgentJob,
  db?: AgentDb,
): Promise<void> {
  if (env.WELDAGENT_JOB) {
    const id = instanceIdFor(job);
    try {
      await env.WELDAGENT_JOB.create({ id, params: job });
      return;
    } catch (err) {
      // A retried request re-creates the same instance id: the job is already
      // queued, so running it inline too would answer (and act) twice.
      if (id && (await instanceExists(env.WELDAGENT_JOB, id))) return;
      console.error('[weldagent/jobs] workflow create failed, running inline:', err);
    }
  }
  const work = runWeldAgentJob(env, job, db).catch(() => undefined);
  if (waitUntil) waitUntil(work);
  else await work;
}
