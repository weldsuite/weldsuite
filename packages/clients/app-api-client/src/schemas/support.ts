import { z } from 'zod';

// ============================================================================
// Contact Support — the Enterprise plan's support channel (`/api/support`).
//
//   GET    /channel          → supportChannelWithMembersSchema (201 when created)
//   GET    /messages         → supportMessagePageSchema (`?before=<id>&limit=`)
//   POST   /messages         → supportMessageSchema (201)
//   GET    /members          → supportChannelMemberSchema[]
//   POST   /members          → supportChannelMemberSchema[] (the whole list)
//   DELETE /members/:userId  → supportMemberRemovedSchema
// ============================================================================

export const supportChannelSchema = z.object({
  id: z.string(),
  status: z.string(),
  lastMessageAt: z.string().nullable(),
  lastMessagePreview: z.string().nullable(),
  messageCount: z.number().int(),
  memberCount: z.number().int(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

export type SupportChannel = z.infer<typeof supportChannelSchema>;

export const supportChannelMemberSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  userId: z.string(),
  role: z.enum(['owner', 'member']),
  joinedAt: z.string(),
  createdAt: z.string(),
});

export type SupportChannelMember = z.infer<typeof supportChannelMemberSchema>;

export const supportAttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  fileSize: z.number(),
  mimeType: z.string(),
  url: z.string(),
});

export const supportMessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  authorAvatar: z.string().nullable(),
  authorType: z.enum(['customer', 'support']),
  content: z.string(),
  htmlContent: z.string().nullable(),
  isEdited: z.boolean(),
  attachments: z.array(supportAttachmentSchema).nullable(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

export type SupportMessage = z.infer<typeof supportMessageSchema>;

export const supportChannelWithMembersSchema = z.object({
  channel: supportChannelSchema,
  members: z.array(supportChannelMemberSchema),
});

/** Newest first; `nextCursor` is the last message's id when there is more. */
export const supportMessagePageSchema = z.object({
  messages: z.array(supportMessageSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const supportMemberRemovedSchema = z.object({ removed: z.string() });
