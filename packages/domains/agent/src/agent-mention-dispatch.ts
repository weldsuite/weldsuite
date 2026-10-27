/**
 * WeldChat multi-agent room replies.
 *
 * When a human (or agent) posts in a channel that has agent members, this
 * selects which agents should respond, runs each through `runAgentOnce`, and
 * posts the reply with `authorType: 'agent'`.
 *
 * Replies are background work (the durable WeldAgent job): while an agent runs,
 * the room shows "<agent> is working…"; the reply quotes the message that
 * asked and notifies its author; a failed turn answers with what went wrong
 * instead of staying silent.
 */

import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import type { WeldAgentEnv as Env } from './env';
import { runAgentOnce } from './executor';
import { approvalsNotice, pendingApprovalsOf } from './approval-labels';
import { explicitToolAllowList } from './tools';
import { resolveActorPermissions } from './actor-permissions';
import { createAgentRun, completeAgentRun, markRunRunning } from './agents';
import {
  parseAgentRoomPolicy,
  selectAgentsToReply,
  type AgentReplyPolicy,
} from '@weldsuite/chat-domain/agent-room-policy';
import {
  extractChatMentions,
  postAgentChatMessage,
  startAgentWorkingIndicator,
} from '@weldsuite/chat-domain/post-agent-message';
import { buildReplyReference, type ChatReplyReference } from '@weldsuite/chat-domain/reply-reference';

export interface DispatchAgentMentionsContext {
  db: Database;
  env: Env;
  orgId: string;
  /** The user whose message started the chain (credits / audit). */
  invokerUserId: string;
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Tool-loop budget per reply (longer inside the durable job workflow). */
  timeoutMs?: number;
  /**
   * Permissions of the human who started the chain. Agents never act beyond
   * them; resolved from `invokerUserId` when not supplied.
   */
  actorPermissions?: string[];
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

/** How many earlier messages an agent reads before the one it answers. */
const ROOM_CONTEXT_LIMIT = 12;

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

  // Any status answers a mention (draft and paused agents still chat, like in
  // their own panel); unprompted "always" replies are for active agents only,
  // the way pausing stops routines and event triggers.
  const roomAgents = await db
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
    .where(and(inArray(weldagentAgents.id, toReply), isNull(weldagentAgents.deletedAt)));

  const mentioned = new Set(input.mentionedAgentIds);
  const agentsById = new Map(
    roomAgents.filter((a) => mentioned.has(a.id) || a.status === 'active').map((a) => [a.id, a]),
  );
  const [recent, replyTo, roomBrief] = await Promise.all([
    loadRoomContext(db, input.channelId, input.messageId, input.parentId ?? null),
    loadReplyReference(db, input.messageId),
    describeRoom(db, input.channelId),
  ]);
  // Resolve once per dispatch; hop replies reuse it through ctx.
  const actorCtx: DispatchAgentMentionsContext = {
    ...ctx,
    actorPermissions: ctx.actorPermissions ?? (await resolveActorPermissions(db as never, ctx.invokerUserId)),
  };

  // Every addressed agent works at the same time; one slow or failing agent
  // never holds up (or silences) the others.
  const runs = toReply.flatMap((agentId) => {
    const agent = agentsById.get(agentId);
    if (!agent) return [];
    return [
      replyAsAgent({ ctx: actorCtx, agent, input, recent, replyTo, roomBrief }).catch((e) =>
        console.error(`[weldagent/room] agent ${agentId} room reply failed:`, e),
      ),
    ];
  });

  if (ctx.waitUntil) {
    for (const run of runs) ctx.waitUntil(run);
  } else {
    await Promise.all(runs);
  }
}

/**
 * What the room is, for the agent's instructions. A record chat names its
 * record (type, name and id), so the agent can look it up with its tools.
 */
export async function describeRoom(db: Database, channelId: string): Promise<string> {
  const { chatChannels } = schema;
  const [room] = await db
    .select({
      name: chatChannels.name,
      type: chatChannels.type,
      entityType: chatChannels.entityType,
      entityId: chatChannels.entityId,
      entityDisplayName: chatChannels.entityDisplayName,
    })
    .from(chatChannels)
    .where(eq(chatChannels.id, channelId))
    .limit(1);
  if (!room) return 'You are in a WeldChat room.';
  if (room.type === 'entity' && room.entityType && room.entityId) {
    const title = room.entityDisplayName || room.name;
    return (
      `You are in the chat of a ${room.entityType} record: "${title}" (id ${room.entityId}). ` +
      `Questions here are usually about that ${room.entityType}; look it up with your tools when needed.`
    );
  }
  return `You are in the WeldChat channel "${room.name}".`;
}

/** The quote shown above an agent's reply: the message it answers. */
async function loadReplyReference(db: Database, messageId: string): Promise<ChatReplyReference | null> {
  const { chatMessages } = schema;
  const [target] = await db
    .select({
      id: chatMessages.id,
      authorId: chatMessages.authorId,
      authorName: chatMessages.authorName,
      authorAvatar: chatMessages.authorAvatar,
      content: chatMessages.content,
      hasAttachments: chatMessages.hasAttachments,
      metadata: chatMessages.metadata,
    })
    .from(chatMessages)
    .where(and(eq(chatMessages.id, messageId), isNull(chatMessages.deletedAt)))
    .limit(1);
  return target ? buildReplyReference(target) : null;
}

/**
 * What the agent reads before the message it answers: the thread it was asked
 * in (its opening message included), or else the room's main conversation.
 */
