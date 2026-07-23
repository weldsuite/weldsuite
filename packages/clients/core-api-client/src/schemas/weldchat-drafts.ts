import { z } from 'zod';

// ============================================================================
// Shared sub-schemas
// ============================================================================

export const chatAttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  fileSize: z.number(),
  mimeType: z.string(),
  url: z.string(),
  thumbnailUrl: z.string().optional(),
});

export type ChatAttachmentInput = z.infer<typeof chatAttachmentSchema>;

// ============================================================================
// Mutations
// ============================================================================

export const upsertDraftSchema = z.object({
  channelId: z.string().nullish(),
  threadParentMessageId: z.string().nullish(),
  content: z.string(),
  attachments: z.array(chatAttachmentSchema).optional(),
});

export type UpsertDraftInput = z.infer<typeof upsertDraftSchema>;

// ============================================================================
// Response Interfaces
// ============================================================================

export interface DraftItem {
  id: string;
  channelId: string | null;
  threadParentMessageId: string | null;
  content: string;
  attachments: ChatAttachmentInput[] | null;
  channelName: string | null;
  updatedAt: string;
}
