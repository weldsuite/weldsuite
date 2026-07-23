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
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  generateText,
  streamText,
  isGatewayConfigured,
  recommended,
  runWithFallback,
  pickGateway,
  providerCostUsd,
  GATEWAY_FEE_MULTIPLIER,
} from '@weldsuite/ai';
import { type Gateway } from '@weldsuite/credits/gateway-costs';
import { readGatewayCreditSnapshot, toCreditStates } from '@weldsuite/credits/gateway-cache';
import type { Env, Variables } from '../../types';
import { success, error } from '../../lib/response';
import {
  resolveAiMetering,
  assertAiCredits,
  chargeAiUsage,
  InsufficientAiCreditsError,
} from '../../services/ai/billing';

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
});

/** Base persona for the WeldAgent chat panel. Extra `system` context is appended. */
const WELDAGENT_SYSTEM =
  'You are WeldAgent, the AI assistant built into the WeldSuite business platform. ' +
  'You help the user with their CRM, mail, projects, tasks, helpdesk, commerce and ' +
  'accounting work. Be concise, direct and practical. Use plain text — no markdown ' +
  'headings — and keep answers short unless the user asks for detail. If you are not ' +
  'sure about something in the user\'s workspace, say so rather than inventing data.';

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
      const creditsUsed = await chargeAiUsage(metering, {
        modelId,
        usage: result.usage,
        op: 'generate',
        gateway: served?.gateway,
        providerCostUsd: served?.providerCostUsd,
        coveredByServiceCredit: served?.covered,
      });

      return success(c, {
        text: result.text,
        model: modelId,
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
  requirePermission('agents:read'),
  zValidator('json', chatSchema),
  async (c) => {
    if (!isGatewayConfigured(c.env)) {
      return error.internal(c, 'AI gateway is not configured');
    }

    const { messages, model, system, temperature, maxTokens } = c.req.valid('json');
    const modelId = model ?? recommended.copilot.free;
    const metering = await resolveAiMetering(c.env, c.get('workspaceId'), c.get('userId'));

    // Fold any `system` turns + the optional caller context into one system prompt;
    // pass only user/assistant turns as chat messages.
    const extraSystem = [
      ...messages.filter((m) => m.role === 'system').map((m) => m.content),
      ...(system ? [system] : []),
    ].join('\n\n');
    const systemPrompt = extraSystem ? `${WELDAGENT_SYSTEM}\n\n${extraSystem}` : WELDAGENT_SYSTEM;
    const chatMessages = messages
      .filter((m): m is { role: 'user' | 'assistant'; content: string } => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    if (chatMessages.length === 0) {
      return error.badRequest(c, 'At least one user message is required');
    }

    try {
      await assertAiCredits(metering); // hard gate: 402 when the wallet is empty

      const credits = c.env.WORKSPACE_CACHE
        ? toCreditStates(await readGatewayCreditSnapshot(c.env.WORKSPACE_CACHE))
        : [];

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
            system: systemPrompt,
            messages: chatMessages,
            temperature,
            maxOutputTokens: maxTokens,
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

      return success(c, {
        text: result.text,
        model: modelId,
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

/**
 * POST /chat/stream — the streaming twin of /chat.
 *
 * Returns a `text/plain` token stream (AI SDK `toTextStreamResponse`) the client
 * appends to the assistant message as it arrives. Credits are hard-gated BEFORE
 * the stream opens (402 when empty); the actual token charge happens in
 * `onFinish` via `waitUntil`, once usage is known. Streaming uses `pickGateway`
 * (no fallback — a stream can't be retried mid-flight), which is safe now that
 * Cloudflare is the only gateway.
 */
app.post(
  '/chat/stream',
  requirePermission('agents:read'),
  zValidator('json', chatSchema),
  async (c) => {
    if (!isGatewayConfigured(c.env)) {
      return error.internal(c, 'AI gateway is not configured');
    }

    const { messages, model, system, temperature, maxTokens } = c.req.valid('json');
    const modelId = model ?? recommended.copilot.free;
    const metering = await resolveAiMetering(c.env, c.get('workspaceId'), c.get('userId'));

    const extraSystem = [
      ...messages.filter((m) => m.role === 'system').map((m) => m.content),
      ...(system ? [system] : []),
    ].join('\n\n');
    const systemPrompt = extraSystem ? `${WELDAGENT_SYSTEM}\n\n${extraSystem}` : WELDAGENT_SYSTEM;
    const chatMessages = messages
      .filter((m): m is { role: 'user' | 'assistant'; content: string } => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    if (chatMessages.length === 0) {
      return error.badRequest(c, 'At least one user message is required');
    }

    // Hard gate before the stream opens — a 402 must be a clean JSON response,
    // not a half-open stream.
    try {
      await assertAiCredits(metering);
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

    try {
      const credits = c.env.WORKSPACE_CACHE
        ? toCreditStates(await readGatewayCreditSnapshot(c.env.WORKSPACE_CACHE))
        : [];
      const attempt = pickGateway(c.env, { modelId, credits });

      const result = streamText({
        model: attempt.model,
        system: systemPrompt,
        messages: chatMessages,
        temperature,
        maxOutputTokens: maxTokens,
        maxRetries: 1,
        onError: ({ error: streamErr }) => {
          console.error('[ai/chat/stream] model error:', streamErr);
        },
        onFinish: ({ usage }) => {
          // Charge on the real token count once the stream completes. Keyed on the
          // canonical modelId so the customer price is gateway-independent.
          const cost = providerCostUsd(modelId, usage) * (GATEWAY_FEE_MULTIPLIER[attempt.gateway] ?? 1);
          c.executionCtx.waitUntil(
            chargeAiUsage(metering, {
              modelId,
              usage,
              op: 'chat',
              gateway: attempt.gateway as Gateway,
              providerCostUsd: cost,
              coveredByServiceCredit: false,
            }).catch((chargeErr) => {
              console.error('[ai/chat/stream] credit charge failed (untracked):', chargeErr);
            }),
          );
        },
      });

      return result.toTextStreamResponse();
    } catch (err) {
      return error.internal(c, err instanceof Error ? err.message : 'AI request failed');
    }
  },
);

export const aiRoutes = app;
