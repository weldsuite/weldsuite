/**
 * Workspace agents as chat members (ADR AGENT-014).
 *
 * Anyone who may write in a channel, record chat included, can bring in an
 * agent they can use. A record chat only comes into being with its first
 * message, so it has no roster to invite into beforehand: that message brings
 * in the agents it mentions instead.
 */

import { and, eq } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { addChannelMembers } from '@weldsuite/chat-domain/channel-members';
import { extractChatMentions } from '@weldsuite/chat-domain/post-agent-message';
import { publishChatMemberJoined, type WeldChatPublisherEnv } from '@weldsuite/chat-domain/realtime/weldchat-publisher';
import { inaccessibleAgentIds, type AgentViewer } from '@weldsuite/agent-domain/access';
import { canPostInRecordChat, getEntityProvider, type PermissionCheck } from './entity-channels';

/** Channel types agents can be in. DMs stay between people. */
export const AGENT_ROOM_TYPES: ReadonlySet<string> = new Set(['public', 'private', 'entity']);

/**
 * Whether `userId` may write in a record chat they can read: some records
 * (sheets, documents) take more than reading to comment on (ADR CHAT-007).
 * Always true for a channel that is not a record chat.
 */
export async function mayWriteInRecordChat(
  db: Database,
  channel: { type: string; entityType: string | null; entityId: string | null },
  userId: string,
  can: PermissionCheck,
): Promise<boolean> {
  if (channel.type !== 'entity') return true;
  const provider = channel.entityType ? getEntityProvider(channel.entityType) : undefined;
  if (!provider || !channel.entityId) return false;
  return canPostInRecordChat(provider, { db, actingUserId: userId, entityId: channel.entityId, can });
}

/**
 * Add the agents `content` / `mentions` name to the channel, when the author
 * may use them (`canUseAgents` = `weldagent:use`, plus each agent's own
 * visibility). Agents the author cannot use are left out silently, as are
 * ones already in. Returns the ids that joined.
 */
export async function addMentionedAgents(
  db: Database,
  env: WeldChatPublisherEnv,
  params: {
    channelId: string;
    content: string;
    mentions?: string[];
    canUseAgents: boolean;
    viewer: () => Promise<AgentViewer>;
  },
): Promise<string[]> {
  if (!params.canUseAgents) return [];
  const mentioned = extractChatMentions(params.content, params.mentions ?? []).filter((id) => id.startsWith('agt_'));
  if (mentioned.length === 0) return [];

  const { chatChannelMembers } = schema;
  const existing = await db
    .select({ userId: chatChannelMembers.userId })
    .from(chatChannelMembers)
    .where(and(eq(chatChannelMembers.channelId, params.channelId), eq(chatChannelMembers.memberType, 'agent')));
  const inChannel = new Set(existing.map((m) => m.userId));
  const candidates = mentioned.filter((id) => !inChannel.has(id));
  if (candidates.length === 0) return [];

  const blocked = new Set(await inaccessibleAgentIds(db, candidates, await params.viewer()));
  const allowed = candidates.filter((id) => !blocked.has(id));
  if (allowed.length === 0) return [];

  const result = await addChannelMembers(db, { channelId: params.channelId, userIds: allowed, memberType: 'agent' });
  if (!result.ok) return [];
  await Promise.all(
    result.addedUserIds.map((agentId) =>
      publishChatMemberJoined(env, params.channelId, { channelId: params.channelId, userId: agentId }).catch((e) =>
        console.error('[chat-api/agent-members] member_joined publish failed:', e),
      ),
    ),
  );
  return result.addedUserIds;
}
