/**
 * `/api/mail-rules` — backed by `mail_rules`.
 *
 * Includes `/:id/toggle`, `/:id/duplicate`, and `/reorder` (single
 * statement priority update).
 */

import { z } from 'zod';

export const mailRuleConditionField = z.enum([
  'from', 'to', 'cc', 'subject', 'body',
  'has_attachment', 'size', 'date', 'is_spam', 'priority',
]);

export const mailRuleConditionOperator = z.enum([
  'contains', 'not_contains', 'equals', 'not_equals',
  'starts_with', 'ends_with', 'greater_than', 'less_than',
  'is_true', 'is_false',
]);

export const mailRuleConditionSchema = z.object({
  field: mailRuleConditionField,
  operator: mailRuleConditionOperator,
  value: z.union([z.string(), z.array(z.string())]),
});

export const mailRuleActionType = z.enum([
  'move_to_folder', 'copy_to_folder', 'delete', 'mark_as_read', 'mark_as_unread',
  'star', 'add_label', 'remove_label', 'forward_to', 'auto_reply', 'flag', 'archive',
]);

export const mailRuleActionSchema = z.object({
  type: mailRuleActionType,
  value: z.string().optional(),
  folderId: z.string().nullish(),
  labelId: z.string().nullish(),
  email: z.string().email().optional(),
  templateId: z.string().nullish(),
});

const ruleBaseFields = {
  accountId: z.string().min(1),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  conditions: z.array(mailRuleConditionSchema).min(1),
  matchType: z.enum(['all', 'any']).optional(),
  actions: z.array(mailRuleActionSchema).min(1),
  isActive: z.boolean().optional(),
  stopProcessing: z.boolean().optional(),
  priority: z.number().int().optional(),
  applyToExisting: z.boolean().optional(),
  scope: z.enum(['incoming', 'outgoing', 'all']).optional(),
  folders: z.array(z.string()).optional(),
} as const;

export const createMailRuleSchema = z.object(ruleBaseFields);
export const updateMailRuleSchema = z.object(ruleBaseFields).omit({ accountId: true }).partial();

export const listMailRulesQuery = z.object({
  accountId: z.string().optional(),
  isActive: z.coerce.boolean().optional(),
});

export const reorderMailRulesSchema = z.object({
  rules: z.array(z.object({ id: z.string(), priority: z.number().int() })).min(1).max(500),
});

export type CreateMailRuleInput = z.infer<typeof createMailRuleSchema>;
export type UpdateMailRuleInput = z.infer<typeof updateMailRuleSchema>;
export type ListMailRulesQuery = z.infer<typeof listMailRulesQuery>;
export type ReorderMailRulesInput = z.infer<typeof reorderMailRulesSchema>;
export type MailRuleCondition = z.infer<typeof mailRuleConditionSchema>;
export type MailRuleAction = z.infer<typeof mailRuleActionSchema>;
