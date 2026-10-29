/**
 * AI routes — /api/ai/*
 *
 * First consumer of `@weldsuite/ai`. Every call is routed through Cloudflare
 * AI Gateway: Workers AI models (`@cf/…`, free allocation) and third-party
 * models (`provider/model`, unified billing) share one endpoint + one token.
 *
 * The model call runs through the pure `@weldsuite/ai` package; credit
 * metering is applied here at the route/service layer (not in the package).
 *
 *  - POST /generate — one-shot text generation with a chosen (or default) model.
 *
 * Permission: gated on the `agents` object (`agents:create`), matching the
 * object-based permission model used across app-api.
 *
 * Metered against the prepaid credit wallet (serviceType `ai_tokens`): hard
 * gate before the call (402 when empty), consume actual tokens after.
 */

import { z } from 'zod';
import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  ensurePermissionsResolved,
  hasContextPermission,
  requirePermission,
} from '@weldsuite/permissions/server';
import {
  billedModelId,
  createTextStreamResponse,
  generateText,
  streamText,
  isGatewayConfigured,
  recommended,
  runWithFallback,
  pickGateway,
  providerCostUsd,
  gatewayCostFactor,
} from '@weldsuite/ai';
import { type Gateway } from '@weldsuite/credits/gateway-costs';
import { readGatewayCreditSnapshot, toCreditStates } from '@weldsuite/credits/gateway-cache';
import type { Env, Variables } from '../../types';
import { success, error } from '@weldsuite/worker-kit/response';
import {
  resolveAiMetering,
  assertAiCredits,
  chargeAiUsage,
  InsufficientAiCreditsError,
} from '@weldsuite/core-domain/ai-billing';
import { getAgent } from '@weldsuite/agent-domain/agents';
import { canAccessAgent } from '@weldsuite/agent-domain/access';
import { agentViewer } from '../../services/weldagent/viewer';
import { personaPermissions } from '../../services/weldagent/persona-permissions';
import { streamAgentChat, runAgentOnce } from '@weldsuite/agent-domain/executor';
import {
  buildPersonaCall,
  createPersonaTextTransform,
  personaReplyText,
  sumStepUsage,
  type PermissionCheck,
  type PersonaCall,
} from '@weldsuite/agent-domain/persona';
import { isWorkspaceAgentModel } from '@weldsuite/app-api-client/schemas/workspace-agents';
import { aiChatContextSchema } from '@weldsuite/app-api-client/schemas/ai';
import { describeUserTags, taggedSheetsIn } from '@weldsuite/agent-domain/record-tokens';
import { openSheetInstructions } from '@weldsuite/agent-domain/sheets-tools';
import type { PersonaSheets } from '@weldsuite/agent-domain/persona';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const generateSchema = z.object({
  /** The user prompt. */
  prompt: z.string().min(1).max(20000),
  /** Optional model id, e.g. `@cf/meta/llama-3.3-70b-instruct-fp8-fast` or
   *  `anthropic/claude-sonnet-4-5`. Defaults to the free "draft" model. */
  model: z.string().min(1).max(200).optional(),
  /** Optional system prompt. */
  system: z.string().max(8000).optional(),
  /** Sampling temperature (0–2). */
  temperature: z.number().min(0).max(2).optional(),
  /** Max output tokens. */
  maxTokens: z.number().int().min(1).max(8192).optional(),
});

/** One turn of the WeldAgent conversation. `system` turns are folded into the
 *  system prompt; only user/assistant turns become chat messages. */
const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1).max(20000),
});

