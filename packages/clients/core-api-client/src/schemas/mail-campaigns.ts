import { z } from 'zod';

// `/api/mail-campaigns` — backed by `mail_campaigns`.

export const createMailCampaignSchema = z.object({
  name: z.string().min(1).max(255),
  subject: z.string().min(1).max(998),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  fromEmail: z.string().email().max(255).optional(),
  fromName: z.string().max(255).optional(),
  scheduledAt: z.string().optional(),
  status: z.string().max(30).optional(),
  templateId: z.string().nullish(),
  segmentIds: z.array(z.string()).optional(),
  winnerCriteria: z.string().max(50).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateMailCampaignSchema = createMailCampaignSchema.partial();

export type CreateMailCampaignInput = z.infer<typeof createMailCampaignSchema>;
export type UpdateMailCampaignInput = z.infer<typeof updateMailCampaignSchema>;
