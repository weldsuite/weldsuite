import { z } from 'zod';

// ============================================================================
// WeldHost (host-api) response shapes, matching the interfaces of
// `@weldsuite/core-api-client/schemas/{domains,dns-zones,dns-records,
// domain-transfers,email-forwards}`. The conformance suite validates both
// backends' answers against them. Zod v3.
// ============================================================================

const timestamp = z.string();
const record = z.record(z.unknown());

export const hostDnsZoneSchema = z.object({
  id: z.string(),
  domainId: z.string(),
  name: z.string(),
  status: z.enum(['active', 'pending', 'disabled', 'error']),
  provider: z.enum(['hetzner', 'cloudflare', 'route53', 'custom']),
  externalZoneId: z.string().nullable(),
  externalNameservers: z.array(z.string()).nullable(),
  syncedAt: timestamp.nullable(),
  syncError: z.string().nullable(),
  dnssecEnabled: z.boolean().nullable(),
  defaultTtl: z.number().nullable(),
  recordCount: z.number().nullable(),
  metadata: record.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const hostDomainSchema = z.object({
  id: z.string(),
  name: z.string(),
  tld: z.string(),
  fullDomain: z.string(),
  status: z.enum(['active', 'pending', 'expired', 'suspended', 'cancelled']),
  registrationStatus: z.string().nullable(),
  registrar: z.string().nullable(),
  externalRegistrarId: z.string().nullable(),
  registrarStatus: z.string().nullable(),
  registrarSyncedAt: timestamp.nullable(),
  workflowUrl: z.string().nullable(),
  rtrRegistrantHandle: z.string().nullable(),
  rtrProcessId: z.string().nullable(),
  registeredAt: timestamp.nullable(),
  expiresAt: timestamp.nullable(),
  renewedAt: timestamp.nullable(),
  nameservers: z.array(z.string()).nullable(),
  customNameservers: z.boolean().nullable(),
  nameserverVerified: z.boolean().nullable(),
  nameserverVerificationPending: z.boolean().nullable(),
  autoRenew: z.boolean().nullable(),
  privacyProtection: z.boolean().nullable(),
  locked: z.boolean().nullable(),
  sslEnabled: z.boolean().nullable(),
  emailForwardingEnabled: z.boolean().nullable(),
  authCode: z.string().nullable(),
  authCodeExpiresAt: timestamp.nullable(),
  registrantContact: record.nullable(),
  adminContact: record.nullable(),
  techContact: record.nullable(),
  billingContact: record.nullable(),
  notes: z.string().nullable(),
  metadata: record.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  /** On the detail. A deleted zone can still be joined, so it is the row as it is. */
  dnsZone: hostDnsZoneSchema.nullable().optional(),
  usedByWeldReach: z.boolean().optional(),
});

export const hostDomainSearchResultSchema = z.object({
  domain_name: z.string(),
  suffix: z.string(),
  status: z.union([z.literal(1), z.literal(2)]),
  premium: z.boolean(),
  price: z.number().nullable(),
  currency: z.string().nullable(),
  domain: z.string(),
  available: z.boolean(),
  reason: z.string().optional(),
});

export const hostCheckoutResponseSchema = z.object({
  checkoutSessionId: z.string().nullable(),
  checkoutUrl: z.string().nullable(),
  registrationIds: z.array(z.string()),
});

export const hostAbandonedSchema = z.object({ abandoned: z.number() });

export const hostDashboardStatsSchema = z.object({
  totalDomains: z.number(),
  activeDomains: z.number(),
  pendingDomains: z.number(),
  expiredDomains: z.number(),
  expiringSoon: z.number(),
  sslEnabled: z.number(),
  autoRenewEnabled: z.number(),
});

export const hostChartPointSchema = z.object({
  date: z.string(),
  registrations: z.number(),
  renewals: z.number(),
  expirations: z.number(),
});

export const hostDomainListResponseSchema = z.object({
  domains: z.array(hostDomainSchema),
  pagination: z.object({
    page: z.number(),
    pageSize: z.number(),
    total: z.number(),
    totalPages: z.number(),
  }),
  stats: z.object({
    total: z.number(),
    active: z.number(),
    pending: z.number(),
    expired: z.number(),
  }),
});

export const hostExternalDomainSchema = hostDomainSchema.extend({
  verificationRecord: z.object({ name: z.string(), type: z.literal('TXT'), value: z.string() }),
});

/** `POST /:id/sync`: the synced domain, or `{ id, syncedAt }` without a registrar client. */
export const hostDomainSyncSchema = z.union([
  hostDomainSchema,
  z.object({ id: z.string(), syncedAt: timestamp }),
]);

export const hostVerifyNameserversSchema = z.object({
  success: z.boolean(),
  verified: z.boolean(),
  requiredNameservers: z.array(z.string()),
  currentNameservers: z.array(z.string()),
  message: z.string(),
});

export const hostVerifyOwnershipSchema = hostDomainSchema.extend({
  nameservers: z.array(z.string()),
  dnsZone: hostDnsZoneSchema.nullable(),
});

export const hostRefreshZoneStatusSchema = z.object({
  zoneStatus: z.string(),
  domainStatus: z.string(),
  cloudflareStatus: z.string().nullable(),
  nameservers: z.array(z.string()).optional(),
});

export const hostAuthCodeSchema = z.object({
  success: z.boolean(),
  authCode: z.string(),
  expiresAt: timestamp,
});

export const hostRegistrationStatusSchema = z.object({
  registrationId: z.string(),
  domainId: z.string().nullable(),
  domainName: z.string(),
  status: z.enum(['pending', 'payment_complete', 'registering', 'completed', 'failed']),
  totalPrice: z.number().nullable(),
  failureReason: z.string().nullable(),
});

export const hostRegistrationCompletedSchema = z.object({
  success: z.boolean(),
  domainId: z.string(),
  domain: hostDomainSchema,
});

export const hostDnsRecordSchema = z.object({
  id: z.string(),
  zoneId: z.string(),
  externalRecordId: z.string().nullable(),
  type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'PTR', 'SOA']),
  name: z.string(),
  value: z.string(),
  ttl: z.number(),
  priority: z.number().nullable(),
  weight: z.number().nullable(),
  port: z.number().nullable(),
  caaFlag: z.number().nullable(),
  caaTag: z.string().nullable(),
  status: z.enum(['active', 'pending', 'error', 'disabled']),
  syncedAt: timestamp.nullable(),
  syncError: z.string().nullable(),
  comment: z.string().nullable(),
  metadata: record.nullable(),
  managedBy: z.enum(['weldreach']).nullable().optional(),
});

