/**
 * WeldAgent executor — every workspace agent runs as a Claude Managed Agent.
 *
 * A turn: sync the agent object (./managed-agents), get or create the session
 * (one per conversation, or a throwaway one per run / room reply), send the
 * user message, then follow the session's event stream until it settles.
 * Platform tools arrive as `agent.custom_tool_use` and run here with the same
 * grant narrowing, approval gating and entity events as before; sandbox and
 * web tools run at Anthropic. The session's list cost is charged to the credit
 * wallet afterwards, and a session budget caps what one turn can spend.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaManagedAgentsEventParams,
  BetaManagedAgentsStreamSessionEvents,
  BetaManagedAgentsSessionEvent,
} from '@anthropic-ai/sdk/resources/beta/sessions/events';
import { and, eq, isNull } from 'drizzle-orm';
import { checkCredits } from '@weldsuite/credits';
import { CREDITS_PER_USD, PROVIDER_MARKUP, providerCostUsd } from '@weldsuite/ai';
import type { WeldAgentManagedSessionState } from '@weldsuite/db/schema';
import { schema } from '@weldsuite/worker-kit/db';
import type { WeldAgentEnv as Env } from './env';
import {
  resolveAiMetering,
  assertAiCredits,
  chargeAiUsage,
  type AiMetering,
} from '@weldsuite/core-domain/ai-billing';
import {
  resolveAgentTools,
  effectiveAgentPermissions,
  type ToolContext,
  type PlatformToolDefinition,
} from './tools';
import {
  budgetForUsd,
  buildManagedTools,
  builtinToolAccess,
  ensureEnvironment,
  ensureManagedAgent,
  isManagedAgentsConfigured,
  listCostUsd,
  managedAgentsClient,
  resolveManagedModel,
  sha256Hex,
  ManagedAgentsConfigError,
  type ManagedAgentRef,
  type ManagedToolList,
} from './managed-agents';

export interface StoredToolInvocation {
  toolName: string;
  state: 'call' | 'result' | 'error';
  args?: unknown;
  result?: unknown;
}

export interface AgentExecutorInput {
  env: Env;
  workspaceId: string;
  actorUserId: string;
  agent: {
    id: string;
    name: string;
    description?: string | null;
    systemPrompt: string;
    modelId: string;
    /** Unused by Claude Managed Agents (kept for the stored agent shape). */
    temperature: string;
    /** Unused by Claude Managed Agents (kept for the stored agent shape). */
    maxTokens: number;
    /** Cap on model requests per turn; the turn is interrupted past it. */
    maxIterations: number;
    permissions: string[];
    enabledTools: string[];
    autoReviewEnabled?: boolean;
  };
  toolContext: ToolContext;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Extra system context (entity event payload, etc.). */
  extraSystem?: string;
  /**
   * Permissions of the human driving this turn. When set, the agent's grants
   * are narrowed to them (an agent never acts beyond its user's role). Omit
   * for unattended runs (entity events, routines).
   */
  actorPermissions?: string[] | null;
  /**
   * Run high-risk tools without parking an approval. Only for routines whose
   * owner explicitly turned "ask for approval" off.
   */
  skipApprovals?: boolean;
  /**
   * Wall-clock budget for the turn. Defaults to 75s, which suits a blocking
   * HTTP request; durable jobs (Workflows) pass a longer budget.
   */
  timeoutMs?: number;
}

/** Default turn budget for request-bound runs. */
export const REQUEST_RUN_TIMEOUT_MS = 75_000;
/** Turn budget for durable background runs (WeldAgent job workflow). */
export const BACKGROUND_RUN_TIMEOUT_MS = 8 * 60_000;

/** Most one turn may spend (USD list cost), whatever the wallet holds. */
export const MAX_TURN_SPEND_USD = 10;

export interface AgentExecutorResult {
  text: string;
  modelId: string;
  finishReason: string;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  creditsUsed: number;
  toolInvocations: StoredToolInvocation[];
  steps: number;
}

