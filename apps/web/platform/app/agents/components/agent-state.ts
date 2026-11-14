import {
  DEFAULT_WORKSPACE_AGENT_MODEL,
  isWorkspaceAgentAnyModel,
  isWorkspaceAgentModel,
} from '@weldsuite/app-api-client/schemas/workspace-agents';
import { hasAiSettings } from '@/lib/edition';

/** An agent without lasting instructions still runs its setup interview. */
export function agentNeedsSetup(agent: { systemPrompt?: string | null }): boolean {
  return !agent.systemPrompt?.trim();
}

/**
 * The model an agent form shows: a Claude id on Global, any catalog model id
 * (`mistral/…`) or the policy default on a Kubernetes install. Agents saved
 * before Managed Agents may hold some other id (`anthropic/claude-sonnet-4-5`);
 * on Global that id is shown as the default, because agent-api only accepts
 * the Claude ids and the form saves the model back.
 */
export function resolveModelId(value: string | null | undefined): string {
  const allowed = hasAiSettings() ? isWorkspaceAgentAnyModel(value) : isWorkspaceAgentModel(value);
  return allowed ? (value as string) : DEFAULT_WORKSPACE_AGENT_MODEL;
}

/** Sandbox (bash, files, code) and web (search, fetch, browser) run at Anthropic. */
export const BUILTIN_GRANTS = { sandbox: 'computer:use', web: 'browser:use' } as const;

export type AgentBadge = 'setup' | 'active' | 'paused' | 'draft';

/** The status an agent shows on its card: an agent without instructions is still being set up. */
export function agentBadge(agent: { status: 'draft' | 'active' | 'paused'; systemPrompt?: string | null }): AgentBadge {
  return agentNeedsSetup(agent) ? 'setup' : agent.status;
}