export const hostDnsRecordsListSchema = z.object({
  records: z.array(hostDnsRecordSchema),
  zone: z
    .object({ id: z.string(), syncedAt: timestamp.nullable(), syncError: z.string().nullable() })
    .nullable(),
});

export const hostDnsRecordsMutationSchema = z.object({ records: z.array(hostDnsRecordSchema) });

export const hostDnsRecordsSyncSchema = z.object({
  records: z.array(hostDnsRecordSchema),
  added: z.number(),
  updated: z.number(),
  removed: z.number(),
});

export const hostScannedDnsRecordSchema = z.object({
  name: z.string(),
  type: z.string(),
  value: z.string(),
  ttl: z.number().optional(),
  priority: z.number().optional(),
});

export const hostDnsScanSchema = z.object({ records: z.array(hostScannedDnsRecordSchema) });

export const hostDnsImportSchema = z.object({
  imported: z.number(),
  skipped: z.number(),
  failed: z.array(z.object({ record: hostScannedDnsRecordSchema, error: z.string() })),
});

export const hostDomainTransferSchema = z.object({
  id: z.string(),
  domainId: z.string().nullable(),
  domainName: z.string(),
  type: z.enum(['incoming', 'outgoing']),
  status: z.enum([
    'pending',
    'pending_approval',
    'approved',
    'rejected',
    'cancelled',
    'in_progress',
    'completed',
    'failed',
  ]),
  authCode: z.string().nullable(),
  fromRegistrar: z.string().nullable(),
  toRegistrar: z.string().nullable(),
  externalTransferId: z.string().nullable(),
  requestedAt: timestamp,
  approvedAt: timestamp.nullable(),
  rejectedAt: timestamp.nullable(),
  cancelledAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  expiresAt: timestamp.nullable(),
  rejectionReason: z.string().nullable(),
  cancellationReason: z.string().nullable(),
  failureReason: z.string().nullable(),
  notificationsSent: z.array(z.string()).nullable(),
  metadata: record.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const hostEmailForwardSchema = z.object({
  id: z.string(),
  domainId: z.string(),
  source: z.string(),
  destination: z.string(),
  additionalDestinations: z.array(z.string()).nullable(),
  enabled: z.boolean(),
  catchAll: z.boolean().nullable(),
  wildcard: z.boolean().nullable(),
  status: z.enum(['active', 'pending', 'disabled', 'error']),
  lastForwardedAt: timestamp.nullable(),
  forwardCount: z.number().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: timestamp.nullable(),
  errorCount: z.number().nullable(),
  metadata: record.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const hostWebhookHealthSchema = z.object({ ok: z.boolean(), service: z.string() });

/** The Realtime Register webhook's acknowledgements. */
export const hostWebhookAckSchema = z.object({
  received: z.boolean(),
  processId: z.number().optional(),
  mapped: z.boolean().optional(),
});
