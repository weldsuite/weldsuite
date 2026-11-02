import { z } from 'zod';

/**
 * Response shapes of /api/helpdesk-email (desk-api): the addresses connected
 * to the helpdesk, from the master mail registry and from WeldMail accounts.
 */

/** GET /addresses: one connected address, from either source. */
export const helpdeskEmailAddressSchema = z.object({
  id: z.string(),
  email: z.string(),
  accountId: z.string(),
  isActive: z.boolean(),
  createdAt: z.string().nullable(),
  source: z.enum(['registry', 'mail_account']),
});

/** GET /mail-accounts: an active WeldMail account, and whether the helpdesk uses it. */
export const helpdeskEmailMailAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  provider: z.string(),
  status: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  isLinkedToHelpdesk: z.boolean(),
});

/** GET /domains: a verified, active mail domain. */
export const helpdeskEmailDomainSchema = z.object({
  id: z.string(),
  domainName: z.string(),
  dnsStatus: z.string().nullable(),
  isActive: z.boolean(),
});

/** POST /addresses: the connected address (`source` only when it is a WeldMail account). */
export const helpdeskEmailConnectedSchema = z.object({
  id: z.string(),
  email: z.string(),
  accountId: z.string(),
  isActive: z.literal(true),
  source: z.literal('mail_account').optional(),
});

/** DELETE /addresses/:id. */
export const helpdeskEmailDisconnectedSchema = z.object({
  id: z.string(),
  isActive: z.literal(false),
});
