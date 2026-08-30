/**
 * Server-owned WeldAgent chat turn.
 *
 * Persists the user message, generates a reply (workspace agent or personal
 * assistant), persists the assistant message, and notifies the owner. The
 * route wraps this in `waitUntil` so a backgrounded mobile client still gets
 * a completed turn + push.
 */

import { and, eq, isNull } from 'drizzle-orm';
import {
  generateText,
  recommended,
  runWithFallback,
  isGatewayConfigured,
} from '@weldsuite/ai';
import { readGatewayCreditSnapshot, toCreditStates } from '@weldsuite/credits/gateway-cache';
import type { Gateway } from '@weldsuite/credits/gateway-costs';
import {
  sendWeldAgentReplyNotification,
} from '@weldsuite/notifications';
import type { Database as NotificationDatabase, NotificationEnv } from '@weldsuite/notifications/types';
import type { CompleteTurnResult, WeldAgentMessageRow } from '@weldsuite/app-api-client/schemas/weldagent';
import type { Env } from '../../types';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import {
  resolveAiMetering,
  assertAiCredits,
  chargeAiUsage,
} from '../ai/billing';
import { getAgent, type AgentDb } from './agents';
import { runAgentOnce } from './executor';

const WELDAGENT_SYSTEM =
  'You are WeldAgent, the AI assistant built into the WeldSuite business platform. ' +
  'You help the user with their CRM, mail, projects, tasks, helpdesk, commerce and ' +
  'accounting work. Be concise, direct and practical. Use plain text — no markdown ' +
  'headings — and keep answers short unless the user asks for detail. If you are not ' +
  'sure about something in the user\'s workspace, say so rather than inventing data.';

export class ConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`Conversation not found: ${conversationId}`);
    this.name = 'ConversationNotFoundError';
  }
}

export interface TurnGeneratorResult {
  text: string;
  creditsUsed: number;
  toolInvocations?: unknown[];
  success: boolean;
  error?: string;
}

export type TurnGenerator = (input: {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  agentId: string | null;
}) => Promise<TurnGeneratorResult>;

