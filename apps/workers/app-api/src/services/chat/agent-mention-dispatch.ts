/**
 * WeldChat multi-agent room replies.
 *
 * When a human (or agent) posts in a channel that has agent members, this
 * selects which agents should respond, runs each through `runAgentOnce`, and
 * posts the reply with `authorType: 'agent'`.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db';
import { schema } from '../../db';
import type { Env } from '../../types';
import { runAgentOnce } from '../weldagent/executor';
import { createAgentRun, completeAgentRun, markRunRunning } from '../weldagent/agents';
import {
  parseAgentRoomPolicy,
  selectAgentsToReply,
  type AgentReplyPolicy,
} from './agent-room-policy';
import { extractChatMentions, postAgentChatMessage } from './post-agent-message';

export interface DispatchAgentMentionsContext {
  db: Database;
  env: Env;
  orgId: string;
  /** The user whose message started the chain (credits / audit). */
  invokerUserId: string;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface DispatchAgentMentionsInput {
  /** Mention ids already filtered to the `agt_` prefix (may be empty when policy=always). */
  agentMentionIds: string[];
  channelId: string;
  messageId: string;
  messageContent: string;
}

export interface DispatchAgentRoomRepliesInput {
  channelId: string;
  messageId: string;
  messageContent: string;
  authorId: string;
  authorType: 'user' | 'agent' | 'system';
  authorName: string;
  mentionedAgentIds: string[];
  hop: number;
  maxHops: number;
  replyPolicy: AgentReplyPolicy;
  parentId?: string | null;
}

/**
 * Entry point used by `postChatMessage` after a human posts.
 * Loads channel policy + agent roster, then fans out replies.
 */
export async function dispatchAgentMentions(
  ctx: DispatchAgentMentionsContext,
  input: DispatchAgentMentionsInput,
): Promise<void> {
  const { db } = ctx;
  const { chatChannels, chatMessages } = schema;

  const [channel] = await db
    .select({ metadata: chatChannels.metadata })
    .from(chatChannels)
    .where(eq(chatChannels.id, input.channelId))
    .limit(1);
  if (!channel) return;

  const [trigger] = await db
    .select({
      authorId: chatMessages.authorId,
      authorType: chatMessages.authorType,
      authorName: chatMessages.authorName,
      parentId: chatMessages.parentId,
    })
    .from(chatMessages)
    .where(eq(chatMessages.id, input.messageId))
    .limit(1);
  if (!trigger) return;

  const policy = parseAgentRoomPolicy(channel.metadata as Record<string, unknown> | null);

  await dispatchAgentRoomReplies(ctx, {
    channelId: input.channelId,
    messageId: input.messageId,
    messageContent: input.messageContent,
    authorId: trigger.authorId,
    authorType: (trigger.authorType as 'user' | 'agent' | 'system') || 'user',
    authorName: trigger.authorName,
    mentionedAgentIds: input.agentMentionIds,
    hop: 0,
    maxHops: policy.agentMaxHops,
    replyPolicy: policy.agentReplyPolicy,
    parentId: trigger.parentId,
  });
}

export async function dispatchAgentRoomReplies(
  ctx: DispatchAgentMentionsContext,
  input: DispatchAgentRoomRepliesInput,
): Promise<void> {
  const { db } = ctx;
  const { chatChannelMembers, weldagentAgents } = schema;

  if (input.replyPolicy === 'none') return;
  if (input.hop > input.maxHops) return;

  const agentMembers = await db
    .select({ userId: chatChannelMembers.userId })
    .from(chatChannelMembers)
    .where(
      and(
        eq(chatChannelMembers.channelId, input.channelId),
        eq(chatChannelMembers.memberType, 'agent'),
      ),
    );
  const agentMemberIds = agentMembers.map((m) => m.userId);
  if (agentMemberIds.length === 0) return;

  const toReply = selectAgentsToReply({
    policy: input.replyPolicy,
    agentMemberIds,
    mentionedAgentIds: input.mentionedAgentIds,
    authorType: input.authorType,
    authorId: input.authorId,
    hop: input.hop,
    maxHops: input.maxHops,
  });
  if (toReply.length === 0) return;

  const activeAgents = await db
    .select({
      id: weldagentAgents.id,
      name: weldagentAgents.name,
      icon: weldagentAgents.icon,
      status: weldagentAgents.status,
      systemPrompt: weldagentAgents.systemPrompt,
      modelId: weldagentAgents.modelId,
      temperature: weldagentAgents.temperature,
      maxTokens: weldagentAgents.maxTokens,
      maxIterations: weldagentAgents.maxIterations,
      permissions: weldagentAgents.permissions,
      enabledTools: weldagentAgents.enabledTools,
    })
    .from(weldagentAgents)
    .where(and(eq(weldagentAgents.status, 'active'), isNull(weldagentAgents.deletedAt)));

  const activeById = new Map(activeAgents.map((a) => [a.id, a]));
  const recent = await loadRecentChannelContext(db, input.channelId, input.messageId);

  for (const agentId of toReply) {
    const agent = activeById.get(agentId);
    if (!agent) continue;

    const runPromise = replyAsAgent({ ctx, agent, input, recent });

    if (ctx.waitUntil) {
      ctx.waitUntil(
        runPromise.catch((e) =>
          console.error(`[app-api/chat] agent ${agentId} room reply failed:`, e),
        ),
      );
    } else {
      try {
        await runPromise;
      } catch (e) {
        console.error(`[app-api/chat] agent ${agentId} room reply failed:`, e);
      }
    }
  }
}

