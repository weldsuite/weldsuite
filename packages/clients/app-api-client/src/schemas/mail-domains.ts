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

export const updateMailDomainSchema = createMailDomainSchema
  .omit({ domainName: true })
  .extend({
    catchAllEnabled: z.boolean().optional(),
    catchAllAccountId: z.string().min(1).max(30).nullable().optional(),
  })
  .partial();

export const listMailDomainsQuery = z.object({
  isActive: z.coerce.boolean().optional(),
  isPrimary: z.coerce.boolean().optional(),
});

export type CreateMailDomainInput = z.infer<typeof createMailDomainSchema>;
export type UpdateMailDomainInput = z.infer<typeof updateMailDomainSchema>;
export type ListMailDomainsQuery = z.infer<typeof listMailDomainsQuery>;

// DMARC (ADR MAIL-015)

export const dmarcPolicySchema = z.object({
  p: z.string(),
  sp: z.string().nullable(),
  np: z.string().nullable(),
  pct: z.number().nullable(),
  testing: z.boolean(),
  adkim: z.enum(['r', 's']),
  aspf: z.enum(['r', 's']),
  rua: z.array(z.string()),
  ruf: z.array(z.string()),
});

export const dmarcRecordStateSchema = z.enum(['missing', 'multiple', 'invalid', 'ok']);

/** What the DMARC DNS entry of a mail domain carries on top of the plain record. */
export const dmarcRecordCheckSchema = z.object({
  state: dmarcRecordStateSchema,
  found: z.array(z.string()),
  policy: dmarcPolicySchema.nullable(),
  reportsToWeldSuite: z.boolean(),
});

/** One entry of `mail_domains.dns_records`; `dmarc` is optional so older rows still parse. */
export const mailDnsRecordSchema = z.object({
  type: z.string(),
  name: z.string(),
  value: z.string(),
  priority: z.number().optional(),
  ttl: z.number().optional(),
  verified: z.boolean().optional(),
  purpose: z.enum(['spf', 'dkim', 'dmarc', 'mx', 'verification', 'other']).optional(),
  dmarc: dmarcRecordCheckSchema.optional(),
});

export const dmarcPeriodDaysSchema = z.union([z.literal(7), z.literal(30), z.literal(90)]);

export const markDmarcSourceSchema = z.object({
  key: z.string().min(1),
  mark: z.enum(['mine', 'not_mine']).nullable(),
});

export type DmarcPolicy = z.infer<typeof dmarcPolicySchema>;
export type DmarcRecordCheck = z.infer<typeof dmarcRecordCheckSchema>;
export type DmarcPeriodDays = z.infer<typeof dmarcPeriodDaysSchema>;
export type MarkDmarcSourceInput = z.infer<typeof markDmarcSourceSchema>;