const chatSchema = z.object({
  /** Full running conversation (client is stateless-server; sends history each turn). */
  messages: z.array(chatMessageSchema).min(1).max(50),
  /** Optional model id. Defaults to the free Workers AI copilot model. */
  model: z.string().min(1).max(200).optional(),
  /** Optional extra system instructions (e.g. the entity the user is viewing). */
  system: z.string().max(8000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(8192).optional(),
  /** When set, load a workspace agent and run with its tools + instructions. */
  agentId: z.string().min(1).max(30).optional(),
  /** What the person has open (a spreadsheet), for the agent to work on. */
  context: aiChatContextSchema.optional(),
});

/**
 * POST /generate — generate text via the AI gateway.
 */
app.post(
  '/generate',
  requirePermission('agents:create'),
  zValidator('json', generateSchema),
  async (c) => {
    // @weldsuite/ai validates the Cloudflare AI Gateway env in one place.
    if (!isGatewayConfigured(c.env)) {
      return error.internal(c, 'AI gateway is not configured');
    }

    const { prompt, model, system, temperature, maxTokens } = c.req.valid('json');
    const modelId = model ?? recommended.draft.free;
    const metering = await resolveAiMetering(c.env, c.get('workspaceId'), c.get('userId'));

    try {
      await assertAiCredits(metering); // hard gate: 402 when the wallet is empty

      // Ops credit state comes from one edge-cached KV read (never the DB — a KV
      // outage must degrade routing, not stampede master). Empty = fee order.
      const credits = c.env.WORKSPACE_CACHE
        ? toCreditStates(await readGatewayCreditSnapshot(c.env.WORKSPACE_CACHE))
        : [];

      let served: { gateway: Gateway; providerCostUsd: number; covered: boolean } | undefined;
      const { value: result } = await runWithFallback(
        c.env,
        {
          modelId,
          op: 'generate',
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
            system,
            prompt,
            temperature,
            maxOutputTokens: maxTokens,
            // One in-gateway retry, then move on — the SDK's default of 2 burns
            // two backed-off retries before we ever reach the next gateway.
            maxRetries: 1,
          }),
      );

      // Canonical modelId: the customer's price never depends on which gateway
      // served them. `gateway`/`providerCostUsd` feed the OPS ledger only.
      const servedModelId = billedModelId(modelId, result);
      const creditsUsed = await chargeAiUsage(metering, {
        modelId: servedModelId,
        usage: result.usage,
        op: 'generate',
        gateway: served?.gateway,
        providerCostUsd: served?.providerCostUsd,
        coveredByServiceCredit: served?.covered,
      });

      return success(c, {
        text: result.text,
        model: servedModelId,
        finishReason: result.finishReason,
        usage: result.usage,
        creditsUsed,
      });
    } catch (err) {
      if (err instanceof InsufficientAiCreditsError) {
        return error.insufficientCredits(c, {
          currentBalance: err.currentBalance,
          required: err.required,
          shortfall: err.shortfall,
        });
      }
      return error.internal(c, err instanceof Error ? err.message : 'AI request failed');
    }
  },
);

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
type ChatInput = z.infer<typeof chatSchema>;
type ChatTurn = { role: 'user' | 'assistant'; content: string };
type ChatParts = { extraSystem: string; chatMessages: ChatTurn[]; sheets: PersonaSheets };
type Metering = Awaited<ReturnType<typeof resolveAiMetering>>;
type WorkspaceAgent = NonNullable<Awaited<ReturnType<typeof getAgent>>>;
type ResolvedPermissions = NonNullable<Awaited<ReturnType<typeof ensurePermissionsResolved>>>;

/** Map a thrown AI error to the HTTP response (402 for an empty wallet, else 500). */
function aiErrorResponse(c: AppContext, err: unknown) {
  if (err instanceof InsufficientAiCreditsError) {
    return error.insufficientCredits(c, {
      currentBalance: err.currentBalance,
      required: err.required,
      shortfall: err.shortfall,
    });
  }
  return error.internal(c, err instanceof Error ? err.message : 'AI request failed');
}

/**
 * Fold `system` turns (plus the optional extra `system` field) into one system
 * string and keep only the user/assistant turns as chat messages. The
 * spreadsheets the person points at are the open one (`context.sheet`) and
 * the ones tagged in their messages (`<@sheet:id|Budget>`); the tags are then
 * spelled out for the model.
 */
