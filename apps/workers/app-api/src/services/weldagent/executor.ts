/**
 * WeldAgent tool-loop executor — generateText / streamText with filtered tools.
 */

import {
  generateText,
  streamText,
  tool,
  stepCountIs,
  recommended,
  runWithFallback,
  pickGateway,
  providerCostUsd,
  GATEWAY_FEE_MULTIPLIER,
  isGatewayConfigured,
} from '@weldsuite/ai';
import { readGatewayCreditSnapshot, toCreditStates } from '@weldsuite/credits/gateway-cache';
import type { Gateway } from '@weldsuite/credits/gateway-costs';
import type { Env } from '../../types';
import {
  resolveAiMetering,
  assertAiCredits,
  chargeAiUsage,
  type AiMetering,
} from '../ai/billing';
import {
  resolveAgentTools,
  type ToolContext,
  type PlatformToolDefinition,
} from './tools';
import { logSafe } from '../../lib/log-safe';

/**
 * Third-party models (`anthropic/…`, `openai/…`) need Cloudflare AI Gateway
 * (`CF_AI_GATEWAY`). Direct Workers AI only serves `@cf/…`. Without a gateway,
 * fall back to the free Workers AI default so chat doesn't 404.
 */
export function resolveAgentModelId(env: Env, requested: string | null | undefined): string {
  const fallback = recommended.copilot.free;
  const modelId = (requested?.trim() || fallback);
  const hasGateway = Boolean(
    typeof env.CF_AI_GATEWAY === 'string' && env.CF_AI_GATEWAY.length > 0,
  );
  if (hasGateway || modelId.startsWith('@cf/')) return modelId;
  console.warn(
    `[weldagent] Model "${logSafe(modelId)}" needs CF_AI_GATEWAY; falling back to ${logSafe(fallback)}`,
  );
  return fallback;
}

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
    systemPrompt: string;
    modelId: string;
    temperature: string;
    maxTokens: number;
    maxIterations: number;
    permissions: string[];
    enabledTools: string[];
    autoReviewEnabled?: boolean;
  };
  toolContext: ToolContext;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Extra system context (entity event payload, etc.). */
  extraSystem?: string;
}

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
 * During onboarding, only expose save_agent_setup (and only after the user has
 * answered at least one follow-up). Platform/computer tools stay off so the
 * interview cannot hang on a cloud sandbox or invent workspace mutations.
 */
export function toolsForAgentTurn(input: {
  permissions: string[];
  enabledTools: string[];
  systemPrompt: string;
  userMessageCount: number;
}): PlatformToolDefinition[] {
  if (agentNeedsSetup(input.systemPrompt)) {
    if (input.userMessageCount < 2) return [];
    return resolveAgentTools([], []).filter((tool) => tool.id === 'agent.save_setup');
  }
  return resolveAgentTools(input.permissions, input.enabledTools);
}

function buildSystemPrompt(agent: AgentExecutorInput['agent'], extra?: string): string {
  if (agentNeedsSetup(agent.systemPrompt)) {
    const setup =
      `You are "${agent.name}", a workspace AI agent in WeldSuite that is being configured for the first time.\n\n` +
      SETUP_INTERVIEW_INSTRUCTIONS;
    return extra ? `${setup}\n\n${extra}` : setup;
  }

  const base =
    `You are "${agent.name}", a workspace AI agent in WeldSuite. ` +
    'You act only through the tools you have been given. Never invent IDs or claim you mutated data without a successful tool result. ' +
    'Prefer platform tools (people, tickets, tasks, chat) when they fit. Use computer_* / browser_* only when you need a Linux shell, files, code, or a website without an API. ' +
    'Be concise and practical.\n\n' +
    (agent.systemPrompt?.trim() || 'Help the user with their workspace tasks.');
  return extra ? `${base}\n\n${extra}` : base;
}

