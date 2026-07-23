import { z } from 'zod';

export const entityChannelRefSchema = z.object({
  entityType: z.string().min(1).max(50),
  entityId: z.string().min(1).max(30),
});

export type EntityChannelRef = z.infer<typeof entityChannelRefSchema>;

export const sendEntityMessageSchema = z.object({
  content: z.string().min(1),
  htmlContent: z.string().optional(),
  parentId: z.string().nullish(),
  mentions: z.array(z.string()).optional(),
  mentionsEveryone: z.boolean().optional(),
  attachments: z.array(z.record(z.any())).optional(),
  metadata: z.record(z.any()).optional(),
});

export type SendEntityMessageInput = z.infer<typeof sendEntityMessageSchema>;

export interface EntityChannelResponse {
  id: string;
  name: string;
  slug: string;
  type: 'entity';
  entityType: string;
  entityId: string;
  entityDisplayName: string | null;
  entityUrl?: string | null;
  description: string | null;
  topic: string | null;
  icon: string | null;
  createdBy: string | null;
  isArchived: boolean;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  messageCount: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown> | null;
}
