/**
 * Server-owned WeldAgent chat turn.
 *
 * Accepts the user message immediately, then generates the assistant reply in
 * the Worker (via `waitUntil`) so the browser/mobile client does not block on
 * model latency. Sync `completeConversationTurn` remains for tests / callers
 * that pass `wait: true`.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
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
import { runAgentOnce, REQUEST_RUN_TIMEOUT_MS } from './executor';

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

export interface AcceptedTurn {
  conversationId: string;
  userId: string;
  workspaceId: string;
  boundAgentId: string | null;
  userMessage: WeldAgentMessageRow;
  chatMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Permissions of the user driving the turn — narrows the agent's grants. */
  actorPermissions?: string[] | null;
}

/** Serializable handle for an accepted turn (Workflow payload). */
export interface AcceptedTurnRef {
  conversationId: string;
  userId: string;
  workspaceId: string;
  userMessageId: string;
  agentId: string | null;
  actorPermissions?: string[] | null;
}

type MessageRow = typeof schema.weldagentMessages.$inferSelect;

const TOOL_SUMMARY_MAX_CHARS = 1500;

/**
 * Compact recap of the tools an assistant turn ran, appended to its text when
 * replaying history. Without it the model forgets ids/results it fetched in
 * earlier turns and re-queries (or invents) them.
 */
function summarizeToolInvocations(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  const lines: string[] = [];
  for (const inv of raw as Array<Record<string, unknown>>) {
    if (!inv || (inv.state !== 'result' && inv.state !== 'error')) continue;
    let result = '';
    try {
      result = JSON.stringify(inv.result ?? null);
    } catch {
      result = '[unserializable]';
    }
    if (result.length > 400) result = `${result.slice(0, 400)}…`;
    lines.push(`- ${String(inv.toolName)} → ${result}`);
  }
  if (lines.length === 0) return '';
  let summary = `[Tools used in this turn]\n${lines.join('\n')}`;
  if (summary.length > TOOL_SUMMARY_MAX_CHARS) {
    summary = `${summary.slice(0, TOOL_SUMMARY_MAX_CHARS)}…`;
  }
  return summary;
}

/** Map persisted messages to model history (user/assistant only). */
export function toModelHistory(
  rows: MessageRow[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return rows
    .filter((m): m is MessageRow & { role: 'user' | 'assistant' } =>
      m.role === 'user' || m.role === 'assistant',
    )
    .map((m) => {
      if (m.role !== 'assistant') return { role: m.role, content: m.content };
      const tools = summarizeToolInvocations(m.toolInvocations);
      return { role: m.role, content: tools ? `${m.content}\n\n${tools}` : m.content };
    });
}

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
  conversationId?: string;
  actorPermissions?: string[] | null;
  timeoutMs?: number;
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
        autoReviewEnabled: Boolean((agent as { autoReviewEnabled?: boolean }).autoReviewEnabled),
      },
      toolContext: {
        db: params.db,
        agentId: agent.id,
        actorUserId: params.userId,
        workspaceId: params.workspaceId,
        env: params.env,
        conversationId: params.conversationId,
      },
      messages: params.messages,
      actorPermissions: params.actorPermissions,
      timeoutMs: params.timeoutMs ?? REQUEST_RUN_TIMEOUT_MS,
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

/**
 * Persist the user message and prepare generation context. Returns quickly so
 * the HTTP response can leave before the model runs.
 */
