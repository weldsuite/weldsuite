/**
 * Run a workspace agent (manual or event) and persist the result.
 */

import type { Env } from '../../types';
import { runAgentOnce } from './executor';
import {
  getAgent,
  createAgentRun,
  markRunRunning,
  completeAgentRun,
  type AgentDb,
} from './agents';

export async function executeAgentRun(params: {
  db: AgentDb;
  env: Env;
  workspaceId: string;
  actorUserId: string;
  agentId: string;
  triggerType: 'manual' | 'event' | 'chat';
  triggerData?: Record<string, unknown>;
  userMessage: string;
  extraSystem?: string;
  /** When set, reuse an existing queued run id. */
  runId?: string;
}): Promise<{ runId: string; text: string; success: boolean; error?: string }> {
  const agent = await getAgent(params.db, params.agentId);
  if (!agent) {
    throw new Error('Agent not found');
  }

  const runId =
    params.runId ??
    (await createAgentRun(params.db, {
      agentId: agent.id,
      status: 'queued',
      triggerType: params.triggerType,
      triggerData: params.triggerData,
    }));

  await markRunRunning(params.db, runId);

  try {
    const result = await runAgentOnce({
      env: params.env,
      workspaceId: params.workspaceId,
      actorUserId: params.actorUserId,
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
        actorUserId: params.actorUserId,
        workspaceId: params.workspaceId,
      },
      messages: [{ role: 'user', content: params.userMessage }],
      extraSystem: params.extraSystem,
    });

    const actionsPerformed = result.toolInvocations
      .filter((t) => t.state === 'result' || t.state === 'error')
      .map((t) => ({
        tool: t.toolName,
        description: t.state === 'error' ? 'failed' : 'ok',
        success: t.state === 'result',
      }));

    await completeAgentRun(params.db, {
      runId,
      agentId: agent.id,
      success: true,
      result: {
        summary: result.text.slice(0, 2000),
        actionsPerformed,
        toolInvocations: result.toolInvocations,
      },
      totalIterations: result.steps,
      totalTokensUsed:
        (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0) ||
        result.usage.totalTokens ||
        0,
      toolCallCount: actionsPerformed.length,
    });

    return { runId, text: result.text, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Agent run failed';
    await completeAgentRun(params.db, {
      runId,
      agentId: agent.id,
      success: false,
      error: message,
    });
    return { runId, text: '', success: false, error: message };
  }
}
