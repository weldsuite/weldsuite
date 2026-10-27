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
import type { Database as NotificationDatabase, NotificationEnv } from '@weldsuite/notifications/types';
import {
  ASK_USER_TOOL_NAME,
  encodeQuestionMarker,
  parseAgentQuestion,
} from '@weldsuite/app-api-client/schemas/weldagent-questions';
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
import { getSubagents, type SerializedAgent } from './agents';
import { agentViewerFor, canEditAgent } from './access';
import { approvalLabel, approvalRecipients, heldForApprovalMessage } from './approval-labels';
import {
  budgetForUsd,
  buildManagedTools,
  builtinToolAccess,
  builtinToolGrant,
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
  /**
   * The conversation so far, ending with this turn's user message. For a long
   * chat only its recent part; `historyOffset` says how many older messages
   * precede it.
   */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  historyOffset?: number;
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
  'The user was just asked "What should this agent do?" and their first message is the answer. ' +
  'Interview them until you know your purpose AND your routines, then save your setup.\n\n' +
  'HOW TO ASK:\n' +
  '- Ask every question with the ask_user tool: one focused question, 2-4 concrete options that fit what they told you. ' +
  'They can always type their own answer, so do not add an "other" option.\n' +
  '- Before calling ask_user, write at most one short sentence (or nothing). Do not repeat the question or the options in text.\n' +
  '- After ask_user, end your turn. Their answer arrives as the next message.\n' +
  '- Usually 2-4 questions are enough: what to focus on, when to act (new records, a schedule, only when asked in chat), ' +
  'and what to do each time. Skip anything their answers already cover.\n\n' +
  'HARD RULES:\n' +
  '- NEVER call save_agent_setup until the user has answered at least one question about routines (when you act).\n' +
  '- NEVER say you are "active", "ready", or "now helping" until save_agent_setup has succeeded.\n' +
  '- Set activate=true only if the user explicitly asks you to go live / activate; otherwise set activate=false and you keep your current status (a new agent stays a draft).\n' +
  '- Do not invent workspace data or claim you already run automations.\n\n' +
  'When purpose and routines are clear, call save_agent_setup with a short display name, lasting systemPrompt, description, ' +
  'and the workspace permissions the job needs (e.g. tasks:read for a task digest, tickets:read and tickets:update for triage). ' +
  'If it reports permissions it could not grant, say so. ' +
  'After a successful save, confirm in two or three sentences who you are and what you will do.';

/** The setup interview's tools, from the first turn on: ask_user and save_agent_setup. */
function setupTools(canEdit = true): PlatformToolDefinition[] {
  return resolveAgentTools([], [], canEdit).filter(
    (tool) => tool.id === 'agent.ask_user' || tool.id === 'agent.save_setup',
  );
}

/**
 * Whether the person driving the turn may change the agent: its owner or a
 * manager, the rule its routes apply. Unattended runs (no actor permissions)
 * keep maintaining their own agent.
 */
function actorMayEdit(
  agent: { ownerId: string | null },
  input: { actorUserId: string; actorPermissions?: string[] | null },
): boolean {
  if (!input.actorPermissions) return true;
  return canEditAgent(agent, agentViewerFor(input.actorUserId, { permissions: input.actorPermissions }));
}

/**
 * The platform tools the agent may run this turn. During onboarding only
 * ask_user, plus save_agent_setup once the user has answered at least one
 * follow-up, so the interview cannot invent workspace mutations.
 */
export function toolsForAgentTurn(input: {
  permissions: string[];
  enabledTools: string[];
  systemPrompt: string;
  userMessageCount: number;
  actorPermissions?: string[] | null;
  /** False when the person chatting may not change the agent: it gets no setup, routine, skill or memory tools. */
  canEdit?: boolean;
}): PlatformToolDefinition[] {
  const canEdit = input.canEdit ?? true;
  if (agentNeedsSetup(input.systemPrompt)) {
    const tools = setupTools(canEdit);
    return input.userMessageCount < 2 ? tools.filter((tool) => tool.id === 'agent.ask_user') : tools;
  }
  return resolveAgentTools(
    effectiveAgentPermissions(input.permissions, input.actorPermissions),
    input.enabledTools,
    canEdit,
  );
}

/**
 * How every workspace agent talks about records, whatever its own
 * instructions say: people read names, not database keys.
 */
export const PRESENTATION_RULES =
  'Never show internal ids (for example prj_…, task_…, per_…, apr_…, agt_…), tool names or raw field keys to the user. ' +
  'Refer to records by their name, title or number.';

/** The agent's own system prompt, as stored on its Anthropic agent object. */
export function buildSystemPrompt(agent: AgentExecutorInput['agent']): string {
  if (agentNeedsSetup(agent.systemPrompt)) {
    return (
      `You are "${agent.name}", a workspace AI agent in WeldSuite that is being configured for the first time.\n\n` +
      `${PRESENTATION_RULES}\n\n` +
      SETUP_INTERVIEW_INSTRUCTIONS
    );
  }

  return (
    `You are "${agent.name}", a workspace AI agent in WeldSuite. ` +
    'You act on workspace data only through the WeldSuite tools you have been given. Never invent IDs or claim you mutated data without a successful tool result. ' +
    `${PRESENTATION_RULES} ` +
    'Prefer WeldSuite tools (people, tickets, tasks, chat) when they fit. When you have them, use your sandbox (bash, files) for scripts, data work and code, ' +
    'web search / fetch to look things up, and browser_* only for interactive websites without an API. ' +
    'When you need a decision or a missing detail from the user, ask it with ask_user (one question, concrete options) and end your turn. ' +
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

/**
 * Tell the people who must act that an approval is waiting: the agent's owner,
 * like a manager asked to sign off (not when they asked themselves and see it
 * in their chat), and whoever asked in a WeldChat room, where there is no chat
 * of theirs to show it. Never throws.
 */
async function notifyApprovalPeople(ctx: ToolContext, approvalId: string, label: string): Promise<void> {
  if (!ctx.env) return;
  try {
    const [agent] = await ctx.db
      .select({ name: schema.weldagentAgents.name, ownerId: schema.weldagentAgents.ownerId })
      .from(schema.weldagentAgents)
      .where(eq(schema.weldagentAgents.id, ctx.agentId))
      .limit(1);
    if (!agent) return;
    const recipients = approvalRecipients({
      ownerId: agent.ownerId,
      actorUserId: ctx.actorUserId,
      inChannel: Boolean(ctx.channelId),
    });
    if (recipients.length === 0) return;
    const { sendWeldAgentApprovalNotification } = await import('@weldsuite/notifications');
    await Promise.all(
      recipients.map((userId) =>
        sendWeldAgentApprovalNotification({
          db: ctx.db as unknown as NotificationDatabase,
          env: ctx.env as unknown as NotificationEnv,
          workspaceId: ctx.workspaceId,
          userId,
          agentId: ctx.agentId,
          agentName: agent.name,
          approvalId,
          label,
        }),
      ),
    );
  } catch (err) {
    console.warn('[weldagent] approval notification failed:', err instanceof Error ? err.message : err);
  }
}

async function executePlatformTool(
  def: PlatformToolDefinition,
  ctx: ToolContext,
  input: unknown,
  invocations: StoredToolInvocation[],
  opts: { autoReviewEnabled?: boolean; skipApprovals?: boolean },
): Promise<{ result: unknown; isError: boolean }> {
  // One stored entry per call: it starts as `call` and takes its final state.
  const entry: StoredToolInvocation = { toolName: def.name, state: 'call', args: input };
  invocations.push(entry);
  const settle = (state: 'result' | 'error', result: unknown) => {
    entry.state = state;
    entry.result = result;
  };
  try {
    const { toolRiskLevel, createApproval, findPriorApproval, allowsAutoReview } = await import('./parity');
    const risk = toolRiskLevel(def.name, input);
    if (risk === 'high' && !opts.skipApprovals) {
      const autoOk =
        opts.autoReviewEnabled &&
        allowsAutoReview(def.name) &&
        (await findPriorApproval(ctx.db, ctx.agentId, def.name));
      if (!autoOk) {
        const args = (input && typeof input === 'object' ? input : { value: input }) as Record<string, unknown>;
        const approval = await createApproval(ctx.db, {
          agentId: ctx.agentId,
          conversationId: ctx.conversationId ?? ctx.channelId ?? null,
          toolName: def.name,
          args,
          riskLevel: 'high',
          createdBy: ctx.actorUserId,
        });
        const label = approvalLabel(def.name, args);
        await notifyApprovalPeople(ctx, approval.id, label);
        // The stored step carries the approval to decide (the chat and the
        // room render its buttons from it); the model is told it is held,
        // without an id it could repeat to the user.
        settle('result', {
          pendingApproval: true,
          approvalId: approval.id,
          label,
          message: `Waiting for approval: ${label}`,
        });
        return { result: { pendingApproval: true, message: heldForApprovalMessage(label) }, isError: false };
      }
    }
    const result = await def.execute(ctx, input);
    settle('result', result);
    return { result, isError: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Tool failed';
    settle('error', { error: message });
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

/** Who runs a session thread: its agent's name and Anthropic object id. */
export interface ThreadAgent {
  name: string;
  objectId: string | null;
}

/** The stored invocation name for work handed to (and reported back by) a sub-agent. */
export const DELEGATION_TOOL_NAME = 'delegate_to_agent';

type TurnEvent = BetaManagedAgentsStreamSessionEvents | BetaManagedAgentsSessionEvent;
type EventOf<T extends TurnEvent['type']> = Extract<TurnEvent, { type: T }>;

export interface TurnOutcome {
  texts: string[];
  finishReason: string;
  error?: string;
  modelRequests: number;
  usage: { inputTokens: number; outputTokens: number };
  /**
   * Input tokens weighted by their list price relative to uncached input
   * (cache reads 0.1×, cache writes 1.25×), for pricing a turn by tokens.
   */
  pricedInputTokens: number;
}

export interface DriveTurnParams {
  client: Anthropic;
  sessionId: string;
  kickoff: BetaManagedAgentsEventParams[];
  deadline: number;
  maxModelRequests: number;
  /** `agent`: the sub-agent whose thread made the call (null: this agent or a copy of it). */
  onCustomTool: (
    name: string,
    input: unknown,
    agent: ThreadAgent | null,
  ) => Promise<{ result: unknown; isError: boolean }>;
  /** A sub-agent's sandbox / web call waiting for a decision: may it run? */
  allowSubagentBuiltin?: (agent: ThreadAgent | null, toolName: string) => boolean;
  invocations: StoredToolInvocation[];
  onText?: (text: string) => void;
  /** Aborting it (e.g. the client went away) interrupts the turn. */
  signal?: AbortSignal;
}

/** Anthropic list price of cached input relative to uncached input. */
const CACHE_READ_PRICE_RATIO = 0.1;
const CACHE_WRITE_PRICE_RATIO = 1.25;

/**
 * State of one turn as its events arrive. One small handler per event family;
 * {@link TurnFollower.handle} dispatches and drops events already seen (the
 * stream and the history replay overlap after a reconnect).
 */
class TurnFollower {
  readonly outcome: TurnOutcome = {
    texts: [],
    finishReason: 'end_turn',
    modelRequests: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    pricedInputTokens: 0,
  };
  done = false;
  /** Why the turn was stopped from our side, if it was. */
  stopped: 'timeout' | 'cancelled' | null = null;
  private readonly seen = new Set<string>();
  private readonly kickoffIds = new Set<string>();
  /** Built-in tool calls by event id: the stored step each result completes. */
  private readonly builtinCalls = new Map<string, StoredToolInvocation>();
  /** Questions already put to the user this turn (as streamed), so a repeat is not shown twice. */
  private readonly questionsEmitted = new Set<string>();
  /** Session threads (sub-agents and copies) by id. */
  private readonly threads = new Map<string, ThreadAgent>();
  /** Preview text already emitted per agent.message id (streaming only). */
  private readonly emitted = new Map<string, number>();
  private emittedAny = false;
  private started = false;
  private interrupted = false;
  private kickoffSent = false;
  private lastError: string | undefined;

  constructor(private readonly params: DriveTurnParams) {}

  private send(events: BetaManagedAgentsEventParams[]) {
    return this.params.client.beta.sessions.events.send(this.params.sessionId, { events });
  }

  async interrupt(): Promise<void> {
    if (this.interrupted) return;
    this.interrupted = true;
    try {
      await this.send([{ type: 'user.interrupt' }]);
    } catch (err) {
      console.warn('[weldagent/managed] interrupt failed:', err instanceof Error ? err.message : err);
    }
  }

  stop(reason: 'timeout' | 'cancelled'): void {
    this.stopped ??= reason;
    void this.interrupt();
  }

  stopError(): Error | null {
    if (this.stopped === 'timeout') return new Error('The agent did not finish in time');
    if (this.stopped === 'cancelled') return new Error('The turn was cancelled');
    return null;
  }

  /** Stream first, then send: the stream only carries events after it opens. */
  async sendKickoffOnce(): Promise<void> {
    if (this.kickoffSent) return;
    const sent = await this.send(this.params.kickoff);
    for (const ev of sent.data ?? []) if (ev.id) this.kickoffIds.add(ev.id);
    this.kickoffSent = true;
  }

  /** Replay the history from the kickoff on (covers a dropped stream's gap). */
  async replayHistory(): Promise<void> {
    let afterKickoff = false;
    for await (const ev of this.params.client.beta.sessions.events.list(this.params.sessionId)) {
      afterKickoff ||= this.kickoffIds.has(ev.id);
      if (!afterKickoff) continue;
      await this.handle(ev);
      if (this.done) return;
    }
  }

  async handle(ev: TurnEvent): Promise<void> {
    const id = 'id' in ev ? ev.id : undefined;
    if (id) {
      if (this.seen.has(id)) return;
      this.seen.add(id);
    }
    switch (ev.type) {
      case 'event_start':
        return this.onPreviewStart(ev);
      case 'event_delta':
        return this.onPreviewDelta(ev);
      case 'user.message':
        if (this.kickoffIds.has(ev.id) && ev.processed_at) this.started = true;
        return;
      case 'session.status_running':
        this.started = true;
        return;
      case 'span.model_request_start':
        return this.onModelRequestStart();
      case 'span.model_request_end':
        return this.onModelRequestEnd(ev);
      case 'agent.message':
        return this.onAgentMessage(ev);
      case 'agent.custom_tool_use':
        return this.onCustomToolUse(ev);
      case 'agent.tool_use':
      case 'agent.mcp_tool_use':
        return this.onBuiltinToolUse(ev);
      case 'agent.tool_result':
        return this.onBuiltinToolResult(ev);
      case 'session.thread_created':
        // The event names the agent but not its object; {@link threadAgent}
        // reads the thread for that when the thread first needs us.
        return;
      case 'agent.thread_message_sent':
        return this.onThreadMessage(ev.to_agent_name, 'call', ev.content);
      case 'agent.thread_message_received':
        return this.onThreadMessage(ev.from_agent_name, 'result', ev.content);
      case 'session.error':
        this.lastError = (ev.error as { message?: string }).message || ev.error.type;
        return;
      case 'session.status_idle':
        return this.onIdle(ev);
      case 'session.status_terminated':
        this.done = true;
        this.outcome.finishReason = 'error';
        this.outcome.error = this.lastError ?? 'The agent session ended unexpectedly';
        return;
      default:
        return;
    }
  }

  private emit(text: string): void {
    if (text) this.params.onText?.(text);
  }

  /** Separate consecutive messages in the streamed text. */
  private beginMessage(): void {
    if (this.emittedAny) this.emit('\n\n');
    this.emittedAny = true;
  }

  /** Streamed turns carry an ask_user question inline, for the client to render as a card. */
  private emitQuestion(input: unknown): void {
    const question = parseAgentQuestion(input);
    if (!question) return;
    const key = JSON.stringify(question);
    if (this.questionsEmitted.has(key)) return;
    this.questionsEmitted.add(key);
    this.beginMessage();
    this.emit(encodeQuestionMarker(question));
  }

  private onPreviewStart(ev: EventOf<'event_start'>): void {
    if (ev.event.type !== 'agent.message') return;
    this.beginMessage();
    this.emitted.set(ev.event.id, 0);
  }

  private onPreviewDelta(ev: EventOf<'event_delta'>): void {
    const text = ev.delta.content.text ?? '';
    this.emitted.set(ev.event_id, (this.emitted.get(ev.event_id) ?? 0) + text.length);
    this.emit(text);
  }

  private async onModelRequestStart(): Promise<void> {
    this.started = true;
    this.outcome.modelRequests += 1;
    if (this.outcome.modelRequests > this.params.maxModelRequests) {
      this.outcome.finishReason = 'max_iterations';
      await this.interrupt();
    }
  }

  private onModelRequestEnd(ev: EventOf<'span.model_request_end'>): void {
    const usage = ev.model_usage;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const uncached = usage.input_tokens ?? 0;
    this.outcome.usage.inputTokens += uncached + cacheRead + cacheWrite;
    this.outcome.usage.outputTokens += usage.output_tokens ?? 0;
    this.outcome.pricedInputTokens +=
      uncached + cacheRead * CACHE_READ_PRICE_RATIO + cacheWrite * CACHE_WRITE_PRICE_RATIO;
  }

  private onAgentMessage(ev: EventOf<'agent.message'>): void {
    const text = blocksText(ev.content);
    if (!text) return;
    this.outcome.texts.push(text);
    // Reconcile the preview: emit whatever the deltas did not cover.
    const already = this.emitted.get(ev.id);
    if (already === undefined) {
      this.beginMessage();
      this.emit(text);
    } else if (already < text.length) {
      this.emit(text.slice(already));
    }
  }

  /**
   * The agent running a cross-posted call's thread; null for the primary
   * thread. Identified by its Anthropic object id (read from the thread once,
   * then cached), never by name: names can collide after a rename. When the
   * thread can't be read, `objectId` is null and the caller refuses the call.
   */
  private async threadAgent(threadId: string | null | undefined): Promise<ThreadAgent | null> {
    if (!threadId) return null;
    const known = this.threads.get(threadId);
    if (known) return known;
    try {
      const thread = await this.params.client.beta.sessions.threads.retrieve(threadId, {
        session_id: this.params.sessionId,
      });
      const agent = thread.agent as { id?: string; name?: string };
      const found = { name: agent.name ?? '', objectId: agent.id ?? null };
      this.threads.set(threadId, found);
      return found;
    } catch (err) {
      console.warn('[weldagent/managed] reading a thread failed:', err instanceof Error ? err.message : err);
      return { name: '', objectId: null };
    }
  }

  /** Work handed to a sub-agent (`call`) and its report (`result`), as one stored step. */
  private onThreadMessage(agentName: string | null | undefined, state: 'call' | 'result', content: unknown): void {
    if (!agentName) return;
    const text = blocksText(content);
    this.params.invocations.push(
      state === 'call'
        ? { toolName: DELEGATION_TOOL_NAME, state, args: { agent: agentName, task: text } }
        : {
            toolName: DELEGATION_TOOL_NAME,
            state,
            args: { agent: agentName },
            result: text.length > MAX_STORED_RESULT_CHARS ? `${text.slice(0, MAX_STORED_RESULT_CHARS)}…` : text,
          },
    );
  }

  private async onCustomToolUse(ev: EventOf<'agent.custom_tool_use'>): Promise<void> {
    const agent = await this.threadAgent(ev.session_thread_id);
    const { result, isError } = await this.params.onCustomTool(ev.name, ev.input, agent);
    if (ev.name === ASK_USER_TOOL_NAME && !isError) this.emitQuestion(ev.input);
    await this.send([
      {
        type: 'user.custom_tool_result',
        custom_tool_use_id: ev.id,
        content: [{ type: 'text', text: toResultText(result) }],
        is_error: isError,
      },
    ]);
  }

  private async onBuiltinToolUse(ev: EventOf<'agent.tool_use'> | EventOf<'agent.mcp_tool_use'>): Promise<void> {
    if (ev.session_thread_id) {
      // A sub-agent's call, paused for us (its worker object always asks).
      if (ev.evaluated_permission !== 'ask') return;
      const agent = await this.threadAgent(ev.session_thread_id);
      const allowed = this.params.allowSubagentBuiltin?.(agent, ev.name) ?? false;
      await this.send([
        allowed
          ? { type: 'user.tool_confirmation', tool_use_id: ev.id, result: 'allow' }
          : {
              type: 'user.tool_confirmation',
              tool_use_id: ev.id,
              result: 'deny',
              deny_message: 'The person this work is for may not use this tool, so it is not available to you here.',
            },
      ]);
      return;
    }
    // One stored step per call: its result (below) completes this entry.
    const step: StoredToolInvocation = { toolName: ev.name, state: 'call', args: ev.input };
    this.builtinCalls.set(ev.id, step);
    this.params.invocations.push(step);
    if (ev.evaluated_permission !== 'ask') return;
    // Paused for approval with nobody to ask: deny, never blanket-allow.
    await this.send([
      { type: 'user.tool_confirmation', tool_use_id: ev.id, result: 'deny', deny_message: DENY_UNREVIEWED },
    ]);
  }

  private onBuiltinToolResult(ev: EventOf<'agent.tool_result'>): void {
    const text = blocksText(ev.content);
    const state = ev.is_error ? 'error' : 'result';
    const result = text.length > MAX_STORED_RESULT_CHARS ? `${text.slice(0, MAX_STORED_RESULT_CHARS)}…` : text;
    const step = this.builtinCalls.get(ev.tool_use_id);
    if (step) {
      step.state = state;
      step.result = result;
    } else {
      this.params.invocations.push({ toolName: 'tool', state, result });
    }
  }

  private onIdle(ev: EventOf<'session.status_idle'>): void {
    const reason = ev.stop_reason.type;
    if (!this.started || reason === 'requires_action') return;
    this.done = true;
    const outcome = this.outcome;
    if (reason === 'retries_exhausted') {
      outcome.finishReason = 'error';
      outcome.error = this.lastError ?? 'The agent session failed after retries';
    } else if (reason === 'budget_reached') {
      outcome.finishReason = 'budget_reached';
      outcome.error = 'This turn reached its spending limit (credits or the per-turn cap).';
    } else if (reason === 'refusal') {
      outcome.finishReason = 'refusal';
    } else if (outcome.finishReason === 'end_turn' && this.interrupted && !this.stopped) {
      outcome.finishReason = 'max_iterations';
    }
  }
}

/** Open the event stream once (sending the kickoff the first time) and follow it. */
async function followStream(follower: TurnFollower, params: DriveTurnParams, signal: AbortSignal, replay: boolean) {
  const stream = await params.client.beta.sessions.events.stream(
    params.sessionId,
    params.onText ? { event_deltas: ['agent.message'] } : {},
    { signal },
  );
  await follower.sendKickoffOnce();
  if (replay) await follower.replayHistory();
  if (follower.done) {
    // Settled during the replay: don't wait on the live stream.
    stream.controller.abort();
    return;
  }
  for await (const ev of stream) {
    await follower.handle(ev);
    if (follower.done) break;
  }
  if (follower.done) stream.controller.abort();
}

/**
 * Follow the session until the turn settles. The SSE stream has no replay, so
 * a dropped connection is reopened and the history replayed from the kickoff.
 */
async function followSession(follower: TurnFollower, params: DriveTurnParams, signal: AbortSignal) {
  let replay = false;
  let reconnects = 0;
  while (!follower.done) {
    throwIfStopped(follower);
    try {
      await followStream(follower, params, signal, replay);
    } catch (err) {
      reconnects = afterStreamError(follower, err, reconnects);
    }
    replay = true;
    if (!follower.done && Date.now() > params.deadline) follower.stop('timeout');
  }
}

/** The stop error (timeout / cancel) once the turn was stopped from our side. */
function throwIfStopped(follower: TurnFollower): void {
  const stopError = follower.stopError();
  if (stopError) throw stopError;
}

/** A dropped stream: rethrow a stop or a 4th failure, otherwise count it and reconnect. */
function afterStreamError(follower: TurnFollower, err: unknown, reconnects: number): number {
  throwIfStopped(follower);
  if (reconnects >= 3) throw err;
  console.warn('[weldagent/managed] event stream dropped, reconnecting:', err instanceof Error ? err.message : err);
  return reconnects + 1;
}

/**
 * Send the kickoff events and follow the session until the turn settles:
 * idle with anything but `requires_action`, or terminated. Past the deadline,
 * or when `params.signal` aborts, the turn is interrupted and this throws.
 */
export async function driveTurn(params: DriveTurnParams): Promise<TurnOutcome> {
  const follower = new TurnFollower(params);
  const abort = new AbortController();
  const stop = (reason: 'timeout' | 'cancelled') => {
    follower.stop(reason);
    abort.abort();
  };
  const timer = setTimeout(() => stop('timeout'), Math.max(1_000, params.deadline - Date.now()));
  const onCancel = () => stop('cancelled');
  params.signal?.addEventListener('abort', onCancel, { once: true });
  try {
    if (params.signal?.aborted) onCancel();
    await followSession(follower, params, abort.signal);
    const stopError = follower.stopError();
    if (stopError && !follower.done) throw stopError;
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener('abort', onCancel);
  }
  return follower.outcome;
}

function transcript(messages: AgentExecutorInput['messages']): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
}

/** The user message for a turn, with any history the session has not seen. */
function turnMessage(
  messages: AgentExecutorInput['messages'],
  unseen: AgentExecutorInput['messages'],
  olderOmitted = false,
): string {
  const latest = messages[messages.length - 1]?.content ?? '';
  if (unseen.length === 0) return latest;
  const intro = olderOmitted
    ? 'This is a long-running chat. The most recent part of it (for context; you did not see these messages yet; older messages are not included):\n\n'
    : 'Earlier in this conversation (for context; you did not see these messages yet):\n\n';
  return `${intro}${transcript(unseen)}\n\n---\n\n${latest}`;
}

/** Most history a new session is seeded with; the rest of a long chat is summarised away. */
const SEED_HISTORY_MAX_CHARS = 120_000;

/** The newest messages that fit {@link SEED_HISTORY_MAX_CHARS}, oldest first. */
function seedHistory(prior: AgentExecutorInput['messages']): AgentExecutorInput['messages'] {
  let total = 0;
  let start = prior.length;
  while (start > 0) {
    const next = prior[start - 1].content.length + 16;
    if (total + next > SEED_HISTORY_MAX_CHARS) break;
    total += next;
    start -= 1;
  }
  return prior.slice(start);
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

/**
 * Archive a kept session's finished sub-agent threads. A session holds at
 * most 25 child threads, idle ones included, and a continuous chat outlives
 * that; the reports already came back to the agent. Best effort.
 */
async function archiveIdleThreads(client: Anthropic, sessionId: string): Promise<void> {
  try {
    for await (const thread of client.beta.sessions.threads.list(sessionId)) {
      if (!thread.parent_thread_id || thread.archived_at || thread.status !== 'idle') continue;
      await client.beta.sessions.threads.archive(thread.id, { session_id: sessionId });
    }
  } catch (err) {
    console.warn('[weldagent/managed] archiving sub-agent threads failed:', err instanceof Error ? err.message : err);
  }
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
  /** Aborting it interrupts the turn (the turn is still charged for what ran). */
  signal?: AbortSignal;
}

/** Everything a turn needs before it touches a session. */
interface PreparedTurn {
  client: Anthropic;
  metering: AiMetering | null;
  modelId: string;
  setup: boolean;
  /** Whether the person chatting may change the agent (its owner or a manager). */
  canEdit: boolean;
  /** Platform tools that may run this turn. */
  allowedNow: PlatformToolDefinition[];
  /** Platform tools the session declares (setup: save_agent_setup from the start). */
  declared: PlatformToolDefinition[];
  sessionTools: ManagedToolList;
  ref: ManagedAgentRef;
  environmentId: string;
  system: string;
  toolsHash: string;
  systemHash: string;
  allowanceUsd: number;
  /** The sub-agents this turn may delegate to, by name and worker object id. */
  team: SubagentTeam | null;
}

/** A sub-agent as it works in this turn: tools narrowed to the person chatting. */
interface SubagentMember {
  agent: SerializedAgent;
  objectId: string;
  /** Its grants narrowed to the actor (unattended runs: as granted). */
  permissions: string[];
  /** Whether the actor may change this sub-agent (its owner or a manager). */
  canEdit: boolean;
  /** Platform tools it may run this turn. */
  tools: PlatformToolDefinition[];
}

interface SubagentTeam {
  roster: Array<ManagedAgentRef | 'self'>;
  members: SubagentMember[];
}

/** Platform tools a sub-agent never gets: it does not interview the user or set itself up. */
const WORKER_EXCLUDED_TOOLS = new Set(['agent.ask_user', 'agent.save_setup']);

function workerTools(permissions: string[], enabledTools: string[], canEdit = true): PlatformToolDefinition[] {
  return resolveAgentTools(permissions, enabledTools, canEdit).filter((tool) => !WORKER_EXCLUDED_TOOLS.has(tool.id));
}

/**
 * Sync the worker objects of the agent's sub-agents and build this turn's
 * roster. Sub-agents still in setup are left out. Each worker object carries
 * the sub-agent's full grants (an agent object can't be narrowed per
 * session), so the driver narrows: custom tools run with the sub-agent's
 * grants ∩ the actor's, and sandbox / web calls ask first.
 */
async function prepareTeam(
  client: Anthropic,
  input: AgentExecutorInput,
  environment: { workspaceId: string; env: Env },
): Promise<SubagentTeam | null> {
  // Read from the row, not the caller: every turn (chat, run, room reply)
  // must sync the same roster, or the agent object's version would flip.
  const [row] = await input.toolContext.db
    .select({ subagentIds: schema.weldagentAgents.subagentIds, delegateToSelf: schema.weldagentAgents.delegateToSelf })
    .from(schema.weldagentAgents)
    .where(eq(schema.weldagentAgents.id, input.agent.id))
    .limit(1);
  const subIds = (row?.subagentIds ?? []) as string[];
  const self = Boolean(row?.delegateToSelf);
  if (subIds.length === 0 && !self) return null;

  const subs = (await getSubagents(input.toolContext.db, subIds)).filter(
    (sub) => sub.id !== input.agent.id && !agentNeedsSetup(sub.systemPrompt),
  );
  const members = await Promise.all(
    subs.map(async (sub): Promise<SubagentMember & { ref: ManagedAgentRef }> => {
      const ref = await ensureManagedAgent(client, input.toolContext.db, environment.env, {
        agentId: sub.id,
        workspaceId: environment.workspaceId,
        name: sub.name,
        description: sub.description,
        modelId: sub.modelId,
        system: buildSystemPrompt(sub),
        tools: await buildManagedTools(
          workerTools(sub.permissions, sub.enabledTools),
          builtinToolAccess(sub.permissions),
          'ask',
        ),
        variant: 'worker',
      });
      const permissions = effectiveAgentPermissions(sub.permissions, input.actorPermissions);
      const canEdit = actorMayEdit(sub, input);
      return {
        agent: sub,
        objectId: ref.id,
        ref,
        permissions,
        canEdit,
        tools: workerTools(permissions, sub.enabledTools, canEdit),
      };
    }),
  );
  const roster: SubagentTeam['roster'] = members.map((member) => member.ref);
  if (self) roster.push('self');
  return roster.length > 0 ? { roster, members } : null;
}

/** The sub-agent running a thread, matched by its worker object id (a copy of the agent itself is none). */
function findMember(team: SubagentTeam | null, agent: ThreadAgent | null): SubagentMember | null {
  if (!team || !agent?.objectId) return null;
  return team.members.find((member) => member.objectId === agent.objectId) ?? null;
}

/** A sub-agent's sandbox / web call runs only when its narrowed grants allow it. */
function allowSubagentBuiltin(team: SubagentTeam | null, agent: ThreadAgent | null, toolName: string): boolean {
  const member = findMember(team, agent);
  const grant = builtinToolGrant(toolName);
  if (!member || !grant) return false;
  return builtinToolAccess(member.permissions)[grant === 'computer:use' ? 'sandbox' : 'web'];
}

async function prepareTurn(input: AgentExecutorInput, options: TurnOptions): Promise<PreparedTurn> {
  if (!isManagedAgentsConfigured(input.env)) {
    throw new ManagedAgentsConfigError('Claude Managed Agents is not configured (ANTHROPIC_API_KEY)');
  }
  const client = managedAgentsClient(input.env);
  const metering =
    options.metering === undefined
      ? await resolveAiMetering(input.env, input.workspaceId, input.actorUserId)
      : options.metering;
  await assertAiCredits(metering);

  const modelId = resolveManagedModel(input.agent.modelId);
  const setup = agentNeedsSetup(input.agent.systemPrompt);
  // Read from the row, not the caller: who owns the agent decides whether the
  // person chatting may change it through the setup, routine, skill and memory tools.
  const [ownerRow] = await input.toolContext.db
    .select({ ownerId: schema.weldagentAgents.ownerId })
    .from(schema.weldagentAgents)
    .where(eq(schema.weldagentAgents.id, input.agent.id))
    .limit(1);
  const canEdit = actorMayEdit({ ownerId: ownerRow?.ownerId ?? null }, input);
  // During setup the session declares both setup tools from the start (one
  // session for the whole interview); saving too early is refused.
  const allowedNow = toolsForAgentTurn({
    permissions: input.agent.permissions,
    enabledTools: input.agent.enabledTools,
    systemPrompt: input.agent.systemPrompt,
    userMessageCount: input.messages.filter((m) => m.role === 'user').length,
    actorPermissions: input.actorPermissions,
    canEdit,
  });
  const declared = setup ? setupTools(canEdit) : allowedNow;
  const sessionTools = await buildManagedTools(
    declared,
    setup
      ? { sandbox: false, web: false }
      : builtinToolAccess(effectiveAgentPermissions(input.agent.permissions, input.actorPermissions)),
  );
  const agentTools = setup ? sessionTools : await agentObjectTools(input);
  // The roster lives on the agent object, so the worker objects come first.
  const team = setup ? null : await prepareTeam(client, input, { workspaceId: input.workspaceId, env: input.env });

  const [ref, environmentId, system] = await Promise.all([
    ensureManagedAgent(client, input.toolContext.db, input.env, {
      agentId: input.agent.id,
      workspaceId: input.workspaceId,
      name: input.agent.name,
      description: input.agent.description,
      modelId,
      system: buildSystemPrompt(input.agent),
      tools: agentTools,
      roster: team?.roster,
    }),
    ensureEnvironment(client, input.env),
    buildSessionSystem(input),
  ]);

  return {
    client,
    metering,
    modelId,
    setup,
    canEdit,
    allowedNow,
    declared,
    sessionTools,
    ref,
    environmentId,
    system,
    toolsHash: await sha256Hex(JSON.stringify(sessionTools)),
    systemHash: await sha256Hex(system),
    allowanceUsd: await turnAllowanceUsd(metering),
    team,
  };
}

/** The agent object's own tools: everything its grants allow, unnarrowed. */
function agentObjectTools(input: AgentExecutorInput): Promise<ManagedToolList> {
  return buildManagedTools(
    resolveAgentTools(input.agent.permissions, input.agent.enabledTools),
    builtinToolAccess(input.agent.permissions),
  );
}

interface TurnSession {
  sessionId: string;
  /** List cost (USD) already charged before this turn. */
  chargedUsd: number;
  kickoff: BetaManagedAgentsEventParams[];
  /** Set for conversation turns: the session is kept and its state saved. */
  conversation: Awaited<ReturnType<typeof loadConversationSession>>;
}

/**
 * The conversation's session when it still fits (same agent version and tool
 * list, not terminated), with its budget topped up for this turn; otherwise a
 * new session seeded with the history it has not seen.
 */
async function openOrReuseSession(input: AgentExecutorInput, turn: PreparedTurn): Promise<TurnSession> {
  const { client } = turn;
  const ctx = input.toolContext;
  const conversation = await loadConversationSession(ctx);
  const priorMessages = input.messages.slice(0, -1);
  const offset = input.historyOffset ?? 0;
  const state = conversation?.state;

  if (state && (await canReuse(client, state, turn.ref, turn.toolsHash))) {
    const consumed = await sessionListCostUsd(client, state.sessionId);
    await client.beta.sessions.update(state.sessionId, { budget: budgetForUsd(consumed + turn.allowanceUsd) });
    const kickoff: BetaManagedAgentsEventParams[] = [];
    if (state.systemHash !== turn.systemHash) {
      kickoff.push({
        type: 'system.message',
        content: [{ type: 'text', text: `Your instructions and saved context were updated. Current version:\n\n${turn.system}` }],
      });
    }
    // `syncedMessages` counts from the start of the chat; `priorMessages`
    // starts `offset` messages in.
    const unseen = priorMessages.slice(Math.max(0, state.syncedMessages - offset));
    kickoff.push(userMessageEvent(turnMessage(input.messages, unseen, state.syncedMessages < offset)));
    return { sessionId: state.sessionId, chargedUsd: state.chargedUsd, kickoff, conversation };
  }

  // A new session (first turn, or the agent changed): seed it with the recent
  // part of the chat; from here the session keeps (and compacts) the rest.
  const seed = seedHistory(priorMessages);

  const session = await client.beta.sessions.create({
    agent: {
      type: 'agent_with_overrides',
      id: turn.ref.id,
      version: turn.ref.version,
      system: turn.system,
      tools: turn.sessionTools,
    },
    environment_id: turn.environmentId,
    title: `${input.agent.name}${ctx.conversationId ? ' · conversation' : ' · run'}`.slice(0, 200),
    budget: budgetForUsd(turn.allowanceUsd),
    metadata: {
      weldsuite_workspace_id: input.workspaceId,
      weldsuite_agent_id: input.agent.id,
      ...(ctx.conversationId ? { weldsuite_conversation_id: ctx.conversationId } : {}),
      ...(ctx.channelId ? { weldsuite_channel_id: ctx.channelId } : {}),
    },
  });
  return {
    sessionId: session.id,
    chargedUsd: 0,
    kickoff: [userMessageEvent(turnMessage(input.messages, seed, offset > 0 || seed.length < priorMessages.length))],
    conversation,
  };
}

/**
 * Runs a custom tool call: refused when the tool is not allowed this turn.
 * Exported for tests.
 */
export function customToolRunner(
  input: Pick<AgentExecutorInput, 'toolContext' | 'agent' | 'skipApprovals'>,
  turn: Pick<PreparedTurn, 'allowedNow' | 'declared' | 'setup' | 'canEdit' | 'team' | 'ref'>,
  invocations: StoredToolInvocation[],
) {
  const allowedNames = new Set(turn.allowedNow.map((tool) => tool.name));
  /** The question this turn already put to the user, and what the tool answered. */
  let asked: { key: string; result: unknown } | null = null;
  return async (name: string, args: unknown, threadAgent: ThreadAgent | null) => {
    // A thread is this agent (primary, or a copy of itself: its main object),
    // one of its sub-agents (a worker object), or unidentified: refused.
    const member = findMember(turn.team, threadAgent);
    if (threadAgent && !member && threadAgent.objectId !== turn.ref.id) {
      const error = 'This call came from a thread that could not be identified, so it was not run.';
      invocations.push({ toolName: name, state: 'error', args, result: { error } });
      return { result: { error }, isError: true };
    }
    if (member) {
      // A sub-agent's call: its own tools, narrowed to the actor, attributed to it.
      const def = member.tools.find((tool) => tool.name === name);
      if (!def) {
        const error = `Tool "${name}" is not available to ${member.agent.name} right now.`;
        invocations.push({ toolName: name, state: 'error', args, result: { error } });
        return { result: { error }, isError: true };
      }
      return executePlatformTool(
        def,
        { ...input.toolContext, agentId: member.agent.id, actorCanEdit: member.canEdit },
        args,
        invocations,
        {
          autoReviewEnabled: member.agent.autoReviewEnabled,
          skipApprovals: input.skipApprovals,
        },
      );
    }
    // One question per turn: the user answers one card, then the agent continues.
    // The same question again (the model asked twice in one go) gets the same
    // answer and is not recorded again; a different one is refused.
    const questionKey = name === ASK_USER_TOOL_NAME ? JSON.stringify(args ?? null) : null;
    if (questionKey !== null && asked) {
      if (asked.key === questionKey) return { result: asked.result, isError: false };
      const error = 'You already asked a question this turn. End your turn and wait for the answer.';
      invocations.push({ toolName: name, state: 'error', args, result: { error } });
      return { result: { error }, isError: true };
    }
    const def = turn.declared.find((tool) => tool.name === name);
    if (!def || !allowedNames.has(name)) {
      const error =
        def && turn.setup
          ? 'Not yet: ask the user at least one clarifying question about routines before saving the setup.'
          : `Tool "${name}" is not available to this agent right now.`;
      invocations.push({ toolName: name, state: 'error', args, result: { error } });
      return { result: { error }, isError: true };
    }
    const outcome = await executePlatformTool(
      def,
      { ...input.toolContext, actorCanEdit: turn.canEdit },
      args,
      invocations,
      {
        autoReviewEnabled: input.agent.autoReviewEnabled,
        skipApprovals: input.skipApprovals,
      },
    );
    if (questionKey !== null && !outcome.isError) asked = { key: questionKey, result: outcome.result };
    return outcome;
  };
}

/**
 * After a turn (also a failed or cancelled one): charge it, then keep the
 * conversation's session state or archive a one-off session. Never throws.
 */
async function finishTurn(
  input: AgentExecutorInput,
  turn: PreparedTurn,
  session: TurnSession,
  outcome: TurnOutcome | undefined,
): Promise<number> {
  const { credits, totalUsd } = await settleTurn({
    client: turn.client,
    sessionId: session.sessionId,
    metering: turn.metering,
    modelId: turn.modelId,
    chargedUsd: session.chargedUsd,
    outcome,
    referenceId: input.agent.id,
  });
  try {
    if (session.conversation) {
      await saveConversationSession(input.toolContext, {
        sessionId: session.sessionId,
        agentObjectId: turn.ref.id,
        agentVersion: turn.ref.version,
        toolsHash: turn.toolsHash,
        systemHash: turn.systemHash,
        // History (from the start of the chat) plus the reply this turn adds.
        syncedMessages: (input.historyOffset ?? 0) + input.messages.length + 1,
        chargedUsd: totalUsd,
      });
      if (turn.team) await archiveIdleThreads(turn.client, session.sessionId);
    } else {
      await archiveSession(turn.client, session.sessionId);
    }
  } catch (err) {
    console.error('[weldagent/managed] saving session state failed:', err);
  }
  return credits;
}

function toExecutorResult(
  outcome: TurnOutcome,
  modelId: string,
  creditsUsed: number,
  invocations: StoredToolInvocation[],
): AgentExecutorResult {
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

/**
 * One agent turn on Claude Managed Agents. Conversation turns
 * (`toolContext.conversationId`) keep using the conversation's session;
 * everything else gets a one-off session, archived afterwards.
 */
async function runManagedTurn(input: AgentExecutorInput, options: TurnOptions = {}): Promise<AgentExecutorResult> {
  const turn = await prepareTurn(input, options);
  const session = await openOrReuseSession(input, turn);
  const invocations: StoredToolInvocation[] = [];
  let outcome: TurnOutcome | undefined;
  let creditsUsed = 0;
  try {
    outcome = await driveTurn({
      client: turn.client,
      sessionId: session.sessionId,
      kickoff: session.kickoff,
      deadline: Date.now() + (input.timeoutMs ?? REQUEST_RUN_TIMEOUT_MS),
      maxModelRequests: Math.max(1, input.agent.maxIterations),
      invocations,
      onText: options.onText,
      signal: options.signal,
      onCustomTool: customToolRunner(input, turn, invocations),
      allowSubagentBuiltin: (agent, toolName) => allowSubagentBuiltin(turn.team, agent, toolName),
    });
  } finally {
    creditsUsed = await finishTurn(input, turn, session, outcome);
  }
  return toExecutorResult(outcome, turn.modelId, creditsUsed, invocations);
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
 * Charge the turn: the growth of the session's list cost since the last
 * charge (tokens at their real cache rates, sandbox runtime, web search).
 * Only when the list cost can't be read is the turn priced from its tokens.
 * Any turn that used the model costs at least one credit. Never throws — the
 * work already happened.
 */
async function settleTurn(params: {
  client: Anthropic;
  sessionId: string;
  metering: AiMetering | null;
  modelId: string;
  chargedUsd: number;
  outcome?: TurnOutcome;
  referenceId: string;
}): Promise<{ credits: number; totalUsd: number }> {
  const usage = params.outcome?.usage ?? { inputTokens: 0, outputTokens: 0 };
  let costUsd: number;
  let totalUsd: number;
  try {
    const listUsd = await sessionListCostUsd(params.client, params.sessionId);
    costUsd = Math.max(0, listUsd - params.chargedUsd);
    totalUsd = Math.max(params.chargedUsd, listUsd);
  } catch (err) {
    console.error('[weldagent/managed] reading session cost failed, pricing by tokens:', err);
    costUsd = providerCostUsd(params.modelId, {
      inputTokens: params.outcome?.pricedInputTokens ?? 0,
      outputTokens: usage.outputTokens,
    });
    // Count it as charged so the next turn's list-cost growth doesn't bill it again.
    totalUsd = params.chargedUsd + costUsd;
  }
  if (costUsd <= 0 && usage.inputTokens + usage.outputTokens === 0) return { credits: 0, totalUsd };
  try {
    const credits = await chargeAiUsage(params.metering, {
      modelId: params.modelId,
      usage,
      op: 'agent',
      referenceId: params.referenceId,
      costUsd,
    });
    return { credits, totalUsd };
  } catch (err) {
    console.error('[weldagent/managed] charging the turn failed:', err);
    return { credits: 0, totalUsd };
  }
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
  /** The request's signal: a client disconnect interrupts the turn. */
  signal?: AbortSignal;
}

/**
 * Streaming chat: a `text/plain` stream of the agent's reply as it is written.
 * Tool calls run in between; the turn is charged when it settles. When the
 * client stops reading (or `signal` aborts), the turn is interrupted so it
 * stops spending, and still charged for what ran.
 */
export function streamAgentChat(input: StreamAgentParams): { stream: ReadableStream<Uint8Array>; modelId: string } {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const cancel = new AbortController();
  const stop = () => cancel.abort();
  input.signal?.addEventListener('abort', stop, { once: true });
  // Cancelling the response body errors the writable side.
  writer.closed.catch(stop);

  let pending = Promise.resolve();
  const write = (text: string) => {
    pending = pending.then(() => writer.write(encoder.encode(text))).catch(stop);
  };

  const work = runManagedTurn(input, { metering: input.metering, onText: write, signal: cancel.signal })
    .catch((err) => {
      if (cancel.signal.aborted) return;
      console.error('[weldagent/stream] turn failed:', err);
      write(`\n\n${err instanceof Error ? err.message : 'The agent could not finish this reply.'}`);
    })
    .finally(async () => {
      input.signal?.removeEventListener('abort', stop);
      await pending;
      await writer.close().catch(() => undefined);
    });
  input.executionCtx.waitUntil(work);

  return { stream: readable, modelId: resolveManagedModel(input.agent.modelId) };
}
