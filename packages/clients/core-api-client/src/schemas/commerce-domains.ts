import { z } from 'zod';

export const createCommerceDomainSchema = z.object({
  domain: z.string().min(1).max(255),
  websiteId: z.string().nullish(),
  domainType: z.enum(['custom', 'subdomain']).optional(),
  isPrimary: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateCommerceDomainSchema = createCommerceDomainSchema.partial();
export type CreateCommerceDomainInput = z.infer<typeof createCommerceDomainSchema>;
export type UpdateCommerceDomainInput = z.infer<typeof updateCommerceDomainSchema>;
