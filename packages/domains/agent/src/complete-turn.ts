/**
 * Server-owned WeldAgent chat turn.
 *
 * Accepts the user message immediately, then generates the assistant reply in
 * the Worker (via `waitUntil`) so the browser/mobile client does not block on
 * model latency. Sync `completeConversationTurn` remains for tests / callers
 * that pass `wait: true`.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  billedModelId,
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
import type { WeldAgentEnv as Env } from './env';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import {
  resolveAiMetering,
  assertAiCredits,
  chargeAiUsage,
} from '@weldsuite/core-domain/ai-billing';
import { getAgent, type AgentDb } from './agents';
import { findAccessibleAgentRow, type AgentViewer } from './access';
import { runAgentOnce, REQUEST_RUN_TIMEOUT_MS } from './executor';
import { isManagedAgentsConfigured } from './managed-agents';
import { asText } from '@weldsuite/text';
import { buildPersonaCall, holdsPermissions, personaReplyText } from './persona';
import { describeUserTags, taggedSheetsIn } from './record-tokens';

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
  /** How many older history messages precede `messages` (see {@link HISTORY_WINDOW}). */
  historyOffset?: number;
}) => Promise<TurnGeneratorResult>;

export interface AcceptedTurn {
  conversationId: string;
  userId: string;
  workspaceId: string;
  boundAgentId: string | null;
  userMessage: WeldAgentMessageRow;
  /** The recent part of the history, ending with the user message. */
  chatMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** How many older history messages precede `chatMessages`. */
  historyOffset: number;
  /** Permissions of the user driving the turn — narrows the agent's grants. */
  actorPermissions?: string[] | null;
  /**
   * The persona keys (`personaPermissionKeys`) the user holds, checked
   * deny-aware by the route: what the default WeldAgent may look up for them.
   */
  personaPermissions?: string[] | null;
  /** The user's IANA timezone, when the client sent one. */
  timezone?: string | null;
}

/** Serializable handle for an accepted turn (Workflow payload). */
export interface AcceptedTurnRef {
  conversationId: string;
  userId: string;
  workspaceId: string;
  userMessageId: string;
  agentId: string | null;
  actorPermissions?: string[] | null;
  personaPermissions?: string[] | null;
  timezone?: string | null;
}

type MessageRow = typeof schema.weldagentMessages.$inferSelect;

/** An agent the caller may not use (see ./access). */
export class AgentAccessDeniedError extends Error {
  constructor(agentId: string) {
    super(`No access to agent: ${agentId}`);
    this.name = 'AgentAccessDeniedError';
  }
}

/**
 * How many recent history messages a turn loads. A continuous chat grows
 * without end; its Managed Agents session already holds (and compacts) the
 * rest, so a turn only needs what the session has not seen yet, and a fresh
 * session is seeded from the recent part (see ./executor).
 */
export const HISTORY_WINDOW = 80;

/**
 * SQL condition: the message sorts after (`>`) or at-or-before (`<=`) the
 * message `anchorId`, in (created_at, id) order. The anchor's timestamp is
 * read inside SQL: Postgres keeps microseconds, a JS Date only milliseconds,
 * so passing a Date back in would put the anchor itself on the wrong side.
 */
export function relativeToMessage(op: '>' | '<=' | '<', anchorId: string) {
  const { weldagentMessages: m } = schema;
  return sql`(${m.createdAt}, ${m.id}) ${sql.raw(op)} (select "created_at", "id" from ${m} where "id" = ${anchorId})`;
}

/**
 * The latest {@link HISTORY_WINDOW} model-history rows (user + assistant) of a
 * conversation, oldest first, optionally only up to and including the message
 * `throughId`; plus how many older ones precede them.
 */
