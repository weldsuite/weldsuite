/**
 * WeldAgent notifications carry the mobile app's deep links
 * (`@weldsuite/notifications` helpers/weldagent.ts). The platform has no
 * `/weldagent/*` pages, so map them onto `/agents`.
 */

const CHAT_LINK = /^\/weldagent\/chat\/([^/?#]+)\/?$/;
const RUN_LINK = /^\/weldagent\/agent\/([^/?#]+)\/run\/[^/?#]+\/?$/;
const AGENT_LINK = /^\/weldagent\/agent\/([^/?#]+)\/?$/;

/** The platform page for a notification's `actionUrl`; anything else passes through. */
export function webHrefForAction(actionUrl: string): string {
  const chat = CHAT_LINK.exec(actionUrl);
  if (chat) return `/agents?conversation=${encodeURIComponent(chat[1])}`;
  const run = RUN_LINK.exec(actionUrl);
  if (run) return `/agents/${encodeURIComponent(run[1])}?settings=activity`;
  // Approvals: the agent's chat shows its pending approvals.
  const agent = AGENT_LINK.exec(actionUrl);
  if (agent) return `/agents/${encodeURIComponent(agent[1])}`;
  return actionUrl;
}
