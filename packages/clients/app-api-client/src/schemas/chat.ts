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

/** A bookmark with its message and channel (`GET /api/chat-bookmarks`). */
export const chatBookmarkSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    messageId: z.string(),
    channelId: z.string(),
    note: z.string().nullable(),
    createdAt: iso,
    messageContent: z.string().nullable(),
    messageAuthorId: z.string().nullable(),
    messageAuthorName: z.string().nullable(),
    messageAuthorAvatar: z.string().nullable(),
    messageCreatedAt: nullableIso,
    messageAttachments: z.array(z.record(z.unknown())).nullable(),
    channelName: z.string().nullable(),
    channelSlug: z.string().nullable(),
    channelType: z.string().nullable(),
  })
  .passthrough();

/** `POST /api/chat-bookmarks`: the new bookmark, or `{ id, alreadyExists }`. */
export const chatBookmarkCreatedSchema = z.union([
  z.object({ id: z.string(), alreadyExists: z.literal(true) }),
  z
    .object({ id: z.string(), userId: z.string(), messageId: z.string(), channelId: z.string(), createdAt: iso })
    .passthrough(),
]);

/** A `chat_drafts` row. */
export const chatDraftRowSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    userId: z.string(),
    channelId: z.string().nullable(),
    threadParentMessageId: z.string().nullable(),
    content: z.string(),
    attachments: z.unknown(),
    createdAt: iso,
    updatedAt: iso,
  })
  .passthrough();

/** A draft write: `{ id }`, or `{ id, deleted }` when it ended up empty. */
export const chatDraftWriteSchema = z.object({ id: z.string().nullable(), deleted: z.boolean().optional() });

/** A `chat_sections` row. */
export const chatSectionRowSchema = z
  .object({ id: z.string(), name: z.string(), position: z.number(), createdAt: iso, updatedAt: iso })
  .passthrough();

const presenceSchema = z.enum(['online', 'away', 'busy']);
const statusSchema = z.enum(['online', 'busy', 'away', 'dnd', 'offline']);

/** One member's status (`GET /api/chat-status`). */
export const chatMemberStatusSchema = z.object({
  userId: z.string(),
  status: statusSchema,
  manualStatus: statusSchema,
  live: presenceSchema.nullable(),
  statusText: z.string().nullable(),
  statusEmoji: z.string().nullable(),
  statusExpiresAt: nullableIso,
  updatedAt: nullableIso,
});

/** `PUT /api/chat-status`. */
export const chatStatusSetSchema = z.object({
  userId: z.string(),
  status: statusSchema,
  manualStatus: statusSchema,
  statusText: z.string().nullable(),
  statusEmoji: z.string().nullable(),
  expiresAt: nullableIso,
  updatedAt: iso,
});

/** `DELETE /api/chat-status`. */
export const chatStatusClearedSchema = z.object({ userId: z.string(), cleared: z.literal(true) });

/** A reaction toggle (`POST /api/chat-messages/:id/reactions`). */
export const chatReactionsSchema = z.object({
  messageId: z.string(),
  channelId: z.string(),
  reactions: z.record(z.array(z.string())),
});

/** A pin or unpin (`PinResult`). */
export const chatPinResultSchema = z.object({
  messageId: z.string(),
  channelId: z.string(),
  isPinned: z.boolean(),
  pinnedAt: nullableIso,
  pinnedBy: z.string().nullable(),
  pinExpiresAt: nullableIso,
});

/** An uploaded attachment (`POST /api/chat-messages/upload`). */
export const chatUploadSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  fileSize: z.number(),
  mimeType: z.string(),
  url: z.string(),
  fileKey: z.string(),
});

/** One entry of the activity feed (`GET /api/chat-activity`). */
export const chatActivityItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  channelId: z.string().nullable(),
  channelName: z.string().nullable(),
  messageId: z.string().nullable(),
  actorId: z.string().nullable(),
  actorName: z.null(),
  actorAvatarUrl: z.null(),
  actionUrl: z.string().nullable(),
  readAt: nullableIso,
  createdAt: iso,
});

