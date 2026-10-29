/**
 * Run (or decline) the tool call behind a decided WeldAgent approval.
 *
 * High-risk tools don't run during the agent turn — they park a pending
 * approval. Approving it runs the stored call here, with the agent's grants
 * narrowed to the approver's, and posts the outcome back into the
 * conversation the request came from.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Env } from '../../types';
import { getAgent, type AgentDb } from '@weldsuite/agent-domain/agents';
import { APPROVAL_OUTCOME_KIND, persistAssistantMessage } from '@weldsuite/agent-domain/complete-turn';
import type { StoredToolInvocation } from '@weldsuite/agent-domain/executor';
import { effectiveAgentPermissions, findAgentToolByName } from '@weldsuite/agent-domain/tools';
import { approvedOutcome, failedOutcome, rejectedOutcome } from '@weldsuite/agent-domain/approval-labels';

export interface ApprovalExecution {
  ran: boolean;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface DecidedApproval {
  id: string;
  agentId: string;
  conversationId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  status: string;
}

type ApprovalOrigin =
  | { kind: 'conversation'; id: string }
  | { kind: 'channel'; id: string }
  | { kind: 'none' };

/**
 * Where the approval was requested: a WeldAgent conversation (chat panel) or a
 * WeldChat room (`conversationId` then holds the channel id).
 */
async function resolveOrigin(db: AgentDb, id: string | null): Promise<ApprovalOrigin> {
  if (!id) return { kind: 'none' };
  const { weldagentConversations: c, chatChannels: ch } = schema;
  const [conversation] = await db
    .select({ id: c.id })
    .from(c)
    .where(and(eq(c.id, id), isNull(c.deletedAt)))
    .limit(1);
  if (conversation) return { kind: 'conversation', id };
  const [channel] = await db.select({ id: ch.id }).from(ch).where(eq(ch.id, id)).limit(1);
  return channel ? { kind: 'channel', id } : { kind: 'none' };
}

/**
 * The agent's reply that carried this approval in a room (`metadata.approvals`)
 * learns the decision, so its Approve / Reject buttons go away, for everyone
 * looking at the room right now too. Never throws.
 */
async function markChannelApprovalDecided(
  db: AgentDb,
  env: Env,
  channelId: string,
  approvalId: string,
  status: 'approved' | 'rejected',
): Promise<void> {
  try {
    const { chatMessages: m } = schema;
    const [row] = await db
      .select({ id: m.id, metadata: m.metadata })
      .from(m)
      .where(
        and(
          eq(m.channelId, channelId),
          sql`${m.metadata} @> ${JSON.stringify({ approvals: [{ id: approvalId }] })}::jsonb`,
        ),
      )
      .limit(1);
    if (!row) return;
    const metadata = (row.metadata ?? {}) as { approvals?: Array<Record<string, unknown>> };
    const approvals = (metadata.approvals ?? []).map((entry) => (entry.id === approvalId ? { ...entry, status } : entry));
    const next = { ...metadata, approvals };
    await db.update(m).set({ metadata: next, updatedAt: new Date() }).where(eq(m.id, row.id));
    // Only the metadata changed: the message is not marked edited.
    const { publishChatMessageUpdated } = await import('@weldsuite/chat-domain/realtime/weldchat-publisher');
    await publishChatMessageUpdated(env, channelId, { id: row.id, metadata: next });
  } catch (err) {
    console.error('[weldagent/approvals] updating the room message failed:', err);
  }
}

export async function executeDecidedApproval(params: {
  db: AgentDb;
  env: Env;
  workspaceId: string;
  approval: DecidedApproval;
  deciderUserId: string;
  deciderPermissions: string[];
}): Promise<ApprovalExecution> {
  const { db, approval } = params;
  const origin = await resolveOrigin(db, approval.conversationId);
  const agent = await getAgent(db, approval.agentId);

  /** Post the outcome back where the approval was requested. */
  const report = async (content: string, invocation?: StoredToolInvocation) => {
    try {
      if (origin.kind === 'conversation') {
        await persistAssistantMessage({
          db,
          conversationId: origin.id,
          content,
          toolInvocations: invocation ? [invocation] : undefined,
          metadata: { kind: APPROVAL_OUTCOME_KIND, approvalId: approval.id },
        });
      } else if (origin.kind === 'channel' && agent) {
        const { postAgentChatMessage } = await import('@weldsuite/chat-domain/post-agent-message');
        await postAgentChatMessage(
          {
            db: db as never,
            env: params.env,
            orgId: params.workspaceId,
            channelId: origin.id,
            agentId: agent.id,
            agentName: agent.name,
            invokerUserId: params.deciderUserId,
          },
          { content, hop: 0 },
        );
      }
    } catch (err) {
      console.error('[weldagent/approvals] posting outcome failed:', err);
    }
  };

  if (origin.kind === 'channel' && (approval.status === 'approved' || approval.status === 'rejected')) {
    await markChannelApprovalDecided(db, params.env, origin.id, approval.id, approval.status);
  }

  if (approval.status !== 'approved') {
    await report(rejectedOutcome(approval.toolName, approval.args));
    return { ran: false, ok: true };
  }

  if (!agent) return { ran: false, ok: false, error: 'Agent not found' };

  const tool = findAgentToolByName(
    effectiveAgentPermissions(agent.permissions, params.deciderPermissions),
    agent.enabledTools,
    approval.toolName,
  );
  if (!tool) {
    const error = 'This action is no longer available to this agent, or you lack the permission it needs.';
    await report(failedOutcome(approval.toolName, approval.args, error));
    return { ran: false, ok: false, error };
  }

  let invocation: StoredToolInvocation;
  let execution: ApprovalExecution;
  try {
    const result = await tool.execute(
      {
        db,
        agentId: agent.id,
        actorUserId: params.deciderUserId,
        workspaceId: params.workspaceId,
        env: params.env,
        conversationId: origin.kind === 'conversation' ? origin.id : undefined,
        channelId: origin.kind === 'channel' ? origin.id : undefined,
      },
      approval.args,
    );
    const failed =
      !!result && typeof result === 'object' && typeof (result as { error?: unknown }).error === 'string';
    invocation = { toolName: tool.name, state: failed ? 'error' : 'result', args: approval.args, result };
    execution = failed
      ? { ran: true, ok: false, result, error: (result as { error: string }).error }
      : { ran: true, ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Tool failed';
    invocation = { toolName: tool.name, state: 'error', args: approval.args, result: { error: message } };
    execution = { ran: true, ok: false, error: message };
  }

  await report(
    execution.ok
      ? approvedOutcome(tool.name, approval.args, execution.result)
      : failedOutcome(tool.name, approval.args, execution.error ?? 'it failed'),
    invocation,
  );
  return execution;
}
