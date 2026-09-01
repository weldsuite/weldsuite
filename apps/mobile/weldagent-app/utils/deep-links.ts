/**
 * Parse WeldAgent deep-link targets from an Expo push payload.
 * Prefer explicit conversationId / agentId (sent by the orchestrator); fall
 * back to scraping `/weldagent/chat/{id}` or `/weldagent/agent/{id}` from actionUrl.
 */

const ID = /^[A-Za-z0-9_-]+$/;

export interface WeldAgentDeepLink {
  conversationId?: string;
  agentId?: string;
  runId?: string;
}

export function resolveWeldAgentDeepLink(
  data: Record<string, unknown> | undefined,
): WeldAgentDeepLink | null {
  if (!data) return null;

  const conversationId =
    typeof data.conversationId === 'string' && ID.test(data.conversationId)
      ? data.conversationId
      : typeof data.actionUrl === 'string'
        ? data.actionUrl.match(/\/weldagent\/chat\/([^/?#]+)/)?.[1]
        : undefined;

  const agentId =
    typeof data.agentId === 'string' && ID.test(data.agentId)
      ? data.agentId
      : typeof data.actionUrl === 'string'
        ? data.actionUrl.match(/\/weldagent\/agent\/([^/?#/]+)/)?.[1]
        : undefined;

  const runId =
    typeof data.runId === 'string' && ID.test(data.runId)
      ? data.runId
      : typeof data.actionUrl === 'string'
        ? data.actionUrl.match(/\/run\/([^/?#]+)/)?.[1]
        : undefined;

  const safeConversation =
    conversationId && ID.test(conversationId) ? conversationId : undefined;
  const safeAgent = agentId && ID.test(agentId) ? agentId : undefined;
  const safeRun = runId && ID.test(runId) ? runId : undefined;

  if (!safeConversation && !safeAgent) return null;
  return { conversationId: safeConversation, agentId: safeAgent, runId: safeRun };
}

export function routeForDeepLink(target: WeldAgentDeepLink): string {
  if (target.conversationId) return `/chat/${target.conversationId}`;
  if (target.agentId) return `/agent/${target.agentId}`;
  return '/(tabs)';
}
