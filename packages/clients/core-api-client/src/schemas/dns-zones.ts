/**
 * DNS zone schemas (Zod v3).
 *
 * Powers the `/api/dns-zones/*` surface on `app-api`. Successor to the
 * thin host-dns-records.ts file from the api-worker era.
 */

import { z } from 'zod';

export const dnsZoneStatusEnum = z.enum(['active', 'pending', 'disabled', 'error']);
export const dnsProviderEnum = z.enum(['hetzner', 'cloudflare', 'route53', 'custom']);

export const listDnsZonesQuery = z.object({
  domainId: z.string().optional(),
  status: dnsZoneStatusEnum.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const createDnsZoneSchema = z.object({
  domainId: z.string().min(1),
  name: z.string().min(1).max(255),
  status: dnsZoneStatusEnum.optional().default('pending'),
  provider: dnsProviderEnum.optional().default('hetzner'),
  externalZoneId: z.string().max(255).nullish(),
  externalNameservers: z.array(z.string()).optional(),
  defaultTtl: z.number().int().min(60).max(86400).optional().default(3600),
});

export const updateDnsZoneSchema = createDnsZoneSchema
  .omit({ domainId: true })
  .partial()
  .extend({ syncedAt: z.string().datetime().optional() });

export type ListDnsZonesQuery = z.input<typeof listDnsZonesQuery>;
export type CreateDnsZoneInput = z.infer<typeof createDnsZoneSchema>;
export type UpdateDnsZoneInput = z.infer<typeof updateDnsZoneSchema>;

export interface DnsZone {
  id: string;
  domainId: string;
  name: string;
  status: 'active' | 'pending' | 'disabled' | 'error';
  provider: 'hetzner' | 'cloudflare' | 'route53' | 'custom';
  externalZoneId: string | null;
  externalNameservers: string[] | null;
  syncedAt: string | null;
  syncError: string | null;
  dnssecEnabled: boolean | null;
  defaultTtl: number | null;
  recordCount: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}