/** True when the agent has no saved purpose yet and must interview the user first. */
export function agentNeedsSetup(systemPrompt: string | null | undefined): boolean {
  return !systemPrompt?.trim();
}

const SETUP_INTERVIEW_INSTRUCTIONS =
  'SETUP MODE — you do not have a job or a real name yet (you may appear as "Untitled").\n' +
  'You are interviewing the user. A preset choice (e.g. "Work & projects") is ONLY a starting hint — it is NOT enough to finish setup.\n\n' +
  'HARD RULES:\n' +
  '- After the user picks a preset or gives a short answer, your reply MUST be a clarifying question. Do not summarise a finished job yet.\n' +
  '- Ask about ROUTINES next: when should you act (new tickets, quiet contacts, schedules, chat-only, etc.) and what steps you take.\n' +
  '- Ask one focused question at a time. Keep asking until purpose AND routines are clear.\n' +
  '- NEVER call save_agent_setup until the user has answered at least one clarifying question about routines.\n' +
  '- NEVER say you are "active", "ready", or "now helping" until save_agent_setup has succeeded.\n' +
  '- Set activate=true only if the user explicitly asks you to go live / activate; otherwise save as draft (activate=false).\n' +
  '- Do not invent workspace data or claim you already run automations.\n\n' +
  'When both purpose and routines are clear, call save_agent_setup with a short display name, lasting systemPrompt, and description. ' +
  'After a successful save, briefly confirm your name and what you will do.';

/**
 * The platform tools the agent may run this turn. During onboarding only
 * save_agent_setup, and only after the user has answered at least one
 * follow-up, so the interview cannot invent workspace mutations.
 */
export function toolsForAgentTurn(input: {
  permissions: string[];
  enabledTools: string[];
  systemPrompt: string;
  userMessageCount: number;
  actorPermissions?: string[] | null;
}): PlatformToolDefinition[] {
  if (agentNeedsSetup(input.systemPrompt)) {
    if (input.userMessageCount < 2) return [];
    return resolveAgentTools([], []).filter((tool) => tool.id === 'agent.save_setup');
  }
  return resolveAgentTools(
    effectiveAgentPermissions(input.permissions, input.actorPermissions),
    input.enabledTools,
  );
}

/** The agent's own system prompt, as stored on its Anthropic agent object. */
function buildSystemPrompt(agent: AgentExecutorInput['agent']): string {
  if (agentNeedsSetup(agent.systemPrompt)) {
    return (
      `You are "${agent.name}", a workspace AI agent in WeldSuite that is being configured for the first time.\n\n` +
      SETUP_INTERVIEW_INSTRUCTIONS
    );
  }

  return (
    `You are "${agent.name}", a workspace AI agent in WeldSuite. ` +
    'You act on workspace data only through the WeldSuite tools you have been given. Never invent IDs or claim you mutated data without a successful tool result. ' +
    'Prefer WeldSuite tools (people, tickets, tasks, chat) when they fit. When you have them, use your sandbox (bash, files) for scripts, data work and code, ' +
    'web search / fetch to look things up, and browser_* only for interactive websites without an API. ' +
    'Be concise and practical.\n\n' +
    (agent.systemPrompt?.trim() || 'Help the user with their workspace tasks.')
  );
}

/** Session system context: the agent's prompt plus skills, memory and run context. */
async function buildSessionSystem(input: AgentExecutorInput): Promise<string> {
  let system = buildSystemPrompt(input.agent);
  if (input.toolContext.db && input.agent.id && !agentNeedsSetup(input.agent.systemPrompt)) {
    try {
      const { skillsPromptBlock, memoryPromptBlock } = await import('./parity');
      const [skills, memory] = await Promise.all([
        skillsPromptBlock(input.toolContext.db, input.agent.id),
        memoryPromptBlock(input.toolContext.db, input.agent.id),
      ]);
      if (skills) system = `${system}\n\n${skills}`;
      if (memory) system = `${system}\n\n${memory}`;
    } catch (err) {
      console.warn('[weldagent] failed to load skills/memory prompt blocks:', err);
    }
  }
  return input.extraSystem ? `${system}\n\n${input.extraSystem}` : system;
}

