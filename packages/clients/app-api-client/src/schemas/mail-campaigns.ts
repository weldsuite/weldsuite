/**
 * `/api/mail-campaigns` — backed by `mail_campaigns`.
 */

import { z } from 'zod';

export const mailCampaignStatus = z.enum([
  'draft', 'scheduled', 'sending', 'sent', 'paused', 'cancelled', 'failed',
]);

export const mailCampaignRecipientListSchema = z.object({
  type: z.enum(['contacts', 'people', 'segments', 'manual', 'csv']),
  contactIds: z.array(z.string()).optional(),
  personIds: z.array(z.string()).optional(),
  segmentIds: z.array(z.string()).optional(),
  emails: z.array(z.object({ email: z.string().email(), name: z.string().optional() })).optional(),
  csvUrl: z.string().url().optional(),
  excludeUnsubscribed: z.boolean().optional(),
  excludeBounced: z.boolean().optional(),
});

const campaignBaseFields = {
  templateId: z.string().nullish(),
  name: z.string().min(1).max(255),
  subject: z.string().min(1).max(998),
  preheader: z.string().max(500).optional(),
  htmlContent: z.string().min(1),
  textContent: z.string().optional(),
  recipientList: mailCampaignRecipientListSchema,
  fromName: z.string().min(1).max(255),
  fromEmail: z.string().email().max(255),
  replyToEmail: z.string().email().max(255).optional(),
  scheduledAt: z.string().datetime().optional(),
  status: mailCampaignStatus.optional(),
  trackOpens: z.boolean().optional(),
  trackClicks: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
} as const;

export const createMailCampaignSchema = z.object(campaignBaseFields);
export const updateMailCampaignSchema = z.object(campaignBaseFields).partial();

export const listMailCampaignsQuery = z.object({
  status: mailCampaignStatus.optional(),
  templateId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type CreateMailCampaignInput = z.infer<typeof createMailCampaignSchema>;
export type UpdateMailCampaignInput = z.infer<typeof updateMailCampaignSchema>;
export type ListMailCampaignsQuery = z.infer<typeof listMailCampaignsQuery>;
export type MailCampaignRecipientList = z.infer<typeof mailCampaignRecipientListSchema>;
