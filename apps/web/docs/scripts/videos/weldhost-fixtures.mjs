/**
 * Shared WeldHost fixture builders for the support videos
 * (weldhost-manage-dns-records, weldhost-connect-external-domain).
 * Fictional domains only.
 */
export const NOW = '2026-01-15T12:00:00.000Z'
export const WORKSPACE_ID = 'ws_video_preview'

export const NAMESERVERS = ['ada.ns.cloudflare.com', 'ken.ns.cloudflare.com']

/** Full `Domain` (detail endpoint; the list endpoint accepts the same shape). */
export function domain(id, name, tld, overrides = {}) {
  return {
    id,
    name,
    tld,
    fullDomain: `${name}.${tld}`,
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
    nameservers: NAMESERVERS,
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
    workspaceId: WORKSPACE_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

export function zoneFor(dom, overrides = {}) {
  return {
    id: `zone_${dom.id}`,
    domainId: dom.id,
    name: dom.fullDomain,
    status: 'active',
    provider: 'cloudflare',
    externalZoneId: `cf_${dom.id}`,
    externalNameservers: NAMESERVERS,
    syncedAt: NOW,
    syncError: null,
    dnssecEnabled: false,
    defaultTtl: 3600,
    recordCount: 0,
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

export function dnsRecord(zoneId, id, type, name, value, { ttl = 3600, priority = null, lock = null } = {}) {
  return {
    id,
    zoneId,
    externalRecordId: null,
    type,
    name,
    value,
    ttl,
    priority,
    weight: null,
    port: null,
    caaFlag: null,
    caaTag: null,
    status: 'active',
    syncedAt: NOW,
    syncError: null,
    comment: null,
    metadata: lock ? { locks: [{ source: 'weldmail', reason: lock, lockedAt: NOW }] } : null,
  }
}