async function loadRecentChannelContext(
  db: Database,
  channelId: string,
  excludeMessageId: string,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const { chatMessages } = schema;
  const rows = await db
    .select({
      id: chatMessages.id,
      authorName: chatMessages.authorName,
      authorType: chatMessages.authorType,
      content: chatMessages.content,
    })
    .from(chatMessages)
    .where(and(eq(chatMessages.channelId, channelId), isNull(chatMessages.deletedAt)))
    .orderBy(desc(chatMessages.createdAt))
    .limit(12);

  return rows
    .reverse()
    .filter((r) => r.id !== excludeMessageId)
    .map((r) => ({
      role: (r.authorType === 'agent' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: `[${r.authorName}]: ${r.content}`,
    }));
}

async function replyAsAgent(params: {
  ctx: DispatchAgentMentionsContext;
  agent: {
    id: string;
    name: string;
    icon: string | null;
    systemPrompt: string;
    modelId: string;
    temperature: string;
    maxTokens: number;
    maxIterations: number;
    permissions: string[] | null;
    enabledTools: string[] | null;
  };
  input: DispatchAgentRoomRepliesInput;
  recent: Array<{ role: 'user' | 'assistant'; content: string }>;
}): Promise<void> {
  const { ctx, agent, input, recent } = params;
  const { db, env, orgId, invokerUserId } = ctx;

  const runId = await createAgentRun(db, {
    agentId: agent.id,
    status: 'queued',
    triggerType: 'chat',
    triggerData: {
      channelId: input.channelId,
      messageId: input.messageId,
      hop: input.hop,
    },
  });
  await markRunRunning(db, runId);

  const extraSystem =
    `You are participating in a WeldChat room. ` +
    `Other humans and agents may be present. Address the latest message. ` +
    `To talk to another agent in this room, mention them as <@agt_ID>. ` +
    `Keep replies concise and useful in a group chat.\n` +
    `Triggering author: ${input.authorName} (${input.authorType}).`;

  try {
    const result = await runAgentOnce({
      env,
      workspaceId: orgId,
      actorUserId: invokerUserId,
      agent: {
        id: agent.id,
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        modelId: agent.modelId,
        temperature: agent.temperature,
        maxTokens: agent.maxTokens,
        maxIterations: Math.min(agent.maxIterations, 8),
        permissions: (agent.permissions ?? []) as string[],
        enabledTools:
          (() => {
            const base = (agent.enabledTools ?? []) as string[];
            const chatTools = ['chat.message_agent', 'chat.create_agent_group'];
            if (base.length === 0) return [];
            return Array.from(new Set([...base, ...chatTools]));
          })(),
      },
      toolContext: {
        db,
        agentId: agent.id,
        actorUserId: invokerUserId,
        workspaceId: orgId,
        channelId: input.channelId,
        env,
        agentHop: input.hop,
        maxAgentHops: input.maxHops,
      },
      messages: [
        ...recent,
        {
          role: 'user',
          content: `[${input.authorName}]: ${input.messageContent}`,
        },
      ],
      extraSystem,
    });

    const text = (result.text || '').trim();
    if (!text) {
      await completeAgentRun(db, {
        runId,
        agentId: agent.id,
        success: true,
        result: { summary: '(empty reply)', actionsPerformed: [] },
        totalIterations: result.steps,
        totalTokensUsed: result.usage.totalTokens ?? 0,
        toolCallCount: result.toolInvocations.length,
      });
      return;
    }

    const posted = await postAgentChatMessage(
      {
        db,
        env,
        orgId,
        channelId: input.channelId,
        agentId: agent.id,
        agentName: agent.name,
        agentIcon: agent.icon,
        invokerUserId,
      },
      {
        content: text,
        parentId: input.parentId ?? null,
        hop: input.hop,
        metadata: {
          replyToMessageId: input.messageId,
          runId,
        },
      },
    );

    await completeAgentRun(db, {
      runId,
      agentId: agent.id,
      success: true,
      result: {
        summary: text.slice(0, 2000),
        actionsPerformed: result.toolInvocations
          .filter((t) => t.state === 'result' || t.state === 'error')
          .map((t) => ({
            tool: t.toolName,
            description: t.state === 'error' ? 'failed' : 'ok',
            success: t.state === 'result',
          })),
        toolInvocations: result.toolInvocations,
      },
      totalIterations: result.steps,
      totalTokensUsed:
        (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0) ||
        result.usage.totalTokens ||
        0,
      toolCallCount: result.toolInvocations.length,
    });

    // Agent→agent mention chain (next hop).
    const nextMentions = extractChatMentions(text).filter(
      (m) => m.startsWith('agt_') && m !== agent.id,
    );
    if (nextMentions.length > 0 && input.hop + 1 <= input.maxHops) {
      const hopPromise = dispatchAgentRoomReplies(ctx, {
        channelId: input.channelId,
        messageId: posted.id,
        messageContent: text,
        authorId: agent.id,
        authorType: 'agent',
        authorName: agent.name,
        mentionedAgentIds: nextMentions,
        hop: input.hop + 1,
        maxHops: input.maxHops,
        replyPolicy: input.replyPolicy,
        parentId: input.parentId ?? null,
      });
      if (ctx.waitUntil) {
        ctx.waitUntil(
          hopPromise.catch((e) => console.error('[app-api/chat] agent hop dispatch failed:', e)),
        );
      } else {
        await hopPromise;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Agent room reply failed';
    await completeAgentRun(db, {
      runId,
      agentId: agent.id,
      success: false,
      error: message,
      totalIterations: 0,
      totalTokensUsed: 0,
      toolCallCount: 0,
    });
    throw err;
  }
}
