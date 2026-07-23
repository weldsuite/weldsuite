import { z } from 'zod';

// ── Email Templates ──────────────────────────────────────────────────────────

export const createEmailTemplateSchema = z.object({
  name: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  variables: z.array(z.string()).optional(),
  triggerEvent: z.string().optional(),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const updateEmailTemplateSchema = createEmailTemplateSchema.partial();

// ── SMS Templates ────────────────────────────────────────────────────────────

export const createSmsTemplateSchema = z.object({
  name: z.string().min(1),
  message: z.string().min(1),
  maxLength: z.number().default(160),
  variables: z.array(z.string()).optional(),
  triggerEvent: z.string().optional(),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const updateSmsTemplateSchema = createSmsTemplateSchema.partial();

// ── WhatsApp Templates ───────────────────────────────────────────────────────

const whatsAppButtonSchema = z.object({
  type: z.enum(['quick_reply', 'url', 'phone']),
  text: z.string(),
  url: z.string().optional(),
  phoneNumber: z.string().optional(),
});

export const createWhatsAppTemplateSchema = z.object({
  name: z.string().min(1),
  message: z.string().min(1),
  headerText: z.string().optional(),
  footerText: z.string().optional(),
  variables: z.array(z.string()).optional(),
  mediaType: z.string().optional(),
  mediaUrl: z.string().optional(),
  buttons: z.array(whatsAppButtonSchema).optional(),
  triggerEvent: z.string().optional(),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const updateWhatsAppTemplateSchema = createWhatsAppTemplateSchema.partial().extend({
  approvalStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
});

// ── Webhooks ─────────────────────────────────────────────────────────────────

export const createWebhookSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  events: z.array(z.string()).min(1),
  secret: z.string().optional(),
  description: z.string().optional(),
  headers: z.record(z.string()).optional(),
});

export const updateWebhookSchema = createWebhookSchema.partial();

// ── Inferred types ───────────────────────────────────────────────────────────

export type CreateEmailTemplateInput = z.infer<typeof createEmailTemplateSchema>;
export type UpdateEmailTemplateInput = z.infer<typeof updateEmailTemplateSchema>;
export type CreateSmsTemplateInput = z.infer<typeof createSmsTemplateSchema>;
export type UpdateSmsTemplateInput = z.infer<typeof updateSmsTemplateSchema>;
export type CreateWhatsAppTemplateInput = z.infer<typeof createWhatsAppTemplateSchema>;
export type UpdateWhatsAppTemplateInput = z.infer<typeof updateWhatsAppTemplateSchema>;
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;
