/**
 * `/api/mail-folders` — backed by `mail_folders`.
 */

import { z } from 'zod';

export const mailFolderType = z.enum([
  'inbox', 'sent', 'drafts', 'spam', 'trash', 'archive', 'custom',
]);

export const createMailFolderSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1).max(255),
  type: mailFolderType.optional(),
  parentId: z.string().nullish(),
  path: z.string().max(1000).optional(),
  color: z.string().max(7).optional(),
  icon: z.string().max(50).optional(),
  position: z.number().int().optional(),
});

export const updateMailFolderSchema = createMailFolderSchema.omit({ accountId: true }).partial();

export const listMailFoldersQuery = z.object({ accountId: z.string().optional() });

export type CreateMailFolderInput = z.infer<typeof createMailFolderSchema>;
export type UpdateMailFolderInput = z.infer<typeof updateMailFolderSchema>;
export type ListMailFoldersQuery = z.infer<typeof listMailFoldersQuery>;
