import type { Domain } from '@weldsuite/core-api-client/schemas/domains';
import type { DnsZone } from '@weldsuite/core-api-client/schemas/dns-zones';
import type { HostDnsRecord } from '@/hooks/queries/use-host-queries';
import type { HostDomain } from '@/lib/api/domains/weldhost';

const now = '2026-01-15T12:00:00.000Z';

export const previewDomain: Domain = {
  id: 'dom_help_preview',
  name: 'acme',
  tld: 'com',
  fullDomain: 'acme.com',
  status: 'active',
  registrationStatus: 'registered',
  registrar: 'Cloudflare',
  externalRegistrarId: null,
  registrarStatus: null,
  registrarSyncedAt: null,
  workflowUrl: null,
  rtrRegistrantHandle: null,
  rtrProcessId: null,
  registeredAt: '2024-06-01T00:00:00.000Z',
  expiresAt: '2027-06-01T00:00:00.000Z',
  renewedAt: null,
  nameservers: ['ns1.weldhost.net', 'ns2.weldhost.net'],
  customNameservers: false,
  nameserverVerified: true,
  nameserverVerificationPending: false,
  autoRenew: true,
  privacyProtection: true,
  locked: false,
  sslEnabled: true,
  emailForwardingEnabled: true,
  authCode: null,
  authCodeExpiresAt: null,
  registrantContact: null,
  adminContact: null,
  techContact: null,
  billingContact: null,
  notes: null,
  metadata: null,
  createdAt: now,
  updatedAt: now,
};

export const previewDnsZone: DnsZone = {
  id: 'zone_help_preview',
  domainId: previewDomain.id,
  name: previewDomain.fullDomain,
  status: 'active',
  provider: 'cloudflare',
  externalZoneId: 'cf_zone_preview',
  externalNameservers: ['ns1.weldhost.net', 'ns2.weldhost.net'],
  syncedAt: now,
  syncError: null,
  dnssecEnabled: false,
  defaultTtl: 3600,
  recordCount: 11,
  metadata: null,
  createdAt: now,
  updatedAt: now,
};

const baseRecord = {
  zoneId: previewDnsZone.id,
  externalRecordId: null,
  weight: null,
  port: null,
  caaFlag: null,
  caaTag: null,
  status: 'active' as const,
  syncedAt: now,
  syncError: null,
  comment: null,
};

export const previewDnsRecords: HostDnsRecord[] = [
  {
    ...baseRecord,
    id: 'rec_a',
    type: 'A',
    name: '@',
    value: '203.0.113.10',
    ttl: 3600,
    priority: null,
    metadata: null,
  },
  {
    ...baseRecord,
    id: 'rec_cname',
    type: 'CNAME',
    name: 'www',
    value: 'acme.com',
    ttl: 3600,
    priority: null,
    metadata: null,
  },
  {
    ...baseRecord,
    id: 'rec_txt',
    type: 'TXT',
    name: '@',
    value: 'v=spf1 include:_spf.mx.cloudflare.net ~all',
    ttl: 3600,
    priority: null,
    metadata: {
      locks: [
        {
          source: 'weldmail',
          reason: 'SPF record managed by WeldMail',
          lockedAt: now,
        },
      ],
    },
  },
  {
    ...baseRecord,
    id: 'rec_mx',
    type: 'MX',
    name: '@',
    value: 'route1.mx.cloudflare.net',
    ttl: 3600,
    priority: 10,
    metadata: {
      locks: [
        {
          source: 'weldmail',
          reason: 'MX record managed by WeldMail',
          lockedAt: now,
        },
      ],
    },
  },
  {
    ...baseRecord,
    id: 'rec_mx2',
    type: 'MX',
    name: '@',
    value: 'route2.mx.cloudflare.net',
    ttl: 3600,
    priority: 20,
    metadata: {
      locks: [
        {
          source: 'weldmail',
          reason: 'MX record managed by WeldMail',
          lockedAt: now,
        },
      ],
    },
  },
  {
    ...baseRecord,
    id: 'rec_mx3',
    type: 'MX',
    name: '@',
    value: 'route3.mx.cloudflare.net',
    ttl: 3600,
    priority: 30,
    metadata: {
      locks: [
        {
          source: 'weldmail',
          reason: 'MX record managed by WeldMail',
          lockedAt: now,
        },
      ],
    },
  },
  {
    ...baseRecord,
    id: 'rec_txt_dmarc',
    type: 'TXT',
    name: '_dmarc',
    value: 'v=DMARC1; p=none; rua=mailto:dmarc@acme.com',
    ttl: 3600,
    priority: null,
    metadata: {
      locks: [
        {
          source: 'weldmail',
          reason: 'DMARC record managed by WeldMail',
          lockedAt: now,
        },
      ],
    },
  },
  {
    ...baseRecord,
    id: 'rec_txt_dkim',
    type: 'TXT',
    name: 'cf2024-1._domainkey',
    value: 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC...',
    ttl: 3600,
    priority: null,
    metadata: {
      locks: [
        {
          source: 'weldmail',
          reason: 'DKIM record managed by WeldMail',
          lockedAt: now,
        },
      ],
    },
  },
  {
    ...baseRecord,
    id: 'rec_txt_dkim2',
    type: 'TXT',
    name: 'cf2024-2._domainkey',
    value: 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQD...',
    ttl: 3600,
    priority: null,
    metadata: {
      locks: [
        {
          source: 'weldmail',
          reason: 'DKIM record managed by WeldMail',
          lockedAt: now,
        },
      ],
    },
  },
  {
    ...baseRecord,
    id: 'rec_txt_verify',
    type: 'TXT',
    name: '@',
    value: 'google-site-verification=abc123xyz',
    ttl: 3600,
    priority: null,
    metadata: null,
  },
  {
    ...baseRecord,
    id: 'rec_a_www',
    type: 'A',
    name: 'www',
    value: '203.0.113.10',
    ttl: 3600,
    priority: null,
    metadata: null,
  },
];