export async function acceptConversationTurn(params: {
  db: AgentDb;
  env: Env;
  workspaceId: string;
  userId: string;
  conversationId: string;
  content: string;
  agentId?: string;
  actorPermissions?: string[] | null;
}): Promise<AcceptedTurn> {
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

  // Fail fast on empty credits before accepting the turn into the background.
  if (isGatewayConfigured(params.env)) {
    const metering = await resolveAiMetering(params.env, params.workspaceId, params.userId);
    await assertAiCredits(metering);
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

  await db
    .update(weldagentConversations)
    .set({
      lastMessageAt: new Date(),
      messageCount: sql`${weldagentConversations.messageCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(weldagentConversations.id, conversation.id));

  const [userRow] = await db
    .select()
    .from(weldagentMessages)
    .where(eq(weldagentMessages.id, userMessageId))
    .limit(1);

  const chatMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    ...toModelHistory(history),
    { role: 'user', content: params.content },
  ];

  return {
    conversationId: conversation.id,
    userId: params.userId,
    workspaceId: params.workspaceId,
    boundAgentId,
    userMessage: serializeMessage(userRow),
    chatMessages,
    actorPermissions: params.actorPermissions ?? null,
  };
}

export function toAcceptedTurnRef(accepted: AcceptedTurn): AcceptedTurnRef {
  return {
    conversationId: accepted.conversationId,
    userId: accepted.userId,
    workspaceId: accepted.workspaceId,
    userMessageId: accepted.userMessage.id,
    agentId: accepted.boundAgentId,
    actorPermissions: accepted.actorPermissions ?? null,
  };
}

/**
 * Rebuild an accepted turn from the database (history up to and including the
 * user message). Used by the durable job runner, whose payload must stay small
 * and serializable. Returns null when the turn is gone or already answered.
 */
export async function loadAcceptedTurn(db: AgentDb, ref: AcceptedTurnRef): Promise<AcceptedTurn | null> {
  const { weldagentConversations, weldagentMessages } = schema;
  const [conversation] = await db
    .select({ id: weldagentConversations.id })
    .from(weldagentConversations)
    .where(
      and(
        eq(weldagentConversations.id, ref.conversationId),
        eq(weldagentConversations.userId, ref.userId),
        isNull(weldagentConversations.deletedAt),
      ),
    )
    .limit(1);
  if (!conversation) return null;

  const rows = await db
    .select()
    .from(weldagentMessages)
    .where(
      and(
        eq(weldagentMessages.conversationId, ref.conversationId),
        isNull(weldagentMessages.deletedAt),
      ),
    )
    .orderBy(weldagentMessages.createdAt);

  const index = rows.findIndex((m) => m.id === ref.userMessageId);
  if (index === -1) return null;
  // A reply already landed after this user message (e.g. a duplicate job).
  // Approval outcomes posted meanwhile are not replies.
  if (rows.slice(index + 1).some(isTurnReply)) return null;

  return {
    conversationId: ref.conversationId,
    userId: ref.userId,
    workspaceId: ref.workspaceId,
    boundAgentId: ref.agentId,
    userMessage: serializeMessage(rows[index]),
    chatMessages: toModelHistory(rows.slice(0, index + 1)),
    actorPermissions: ref.actorPermissions ?? null,
  };
}

/**
 * Generate the assistant reply for an already-accepted user turn and persist it.
 */
/**
 * `metadata.kind` of assistant rows that are NOT the reply to a user turn
 * (e.g. an approval outcome posted later). Turn completion ignores them.
 */
export const APPROVAL_OUTCOME_KIND = 'approval_outcome';

function isTurnReply(row: MessageRow): boolean {
  return (
    row.role === 'assistant' &&
    (row.metadata as { kind?: unknown } | null)?.kind !== APPROVAL_OUTCOME_KIND
  );
}

export async function persistAssistantMessage(params: {
  db: AgentDb;
  conversationId: string;
  content: string;
  toolInvocations?: unknown;
  metadata?: Record<string, unknown>;
}): Promise<WeldAgentMessageRow> {
  const { weldagentConversations, weldagentMessages } = schema;
  const assistantMessageId = generateId('msg');
  const content = params.content.trim() || 'I could not complete that reply. Please try again.';

  await params.db.insert(weldagentMessages).values({
    id: assistantMessageId,
    conversationId: params.conversationId,
    role: 'assistant',
    content,
    toolInvocations:
      (params.toolInvocations as typeof weldagentMessages.$inferInsert['toolInvocations']) ?? null,
    metadata: params.metadata ?? null,
  });

  await params.db
    .update(weldagentConversations)
    .set({
      lastMessageAt: new Date(),
      messageCount: sql`${weldagentConversations.messageCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(weldagentConversations.id, params.conversationId));

  const [assistantRow] = await params.db
    .select()
    .from(weldagentMessages)
    .where(eq(weldagentMessages.id, assistantMessageId))
    .limit(1);

  return serializeMessage(assistantRow);
}

/**
 * Persist a user-visible failure so async clients stop polling forever when
 * background generation throws (gateway, credits, runtime, etc.).
 */
export async function persistFailedAssistantTurn(params: {
  db: AgentDb;
  accepted: AcceptedTurn;
  error: unknown;
}): Promise<CompleteTurnResult> {
  const message =
    params.error instanceof Error && params.error.message.trim()
      ? `Sorry — I could not finish that reply (${params.error.message}). Try again in a moment.`
      : 'Sorry — I could not finish that reply. Try again in a moment.';

  const assistantMessage = await persistAssistantMessage({
    db: params.db,
    conversationId: params.accepted.conversationId,
    content: message,
  });

  return {
    status: 'completed',
    pending: false,
    userMessage: params.accepted.userMessage,
    assistantMessage,
    creditsUsed: 0,
    success: false,
    error: params.error instanceof Error ? params.error.message : 'Turn failed',
  };
}

export async function finishAcceptedTurn(params: {
  db: AgentDb;
  env: Env;
  accepted: AcceptedTurn;
  generate?: TurnGenerator;
  notify?: boolean;
  timeoutMs?: number;
}): Promise<CompleteTurnResult> {
  const { accepted, db } = params;

  try {
    const generate =
      params.generate ??
      ((input) =>
        defaultTurnGenerator({
          db,
          env: params.env,
          workspaceId: accepted.workspaceId,
          userId: accepted.userId,
          messages: input.messages,
          agentId: input.agentId,
          conversationId: accepted.conversationId,
          actorPermissions: accepted.actorPermissions,
          timeoutMs: params.timeoutMs,
        }));

    const generated = await generate({
      messages: accepted.chatMessages,
      agentId: accepted.boundAgentId,
    });

    const assistantText = generated.success
      ? generated.text
      : generated.error || 'The assistant could not complete this turn.';

    const assistantMessage = await persistAssistantMessage({
      db,
      conversationId: accepted.conversationId,
      content: assistantText,
      toolInvocations: generated.toolInvocations,
    });

    if (params.notify !== false && generated.success) {
      let agentName: string | null = null;
      if (accepted.boundAgentId) {
        const agent = await getAgent(db, accepted.boundAgentId);
        agentName = agent?.name ?? null;
      }
      try {
        await sendWeldAgentReplyNotification({
          db: db as unknown as NotificationDatabase,
          env: params.env as unknown as NotificationEnv,
          workspaceId: accepted.workspaceId,
          userId: accepted.userId,
          conversationId: accepted.conversationId,
          agentName,
          previewText: assistantMessage.content,
        });
      } catch (err) {
        console.error('[weldagent/complete-turn] notify failed:', err);
      }
    }

    return {
      status: 'completed',
      pending: false,
      userMessage: accepted.userMessage,
      assistantMessage,
      creditsUsed: generated.creditsUsed,
      success: generated.success,
      error: generated.error,
    };
  } catch (err) {
    console.error('[weldagent/complete-turn] finishAcceptedTurn failed:', err);
    return persistFailedAssistantTurn({ db, accepted, error: err });
  }
}

/** Full synchronous turn (tests / wait:true). */
export async function completeConversationTurn(params: {
  db: AgentDb;
  env: Env;
  workspaceId: string;
  userId: string;
  conversationId: string;
  content: string;
  agentId?: string;
  actorPermissions?: string[] | null;
  generate?: TurnGenerator;
  /** Skip push (used when the caller already notified, or in tests). */
  notify?: boolean;
}): Promise<CompleteTurnResult> {
  const accepted = await acceptConversationTurn({
    db: params.db,
    env: params.env,
    workspaceId: params.workspaceId,
    userId: params.userId,
    conversationId: params.conversationId,
    content: params.content,
    agentId: params.agentId,
    actorPermissions: params.actorPermissions,
  });

  return finishAcceptedTurn({
    db: params.db,
    env: params.env,
    accepted,
    generate: params.generate,
    notify: params.notify,
  });
}