async function loadRecentHistory(
  db: AgentDb,
  conversationId: string,
  throughId?: string,
): Promise<{ rows: MessageRow[]; offset: number }> {
  const { weldagentMessages: m } = schema;
  const where = and(
    eq(m.conversationId, conversationId),
    isNull(m.deletedAt),
    inArray(m.role, ['user', 'assistant']),
    throughId ? relativeToMessage('<=', throughId) : undefined,
  );
  const [latest, [{ total }]] = await Promise.all([
    db.select().from(m).where(where).orderBy(desc(m.createdAt), desc(m.id)).limit(HISTORY_WINDOW),
    db.select({ total: sql<number>`count(*)::int` }).from(m).where(where),
  ]);
  return { rows: latest.reverse(), offset: Math.max(0, Number(total) - latest.length) };
}

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
    lines.push(`- ${asText(inv.toolName)} → ${result}`);
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
  db: AgentDb;
  env: Env;
  workspaceId: string;
  userId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** The persona keys the user holds, deny-aware: what the default WeldAgent may look up for them. */
  personaPermissions?: string[] | null;
  timezone?: string | null;
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
  // Read-only lookups, limited to what this user may read themselves, and the
  // spreadsheets they tagged.
  const persona = await buildPersonaCall({
    db: params.db,
    workspaceId: params.workspaceId,
    userId: params.userId,
    env: params.env,
    holds: holdsPermissions(params.personaPermissions ?? []),
    sheets: { tagged: taggedSheetsIn(params.messages) },
    timezone: params.timezone,
  });

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
        system: persona.system,
        messages: describeUserTags(params.messages),
        tools: persona.tools,
        stopWhen: persona.stopWhen,
        maxRetries: 1,
      }),
  );

  // `result.usage` adds up every model request of the reply (AI SDK 7).
  const creditsUsed = await chargeAiUsage(metering, {
    modelId: billedModelId(modelId, result),
    usage: result.usage,
    op: 'chat',
    gateway: served?.gateway,
    providerCostUsd: served?.providerCostUsd,
    coveredByServiceCredit: served?.covered,
  });

  return { text: personaReplyText(result.text), creditsUsed, success: true };
}

/** Tells the agent the user's clock, so "7:00" means their 7:00. */
function timezoneSystem(timezone: string | null | undefined): string | undefined {
  if (!timezone) return undefined;
  return `The user's timezone is ${timezone}. Read and schedule times (routines included) in it unless they say otherwise.`;
}

