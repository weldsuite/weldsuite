import { z } from 'zod';

// `/api/mail-labels` — backed by `mail_labels`. Gmail-style label model.

export const createMailLabelSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().max(50).optional(),
  isSystem: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateMailLabelSchema = createMailLabelSchema.partial();

export type CreateMailLabelInput = z.infer<typeof createMailLabelSchema>;
export type UpdateMailLabelInput = z.infer<typeof updateMailLabelSchema>;
