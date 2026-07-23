import { z } from 'zod';

// `/api/mail-templates` — backed by `mail_templates`.

export const createMailTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  subject: z.string().min(1).max(998),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  type: z.string().max(50).optional(),
  category: z.string().max(100).optional(),
  isShared: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateMailTemplateSchema = createMailTemplateSchema.partial();

export type CreateMailTemplateInput = z.infer<typeof createMailTemplateSchema>;
export type UpdateMailTemplateInput = z.infer<typeof updateMailTemplateSchema>;
