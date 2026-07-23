import { z } from 'zod';

// `/api/mail-folders` — backed by `mail_folders`.

export const createMailFolderSchema = z.object({
  accountId: z.string(),
  name: z.string().min(1).max(255),
  type: z.string().max(50).optional(),
  parentId: z.string().nullish(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateMailFolderSchema = createMailFolderSchema.partial();

export type CreateMailFolderInput = z.infer<typeof createMailFolderSchema>;
export type UpdateMailFolderInput = z.infer<typeof updateMailFolderSchema>;
