import { z } from 'zod';

// `/api/mail-domains` — backed by `mail_domains`.

export const createMailDomainSchema = z.object({
  domainName: z.string().min(1).max(255),
  dnsStatus: z.string().max(30).optional(),
  isVerified: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateMailDomainSchema = createMailDomainSchema.partial();

export type CreateMailDomainInput = z.infer<typeof createMailDomainSchema>;
export type UpdateMailDomainInput = z.infer<typeof updateMailDomainSchema>;
