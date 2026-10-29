/**
 * Response shapes of chat-api (WeldChat) as Zod schemas, matching the
 * interfaces of `../domains/channels`, `chat-messages`, `chat-dm`, … The
 * conformance suite validates every Rust answer against them
 * (`@weldsuite/worker-kit/testing/conformance-schemas`). Rows pass extra
 * columns through, as the routes return whole Drizzle rows.
 */

import { z } from 'zod';

const iso = z.string();
const nullableIso = z.string().nullable();

/** A `chat_channels` row (`ChannelRow`). */
export const chatChannelRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    topic: z.string().nullable(),
    type: z.string(),
    icon: z.string().nullable(),
    createdBy: z.string().nullable(),
    isArchived: z.boolean(),
    isDefault: z.boolean(),
    voiceCallsEnabled: z.boolean(),
    videoCallsEnabled: z.boolean(),
    threadsEnabled: z.boolean(),
    attachmentsEnabled: z.boolean(),
    reactionsEnabled: z.boolean(),
    slowModeSeconds: z.number(),
    lastMessageAt: nullableIso,
    lastMessagePreview: z.string().nullable(),
    messageCount: z.number(),
    memberCount: z.number(),
    sectionId: z.string().nullable(),
    entityType: z.string().nullable(),
    entityId: z.string().nullable(),
    entityDisplayName: z.string().nullable(),
    metadata: z.record(z.unknown()).nullable(),
    createdAt: iso,
    updatedAt: iso,
    deletedAt: nullableIso,
  })
  .passthrough();

/** A channel in the sidebar list: the row plus the caller's own state. */
export const chatChannelListItemSchema = chatChannelRowSchema.extend({
  isMuted: z.boolean(),
  lastReadAt: nullableIso,
  lastReadMessageId: z.string().nullable(),
  unreadMentionCount: z.number(),
});

/** A roster entry of `GET /api/channels/:id` and `/:id/members` (`ChannelMember`). */
export const chatChannelMemberSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    memberType: z.string().nullable().optional(),
    role: z.string().nullable(),
    joinedAt: nullableIso,
    isMuted: z.boolean().nullable(),
    notificationPreference: z.string().nullable(),
    lastReadAt: nullableIso.optional(),
    lastReadMessageId: z.string().nullable().optional(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    picture: z.string().nullable(),
    workspaceMemberType: z.string().nullable().optional(),
    agentIcon: z.string().nullable().optional(),
    agentDescription: z.string().nullable().optional(),
  })
  .passthrough();

/** `GET /api/channels/:id`: the row, the caller's mute flag, the roster. */
export const chatChannelDetailSchema = chatChannelRowSchema.extend({
  isMuted: z.boolean(),
  members: z.array(chatChannelMemberSchema),
});

/** A `chat_channel_members` row. */
export const chatChannelMemberRowSchema = z
  .object({
    id: z.string(),
    channelId: z.string(),
    userId: z.string(),
    memberType: z.string(),
    role: z.string(),
    addedByRoleId: z.string().nullable(),
    lastReadAt: nullableIso,
    lastReadMessageId: z.string().nullable(),
    isMuted: z.boolean(),
    notificationPreference: z.string(),
    unreadMentionCount: z.number(),
    joinedAt: iso,
    createdAt: iso,
  })
  .passthrough();

/** A `chat_messages` row (`ChatMessageRow`). */
export const chatMessageRowSchema = z
  .object({
    id: z.string(),
    channelId: z.string(),
    authorId: z.string(),
    authorName: z.string(),
    authorAvatar: z.string().nullable(),
    authorType: z.string(),
    content: z.string(),
    htmlContent: z.string().nullable(),
    type: z.string(),
    parentId: z.string().nullable(),
    threadReplyCount: z.number(),
    threadLastReplyAt: nullableIso,
    threadParticipantIds: z.array(z.string()).nullable(),
    isEdited: z.boolean(),
    editedAt: nullableIso,
    isPinned: z.boolean(),
    pinnedAt: nullableIso,
    pinnedBy: z.string().nullable(),
    pinExpiresAt: nullableIso,
    attachments: z.array(z.record(z.unknown())).nullable(),
    hasAttachments: z.boolean(),
    reactions: z.record(z.array(z.string())).nullable(),
    mentions: z.array(z.string()).nullable(),
    mentionsEveryone: z.boolean(),
    forwardedFrom: z.record(z.unknown()).nullable(),
    metadata: z.record(z.unknown()).nullable(),
    createdAt: iso,
    updatedAt: iso,
    deletedAt: nullableIso,
  })
  .passthrough();

/** `GET /api/channels/:id/messages`: a page of messages, not the list envelope. */
export const chatMessagePageSchema = z.object({
  messages: z.array(chatMessageRowSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

/** `{ id }` (and `alreadyExists` when it was there). */
export const chatIdSchema = z.object({ id: z.string() }).passthrough();

/** `POST /api/channels/:id/members`. */
export const chatMembersAddedSchema = z.object({ channelId: z.string(), addedCount: z.number() });

/** `POST /api/channels/:id/agents`. */
export const chatAgentsAddedSchema = z.object({ channelId: z.string(), addedAgentIds: z.array(z.string()) });

/** `DELETE /api/channels/:id/agents/:agentId`. */
export const chatAgentRemovedSchema = z.object({ channelId: z.string(), agentId: z.string(), removed: z.literal(true) });

/** `POST /api/channels/:id/members/join`. */
export const chatChannelJoinSchema = z.union([
  z.object({ channelId: z.string(), joined: z.literal(true) }),
  z.object({ channelId: z.string(), alreadyMember: z.literal(true) }),
]);

/** `POST /api/channels/:id/members/leave`. */
export const chatChannelLeftSchema = z.object({ channelId: z.string(), left: z.literal(true) });

/** `DELETE /api/channels/:id/members/:userId`. */
export const chatMemberRemovedSchema = z.object({ channelId: z.string(), userId: z.string(), removed: z.literal(true) });

/** `GET /api/channels/:id/read-receipts`: receipts by message id. */
export const chatReadReceiptsSchema = z.record(
  z.array(
    z.object({
      userId: z.string(),
      userName: z.string().nullable(),
      userAvatar: z.string().nullable(),
      readAt: nullableIso,
    }),
  ),
);

/** `POST /api/channels/:id/read`. */
export const chatMarkReadSchema = z.object({
  channelId: z.string(),
  lastReadAt: iso,
  lastReadMessageId: z.string().nullable(),
  previousLastReadAt: nullableIso.optional(),
});

/** `POST /api/channels/:id/messages/:messageId/forward`. */
export const chatForwardedSchema = z.object({
  forwarded: z.array(z.object({ channelId: z.string(), messageId: z.string() })),
});