export const previewDomainsList: HostDomain[] = [
  {
    id: previewDomain.id,
    workspaceId: 'ws_help_preview',
    name: 'acme',
    tld: 'com',
    fullDomain: 'acme.com',
    status: 'active',
    registrar: 'Cloudflare',
    customNameservers: false,
    nameserverVerified: true,
    nameserverVerificationPending: false,
    autoRenew: true,
    privacyProtection: true,
    locked: false,
    sslEnabled: true,
    emailForwardingEnabled: true,
    expiresAt: '2027-06-01T00:00:00.000Z',
    registeredAt: '2024-06-01T00:00:00.000Z',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'dom_help_preview_2',
    workspaceId: 'ws_help_preview',
    name: 'acme-shop',
    tld: 'com',
    fullDomain: 'acme-shop.com',
    status: 'pending',
    registrar: 'Namecheap',
    customNameservers: false,
    nameserverVerified: false,
    nameserverVerificationPending: true,
    autoRenew: false,
    privacyProtection: false,
    locked: false,
    sslEnabled: false,
    emailForwardingEnabled: false,
    expiresAt: '2026-12-01T00:00:00.000Z',
    registeredAt: '2025-12-01T00:00:00.000Z',
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'dom_help_preview_3',
    workspaceId: 'ws_help_preview',
    name: 'acme',
    tld: 'io',
    fullDomain: 'acme.io',
    status: 'active',
    registrar: 'Cloudflare',
    customNameservers: false,
    nameserverVerified: true,
    nameserverVerificationPending: false,
    autoRenew: true,
    privacyProtection: true,
    locked: false,
    sslEnabled: true,
    emailForwardingEnabled: false,
    expiresAt: '2027-03-15T00:00:00.000Z',
    registeredAt: '2025-03-15T00:00:00.000Z',
    createdAt: now,
    updatedAt: now,
  },
];

export type HelpDocsPreviewScene =
  | 'domains'
  | 'dns-list'
  | 'dns-add'
  | 'dns-locked';

const APP_NAMES: Record<string, string> = {
  weldhost: 'WeldHost',
  welddesk: 'WeldDesk',
  weldcrm: 'WeldCRM',
  weldmail: 'WeldMail',
  weldflow: 'WeldFlow',
  weldchat: 'WeldChat',
  weldmeet: 'WeldMeet',
  weldcalendar: 'WeldCalendar',
  welddrive: 'WeldDrive',
};

/** Installed apps shown in the left rail for help-doc screenshots. */
export const previewInstalledApps = [
  'weldhost',
  'welddesk',
  'weldcrm',
  'weldmail',
  'weldflow',
  'weldchat',
  'weldmeet',
  'weldcalendar',
  'welddrive',
].map((code, index) => ({
  id: code,
  workspaceId: 'ws_help_preview',
  appCode: code,
  name: APP_NAMES[code] ?? code,
  status: 'active',
  installedAt: '2026-01-15T12:00:00.000Z',
  displayOrder: index,
  appType: 'system' as const,
}));