/** `GET /api/chat-activity/unread-count`. */
export const chatUnreadCountSchema = z.object({ count: z.number() });

/** A DM member with names (`DmMember`). */
export const chatDmMemberSchema = z
  .object({
    userId: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    picture: z.string().nullable(),
    role: z.string().optional(),
    lastReadAt: nullableIso.optional(),
    lastReadMessageId: z.string().nullable().optional(),
  })
  .passthrough();

/** A DM (`DmChannel`): the channel with its members. */
export const chatDmChannelSchema = chatChannelRowSchema.extend({
  members: z.array(chatDmMemberSchema),
  otherMembers: z.array(chatDmMemberSchema).optional(),
  isMuted: z.boolean().optional(),
  lastReadAt: nullableIso.optional(),
  lastReadMessageId: z.string().nullable().optional(),
});

/** `PATCH /api/chat-dm/:id/archive`, `/unarchive`. */
export const chatDmArchivedSchema = z.object({ id: z.string(), isArchived: z.boolean() });

/** `PATCH /api/chat-dm/:id/pin`. */
export const chatDmPinnedSchema = z.object({ id: z.string(), isPinned: z.boolean() });

/** A channel in the directory (`GET /api/chat-directories/channels`). */
export const chatDirectoryChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  memberCount: z.number(),
  isJoined: z.boolean(),
  type: z.enum(['public', 'private']),
});

/** `GET /api/chat-search`. */
export const chatSearchResultSchema = z.object({
  messages: z.array(
    z
      .object({
        id: z.string(),
        channelId: z.string(),
        authorId: z.string(),
        authorName: z.string(),
        content: z.string(),
        createdAt: iso,
        channel: z.object({ name: z.string(), slug: z.string(), type: z.string() }).nullable(),
      })
      .passthrough(),
  ),
  total: z.number(),
});

/** A record chat in the list (`RecordChatListItem`): the row plus the caller's state. */
export const chatRecordChatSchema = chatChannelRowSchema.extend({
  isFollowing: z.boolean(),
  isMuted: z.boolean(),
  lastReadAt: nullableIso,
  lastReadMessageId: z.string().nullable(),
  unreadMentionCount: z.number(),
});

/** `GET /api/chat-entity-channels/summary` (`RecordChatTypeSummary`). */
export const chatRecordChatSummarySchema = z.object({
  type: z.string(),
  label: z.string(),
  followed: z.number(),
  unread: z.number(),
  mentions: z.number(),
});

/** `PATCH /api/chat-entity-channels/:entityType/mute`. */
export const chatRecordChatsMutedSchema = z.object({ updated: z.number() });

/** `GET /api/chat-entity-channels/:entityType/:entityId/comments`. */
export const chatRecordCommentsSchema = z.object({
  channel: chatChannelRowSchema.nullable(),
  messages: z.array(chatMessageRowSchema),
});

/** `POST /api/chat-entity-channels/:entityType/:entityId/messages`. */
export const chatRecordMessageSentSchema = z.object({
  channel: chatChannelRowSchema,
  message: chatMessageRowSchema,
  createdChannel: z.boolean(),
});

/** `POST /api/chat-entity-channels/:entityType/:entityId/follow`. */
export const chatRecordFollowSchema = z.object({
  channel: chatChannelRowSchema,
  following: z.literal(true),
  createdChannel: z.boolean(),
});

/** `GET /api/chat-entity-channels/:entityType/:entityId/detail`: provider-specific. */
export const chatRecordDetailSchema = z.record(z.unknown()).nullable();

/** `POST /api/chat-clips/:channelId`. */
export const chatClipTranscribingSchema = z.object({
  messageId: z.string(),
  attachmentId: z.string(),
  status: z.literal('processing'),
});

/** `PATCH /api/chat-clips/:channelId/:messageId/transcript`. */
export const chatClipTranscriptSchema = z.object({
  messageId: z.string(),
  attachmentId: z.string(),
  transcript: z.object({ status: z.enum(['pending', 'processing', 'completed', 'failed']) }).passthrough(),
});