async function loadRoomContext(
  db: Database,
  channelId: string,
  excludeMessageId: string,
  threadId: string | null,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const { chatMessages } = schema;
  const scope = threadId
    ? or(eq(chatMessages.id, threadId), eq(chatMessages.parentId, threadId))
    : isNull(chatMessages.parentId);
  const rows = await db
    .select({
      id: chatMessages.id,
      authorName: chatMessages.authorName,
      authorType: chatMessages.authorType,
      content: chatMessages.content,
    })
    .from(chatMessages)
    .where(and(eq(chatMessages.channelId, channelId), isNull(chatMessages.deletedAt), scope))
    .orderBy(desc(chatMessages.createdAt))
    .limit(ROOM_CONTEXT_LIMIT);

  return rows
    .reverse()
    .filter((r) => r.id !== excludeMessageId)
    .map((r) => ({
      role: (r.authorType === 'agent' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: `[${r.authorName}]: ${r.content}`,
    }));
}

/** The reply a failed turn leaves in the room, so the asker is not left waiting. */
export function roomFailureReply(err: unknown): string {
  const reason = err instanceof Error ? err.message.trim() : '';
  return reason
    ? `Sorry, I could not finish this (${reason}). Try again in a moment.`
    : 'Sorry, I could not finish this. Try again in a moment.';
}

interface RoomAgent {
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
}

/** The agent's tools for a room reply: its own, plus the room tools when it has an allow-list. */
function roomReplyTools(enabledTools: string[] | null): string[] {
  const flags = enabledTools ?? [];
  const base = explicitToolAllowList(flags);
  // No explicit allow-list: keep flags only, so every granted tool stays on.
  if (base.length === 0) return flags;
  return Array.from(new Set([...flags, 'chat.message_agent', 'chat.create_agent_group']));
}

async function replyAsAgent(params: {
  ctx: DispatchAgentMentionsContext;
  agent: RoomAgent;
  input: DispatchAgentRoomRepliesInput;
  recent: Array<{ role: 'user' | 'assistant'; content: string }>;
  replyTo: ChatReplyReference | null;
  roomBrief: string;
}): Promise<void> {
  const { ctx, agent, input, recent, replyTo, roomBrief } = params;
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
    `${roomBrief} ` +
    `Other humans and agents may be present. Address the latest message. ` +
    `You work in the background: the room sees that you are working, and your reply is ` +
    `posted when you finish, so do the work first and then report what you did. ` +
    `To talk to another agent in this room, mention them as <@agt_ID>. ` +
    `Keep replies concise and useful in a group chat.\n` +
    `Triggering author: ${input.authorName} (${input.authorType}).`;

  const post = (content: string, metadata: Record<string, unknown>) =>
    postAgentChatMessage(
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
        content,
        parentId: input.parentId ?? null,
        hop: input.hop,
        replyTo,
        // A person who asked gets pinged when the answer lands; agents don't.
        notifyUserIds: input.authorType === 'user' ? [input.authorId] : [],
        metadata: { replyToMessageId: input.messageId, runId, ...metadata },
      },
    );

  const stopWorking = startAgentWorkingIndicator(env, input.channelId, agent);
  let result: Awaited<ReturnType<typeof runAgentOnce>>;
  try {
    result = await runAgentOnce({
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
        permissions: agent.permissions ?? [],
        autoReviewEnabled: (agent.enabledTools ?? []).includes('agent.auto_review'),
        enabledTools: roomReplyTools(agent.enabledTools),
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
      timeoutMs: ctx.timeoutMs,
      actorPermissions: ctx.actorPermissions ?? [],
    });
  } catch (err) {
    await stopWorking();
    try {
      await post(roomFailureReply(err), { failed: true });
    } catch (postErr) {
      console.error('[weldagent/room] posting the failure reply failed:', postErr);
    }
    await completeAgentRun(db, {
      runId,
      agentId: agent.id,
      success: false,
      error: err instanceof Error ? err.message : 'Agent room reply failed',
      totalIterations: 0,
      totalTokensUsed: 0,
      toolCallCount: 0,
    });
    throw err;
  }
  await stopWorking();

  // Actions the agent parked for approval ride on its reply, so the room can
  // show Approve / Reject under it; with nothing else to say, it says that.
  const approvals = pendingApprovalsOf(result.toolInvocations);
  const text = (result.text || '').trim() || (approvals.length > 0 ? approvalsNotice(approvals) : '');
  const posted = text ? await post(text, approvals.length > 0 ? { approvals } : {}) : null;
  await completeAgentRun(db, {
    runId,
    agentId: agent.id,
    success: true,
    result: {
      summary: text ? text.slice(0, 2000) : '(empty reply)',
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

  if (posted) await dispatchNextHop(ctx, input, agent, { id: posted.id, text });
}

/** Agent→agent mention chain: agents this reply mentions answer it next. */
async function dispatchNextHop(
  ctx: DispatchAgentMentionsContext,
  input: DispatchAgentRoomRepliesInput,
  agent: RoomAgent,
  reply: { id: string; text: string },
): Promise<void> {
  const nextMentions = extractChatMentions(reply.text).filter((m) => m.startsWith('agt_') && m !== agent.id);
  if (nextMentions.length === 0 || input.hop + 1 > input.maxHops) return;

  const hopPromise = dispatchAgentRoomReplies(ctx, {
    channelId: input.channelId,
    messageId: reply.id,
    messageContent: reply.text,
    authorId: agent.id,
    authorType: 'agent',
    authorName: agent.name,
    mentionedAgentIds: nextMentions,
    hop: input.hop + 1,
    maxHops: input.maxHops,
    replyPolicy: input.replyPolicy,
    parentId: input.parentId ?? null,
  }).catch((e) => console.error('[weldagent/room] agent hop dispatch failed:', e));
  if (ctx.waitUntil) ctx.waitUntil(hopPromise);
  else await hopPromise;
}