function splitChatMessages(
  messages: ChatInput['messages'],
  system: string | undefined,
  context?: ChatInput['context'],
): ChatParts {
  const extraSystem = [
    ...messages.filter((m) => m.role === 'system').map((m) => m.content),
    ...(system ? [system] : []),
  ].join('\n\n');
  const turns = messages
    .filter((m): m is ChatTurn => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
  return {
    extraSystem,
    chatMessages: describeUserTags(turns),
    sheets: { open: context?.sheet ?? null, tagged: taggedSheetsIn(turns) },
  };
}

/**
 * What the default WeldAgent may read for the person chatting: the permission
 * keys its tools need, checked deny-aware like any route, never an agent's grants.
 */
async function personaPermissionCheck(c: AppContext): Promise<PermissionCheck> {
  const held = new Set(await personaPermissions(c));
  return (key) => held.has(key);
}

/**
 * The default WeldAgent's instructions and tools for this caller: read-only
 * lookups, plus the spreadsheet tools for the sheets they point at.
 */
async function preparePersona(c: AppContext, chat: ChatParts): Promise<PersonaCall> {
  return buildPersonaCall({
    db: c.get('tenantDb'),
    workspaceId: c.get('workspaceId'),
    userId: c.get('userId'),
    env: c.env,
    holds: await personaPermissionCheck(c),
    extraSystem: chat.extraSystem || undefined,
    sheets: chat.sheets,
  });
}

/** Ops credit state from one edge-cached KV read; empty = fee order. */
async function loadCreditStates(c: AppContext) {
  return c.env.WORKSPACE_CACHE
    ? toCreditStates(await readGatewayCreditSnapshot(c.env.WORKSPACE_CACHE))
    : [];
}

/**
 * Gate a workspace-agent chat on `weldagent:use` and load the agent.
 * On failure returns the error response to send.
 */
async function loadWorkspaceAgent(
  c: AppContext,
  agentId: string,
): Promise<
  | { ok: true; agent: WorkspaceAgent; resolved: ResolvedPermissions }
  | { ok: false; response: Response }
> {
  const resolved = await ensurePermissionsResolved(c);
  if (!resolved || !(await hasContextPermission(c, 'weldagent:use'))) {
    return { ok: false, response: error.forbidden(c, 'Missing permission: weldagent:use') };
  }
  const agent = await getAgent(c.get('tenantDb'), agentId);
  if (!agent || !(await canAccessAgent(c.get('tenantDb'), agent, await agentViewer(c)))) {
    return { ok: false, response: error.notFound(c, 'Agent not found') };
  }
  return { ok: true, agent, resolved };
}

/** Arguments shared by `runAgentOnce` and `streamAgentChat`. */
function buildAgentRunArgs(
  c: AppContext,
  input: ChatInput,
  loaded: { agent: WorkspaceAgent; resolved: ResolvedPermissions },
  chat: ChatParts,
) {
  const { agent, resolved } = loaded;
  return {
    env: c.env,
    // The agent runtime keeps the Clerk org id (Anthropic metadata, sandbox id, job
    // params); resolveAiMetering inside it accepts either id (workspace-id plan).
    workspaceId: c.get('clerkOrgId'),
    actorUserId: c.get('userId'),
    agent: {
      id: agent.id,
      name: agent.name,
      systemPrompt: agent.systemPrompt,
      // Agents run on their configured Claude model; a non-Claude `model`
      // override (persona model ids) falls back to it.
      modelId: isWorkspaceAgentModel(input.model) ? input.model : agent.modelId,
      temperature: input.temperature !== undefined ? String(input.temperature) : agent.temperature,
      maxTokens: input.maxTokens ?? agent.maxTokens,
      maxIterations: agent.maxIterations,
      permissions: agent.permissions,
      enabledTools: agent.enabledTools,
      autoReviewEnabled: agent.autoReviewEnabled,
    },
    toolContext: {
      db: c.get('tenantDb'),
      agentId: agent.id,
      actorUserId: c.get('userId'),
      workspaceId: c.get('clerkOrgId'),
      env: c.env,
    },
    messages: chat.chatMessages,
    // The agent works on the open sheet with its own spreadsheet tools, if it has them.
    extraSystem:
      [chat.extraSystem, chat.sheets.open ? openSheetInstructions(chat.sheets.open) : ''].filter(Boolean).join('\n\n') ||
      undefined,
    actorPermissions: resolved.permissions,
  };
}

/** /chat with a workspace agent — tools + agent instructions. */
async function chatWithWorkspaceAgent(
  c: AppContext,
  input: ChatInput,
  agentId: string,
  chat: ChatParts,
) {
  const loaded = await loadWorkspaceAgent(c, agentId);
  if (!loaded.ok) return loaded.response;

  try {
    const result = await runAgentOnce(buildAgentRunArgs(c, input, loaded, chat));
    return success(c, {
      text: result.text,
      model: result.modelId,
      finishReason: result.finishReason,
      usage: result.usage,
      creditsUsed: result.creditsUsed,
      toolInvocations: result.toolInvocations,
    });
  } catch (err) {
    return aiErrorResponse(c, err);
  }
}

/** /chat with the plain WeldAgent persona (no workspace agent). */
async function chatWithPersona(
  c: AppContext,
  input: ChatInput,
  metering: Metering,
  chat: ChatParts,
) {
  const modelId = input.model ?? recommended.copilot.free;

  try {
    await assertAiCredits(metering);

    const credits = await loadCreditStates(c);
    const persona = await preparePersona(c, chat);

    let served: { gateway: Gateway; providerCostUsd: number; covered: boolean } | undefined;
    const { value: result } = await runWithFallback(
      c.env,
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
          messages: chat.chatMessages,
          // Read-only lookups, then the answer: a few model requests per reply.
          tools: persona.tools,
          stopWhen: persona.stopWhen,
          temperature: input.temperature,
          maxOutputTokens: input.maxTokens,
          maxRetries: 1,
        }),
    );

    const servedModelId = billedModelId(modelId, result);
    // `result.usage` adds up every model request of the reply (AI SDK 7), so a
    // reply with lookups is charged for all of them.
    const creditsUsed = await chargeAiUsage(metering, {
      modelId: servedModelId,
      usage: result.usage,
      op: 'chat',
      gateway: served?.gateway,
      providerCostUsd: served?.providerCostUsd,
      coveredByServiceCredit: served?.covered,
    });

    return success(c, {
      text: personaReplyText(result.text),
      model: servedModelId,
      finishReason: result.finishReason,
      usage: result.usage,
      creditsUsed,
    });
  } catch (err) {
    return aiErrorResponse(c, err);
  }
}

