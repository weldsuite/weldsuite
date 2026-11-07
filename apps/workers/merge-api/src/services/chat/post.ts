/**
 * One WeldMerge post in a WeldChat channel: a system message authored by
 * `app:weldmerge` whose `metadata.weldmerge` the chat UI renders as a card.
 * Goes through `postSystemChatMessage` (channel counters, realtime, unread
 * counts) and then publishes the `chat_message` created event, as WeldConnect's
 * post-chat-message action does.
 */

import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { postSystemChatMessage } from '@weldsuite/chat-domain/post-system-message';
import { MERGE_CHAT_AUTHOR, type MergeChatCardMetadata } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import type { HookContext } from '../hooks';

export const MERGE_CHAT_AUTHOR_NAME = 'WeldMerge';

export async function postCard(
  ctx: HookContext,
  channelId: string,
  content: string,
  card: MergeChatCardMetadata,
): Promise<void> {
  const message = await postSystemChatMessage(
    {
      db: ctx.db,
      env: ctx.env,
      orgId: ctx.clerkOrgId,
      channelId,
      authorId: MERGE_CHAT_AUTHOR,
      authorName: MERGE_CHAT_AUTHOR_NAME,
      invokerUserId: ctx.userId,
    },
    { content, metadata: { weldmerge: card } },
  );
  await publishEntityEventRaw({
    env: ctx.env,
    workspaceId: ctx.clerkOrgId,
    userId: ctx.userId,
    entityType: 'chat_message',
    action: 'created',
    entityId: message.id,
    data: { id: message.id, channelId, authorId: MERGE_CHAT_AUTHOR, authorType: 'system' },
  });
}

/** Posts to every channel; one channel failing (archived, removed) does not stop the others. */
export async function postCardToChannels(
  ctx: HookContext,
  channelIds: string[],
  content: string,
  card: MergeChatCardMetadata,
): Promise<void> {
  for (const channelId of channelIds) {
    try {
      await postCard(ctx, channelId, content, card);
    } catch (err) {
      console.error(`[merge-api] chat post to ${channelId} failed:`, err);
    }
  }
}
