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

/** An explicit payload field when it is a well-formed id, else the id scraped from `actionUrl`. */
function pickId(
  data: Record<string, unknown>,
  key: string,
  actionUrlPattern: RegExp,
): string | undefined {
  const explicit = data[key];
  if (typeof explicit === 'string' && ID.test(explicit)) return explicit;
  const actionUrl = data.actionUrl;
  return typeof actionUrl === 'string' ? actionUrlPattern.exec(actionUrl)?.[1] : undefined;
}

function onlyValidId(value: string | undefined): string | undefined {
  return value && ID.test(value) ? value : undefined;
}

export function resolveWeldAgentDeepLink(
  data: Record<string, unknown> | undefined,
): WeldAgentDeepLink | null {
  if (!data) return null;

  const safeConversation = onlyValidId(
    pickId(data, 'conversationId', /\/weldagent\/chat\/([^/?#]+)/),
  );
  const safeAgent = onlyValidId(pickId(data, 'agentId', /\/weldagent\/agent\/([^/?#]+)/));
  const safeRun = onlyValidId(pickId(data, 'runId', /\/run\/([^/?#]+)/));

  if (!safeConversation && !safeAgent) return null;
  return { conversationId: safeConversation, agentId: safeAgent, runId: safeRun };
}

export function routeForDeepLink(target: WeldAgentDeepLink): string {
  if (target.conversationId) return `/chat/${target.conversationId}`;
  if (target.agentId) return `/agent/${target.agentId}`;
  return '/(tabs)';
}