function toSdkTools(
  defs: PlatformToolDefinition[],
  ctx: ToolContext,
  invocations: StoredToolInvocation[],
  opts?: { autoReviewEnabled?: boolean },
): Record<string, unknown> {
  const tools: Record<string, unknown> = {};
  for (const def of defs) {
    tools[def.name] = tool({
      description: def.description,
      inputSchema: def.parameters as never,
      execute: async (args: never) => {
        const input = args as unknown;
        invocations.push({ toolName: def.name, state: 'call', args: input });
        try {
          const { toolRiskLevel, createApproval, findPriorApproval } = await import('./parity');
          const risk = toolRiskLevel(def.name);
          if (risk === 'high') {
            const autoOk =
              opts?.autoReviewEnabled &&
              (await findPriorApproval(ctx.db, ctx.agentId, def.name));
            if (!autoOk) {
              const approval = await createApproval(ctx.db, {
                agentId: ctx.agentId,
                conversationId: ctx.channelId ?? null,
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
                message: `Action "${def.name}" requires human approval before it runs.`,
              };
              invocations.push({ toolName: def.name, state: 'result', args: input, result: blocked });
              return blocked;
            }
          }
          const result = await def.execute(ctx, input);
          invocations.push({ toolName: def.name, state: 'result', args: input, result });
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Tool failed';
          invocations.push({
            toolName: def.name,
            state: 'error',
            args: input,
            result: { error: message },
          });
          return { error: message };
        }
      },
    }) as unknown;
  }
  return tools;
}

/**
 * Non-streaming agent loop (manual runs + event dispatch).
 */
export async function runAgentOnce(input: AgentExecutorInput): Promise<AgentExecutorResult> {
  if (!isGatewayConfigured(input.env)) {
    throw new Error('AI gateway is not configured');
  }

  const metering = await resolveAiMetering(input.env, input.workspaceId, input.actorUserId);
  await assertAiCredits(metering);

  const defs = toolsForAgentTurn({
    permissions: input.agent.permissions,
    enabledTools: input.agent.enabledTools,
    systemPrompt: input.agent.systemPrompt,
    userMessageCount: input.messages.filter((m) => m.role === 'user').length,
  });
  const invocations: StoredToolInvocation[] = [];
  const sdkTools = toSdkTools(defs, input.toolContext, invocations, {
    autoReviewEnabled: input.agent.autoReviewEnabled,
  });
  const modelId = resolveAgentModelId(input.env, input.agent.modelId);
  const temperature = Number.parseFloat(input.agent.temperature) || 0.7;
  let system = buildSystemPrompt(input.agent, input.extraSystem);
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

  const credits = input.env.WORKSPACE_CACHE
    ? toCreditStates(await readGatewayCreditSnapshot(input.env.WORKSPACE_CACHE))
    : [];

  let served: { gateway: Gateway; providerCostUsd: number; covered: boolean } | undefined;
  const { value: result } = await runWithFallback(
    input.env,
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
        system,
        messages: input.messages,
        temperature,
        maxOutputTokens: input.agent.maxTokens,
        tools: Object.keys(sdkTools).length > 0 ? (sdkTools as never) : undefined,
        stopWhen: stepCountIs(Math.max(1, input.agent.maxIterations)),
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(75_000),
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

  return {
    text: result.text,
    modelId,
    finishReason: String(result.finishReason ?? 'stop'),
    usage: result.usage as AgentExecutorResult['usage'],
    creditsUsed,
    toolInvocations: invocations,
    steps: result.steps?.length ?? 1,
  };
}

export interface StreamAgentParams extends AgentExecutorInput {
  metering: AiMetering | null;
  executionCtx: { waitUntil: (p: Promise<unknown>) => void };
}

/**
 * Streaming chat path — returns an AI SDK text stream response after tools settle.
 * Uses toTextStreamResponse for backward-compatible client consumption.
 */
export async function streamAgentChat(input: StreamAgentParams) {
  const defs = toolsForAgentTurn({
    permissions: input.agent.permissions,
    enabledTools: input.agent.enabledTools,
    systemPrompt: input.agent.systemPrompt,
    userMessageCount: input.messages.filter((m) => m.role === 'user').length,
  });
  const invocations: StoredToolInvocation[] = [];
  const sdkTools = toSdkTools(defs, input.toolContext, invocations, {
    autoReviewEnabled: input.agent.autoReviewEnabled,
  });
  const modelId = resolveAgentModelId(input.env, input.agent.modelId);
  const temperature = Number.parseFloat(input.agent.temperature) || 0.7;
  const system = buildSystemPrompt(input.agent, input.extraSystem);

  const credits = input.env.WORKSPACE_CACHE
    ? toCreditStates(await readGatewayCreditSnapshot(input.env.WORKSPACE_CACHE))
    : [];
  const attempt = pickGateway(input.env, { modelId, credits });

  const result = streamText({
    model: attempt.model,
    system,
    messages: input.messages,
    temperature,
    maxOutputTokens: input.agent.maxTokens,
    tools: Object.keys(sdkTools).length > 0 ? (sdkTools as never) : undefined,
    stopWhen: stepCountIs(Math.max(1, input.agent.maxIterations)),
    maxRetries: 1,
    onFinish: ({ usage }) => {
      const cost = providerCostUsd(modelId, usage) * (GATEWAY_FEE_MULTIPLIER[attempt.gateway] ?? 1);
      input.executionCtx.waitUntil(
        chargeAiUsage(input.metering, {
          modelId,
          usage,
          op: 'chat',
          gateway: attempt.gateway as Gateway,
          providerCostUsd: cost,
          coveredByServiceCredit: false,
        }).catch((err) => {
          console.error('[weldagent/stream] credit charge failed:', err);
        }),
      );
    },
  });

  return { result, invocations, modelId };
}