function serializeMessage(row: typeof schema.weldagentMessages.$inferSelect): WeldAgentMessageRow {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as WeldAgentMessageRow['role'],
    content: row.content,
    toolInvocations: row.toolInvocations ?? null,
    formState: row.formState ?? null,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function generatePersonalReply(params: {
  env: Env;
  workspaceId: string;
  userId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}): Promise<TurnGeneratorResult> {
  if (!isGatewayConfigured(params.env)) {
    throw new Error('AI gateway is not configured');
  }

  const metering = await resolveAiMetering(params.env, params.workspaceId, params.userId);
  await assertAiCredits(metering);

  const modelId = recommended.copilot.free;
  const credits = params.env.WORKSPACE_CACHE
    ? toCreditStates(await readGatewayCreditSnapshot(params.env.WORKSPACE_CACHE))
    : [];

  let served: { gateway: Gateway; providerCostUsd: number; covered: boolean } | undefined;
  const { value: result } = await runWithFallback(
    params.env,
    {
      modelId,
      op: 'chat',
      credits,
      onUsage: (rec) => {
        served = {
          gateway: rec.gateway as Gateway,
          providerCostUsd: rec.providerCostUsd,
          covered: rec.coveredByServiceCredit,
        };
      },
    },
    ({ model: resolved }) =>
      generateText({
        model: resolved,
        system: WELDAGENT_SYSTEM,
        messages: params.messages,
        maxRetries: 1,
      }),
  );

  const creditsUsed = await chargeAiUsage(metering, {
    modelId,
    usage: result.usage,
    op: 'chat',
    gateway: served?.gateway,
    providerCostUsd: served?.providerCostUsd,
    coveredByServiceCredit: served?.covered,
  });

  return { text: result.text, creditsUsed, success: true };
}

export async function defaultTurnGenerator(params: {
  db: AgentDb;
  env: Env;
  workspaceId: string;
  userId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  agentId: string | null;
}): Promise<TurnGeneratorResult> {
  if (params.agentId) {
    const agent = await getAgent(params.db, params.agentId);
    if (!agent) {
      return { text: '', creditsUsed: 0, success: false, error: 'Agent not found' };
    }
    const result = await runAgentOnce({
      env: params.env,
      workspaceId: params.workspaceId,
      actorUserId: params.userId,
      agent: {
        id: agent.id,
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        modelId: agent.modelId,
        temperature: agent.temperature,
        maxTokens: agent.maxTokens,
        maxIterations: agent.maxIterations,
        permissions: agent.permissions,
        enabledTools: agent.enabledTools,
      },
      toolContext: {
        db: params.db,
        agentId: agent.id,
        actorUserId: params.userId,
        workspaceId: params.workspaceId,
      },
      messages: params.messages,
    });
    return {
      text: result.text,
      creditsUsed: result.creditsUsed,
      toolInvocations: result.toolInvocations,
      success: true,
    };
  }

  return generatePersonalReply({
    env: params.env,
    workspaceId: params.workspaceId,
    userId: params.userId,
    messages: params.messages,
  });
}

export async function completeConversationTurn(params: {
  db: AgentDb;
  env: Env;
  workspaceId: string;
  userId: string;
  conversationId: string;
  content: string;
  agentId?: string;
  generate?: TurnGenerator;
  /** Skip push (used when the caller already notified, or in tests). */
  notify?: boolean;
}): Promise<CompleteTurnResult> {
  const { weldagentConversations, weldagentMessages } = schema;
  const db = params.db;

  const [conversation] = await db
    .select()
    .from(weldagentConversations)
    .where(
      and(
        eq(weldagentConversations.id, params.conversationId),
        eq(weldagentConversations.userId, params.userId),
        isNull(weldagentConversations.deletedAt),
      ),
    )
    .limit(1);

  if (!conversation) {
    throw new ConversationNotFoundError(params.conversationId);
  }

  const boundAgentId = params.agentId ?? conversation.agentId ?? null;

  if (params.agentId && !conversation.agentId) {
    await db
      .update(weldagentConversations)
      .set({ agentId: params.agentId, updatedAt: new Date() })
      .where(eq(weldagentConversations.id, conversation.id));
  }

  const history = await db
    .select()
    .from(weldagentMessages)
    .where(
      and(
        eq(weldagentMessages.conversationId, conversation.id),
        isNull(weldagentMessages.deletedAt),
      ),
    )
    .orderBy(weldagentMessages.createdAt);

  const userMessageId = generateId('msg');
  await db.insert(weldagentMessages).values({
    id: userMessageId,
    conversationId: conversation.id,
    role: 'user',
    content: params.content,
  });

  const chatMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    ...history
      .filter((m): m is typeof m & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: params.content },
  ];

  const generate =
    params.generate ??
    ((input) =>
      defaultTurnGenerator({
        db,
        env: params.env,
        workspaceId: params.workspaceId,
        userId: params.userId,
        messages: input.messages,
        agentId: input.agentId,
      }));

  const generated = await generate({ messages: chatMessages, agentId: boundAgentId });

  const assistantText = generated.success
    ? generated.text
    : generated.error || 'The assistant could not complete this turn.';

  const assistantMessageId = generateId('msg');
  await db.insert(weldagentMessages).values({
    id: assistantMessageId,
    conversationId: conversation.id,
    role: 'assistant',
    content: assistantText,
    toolInvocations: (generated.toolInvocations as typeof weldagentMessages.$inferInsert['toolInvocations']) ?? null,
  });

  await db
    .update(weldagentConversations)
    .set({
      lastMessageAt: new Date(),
      messageCount: conversation.messageCount + 2,
      updatedAt: new Date(),
    })
    .where(eq(weldagentConversations.id, conversation.id));

  const [userRow] = await db
    .select()
    .from(weldagentMessages)
    .where(eq(weldagentMessages.id, userMessageId))
    .limit(1);
  const [assistantRow] = await db
    .select()
    .from(weldagentMessages)
    .where(eq(weldagentMessages.id, assistantMessageId))
    .limit(1);

  if (params.notify !== false && generated.success) {
    let agentName: string | null = null;
    if (boundAgentId) {
      const agent = await getAgent(db, boundAgentId);
      agentName = agent?.name ?? null;
    }
    try {
      await sendWeldAgentReplyNotification({
        db: db as unknown as NotificationDatabase,
        env: params.env as unknown as NotificationEnv,
        workspaceId: params.workspaceId,
        userId: params.userId,
        conversationId: conversation.id,
        agentName,
        previewText: assistantText,
      });
    } catch (err) {
      console.error('[weldagent/complete-turn] notify failed:', err);
    }
  }

  return {
    userMessage: serializeMessage(userRow),
    assistantMessage: serializeMessage(assistantRow),
    creditsUsed: generated.creditsUsed,
    success: generated.success,
    error: generated.error,
  };
}
