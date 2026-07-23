/**
 * `/api/mail-templates` — backed by `mail_templates`.
 *
 * Plus `/categories` (distinct values), `/:id/duplicate`, and
 * `/:id/render` ({{var}} substitution; HTML-escapes substituted values
 * when rendering into htmlContent).
 */

import { z } from 'zod';

export const mailTemplateType = z.enum([
  'marketing', 'transactional', 'notification', 'newsletter', 'welcome', 'custom',
]);

export const mailTemplateVariableSchema = z.object({
  name: z.string(),
  type: z.enum(['text', 'number', 'date', 'boolean', 'list']),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  description: z.string().optional(),
});

const templateBaseFields = {
  name: z.string().min(1).max(255),
  subject: z.string().min(1).max(998),
  htmlContent: z.string().min(1),
  textContent: z.string().optional(),
  category: z.string().max(100).optional(),
  description: z.string().optional(),
  type: mailTemplateType.optional(),
  purpose: z.string().max(255).optional(),
  variables: z.array(mailTemplateVariableSchema).optional(),
  requiredVariables: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
} as const;

export const createMailTemplateSchema = z.object(templateBaseFields);
export const updateMailTemplateSchema = z.object(templateBaseFields).partial();

export const listMailTemplatesQuery = z.object({
  type: mailTemplateType.optional(),
  category: z.string().optional(),
  isActive: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const renderMailTemplateSchema = z.object({
  variables: z.record(z.unknown()),
});

export type CreateMailTemplateInput = z.infer<typeof createMailTemplateSchema>;
export type UpdateMailTemplateInput = z.infer<typeof updateMailTemplateSchema>;
export type ListMailTemplatesQuery = z.infer<typeof listMailTemplatesQuery>;
export type RenderMailTemplateInput = z.infer<typeof renderMailTemplateSchema>;
export type MailTemplateVariable = z.infer<typeof mailTemplateVariableSchema>;
