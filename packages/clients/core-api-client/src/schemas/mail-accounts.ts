import { z } from 'zod';

// `/api/mail-accounts` — backed by `mail_accounts`.

export const createMailAccountSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().max(255).optional(),
  provider: z.string().max(50).optional(),
  status: z.string().max(30).optional(),
  authType: z.string().max(30).optional(),
  userId: z.string().nullish(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateMailAccountSchema = createMailAccountSchema.partial();

export type CreateMailAccountInput = z.infer<typeof createMailAccountSchema>;
export type UpdateMailAccountInput = z.infer<typeof updateMailAccountSchema>;