/**
 * POST /chat — multi-turn WeldAgent chat via the AI gateway.
 *
 * Stateless on the server: the client sends the full running conversation each
 * turn. Same metering flow as /generate — hard credit gate before, consume
 * actual tokens after — and the customer is charged on the canonical model id,
 * so the price never depends on which gateway served the call.
 */
app.post(
  '/chat',
  requirePermission('agents:read', 'weldagent:use'),
  zValidator('json', chatSchema),
  async (c) => {
    const input = c.req.valid('json');
    const chat = splitChatMessages(input.messages, input.system, input.context);
    if (chat.chatMessages.length === 0) {
      return error.badRequest(c, 'At least one user message is required');
    }

    // Workspace agent path — Claude Managed Agents, tools + agent instructions.
    if (input.agentId) {
      return chatWithWorkspaceAgent(c, input, input.agentId, chat);
    }

    if (!isGatewayConfigured(c.env)) {
      return error.internal(c, 'AI gateway is not configured');
    }
    const metering = await resolveAiMetering(c.env, c.get('workspaceId'), c.get('userId'));
    return chatWithPersona(c, input, metering, chat);
  },
);

/** /chat/stream with a workspace agent — tools + agent instructions. */
async function streamWithWorkspaceAgent(
  c: AppContext,
  input: ChatInput,
  agentId: string,
  metering: Metering,
  chat: ChatParts,
) {
  const loaded = await loadWorkspaceAgent(c, agentId);
  if (!loaded.ok) return loaded.response;

  try {
    const { stream } = streamAgentChat({
      ...buildAgentRunArgs(c, input, loaded, chat),
      metering,
      executionCtx: c.executionCtx,
      // Client disconnect → interrupt the turn so it stops spending.
      signal: c.req.raw.signal,
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  } catch (err) {
    return error.internal(c, err instanceof Error ? err.message : 'AI request failed');
  }
}

/** /chat/stream with the plain WeldAgent persona (no workspace agent). */
async function streamWithPersona(
  c: AppContext,
  input: ChatInput,
  metering: Metering,
  chat: ChatParts,
) {
  const modelId = input.model ?? recommended.copilot.free;

  try {
    const credits = await loadCreditStates(c);
    const attempt = pickGateway(c.env, { modelId, credits });
    const persona = await preparePersona(c, chat);

    const charge = (servedModelId: string, usage: Parameters<typeof providerCostUsd>[1]) => {
      // Zero when service credit covered the attempt; else the served model's factor (BYOK = 1).
      const costFactor = attempt.costFactor === 0 ? 0 : gatewayCostFactor(attempt.ai.config, servedModelId);
      const cost = providerCostUsd(servedModelId, usage) * costFactor;
      c.executionCtx.waitUntil(
        chargeAiUsage(metering, {
          modelId: servedModelId,
          usage,
          op: 'chat',
          gateway: attempt.gateway as Gateway,
          providerCostUsd: cost,
          coveredByServiceCredit: false,
        }).catch((chargeErr) => {
          console.error('[ai/chat/stream] credit charge failed (untracked):', chargeErr);
        }),
      );
    };

    const result = streamText({
      model: attempt.model,
      system: persona.system,
      messages: chat.chatMessages,
      // Read-only lookups, then the answer: a few model requests per reply.
      tools: persona.tools,
      stopWhen: persona.stopWhen,
      temperature: input.temperature,
      maxOutputTokens: input.maxTokens,
      maxRetries: 1,
      onError: ({ error: streamErr }) => {
        console.error('[ai/chat/stream] model error:', streamErr);
      },
      // `event.usage` adds up every model request of the reply (AI SDK 7). A
      // refused third-party model streams from the fallback model instead.
      onFinish: (event) => charge(billedModelId(modelId, event), event.usage),
      // The client left mid-reply: still bill the model requests that ran.
      onAbort: ({ steps }) => {
        if (steps.length > 0) charge(modelId, sumStepUsage(steps));
      },
    });

    return createTextStreamResponse({ stream: result.fullStream.pipeThrough(createPersonaTextTransform()) });
  } catch (err) {
    return error.internal(c, err instanceof Error ? err.message : 'AI request failed');
  }
}

/**
 * POST /chat/stream — the streaming twin of /chat.
 *
 * Returns a `text/plain` token stream (the AI SDK's text stream response, with
 * the text of each lookup step set apart by a blank line) the client
 * appends to the assistant message as it arrives. Credits are hard-gated BEFORE
 * the stream opens (402 when empty); the actual token charge happens in
 * `onFinish` via `waitUntil`, once usage is known. Streaming uses `pickGateway`
 * (no fallback — a stream can't be retried mid-flight), which is safe now that
 * Cloudflare is the only gateway.
 */
app.post(
  '/chat/stream',
  requirePermission('agents:read', 'weldagent:use'),
  zValidator('json', chatSchema),
  async (c) => {
    const input = c.req.valid('json');
    if (!input.agentId && !isGatewayConfigured(c.env)) {
      return error.internal(c, 'AI gateway is not configured');
    }
    const metering = await resolveAiMetering(c.env, c.get('workspaceId'), c.get('userId'));

    const chat = splitChatMessages(input.messages, input.system, input.context);
    if (chat.chatMessages.length === 0) {
      return error.badRequest(c, 'At least one user message is required');
    }

    try {
      await assertAiCredits(metering);
    } catch (err) {
      return aiErrorResponse(c, err);
    }

    if (input.agentId) {
      return streamWithWorkspaceAgent(c, input, input.agentId, metering, chat);
    }

    return streamWithPersona(c, input, metering, chat);
  },
);

export const aiRoutes = app;
