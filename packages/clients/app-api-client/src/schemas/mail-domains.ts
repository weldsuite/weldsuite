/**
 * `/api/mail-domains` — backed by `mail_domains`.
 *
 * Includes Cloudflare Email Routing actions: `/:id/verify`,
 * `/:id/sync`, `/:id/generate-dkim`, plus `/by-name/:domainName` lookup.
 */

import { z } from 'zod';

export const createMailDomainSchema = z.object({
  domainName: z
    .string()
    .min(3)
    .max(255)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'Invalid domain name'),
  isActive: z.boolean().optional(),
  isPrimary: z.boolean().optional(),
  mailProvider: z.string().max(100).optional(),
  sendProvider: z.string().max(50).optional(),
  receiveProvider: z.string().max(50).optional(),
  maxEmailAccounts: z.number().int().min(1).max(10000).optional(),
});

export const updateMailDomainSchema = createMailDomainSchema.omit({ domainName: true }).partial();

export const listMailDomainsQuery = z.object({
  isActive: z.coerce.boolean().optional(),
  isPrimary: z.coerce.boolean().optional(),
});

export type CreateMailDomainInput = z.infer<typeof createMailDomainSchema>;
export type UpdateMailDomainInput = z.infer<typeof updateMailDomainSchema>;
export type ListMailDomainsQuery = z.infer<typeof listMailDomainsQuery>;
