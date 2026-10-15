import {
  DEFAULT_WORKSPACE_AGENT_MODEL,
  isWorkspaceAgentModel,
  type WorkspaceAgentModel,
} from '@weldsuite/app-api-client/schemas/workspace-agents';

/** An agent without lasting instructions still runs its setup interview. */
export function agentNeedsSetup(agent: { systemPrompt?: string | null }): boolean {
  return !agent.systemPrompt?.trim();
}

/** Agents saved before Managed Agents may hold a non-Claude id; show the default. */
export function resolveModelId(value: string | null | undefined): WorkspaceAgentModel {
  return isWorkspaceAgentModel(value) ? value : DEFAULT_WORKSPACE_AGENT_MODEL;
}

/** Sandbox (bash, files, code) and web (search, fetch, browser) run at Anthropic. */
export const BUILTIN_GRANTS = { sandbox: 'computer:use', web: 'browser:use' } as const;
