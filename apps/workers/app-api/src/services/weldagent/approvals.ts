/**
 * Run (or decline) the tool call behind a decided WeldAgent approval.
 *
 * High-risk tools don't run during the agent turn — they park a pending
 * approval. Approving it runs the stored call here, with the agent's grants
 * narrowed to the approver's, and posts the outcome back into the
 * conversation the request came from.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '../../db';
import type { Env } from '../../types';
import { getAgent, type AgentDb } from './agents';
import { APPROVAL_OUTCOME_KIND, persistAssistantMessage } from './complete-turn';
import type { StoredToolInvocation } from './executor';
import { effectiveAgentPermissions, findAgentToolByName } from './tools';

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

function describeResult(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  const label = [r.name, r.fullName, r.title, r.subject, r.ticketNumber].find(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  return label ? ` (${label})` : '';
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
        const { postAgentChatMessage } = await import('../chat/post-agent-message');
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

  if (approval.status !== 'approved') {
    await report(`The "${approval.toolName}" action was rejected, so I did not run it.`);
    return { ran: false, ok: true };
  }

  if (!agent) return { ran: false, ok: false, error: 'Agent not found' };

  const tool = findAgentToolByName(
    effectiveAgentPermissions(agent.permissions, params.deciderPermissions),
    agent.enabledTools,
    approval.toolName,
  );
  if (!tool) {
    const error =
      `"${approval.toolName}" is no longer available to this agent, or you lack the permission it needs.`;
    await report(`Approved, but I could not run it: ${error}`);
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
      ? `Approved and done: ran "${tool.name}"${describeResult(execution.result)}.`
      : `Approved, but "${tool.name}" failed: ${execution.error}`,
    invocation,
  );
  return execution;
}