export async function defaultTurnGenerator(params: {
  db: AgentDb;
  env: Env;
  workspaceId: string;
  userId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  historyOffset?: number;
  agentId: string | null;
  conversationId?: string;
  actorPermissions?: string[] | null;
  personaPermissions?: string[] | null;
  timezone?: string | null;
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
        description: agent.description,
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
        userTimezone: params.timezone ?? null,
        actorPermissions: params.actorPermissions ?? null,
      },
      messages: params.messages,
      historyOffset: params.historyOffset,
      actorPermissions: params.actorPermissions,
      extraSystem: timezoneSystem(params.timezone),
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
    db: params.db,
    env: params.env,
    workspaceId: params.workspaceId,
    userId: params.userId,
    messages: params.messages,
    personaPermissions: params.personaPermissions,
    timezone: params.timezone,
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
  personaPermissions?: string[] | null;
  timezone?: string | null;
  /** When set, the bound agent must be one this viewer may use. */
  viewer?: AgentViewer;
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

  const boundAgentId = params.agentId ?? conversation.agentId ?? null;
  // Access can be withdrawn after the chat started (owner made it private).
  if (boundAgentId && params.viewer && !(await findAccessibleAgentRow(db, boundAgentId, params.viewer))) {
    throw new AgentAccessDeniedError(boundAgentId);
  }

  // Fail fast on empty credits before accepting the turn into the background.
  // Agent turns run on Claude Managed Agents; persona turns on the gateway.
  if (boundAgentId ? isManagedAgentsConfigured(params.env) : isGatewayConfigured(params.env)) {
    const metering = await resolveAiMetering(params.env, params.workspaceId, params.userId);
    await assertAiCredits(metering);
  }

  if (params.agentId && !conversation.agentId) {
    await db
      .update(weldagentConversations)
      .set({ agentId: params.agentId, updatedAt: new Date() })
      .where(eq(weldagentConversations.id, conversation.id));
  }

  const history = await loadRecentHistory(db, conversation.id);

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
    ...toModelHistory(history.rows),
    { role: 'user', content: params.content },
  ];

  return {
    conversationId: conversation.id,
    userId: params.userId,
    workspaceId: params.workspaceId,
    boundAgentId,
    userMessage: serializeMessage(userRow),
    chatMessages,
    historyOffset: history.offset,
    actorPermissions: params.actorPermissions ?? null,
    personaPermissions: params.personaPermissions ?? null,
    timezone: params.timezone ?? null,
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
    personaPermissions: accepted.personaPermissions ?? null,
    timezone: accepted.timezone ?? null,
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

  const [userRow] = await db
    .select()
    .from(weldagentMessages)
    .where(
      and(
        eq(weldagentMessages.id, ref.userMessageId),
        eq(weldagentMessages.conversationId, ref.conversationId),
        isNull(weldagentMessages.deletedAt),
      ),
    )
    .limit(1);
  if (!userRow) return null;

  // A reply already landed after this user message (e.g. a duplicate job).
  // Approval outcomes and routine results posted meanwhile are not replies.
  const later = await db
    .select()
    .from(weldagentMessages)
    .where(
      and(
        eq(weldagentMessages.conversationId, ref.conversationId),
        isNull(weldagentMessages.deletedAt),
        eq(weldagentMessages.role, 'assistant'),
        relativeToMessage('>', userRow.id),
      ),
    );
  if (later.some(isTurnReply)) return null;

  const history = await loadRecentHistory(db, ref.conversationId, userRow.id);

  return {
    conversationId: ref.conversationId,
    userId: ref.userId,
    workspaceId: ref.workspaceId,
    boundAgentId: ref.agentId,
    userMessage: serializeMessage(userRow),
    chatMessages: toModelHistory(history.rows),
    historyOffset: history.offset,
    actorPermissions: ref.actorPermissions ?? null,
    personaPermissions: ref.personaPermissions ?? null,
    timezone: ref.timezone ?? null,
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

/** `metadata.kind` of an assistant message posted by a routine run (./routine-delivery). */
export const ROUTINE_RESULT_KIND = 'routine_result';

function isTurnReply(row: MessageRow): boolean {
  const kind = (row.metadata as { kind?: unknown } | null)?.kind;
  return row.role === 'assistant' && kind !== APPROVAL_OUTCOME_KIND && kind !== ROUTINE_RESULT_KIND;
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
  const ranTools = Array.isArray(params.toolInvocations) && params.toolInvocations.length > 0;
  const content = params.content.trim() || (ranTools ? '' : 'I could not complete that reply. Please try again.');

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

/**
 * A chat reply that arrives within this long of the question is one the person
 * waited for in the chat: it needs no "replied" notification. A longer turn is
 * work they probably left for, so it gets one.
 */
export const INTERACTIVE_REPLY_WINDOW_MS = 30_000;

/** Whether a finished chat turn notifies the person: `notify` when given, else only for a turn long enough that they left. */
export function shouldNotifyChatReply(params: { notify?: boolean; elapsedMs: number }): boolean {
  return params.notify ?? params.elapsedMs >= INTERACTIVE_REPLY_WINDOW_MS;
}

export async function finishAcceptedTurn(params: {
  db: AgentDb;
  env: Env;
  accepted: AcceptedTurn;
  generate?: TurnGenerator;
  /** Force the "replied" notification on or off; unset: only after a turn long enough that the person left. */
  notify?: boolean;
  timeoutMs?: number;
}): Promise<CompleteTurnResult> {
  const { accepted, db } = params;
  const startedAt = Date.now();

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
          historyOffset: input.historyOffset,
          agentId: input.agentId,
          conversationId: accepted.conversationId,
          actorPermissions: accepted.actorPermissions,
          personaPermissions: accepted.personaPermissions,
          timezone: accepted.timezone,
          timeoutMs: params.timeoutMs,
        }));

    const generated = await generate({
      messages: accepted.chatMessages,
      agentId: accepted.boundAgentId,
      historyOffset: accepted.historyOffset,
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

    if (generated.success && shouldNotifyChatReply({ notify: params.notify, elapsedMs: Date.now() - startedAt })) {
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
  personaPermissions?: string[] | null;
  timezone?: string | null;
  viewer?: AgentViewer;
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
    personaPermissions: params.personaPermissions,
    timezone: params.timezone,
    viewer: params.viewer,
  });

  return finishAcceptedTurn({
    db: params.db,
    env: params.env,
    accepted,
    generate: params.generate,
    notify: params.notify,
  });
}