// ---------------------------------------------------------------------------
// Platform tool execution (custom tools)
// ---------------------------------------------------------------------------

async function executePlatformTool(
  def: PlatformToolDefinition,
  ctx: ToolContext,
  input: unknown,
  invocations: StoredToolInvocation[],
  opts: { autoReviewEnabled?: boolean; skipApprovals?: boolean },
): Promise<{ result: unknown; isError: boolean }> {
  invocations.push({ toolName: def.name, state: 'call', args: input });
  try {
    const { toolRiskLevel, createApproval, findPriorApproval, allowsAutoReview } = await import('./parity');
    const risk = toolRiskLevel(def.name, input);
    if (risk === 'high' && !opts.skipApprovals) {
      const autoOk =
        opts.autoReviewEnabled &&
        allowsAutoReview(def.name) &&
        (await findPriorApproval(ctx.db, ctx.agentId, def.name));
      if (!autoOk) {
        const approval = await createApproval(ctx.db, {
          agentId: ctx.agentId,
          conversationId: ctx.conversationId ?? ctx.channelId ?? null,
          toolName: def.name,
          args: (input && typeof input === 'object'
            ? (input as Record<string, unknown>)
            : { value: input }) as Record<string, unknown>,
          riskLevel: 'high',
          createdBy: ctx.actorUserId,
        });
        const blocked = {
          pendingApproval: true,
          approvalId: approval.id,
          message:
            `Action "${def.name}" is waiting for human approval and has NOT run yet. ` +
            'It runs automatically once approved. Tell the user it is pending — do not claim it is done, and do not retry it.',
        };
        invocations.push({ toolName: def.name, state: 'result', args: input, result: blocked });
        return { result: blocked, isError: false };
      }
    }
    const result = await def.execute(ctx, input);
    invocations.push({ toolName: def.name, state: 'result', args: input, result });
    return { result, isError: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Tool failed';
    invocations.push({ toolName: def.name, state: 'error', args: input, result: { error: message } });
    return { result: { error: message }, isError: true };
  }
}

/** Tool results above ~100K chars are offloaded by the platform anyway; keep ours smaller. */
const MAX_TOOL_RESULT_CHARS = 60_000;
/** What we keep of a sandbox/web tool result in the stored invocation. */
const MAX_STORED_RESULT_CHARS = 2_000;

function toResultText(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  } catch {
    text = String(value);
  }
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…[truncated]` : text;
}

function blocksText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block && typeof block === 'object' && (block as { type?: string }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Session handling
// ---------------------------------------------------------------------------

const DENY_UNREVIEWED =
  'No reviewer is available to approve this action in this session. Choose a safer approach, or tell the user what you wanted to run.';

type TurnEvent = BetaManagedAgentsStreamSessionEvents | BetaManagedAgentsSessionEvent;

export interface TurnOutcome {
  texts: string[];
  finishReason: string;
  error?: string;
  modelRequests: number;
  usage: { inputTokens: number; outputTokens: number };
}

export interface DriveTurnParams {
  client: Anthropic;
  sessionId: string;
  kickoff: BetaManagedAgentsEventParams[];
  deadline: number;
  maxModelRequests: number;
  onCustomTool: (name: string, input: unknown) => Promise<{ result: unknown; isError: boolean }>;
  invocations: StoredToolInvocation[];
  onText?: (text: string) => void;
}

/**
 * Send the kickoff events and follow the session until the turn settles:
 * idle with anything but `requires_action`, or terminated. The SSE stream has
 * no replay, so on a dropped connection the stream is reopened and the event
 * history replayed from the kickoff, deduplicated by event id.
 */
export async function driveTurn(params: DriveTurnParams): Promise<TurnOutcome> {
  const { client, sessionId } = params;
  const outcome: TurnOutcome = {
    texts: [],
    finishReason: 'end_turn',
    modelRequests: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const seen = new Set<string>();
  const kickoffIds = new Set<string>();
  /** Built-in tool calls by event id, so results can be matched to names. */
  const builtinCalls = new Map<string, string>();
  /** Preview text already emitted per agent.message id (streaming only). */
  const emitted = new Map<string, number>();
  let emittedAny = false;
  let started = false;
  let done = false;
  let interrupted = false;
  let timedOut = false;
  let lastError: string | undefined;

  const send = (events: BetaManagedAgentsEventParams[]) => client.beta.sessions.events.send(sessionId, { events });
  const interrupt = async () => {
    if (interrupted) return;
    interrupted = true;
    try {
      await send([{ type: 'user.interrupt' }]);
    } catch (err) {
      console.warn('[weldagent/managed] interrupt failed:', err instanceof Error ? err.message : err);
    }
  };

  const emit = (text: string) => {
    if (!params.onText || !text) return;
    params.onText(text);
  };

  const handle = async (ev: TurnEvent) => {
    const id = 'id' in ev ? ev.id : undefined;
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
    }

    switch (ev.type) {
      case 'event_start':
        if (ev.event.type === 'agent.message') {
          if (emittedAny) emit('\n\n');
          emitted.set(ev.event.id, 0);
          emittedAny = true;
        }
        return;
      case 'event_delta': {
        const text = ev.delta.content.text ?? '';
        emitted.set(ev.event_id, (emitted.get(ev.event_id) ?? 0) + text.length);
        emit(text);
        return;
      }
      case 'user.message':
        if (id && kickoffIds.has(id) && ev.processed_at) started = true;
        return;
      case 'session.status_running':
      case 'span.model_request_start':
        started = true;
        if (ev.type === 'span.model_request_start') {
          outcome.modelRequests += 1;
          if (outcome.modelRequests > params.maxModelRequests) {
            outcome.finishReason = 'max_iterations';
            await interrupt();
          }
        }
        return;
      case 'span.model_request_end':
        outcome.usage.inputTokens +=
          (ev.model_usage.input_tokens ?? 0) +
          (ev.model_usage.cache_read_input_tokens ?? 0) +
          (ev.model_usage.cache_creation_input_tokens ?? 0);
        outcome.usage.outputTokens += ev.model_usage.output_tokens ?? 0;
        return;
      case 'agent.message': {
        const text = blocksText(ev.content);
        if (!text) return;
        outcome.texts.push(text);
        // Reconcile the preview: emit whatever the deltas did not cover.
        const already = emitted.get(ev.id);
        if (already === undefined) {
          if (emittedAny) emit('\n\n');
          emittedAny = true;
          emit(text);
        } else if (already < text.length) {
          emit(text.slice(already));
        }
        return;
      }
      case 'agent.custom_tool_use': {
        const { result, isError } = await params.onCustomTool(ev.name, ev.input);
        await send([
          {
            type: 'user.custom_tool_result',
            custom_tool_use_id: ev.id,
            content: [{ type: 'text', text: toResultText(result) }],
            is_error: isError,
          },
        ]);
        return;
      }
      case 'agent.tool_use':
      case 'agent.mcp_tool_use':
        builtinCalls.set(ev.id, ev.name);
        params.invocations.push({ toolName: ev.name, state: 'call', args: ev.input });
        if (ev.evaluated_permission === 'ask') {
          // Paused for approval with nobody to ask: deny, never blanket-allow.
          await send([
            { type: 'user.tool_confirmation', tool_use_id: ev.id, result: 'deny', deny_message: DENY_UNREVIEWED },
          ]);
        }
        return;
      case 'agent.tool_result': {
        const text = blocksText(ev.content);
        params.invocations.push({
          toolName: builtinCalls.get(ev.tool_use_id) ?? 'tool',
          state: ev.is_error ? 'error' : 'result',
          result: text.length > MAX_STORED_RESULT_CHARS ? `${text.slice(0, MAX_STORED_RESULT_CHARS)}…` : text,
        });
        return;
      }
      case 'session.error':
        lastError = (ev.error as { message?: string }).message || ev.error.type;
        return;
      case 'session.status_idle':
        if (!started || ev.stop_reason.type === 'requires_action') return;
        done = true;
        if (ev.stop_reason.type === 'retries_exhausted') {
          outcome.finishReason = 'error';
          outcome.error = lastError ?? 'The agent session failed after retries';
        } else if (ev.stop_reason.type === 'budget_reached') {
          outcome.finishReason = 'budget_reached';
          outcome.error = 'This turn reached its spending limit (credits or the per-turn cap).';
        } else if (ev.stop_reason.type === 'refusal') {
          outcome.finishReason = 'refusal';
        } else if (outcome.finishReason === 'end_turn' && interrupted && !timedOut) {
          outcome.finishReason = 'max_iterations';
        }
        return;
      case 'session.status_terminated':
        done = true;
        outcome.finishReason = 'error';
        outcome.error = lastError ?? 'The agent session ended unexpectedly';
        return;
      default:
        return;
    }
  };

  const abort = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    void interrupt();
    abort.abort();
  }, Math.max(1_000, params.deadline - Date.now()));

  let sentKickoff = false;
  let replayHistory = false;
  let reconnects = 0;
  try {
    while (!done) {
      try {
        const stream = await client.beta.sessions.events.stream(
          sessionId,
          params.onText ? { event_deltas: ['agent.message'] } : {},
          { signal: abort.signal },
        );
        if (!sentKickoff) {
          // Stream first, then send: the stream only carries events after it opens.
          const sent = await send(params.kickoff);
          for (const ev of sent.data ?? []) if (ev.id) kickoffIds.add(ev.id);
          sentKickoff = true;
        }
        if (replayHistory) {
          let afterKickoff = false;
          for await (const ev of client.beta.sessions.events.list(sessionId)) {
            if (!afterKickoff) {
              if (!kickoffIds.has(ev.id)) continue;
              afterKickoff = true;
            }
            await handle(ev);
            if (done) break;
          }
        }
        for await (const ev of stream) {
          await handle(ev);
          if (done) break;
        }
        if (done) stream.controller.abort();
      } catch (err) {
        if (timedOut) throw new Error('The agent did not finish in time');
        if (++reconnects > 3) throw err;
        console.warn('[weldagent/managed] event stream dropped, reconnecting:', err instanceof Error ? err.message : err);
      }
      replayHistory = true;
      if (Date.now() > params.deadline) {
        timedOut = true;
        await interrupt();
        throw new Error('The agent did not finish in time');
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return outcome;
}

function transcript(messages: AgentExecutorInput['messages']): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
}

/** The user message for a turn, with any history the session has not seen. */
function turnMessage(messages: AgentExecutorInput['messages'], unseen: AgentExecutorInput['messages']): string {
  const latest = messages[messages.length - 1]?.content ?? '';
  if (unseen.length === 0) return latest;
  return (
    'Earlier in this conversation (for context; you did not see these messages yet):\n\n' +
    `${transcript(unseen)}\n\n---\n\n${latest}`
  );
}

async function loadConversationSession(
  ctx: ToolContext,
): Promise<{ metadata: Record<string, unknown>; state: WeldAgentManagedSessionState | null } | null> {
  if (!ctx.conversationId || !ctx.db) return null;
  const { weldagentConversations: conv } = schema;
  const [row] = await ctx.db
    .select({ metadata: conv.metadata })
    .from(conv)
    .where(and(eq(conv.id, ctx.conversationId), isNull(conv.deletedAt)))
    .limit(1);
  if (!row) return null;
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  return { metadata, state: (metadata.managedSession as WeldAgentManagedSessionState | undefined) ?? null };
}

async function saveConversationSession(ctx: ToolContext, state: WeldAgentManagedSessionState): Promise<void> {
  const loaded = await loadConversationSession(ctx);
  if (!loaded || !ctx.conversationId) return;
  const { weldagentConversations: conv } = schema;
  await ctx.db
    .update(conv)
    .set({ metadata: { ...loaded.metadata, managedSession: state } })
    .where(eq(conv.id, ctx.conversationId));
}

/** What the wallet can still pay for, as list cost (USD), capped per turn. */
async function turnAllowanceUsd(metering: AiMetering | null): Promise<number> {
  if (!metering) return MAX_TURN_SPEND_USD;
  try {
    const { currentBalance } = await checkCredits(metering.masterDb, metering.internalWsId, 1);
    return Math.min(MAX_TURN_SPEND_USD, Math.max(0.01, currentBalance / CREDITS_PER_USD / PROVIDER_MARKUP));
  } catch {
    return MAX_TURN_SPEND_USD;
  }
}

async function sessionListCostUsd(client: Anthropic, sessionId: string): Promise<number> {
  const session = await client.beta.sessions.retrieve(sessionId);
  return listCostUsd(session.usage?.list_cost);
}

/** Archive a one-off session once it has settled (archive 400s while running). */
async function archiveSession(client: Anthropic, sessionId: string): Promise<void> {
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const session = await client.beta.sessions.retrieve(sessionId);
      if (session.status !== 'running') {
        if (session.status !== 'terminated') await client.beta.sessions.archive(sessionId);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } catch (err) {
    console.warn('[weldagent/managed] archive session failed:', err instanceof Error ? err.message : err);
  }
}

interface TurnOptions {
  metering?: AiMetering | null;
  onText?: (text: string) => void;
}

/**
 * One agent turn on Claude Managed Agents. Conversation turns
 * (`toolContext.conversationId`) keep using the conversation's session;
 * everything else gets a one-off session, archived afterwards.
 */
async function runManagedTurn(input: AgentExecutorInput, options: TurnOptions = {}): Promise<AgentExecutorResult> {
  if (!isManagedAgentsConfigured(input.env)) {
    throw new ManagedAgentsConfigError('Claude Managed Agents is not configured (ANTHROPIC_API_KEY)');
  }
  const client = managedAgentsClient(input.env);
  const ctx = input.toolContext;

  const metering =
    options.metering !== undefined
      ? options.metering
      : await resolveAiMetering(input.env, input.workspaceId, input.actorUserId);
  await assertAiCredits(metering);

  const modelId = resolveManagedModel(input.agent.modelId);
  const setup = agentNeedsSetup(input.agent.systemPrompt);
  const userMessageCount = input.messages.filter((m) => m.role === 'user').length;

  // What may run right now, and what the session declares. During setup the
  // session declares save_agent_setup from the start (one session for the
  // whole interview); calling it too early is refused below.
  const allowedNow = toolsForAgentTurn({
    permissions: input.agent.permissions,
    enabledTools: input.agent.enabledTools,
    systemPrompt: input.agent.systemPrompt,
    userMessageCount,
    actorPermissions: input.actorPermissions,
  });
  const declared = setup
    ? resolveAgentTools([], []).filter((tool) => tool.id === 'agent.save_setup')
    : allowedNow;
  const effectivePermissions = effectiveAgentPermissions(input.agent.permissions, input.actorPermissions);
  const sessionTools = await buildManagedTools(
    declared,
    setup ? { sandbox: false, web: false } : builtinToolAccess(effectivePermissions),
  );
  const agentTools: ManagedToolList = setup
    ? sessionTools
    : await buildManagedTools(
        resolveAgentTools(input.agent.permissions, input.agent.enabledTools),
        builtinToolAccess(input.agent.permissions),
      );

  const [ref, environmentId, system] = await Promise.all([
    ensureManagedAgent(client, ctx.db, input.env, {
      agentId: input.agent.id,
      workspaceId: input.workspaceId,
      name: input.agent.name,
      description: input.agent.description,
      modelId,
      system: buildSystemPrompt(input.agent),
      tools: agentTools,
    }),
    ensureEnvironment(client, input.env),
    buildSessionSystem(input),
  ]);
  const toolsHash = await sha256Hex(JSON.stringify(sessionTools));
  const systemHash = await sha256Hex(system);
  const allowance = await turnAllowanceUsd(metering);

  // --- Session ---------------------------------------------------------------
  const conversation = await loadConversationSession(ctx);
  let state = conversation?.state ?? null;
  if (state && !(await canReuse(client, state, ref, toolsHash))) state = null;

  const kickoff: BetaManagedAgentsEventParams[] = [];
  let sessionId: string;
  let chargedUsd: number;
  const priorMessages = input.messages.slice(0, -1);

  if (state) {
    sessionId = state.sessionId;
    chargedUsd = state.chargedUsd;
    const consumed = await sessionListCostUsd(client, sessionId);
    await client.beta.sessions.update(sessionId, { budget: budgetForUsd(consumed + allowance) });
    if (state.systemHash !== systemHash) {
      kickoff.push({
        type: 'system.message',
        content: [{ type: 'text', text: `Your instructions and saved context were updated. Current version:\n\n${system}` }],
      });
    }
    kickoff.push(userMessageEvent(turnMessage(input.messages, priorMessages.slice(state.syncedMessages))));
  } else {
    const session = await client.beta.sessions.create({
      agent: { type: 'agent_with_overrides', id: ref.id, version: ref.version, system, tools: sessionTools },
      environment_id: environmentId,
      title: `${input.agent.name}${ctx.conversationId ? ' · conversation' : ' · run'}`.slice(0, 200),
      budget: budgetForUsd(allowance),
      metadata: {
        weldsuite_workspace_id: input.workspaceId,
        weldsuite_agent_id: input.agent.id,
        ...(ctx.conversationId ? { weldsuite_conversation_id: ctx.conversationId } : {}),
        ...(ctx.channelId ? { weldsuite_channel_id: ctx.channelId } : {}),
      },
    });
    sessionId = session.id;
    chargedUsd = 0;
    kickoff.push(userMessageEvent(turnMessage(input.messages, priorMessages)));
  }

  // --- Turn ------------------------------------------------------------------
  const invocations: StoredToolInvocation[] = [];
  const allowedNames = new Set(allowedNow.map((tool) => tool.name));
  let outcome: TurnOutcome | undefined;
  let creditsUsed = 0;
  try {
    outcome = await driveTurn({
      client,
      sessionId,
      kickoff,
      deadline: Date.now() + (input.timeoutMs ?? REQUEST_RUN_TIMEOUT_MS),
      maxModelRequests: Math.max(1, input.agent.maxIterations),
      invocations,
      onText: options.onText,
      onCustomTool: async (name, args) => {
        const def = declared.find((tool) => tool.name === name);
        if (!def || !allowedNames.has(name)) {
          const error =
            def && setup
              ? 'Not yet: ask the user at least one clarifying question about routines before saving the setup.'
              : `Tool "${name}" is not available to this agent right now.`;
          invocations.push({ toolName: name, state: 'error', args, result: { error } });
          return { result: { error }, isError: true };
        }
        return executePlatformTool(def, ctx, args, invocations, {
          autoReviewEnabled: input.agent.autoReviewEnabled,
          skipApprovals: input.skipApprovals,
        });
      },
    });
  } finally {
    creditsUsed = await settleTurn({
      client,
      sessionId,
      metering,
      modelId,
      chargedUsd,
      usage: outcome?.usage,
      referenceId: input.agent.id,
    }).then(async ({ credits, totalUsd }) => {
      if (conversation) {
        await saveConversationSession(ctx, {
          sessionId,
          agentObjectId: ref.id,
          agentVersion: ref.version,
          toolsHash,
          systemHash,
          // History plus the assistant reply this turn adds.
          syncedMessages: input.messages.length + 1,
          chargedUsd: totalUsd,
        });
      } else {
        await archiveSession(client, sessionId);
      }
      return credits;
    });
  }

  if (outcome.error && outcome.texts.length === 0) throw new Error(outcome.error);

  const text = outcome.texts.join('\n\n');
  return {
    text: outcome.error ? `${text}\n\n(${outcome.error})` : text,
    modelId,
    finishReason: outcome.finishReason,
    usage: {
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      totalTokens: outcome.usage.inputTokens + outcome.usage.outputTokens,
    },
    creditsUsed,
    toolInvocations: invocations,
    steps: outcome.modelRequests,
  };
}

function userMessageEvent(text: string): BetaManagedAgentsEventParams {
  return { type: 'user.message', content: [{ type: 'text', text }] };
}

/** A stored conversation session is reusable while its agent, tools and status still fit. */
async function canReuse(
  client: Anthropic,
  state: WeldAgentManagedSessionState,
  ref: ManagedAgentRef,
  toolsHash: string,
): Promise<boolean> {
  if (state.agentObjectId !== ref.id || state.agentVersion !== ref.version || state.toolsHash !== toolsHash) {
    return false;
  }
  try {
    const session = await client.beta.sessions.retrieve(state.sessionId);
    return session.status !== 'terminated' && !session.archived_at;
  } catch {
    return false;
  }
}

/**
 * Charge the turn: the session's list-cost growth since the last charge, or
 * the token price when that is higher (list cost is rounded to cents).
 * Never throws — the work already happened.
 */
async function settleTurn(params: {
  client: Anthropic;
  sessionId: string;
  metering: AiMetering | null;
  modelId: string;
  chargedUsd: number;
  usage?: { inputTokens: number; outputTokens: number };
  referenceId: string;
}): Promise<{ credits: number; totalUsd: number }> {
  let totalUsd = params.chargedUsd;
  try {
    totalUsd = Math.max(params.chargedUsd, await sessionListCostUsd(params.client, params.sessionId));
  } catch (err) {
    console.error('[weldagent/managed] reading session cost failed:', err);
  }
  const usage = params.usage ?? { inputTokens: 0, outputTokens: 0 };
  const tokenUsd = providerCostUsd(params.modelId, usage);
  const costUsd = Math.max(totalUsd - params.chargedUsd, tokenUsd);
  if (costUsd <= 0) return { credits: 0, totalUsd };
  const credits = await chargeAiUsage(params.metering, {
    modelId: params.modelId,
    usage,
    op: 'agent',
    referenceId: params.referenceId,
    costUsd,
  });
  return { credits, totalUsd };
}

/**
 * Run one agent turn to completion (chat turns, manual / event / routine runs,
 * WeldChat room replies).
 */
export async function runAgentOnce(input: AgentExecutorInput): Promise<AgentExecutorResult> {
  return runManagedTurn(input);
}

export interface StreamAgentParams extends AgentExecutorInput {
  metering: AiMetering | null;
  executionCtx: { waitUntil: (p: Promise<unknown>) => void };
}

/**
 * Streaming chat: a `text/plain` stream of the agent's reply as it is written.
 * Tool calls run in between; the turn is charged when it settles.
 */
export function streamAgentChat(input: StreamAgentParams): { stream: ReadableStream<Uint8Array>; modelId: string } {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let pending = Promise.resolve();
  const write = (text: string) => {
    pending = pending.then(() => writer.write(encoder.encode(text))).catch(() => undefined);
  };

  const work = runManagedTurn(input, { metering: input.metering, onText: write })
    .catch((err) => {
      console.error('[weldagent/stream] turn failed:', err);
      write(`\n\n${err instanceof Error ? err.message : 'The agent could not finish this reply.'}`);
    })
    .finally(async () => {
      await pending;
      await writer.close().catch(() => undefined);
    });
  input.executionCtx.waitUntil(work);

  return { stream: readable, modelId: resolveManagedModel(input.agent.modelId) };
}
