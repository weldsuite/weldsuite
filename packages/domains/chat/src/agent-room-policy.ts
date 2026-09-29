/**
 * Multi-agent room policy stored on `chat_channels.metadata`.
 *
 * No migration required — uses the existing jsonb metadata column.
 */

export type AgentReplyPolicy = 'mentions' | 'always' | 'none';

export const DEFAULT_AGENT_REPLY_POLICY: AgentReplyPolicy = 'mentions';
export const DEFAULT_AGENT_MAX_HOPS = 2;
export const ABSOLUTE_AGENT_MAX_HOPS = 5;

export interface AgentRoomPolicy {
  /** When agents auto-reply in this channel. */
  agentReplyPolicy: AgentReplyPolicy;
  /** Max agent→agent mention hops after a human message (1–5). */
  agentMaxHops: number;
}

export function parseAgentRoomPolicy(
  metadata: Record<string, unknown> | null | undefined,
): AgentRoomPolicy {
  const rawPolicy = metadata?.agentReplyPolicy;
  const agentReplyPolicy: AgentReplyPolicy =
    rawPolicy === 'always' || rawPolicy === 'none' || rawPolicy === 'mentions'
      ? rawPolicy
      : DEFAULT_AGENT_REPLY_POLICY;

  const rawHops = metadata?.agentMaxHops;
  let agentMaxHops = DEFAULT_AGENT_MAX_HOPS;
  if (typeof rawHops === 'number' && Number.isFinite(rawHops)) {
    agentMaxHops = Math.min(ABSOLUTE_AGENT_MAX_HOPS, Math.max(1, Math.floor(rawHops)));
  }

  return { agentReplyPolicy, agentMaxHops };
}

export function mergeAgentRoomPolicy(
  existing: Record<string, unknown> | null | undefined,
  patch: Partial<AgentRoomPolicy>,
): Record<string, unknown> {
  const current = parseAgentRoomPolicy(existing);
  const next: AgentRoomPolicy = {
    agentReplyPolicy: patch.agentReplyPolicy ?? current.agentReplyPolicy,
    agentMaxHops: patch.agentMaxHops ?? current.agentMaxHops,
  };
  return {
    ...(existing ?? {}),
    agentReplyPolicy: next.agentReplyPolicy,
    agentMaxHops: next.agentMaxHops,
  };
}

/**
 * Decide which agent member ids should run a reply for a triggering message.
 *
 * - `none` → nobody
 * - `mentions` → only explicitly @mentioned agents that are channel members
 * - `always` → all active agent members on human messages; on agent messages,
 *   only explicit mentions (avoids infinite always-on loops)
 */
export function selectAgentsToReply(params: {
  policy: AgentReplyPolicy;
  agentMemberIds: string[];
  mentionedAgentIds: string[];
  authorType: 'user' | 'agent' | 'system';
  authorId: string;
  hop: number;
  maxHops: number;
}): string[] {
  const { policy, agentMemberIds, mentionedAgentIds, authorType, authorId, hop, maxHops } =
    params;

  if (policy === 'none') return [];
  if (hop > maxHops) return [];

  const memberSet = new Set(agentMemberIds);
  const mentionedInRoom = mentionedAgentIds.filter((id) => memberSet.has(id) && id !== authorId);

  if (policy === 'mentions') {
    return mentionedInRoom;
  }

  // always
  if (authorType === 'agent' || authorType === 'system') {
    return mentionedInRoom;
  }

  return agentMemberIds.filter((id) => id !== authorId);
}
