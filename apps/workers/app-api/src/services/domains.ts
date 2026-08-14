/**
 * Domains service — pure functions used by `/api/domains/*` routes.
 *
 * Replaces the per-route logic that lived in `apps/api-worker/src/routes/host`
 * and `apps/core-api/src/routes/weldhost/domains.ts`. All functions accept
 * `db: Database` (tenant) as their first argument; cross-tenant lookups
 * (pricing, workspace Stripe customer) accept `masterDb` explicitly.
 */

import { and, asc, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { schema, masterSchema, type Database, type MasterDatabase } from '../db';
import { generateId } from '../lib/id';
import type { CloudflareRegistrar } from '@weldsuite/cloudflare-registrar';
import {
  RealtimeRegistrar,
  resolvePlatformRegistrarContacts,
  type DomainCheckResult,
  type DomainContactInput,
} from '@weldsuite/realtime-registrar';
import {
  createCloudflareZone,
  deleteCloudflareZone,
  getCloudflareZone,
} from '@weldsuite/cloudflare-zones';
import { lookupTxt } from '../lib/dns-lookup';
import {
  createDomainCheckoutSession,
  createStripeCustomer,
  expireCheckoutSession,
  isDefiniteStripeFailure,
} from '../lib/stripe';
import {
  isExternalDomainRegistrar,
  isHiddenUnpaidDomain,
  MAX_CHECKOUT_DOMAINS,
  toPublicDomain,
} from '@weldsuite/core-api-client/schemas/domains';

export { toPublicDomain, isHiddenUnpaidDomain };

const { hostDomains, hostDnsZones } = schema;

export const DEFAULT_REGISTRAR = 'realtimeregister' as const;
/** Known registrars keep autocomplete; arbitrary strings remain accepted. */
export type DomainRegistrar = 'realtimeregister' | 'cloudflare' | (string & {});

/**
 * Unpaid checkout rows (and the legacy cancelled/failed leftovers) stay out of
 * My Domains, dashboard counts, and search. `IS DISTINCT FROM` keeps NULL
 * `registration_status` (external domains) visible; `IS NOT DISTINCT FROM`
 * hides cancelled+failed without also dropping cancelled rows whose status
 * is NULL (`NULL = 'failed'` is unknown, so a plain `=` predicate would
 * filter them out).
 */
function isListedDomainSql() {
  return sql`(
    ${hostDomains.registrationStatus} IS DISTINCT FROM 'pending_payment'
    AND NOT (
      ${hostDomains.status} = 'cancelled'
      AND ${hostDomains.registrationStatus} IS NOT DISTINCT FROM 'failed'
    )
  )`;
}

// ============================================================================
// Shared output type — mirrors the legacy `TransformedDomainResult` shape
// ============================================================================

export interface TransformedDomainResult {
  domain_name: string;
  suffix: string;
  status: 1 | 2;
  premium: boolean;
  /** Customer-facing price in cents. */
  price: number | null;
  currency: string | null;
  domain: string;
  available: boolean;
  /**
   * Why a domain is not available. Only `domain_unavailable` (and similar
   * "taken" reasons) should render as already registered.
   */
  reason?: string;
}

// ============================================================================
// Pricing helpers
// ============================================================================

async function loadPricingMap(
  masterDb: MasterDatabase,
): Promise<Map<string, typeof masterSchema.hostDomainPricing.$inferSelect>> {
  const rows = await masterDb
    .select()
    .from(masterSchema.hostDomainPricing)
    .where(eq(masterSchema.hostDomainPricing.isActive, true));
  return new Map(rows.map((r) => [r.tld.replace(/^\./, '').toLowerCase(), r]));
}

function tldOf(name: string): string {
  return name.split('.').slice(1).join('.').replace(/^\./, '').toLowerCase();
}

/**
 * Realtime Register is a wholesale registrar — markup from `domain_pricing`
 * is enabled. Wholesale cents come from the RTR check response (premium) or
 * the pricing row's registrationPrice (standard TLDs).
 */
const ALLOW_REGISTRAR_MARKUP = true;

/**
 * Apply markup to a wholesale price already expressed in **cents**.
 * Falls back to `pricing.registrationPrice` (major units) when wholesale
 * cents are missing or when wholesale currency disagrees with the pricing row.
 * Returns null when neither source has a usable price.
 */
export function applyMarkup(
  wholesaleCents: number | undefined | null,
  pricing: typeof masterSchema.hostDomainPricing.$inferSelect | undefined,
  wholesaleCurrency?: string | null,
): number | null {
  const pricingCurrency = pricing?.currency?.toLowerCase() ?? null;
  const wholesaleCur = wholesaleCurrency?.toLowerCase() ?? null;
  const currencyMismatch =
    !!pricingCurrency && !!wholesaleCur && pricingCurrency !== wholesaleCur;

  let cents: number | null =
    !currencyMismatch &&
    wholesaleCents !== undefined &&
    wholesaleCents !== null &&
    Number.isFinite(wholesaleCents)
      ? Math.round(wholesaleCents)
      : null;

  if (cents === null && pricing?.registrationPrice != null) {
    const major = Number.parseFloat(String(pricing.registrationPrice));
    if (Number.isFinite(major)) cents = Math.round(major * 100);
  }
  if (cents === null) return null;

  if (!ALLOW_REGISTRAR_MARKUP || !pricing) return cents;
  if (pricing.markupAmount !== null && pricing.markupAmount !== undefined) {
    return cents + pricing.markupAmount;
  }
  if (pricing.markupPercent !== null && pricing.markupPercent !== undefined) {
    const pct = parseFloat(String(pricing.markupPercent));
    return Math.round(cents * (1 + pct / 100));
  }
  return cents;
}

// ============================================================================
// Search / availability (Realtime Register)
// ============================================================================

function transformResult(
  r: DomainCheckResult,
  pricingMap: Map<string, typeof masterSchema.hostDomainPricing.$inferSelect>,
): TransformedDomainResult {
  const tld = tldOf(r.name);
  const pricing = pricingMap.get(tld);
  const available = r.available && r.reason !== 'check_failed';
  return {
    domain_name: r.name,
    suffix: tld,
    status: available ? 1 : 2,
    premium: r.premium,
    price: applyMarkup(r.priceCents, pricing, r.currency),
    currency: pricing?.currency ?? r.currency ?? 'USD',
    domain: r.name,
    available,
    reason: r.reason,
  };
}

export async function searchDomains(
  rtr: RealtimeRegistrar,
  masterDb: MasterDatabase,
  params: { query: string; limit?: number },
): Promise<TransformedDomainResult[]> {
  const limit = Math.min(params.limit ?? 20, 50);
  const [results, pricingMap] = await Promise.all([
    // ADAC expands the exact SLD across its TLD set in one POST; don't pre-fan-out.
    rtr.searchDomains(params.query, [], 50),
    loadPricingMap(masterDb),
  ]);
  const priced = pricingMap.size
    ? results.filter((r) => pricingMap.has(tldOf(r.name)))
    : results;
  return (priced.length ? priced : results)
    .slice(0, limit)
    .map((r) => transformResult(r, pricingMap));
}

export async function checkDomains(
  rtr: RealtimeRegistrar,
  masterDb: MasterDatabase,
  params: { domains: string[] },
): Promise<TransformedDomainResult[]> {
  const [results, pricingMap] = await Promise.all([
    rtr.checkDomains(params.domains),
    loadPricingMap(masterDb),
  ]);
  return results.map((r) => transformResult(r, pricingMap));
}

/** WeldSuite-owned RTR handles used as admin/tech/billing. Registrant is always the admin handle. */
export function roleContactsFromEnv(env: {
  REALTIME_REGISTER_CONTACT_ADMIN?: string;
  REALTIME_REGISTER_CONTACT_TECH?: string;
  REALTIME_REGISTER_CONTACT_BILLING?: string;
}): Array<{ role: 'ADMIN' | 'BILLING' | 'TECH'; handle: string }> {
  return resolvePlatformRegistrarContacts({
    admin: env.REALTIME_REGISTER_CONTACT_ADMIN,
    tech: env.REALTIME_REGISTER_CONTACT_TECH,
    billing: env.REALTIME_REGISTER_CONTACT_BILLING,
  }).contacts;
}

// ============================================================================
// List / get / CRUD
// ============================================================================

export interface ListDomainsParams {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: 'all' | 'active' | 'pending' | 'expired' | 'suspended' | 'cancelled';
  sortBy?: 'fullDomain' | 'status' | 'expiresAt' | 'createdAt';
  sortOrder?: 'asc' | 'desc';
}

export async function listDomains(db: Database, params: ListDomainsParams) {
  const page = params.page ?? 1;
  const pageSize = Math.min(params.pageSize ?? 20, 100);

  const conditions = [isNull(hostDomains.deletedAt), isListedDomainSql()];
  if (params.search) {
    const term = `%${params.search}%`;
    conditions.push(or(like(hostDomains.fullDomain, term), like(hostDomains.name, term))!);
  }
  if (params.status && params.status !== 'all') {
    conditions.push(eq(hostDomains.status, params.status));
  }

  const sortColumn =
    params.sortBy === 'fullDomain' ? hostDomains.fullDomain :
    params.sortBy === 'status' ? hostDomains.status :
    params.sortBy === 'expiresAt' ? hostDomains.expiresAt :
    hostDomains.createdAt;
  const orderBy = params.sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(hostDomains)
    .where(and(...conditions));

  const offset = (page - 1) * pageSize;
  const domains = await db
    .select()
    .from(hostDomains)
    .where(and(...conditions))
    .orderBy(orderBy)
    .limit(pageSize)
    .offset(offset);

  const [stats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${hostDomains.status} = 'active')::int`,
      pending: sql<number>`count(*) filter (where ${hostDomains.status} = 'pending')::int`,
      expired: sql<number>`count(*) filter (where ${hostDomains.status} = 'expired')::int`,
    })
    .from(hostDomains)
    .where(and(isNull(hostDomains.deletedAt), isListedDomainSql()));

  return {
    domains: domains.map(toPublicDomain),
    pagination: {
      page,
      pageSize,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / pageSize)),
    },
    stats: stats ?? { total: 0, active: 0, pending: 0, expired: 0 },
  };
}

export async function getDomainWithZone(db: Database, id: string) {
  const [row] = await db
    .select({ domain: hostDomains, zone: hostDnsZones })
    .from(hostDomains)
    .leftJoin(hostDnsZones, eq(hostDnsZones.domainId, hostDomains.id))
    .where(and(eq(hostDomains.id, id), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (!row) return null;
  return { domain: row.domain, zone: row.zone };
}

export async function getDomain(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(hostDomains)
    .where(and(eq(hostDomains.id, id), isNull(hostDomains.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function createDomain(
  db: Database,
  data: {
    name: string;
    tld: string;
    fullDomain: string;
    status?: 'active' | 'pending' | 'expired' | 'suspended' | 'cancelled';
    registrar?: string;
    nameservers?: string[];
    customNameservers?: boolean;
    autoRenew?: boolean;
    privacyProtection?: boolean;
    locked?: boolean;
    notes?: string;
  },
) {
  const id = generateId('dom');
  await db.insert(hostDomains).values({
    id,
    name: data.name,
    tld: data.tld,
    fullDomain: data.fullDomain,
    status: data.status ?? 'pending',
    registrar: data.registrar,
    nameservers: data.nameservers,
    customNameservers: data.customNameservers,
    autoRenew: data.autoRenew,
    privacyProtection: data.privacyProtection,
    locked: data.locked,
    notes: data.notes,
  });
  const [row] = await db.select().from(hostDomains).where(eq(hostDomains.id, id)).limit(1);
  return row!;
}

export async function updateDomain(
  db: Database,
  id: string,
  data: Record<string, unknown>,
) {
  const [existing] = await db
    .select()
    .from(hostDomains)
    .where(and(eq(hostDomains.id, id), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (!existing) return null;

  const update: Record<string, unknown> = { updatedAt: new Date() };
  const dateFields = new Set([
    'registrarSyncedAt',
    'registeredAt',
    'expiresAt',
    'renewedAt',
    'authCodeExpiresAt',
  ]);
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    update[k] = dateFields.has(k) && typeof v === 'string' ? new Date(v) : v;
  }

  await db.update(hostDomains).set(update).where(eq(hostDomains.id, id));
  const [row] = await db.select().from(hostDomains).where(eq(hostDomains.id, id)).limit(1);
  return { row: row!, previous: existing };
}

export async function deleteDomain(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(hostDomains)
    .where(and(eq(hostDomains.id, id), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (!existing) return null;
  await db
    .update(hostDomains)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(hostDomains.id, id));
  return existing;
}

/**
 * Soft-delete unpaid checkout rows so the name can be registered again and
 * so they never appear on My Domains. Optionally expire the matching Stripe
 * sessions so a later payment cannot land on a deleted row.
 */
export async function abandonUnpaidDomains(
  db: Database,
  params: {
    ids?: string[];
    fullDomain?: string;
    stripeSecretKey?: string;
  },
): Promise<{ id: string; stripeSessionId: string | null; fullDomain: string; status: string }[]> {
  if (!params.ids?.length && !params.fullDomain) return [];

  const unpaid = or(
    eq(hostDomains.registrationStatus, 'pending_payment'),
    and(
      eq(hostDomains.status, 'cancelled'),
      eq(hostDomains.registrationStatus, 'failed'),
    ),
  )!;

  const conditions = [isNull(hostDomains.deletedAt), unpaid];
  if (params.ids?.length) conditions.push(inArray(hostDomains.id, params.ids));
  if (params.fullDomain) conditions.push(eq(hostDomains.fullDomain, params.fullDomain));

  const rows = await db
    .select({
      id: hostDomains.id,
      stripeSessionId: hostDomains.stripeSessionId,
      fullDomain: hostDomains.fullDomain,
      status: hostDomains.status,
    })
    .from(hostDomains)
    .where(and(...conditions));

  if (rows.length === 0) return [];

  const now = new Date();
  await db
    .update(hostDomains)
    .set({ deletedAt: now, updatedAt: now })
    .where(inArray(hostDomains.id, rows.map((r) => r.id)));

  if (params.stripeSecretKey) {
    await Promise.all(
      rows.map(async (row) => {
        if (!row.stripeSessionId) return;
        try {
          await expireCheckoutSession(params.stripeSecretKey!, row.stripeSessionId);
        } catch {
          // Already expired, paid, or never created — the row is gone either way.
        }
      }),
    );
  }

  return rows;
}

// ============================================================================
// External domains — TXT verification challenge → CF zone on success
// ============================================================================

export interface ExternalDomainResult {
  domain: typeof schema.hostDomains.$inferSelect;
  verificationRecord: { name: string; type: 'TXT'; value: string };
}

export async function addExternalDomain(
  db: Database,
  input: { domain: string; registrar?: string },
): Promise<{ ok: true; result: ExternalDomainResult } | { ok: false; reason: 'conflict' }> {
  const domainName = input.domain;
  const [existing] = await db
    .select({ id: hostDomains.id, status: hostDomains.status })
    .from(hostDomains)
    .where(and(eq(hostDomains.fullDomain, domainName), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (existing && existing.status !== 'cancelled') {
    return { ok: false, reason: 'conflict' };
  }

  const parts = domainName.split('.');
  const name = parts[0] || domainName;
  const tld = parts.slice(1).join('.') || 'com';
  const id = generateId('dom');
  const token = crypto.randomUUID().replace(/-/g, '');
  const verificationValue = `weldhost-verify=${token}`;
  const verificationName = `_weldhost-verify.${domainName}`;

  await db.insert(hostDomains).values({
    id,
    name,
    tld,
    fullDomain: domainName,
    status: 'pending',
    registrar: input.registrar || 'External',
    customNameservers: false,
    nameserverVerified: false,
    nameserverVerificationPending: true,
    nameserverVerificationToken: token,
  });

  const [domain] = await db
    .select()
    .from(hostDomains)
    .where(eq(hostDomains.id, id))
    .limit(1);

  return {
    ok: true,
    result: {
      domain: domain!,
      verificationRecord: { name: verificationName, type: 'TXT', value: verificationValue },
    },
  };
}

export type VerifyOwnershipResult =
  | { ok: true; idempotent: true; domain: typeof schema.hostDomains.$inferSelect; zone: typeof schema.hostDnsZones.$inferSelect; nameservers: string[] }
  | { ok: true; idempotent: false; domain: typeof schema.hostDomains.$inferSelect; zone: typeof schema.hostDnsZones.$inferSelect; nameservers: string[] }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'missing_token' }
  | { ok: false; reason: 'dns_failed' }
  | {
      ok: false;
      reason: 'txt_not_found';
      details: { expected: { name: string; type: 'TXT'; value: string }; found: string[] };
    }
  | { ok: false; reason: 'cf_misconfigured' }
  | { ok: false; reason: 'cf_domain_taken' }
  | { ok: false; reason: 'cf_auth_failed' }
  | { ok: false; reason: 'cf_invalid_domain'; message: string }
  | { ok: false; reason: 'cf_unknown' }
  | { ok: false; reason: 'persist_failed' };

export async function verifyOwnershipAndCreateZone(
  db: Database,
  params: { domainId: string; apiToken: string | undefined; accountId: string | undefined },
): Promise<VerifyOwnershipResult> {
  const { domainId, apiToken, accountId } = params;

  const [domain] = await db
    .select()
    .from(hostDomains)
    .where(and(eq(hostDomains.id, domainId), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (!domain) return { ok: false, reason: 'not_found' };

  const [existingZone] = await db
    .select()
    .from(hostDnsZones)
    .where(and(eq(hostDnsZones.domainId, domainId), isNull(hostDnsZones.deletedAt)))
    .limit(1);
  if (existingZone && existingZone.provider === 'cloudflare') {
    return {
      ok: true,
      idempotent: true,
      domain,
      zone: existingZone,
      nameservers: (existingZone.externalNameservers as string[]) ?? domain.nameservers ?? [],
    };
  }

  if (!domain.nameserverVerificationToken) return { ok: false, reason: 'missing_token' };

  const expected = `weldhost-verify=${domain.nameserverVerificationToken}`;
  const recordName = `_weldhost-verify.${domain.fullDomain}`;

  let records: string[];
  try {
    records = await lookupTxt(recordName);
  } catch (err) {
    console.error('[domains.service] DNS lookup failed:', err);
    return { ok: false, reason: 'dns_failed' };
  }

  if (!records.includes(expected)) {
    return {
      ok: false,
      reason: 'txt_not_found',
      details: { expected: { name: recordName, type: 'TXT', value: expected }, found: records },
    };
  }

  if (!apiToken || !accountId) return { ok: false, reason: 'cf_misconfigured' };

  // Lazy import to avoid pulling the CloudflareZoneError type into the union type.
  const { CloudflareZoneError } = await import('@weldsuite/cloudflare-zones');

  let zone: { zoneId: string; nameservers: string[]; status: string };
  try {
    zone = await createCloudflareZone(apiToken, accountId, domain.fullDomain);
  } catch (err) {
    if (err instanceof CloudflareZoneError) {
      if (err.kind === 'DOMAIN_IN_ANOTHER_CF_ACCOUNT') return { ok: false, reason: 'cf_domain_taken' };
      if (err.kind === 'AUTH_FAILED') return { ok: false, reason: 'cf_auth_failed' };
      if (err.kind === 'INVALID_DOMAIN') return { ok: false, reason: 'cf_invalid_domain', message: err.message };
    }
    console.error('[domains.service] Cloudflare zone creation failed:', err);
    return { ok: false, reason: 'cf_unknown' };
  }

  const zoneRowId = generateId('zone');
  try {
    await db
      .update(hostDomains)
      .set({
        nameservers: zone.nameservers,
        nameserverVerified: true,
        nameserverVerificationPending: false,
        customNameservers: false,
        updatedAt: new Date(),
      })
      .where(eq(hostDomains.id, domainId));

    await db.insert(hostDnsZones).values({
      id: zoneRowId,
      domainId,
      name: domain.fullDomain,
      status: 'pending',
      provider: 'cloudflare',
      externalZoneId: zone.zoneId,
      externalNameservers: zone.nameservers,
    });
  } catch (err) {
    console.error('[domains.service] DB write failed after zone creation, rolling back CF zone:', err);
    await deleteCloudflareZone(apiToken, zone.zoneId);
    return { ok: false, reason: 'persist_failed' };
  }

  const [updated] = await db.select().from(hostDomains).where(eq(hostDomains.id, domainId)).limit(1);
  const [newZone] = await db.select().from(hostDnsZones).where(eq(hostDnsZones.id, zoneRowId)).limit(1);

  return {
    ok: true,
    idempotent: false,
    domain: updated!,
    zone: newZone!,
    nameservers: zone.nameservers,
  };
}

// ============================================================================
// Refresh zone status from Cloudflare
// ============================================================================

export type RefreshZoneStatusResult =
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'no_cf_zone' }
  | { ok: false; reason: 'cf_misconfigured' }
  | { ok: false; reason: 'cf_unreachable' }
  | {
      ok: true;
      zoneStatus: 'active' | 'pending' | 'error';
      domainStatus: string;
      cloudflareStatus: string | null;
      nameservers?: string[];
    };

export async function refreshZoneStatus(
  db: Database,
  params: { domainId: string; apiToken: string | undefined },
): Promise<RefreshZoneStatusResult> {
  const got = await getDomainWithZone(db, params.domainId);
  if (!got || !got.domain) return { ok: false, reason: 'not_found' };
  const { domain, zone } = got;
  if (!zone || zone.provider !== 'cloudflare' || !zone.externalZoneId) {
    return { ok: false, reason: 'no_cf_zone' };
  }
  if (!params.apiToken) return { ok: false, reason: 'cf_misconfigured' };

  let cfZone;
  try {
    cfZone = await getCloudflareZone(params.apiToken, zone.externalZoneId);
  } catch (err) {
    console.error('[domains.service] getCloudflareZone failed:', err);
    return { ok: false, reason: 'cf_unreachable' };
  }

  if (!cfZone) {
    await db
      .update(hostDnsZones)
      .set({
        status: 'error',
        syncError: 'Zone no longer exists on Cloudflare',
        syncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(hostDnsZones.id, zone.id));
    return {
      ok: true,
      zoneStatus: 'error',
      domainStatus: domain.status,
      cloudflareStatus: null,
    };
  }

  const cfStatus = cfZone.status;
  const nextZoneStatus: 'active' | 'pending' | 'error' =
    cfStatus === 'active'
      ? 'active'
      : cfStatus === 'pending' || cfStatus === 'initializing'
        ? 'pending'
        : 'error';

  if (nextZoneStatus !== zone.status) {
    await db
      .update(hostDnsZones)
      .set({
        status: nextZoneStatus,
        externalNameservers: cfZone.nameservers,
        syncedAt: new Date(),
        syncError: nextZoneStatus === 'error' ? `Cloudflare status: ${cfStatus}` : null,
        updatedAt: new Date(),
      })
      .where(eq(hostDnsZones.id, zone.id));
  }

  const isExternal = isExternalDomainRegistrar(domain.registrar);
  let nextDomainStatus = domain.status;
  if (isExternal && nextZoneStatus === 'active' && domain.status === 'pending') {
    nextDomainStatus = 'active';
    await db
      .update(hostDomains)
      .set({ status: 'active', nameservers: cfZone.nameservers, updatedAt: new Date() })
      .where(eq(hostDomains.id, params.domainId));
  }

  return {
    ok: true,
    zoneStatus: nextZoneStatus,
    domainStatus: nextDomainStatus,
    cloudflareStatus: cfStatus,
    nameservers: cfZone.nameservers,
  };
}

// ============================================================================
// Registrar-bound mutations (dual-path: RTR for new, CF for legacy)
// ============================================================================

export async function syncDomainStatus(
  db: Database,
  clients: {
    rtr: RealtimeRegistrar | null;
    cf: CloudflareRegistrar | null;
  },
  domainId: string,
) {
  const [domain] = await db
    .select()
    .from(hostDomains)
    .where(and(eq(hostDomains.id, domainId), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (!domain) return null;

  const inFlightStatuses = new Set([
    'pending_payment',
    'pending_registration',
    'pending_workflow',
    'pending_transfer',
    'pending_renewal',
  ]);
  // Do not force registrationStatus=registered while a payment/register/
  // transfer/renew workflow is still in flight.
  const canMarkRegistered = !inFlightStatuses.has(domain.registrationStatus ?? '');

  if (domain.registrar === 'realtimeregister' && clients.rtr) {
    const remote = await clients.rtr.getDomain(domain.fullDomain);
    const [updated] = await db
      .update(hostDomains)
      .set({
        externalRegistrarId: remote.id,
        registrarStatus: remote.status.join(','),
        locked: remote.locked,
        autoRenew: remote.autoRenew,
        privacyProtection: remote.privacyProtect,
        expiresAt: remote.expiresAt ? new Date(remote.expiresAt) : domain.expiresAt,
        authCode: remote.authCode ?? domain.authCode,
        status: remote.status.includes('OK') || remote.status.includes('ok')
          ? 'active'
          : domain.status,
        ...(canMarkRegistered ? { registrationStatus: 'registered' as const } : {}),
        registrarSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(hostDomains.id, domainId))
      .returning();
    return updated ?? null;
  }

  if (domain.registrar === 'cloudflare' && clients.cf) {
    const cfDomain = await clients.cf.getDomain(domain.fullDomain);
    const [updated] = await db
      .update(hostDomains)
      .set({
        externalRegistrarId: cfDomain.id,
        registrarStatus: cfDomain.status,
        locked: cfDomain.locked,
        autoRenew: cfDomain.autoRenew,
        expiresAt: cfDomain.expiresAt ? new Date(cfDomain.expiresAt) : domain.expiresAt,
        status: cfDomain.status === 'active' ? 'active' : domain.status,
        ...(canMarkRegistered ? { registrationStatus: 'registered' as const } : {}),
        registrarSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(hostDomains.id, domainId))
      .returning();
    return updated ?? null;
  }

  return domain;
}

export async function toggleAutoRenew(
  db: Database,
  clients: {
    rtr: RealtimeRegistrar | null;
    cf: CloudflareRegistrar | null;
  },
  params: { domainId: string; enabled: boolean },
) {
  const [domain] = await db
    .select()
    .from(hostDomains)
    .where(and(eq(hostDomains.id, params.domainId), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (!domain) return null;

  // Registrar-backed domains must succeed at the registrar before we persist.
  // External / unregistered rows only update locally.
  if (domain.registrar === 'realtimeregister' && domain.externalRegistrarId) {
    if (!clients.rtr) throw new Error('Realtime Register is not configured');
    await clients.rtr.updateDomain(domain.fullDomain, { autoRenew: params.enabled });
  } else if (domain.registrar === 'cloudflare' && domain.externalRegistrarId) {
    if (!clients.cf) throw new Error('Cloudflare Registrar is not configured');
    await clients.cf.updateDomain(domain.fullDomain, { autoRenew: params.enabled });
  }

  const [updated] = await db
    .update(hostDomains)
    .set({ autoRenew: params.enabled, updatedAt: new Date() })
    .where(eq(hostDomains.id, params.domainId))
    .returning();
  return updated ?? null;
}

export async function togglePrivacy(
  db: Database,
  clients: {
    rtr: RealtimeRegistrar | null;
    cf: CloudflareRegistrar | null;
  },
  params: { domainId: string; enabled: boolean },
) {
  const [domain] = await db
    .select()
    .from(hostDomains)
    .where(and(eq(hostDomains.id, params.domainId), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (!domain) return null;

  if (domain.registrar === 'realtimeregister' && domain.externalRegistrarId) {
    if (!clients.rtr) throw new Error('Realtime Register is not configured');
    await clients.rtr.updateDomain(domain.fullDomain, { privacyProtect: params.enabled });
  } else if (domain.registrar === 'cloudflare' && domain.externalRegistrarId) {
    // Cloudflare Registrar beta has no privacy toggle API.
    void clients.cf;
    throw new Error(
      'Privacy protection cannot be changed for domains registered through Cloudflare Registrar',
    );
  }

  const [updated] = await db
    .update(hostDomains)
    .set({ privacyProtection: params.enabled, updatedAt: new Date() })
    .where(eq(hostDomains.id, params.domainId))
    .returning();
  return updated ?? null;
}

export async function toggleLock(
  db: Database,
  clients: {
    rtr: RealtimeRegistrar | null;
    cf: CloudflareRegistrar | null;
  },
  params: { domainId: string; locked: boolean },
) {
  const [domain] = await db
    .select()
    .from(hostDomains)
    .where(and(eq(hostDomains.id, params.domainId), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (!domain) return null;

  if (domain.registrar === 'realtimeregister' && domain.externalRegistrarId) {
    if (!clients.rtr) throw new Error('Realtime Register is not configured');
    await clients.rtr.setTransferLock(domain.fullDomain, params.locked);
  } else if (domain.registrar === 'cloudflare' && domain.externalRegistrarId) {
    if (!clients.cf) throw new Error('Cloudflare Registrar is not configured');
    await clients.cf.updateDomain(domain.fullDomain, { locked: params.locked });
  }

  const [updated] = await db
    .update(hostDomains)
    .set({ locked: params.locked, updatedAt: new Date() })
    .where(eq(hostDomains.id, params.domainId))
    .returning();
  return updated ?? null;
}

// ============================================================================
// Verify nameservers — just flips the pending flag; full propagation check
// is handled by `refreshZoneStatus` below.
// ============================================================================

export async function markNameserverVerificationPending(db: Database, domainId: string) {
  const [domain] = await db
    .select()
    .from(hostDomains)
    .where(and(eq(hostDomains.id, domainId), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (!domain) return null;
  await db
    .update(hostDomains)
    .set({ nameserverVerificationPending: true, updatedAt: new Date() })
    .where(eq(hostDomains.id, domainId));
  return domain;
}

// ============================================================================
// Issue (or refresh) the EPP auth code used for outgoing transfers.
// ============================================================================

export type IssueAuthCodeResult =
  | { ok: true; authCode: string; expiresAt: Date }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'unavailable'; message: string };

/**
 * Fetch a real EPP auth code from the registrar. Never invents a synthetic
 * code — a fabricated value would be accepted by the UI as transferable.
 */
export async function issueAuthCode(
  db: Database,
  clients: {
    rtr: RealtimeRegistrar | null;
    cf: CloudflareRegistrar | null;
  },
  domainId: string,
): Promise<IssueAuthCodeResult> {
  const [domain] = await db
    .select()
    .from(hostDomains)
    .where(and(eq(hostDomains.id, domainId), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (!domain) return { ok: false, reason: 'not_found' };

  if (domain.registrar === 'cloudflare') {
    void clients.cf;
    return {
      ok: false,
      reason: 'unavailable',
      message:
        'Auth codes are not available via API for domains registered through Cloudflare Registrar.',
    };
  }
  if (domain.registrar !== 'realtimeregister') {
    return {
      ok: false,
      reason: 'unavailable',
      message:
        'Auth codes are only available for domains registered through WeldHost (Realtime Register).',
    };
  }
  if (!clients.rtr) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Realtime Register is not configured',
    };
  }

  let authCode: string | null = null;
  try {
    authCode = await clients.rtr.getAuthCode(domain.fullDomain);
  } catch (err) {
    console.error('[domains.service] RTR authcode fetch failed:', err);
    return {
      ok: false,
      reason: 'unavailable',
      message: err instanceof Error ? err.message : 'Failed to fetch auth code from registrar',
    };
  }

  if (!authCode) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'The registrar did not return an auth code for this domain yet. Try again shortly.',
    };
  }

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db
    .update(hostDomains)
    .set({ authCode, authCodeExpiresAt: expiresAt, updatedAt: new Date() })
    .where(eq(hostDomains.id, domainId));
  return { ok: true, authCode, expiresAt };
}

// ============================================================================
// Checkout — RTR availability + pricing + Stripe Checkout Session
// ============================================================================

export { MAX_CHECKOUT_DOMAINS };

export type CheckoutResult =
  | { ok: false; reason: 'unavailable'; domain: string }
  | { ok: false; reason: 'no_price'; tld: string }
  | { ok: false; reason: 'workspace_not_found' }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'too_many'; max: number }
  | { ok: false; reason: 'currency_mismatch' }
  | { ok: false; reason: 'unsupported_years' }
  | { ok: true; sessionId: string; url: string; registrationIds: string[]; domains: string[] };

export function domainsFromCheckoutInput(input: {
  domain?: string;
  domains?: string[];
}): string[] {
  const raw = [...(input.domains ?? []), ...(input.domain ? [input.domain] : [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of raw) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

async function insertOrReusePendingCheckoutRows(
  db: Database,
  names: string[],
  input: {
    contact?: Record<string, unknown>;
    autoRenew?: boolean;
    years: number;
  },
): Promise<string[]> {
  const existing = await db
    .select({
      id: hostDomains.id,
      fullDomain: hostDomains.fullDomain,
      createdAt: hostDomains.createdAt,
    })
    .from(hostDomains)
    .where(
      and(
        inArray(hostDomains.fullDomain, names),
        eq(hostDomains.status, 'pending'),
        eq(hostDomains.registrationStatus, 'pending_payment'),
        isNull(hostDomains.stripeSessionId),
        isNull(hostDomains.deletedAt),
      ),
    )
    .orderBy(asc(hostDomains.createdAt));

  const reusedByFqdn = new Map<string, string>();
  for (const row of existing) {
    if (!reusedByFqdn.has(row.fullDomain)) {
      reusedByFqdn.set(row.fullDomain, row.id);
    }
  }

  const now = new Date();
  const metadata = { registrationYears: input.years };
  const registrationIds: string[] = [];
  const toInsert: Array<typeof hostDomains.$inferInsert> = [];

  for (const fullDomain of names) {
    const reusedId = reusedByFqdn.get(fullDomain);
    if (reusedId) {
      registrationIds.push(reusedId);
      await db
        .update(hostDomains)
        .set({
          autoRenew: input.autoRenew ?? true,
          privacyProtection: true,
          registrantContact: (input.contact as never) ?? null,
          metadata,
          updatedAt: now,
        })
        .where(eq(hostDomains.id, reusedId));
      continue;
    }

    const parts = fullDomain.split('.');
    const id = generateId('dom');
    registrationIds.push(id);
    toInsert.push({
      id,
      name: parts[0]!,
      tld: tldOf(fullDomain),
      fullDomain,
      registrar: DEFAULT_REGISTRAR,
      status: 'pending',
      registrationStatus: 'pending_payment',
      autoRenew: input.autoRenew ?? true,
      privacyProtection: true,
      registrantContact: (input.contact as never) ?? null,
      metadata,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (toInsert.length > 0) {
    await db.insert(hostDomains).values(toInsert);
  }
  return registrationIds;
}

export async function createCheckout(
  db: Database,
  rtr: RealtimeRegistrar,
  masterDb: MasterDatabase,
  params: {
    workspaceId: string;
    stripeSecretKey: string;
    origin: string;
    input: {
      domain?: string;
      domains?: string[];
      contact?: Record<string, unknown>;
      autoRenew?: boolean;
      privacyProtection?: boolean;
      years?: number;
    };
  },
): Promise<CheckoutResult> {
  const names = domainsFromCheckoutInput(params.input);
  if (names.length === 0) return { ok: false, reason: 'empty' };
  if (names.length > MAX_CHECKOUT_DOMAINS) {
    return { ok: false, reason: 'too_many', max: MAX_CHECKOUT_DOMAINS };
  }
  const years = params.input.years ?? 1;
  if (years !== 1) {
    return { ok: false, reason: 'unsupported_years' };
  }

  const [checks, pricingMap] = await Promise.all([
    rtr.checkDomains(names),
    loadPricingMap(masterDb),
  ]);
  const checkByName = new Map(checks.map((c) => [c.name.toLowerCase(), c]));

  const lineItems: Array<{ name: string; unitAmountCents: number; currency: string }> = [];
  let sessionCurrency: string | null = null;

  for (const name of names) {
    const check = checkByName.get(name);
    if (!check?.available) {
      return { ok: false, reason: 'unavailable', domain: name };
    }
    const tld = tldOf(name);
    const pricingRow = pricingMap.get(tld);
    const unitAmountCents = applyMarkup(check.priceCents, pricingRow, check.currency);
    if (unitAmountCents === null || unitAmountCents <= 0) {
      return { ok: false, reason: 'no_price', tld };
    }
    const currency = (pricingRow?.currency ?? check.currency ?? 'usd').toLowerCase();
    if (sessionCurrency && sessionCurrency !== currency) {
      return { ok: false, reason: 'currency_mismatch' };
    }
    sessionCurrency = currency;
    lineItems.push({ name, unitAmountCents, currency });
  }

  // `params.workspaceId` is the Clerk org id from app-api middleware
  // (`c.set('workspaceId', orgId)`). Look up by either column so this
  // still works if a caller ever passes the internal `workspaces.id`.
  const [workspaceRow] = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      name: masterSchema.workspaces.name,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
      stripeCustomerId: masterSchema.workspaces.stripeCustomerId,
    })
    .from(masterSchema.workspaces)
    .where(
      or(
        eq(masterSchema.workspaces.id, params.workspaceId),
        eq(masterSchema.workspaces.clerkOrgId, params.workspaceId),
      ),
    )
    .limit(1);

  if (!workspaceRow) {
    return { ok: false, reason: 'workspace_not_found' };
  }

  let customerId = workspaceRow.stripeCustomerId;
  if (!customerId) {
    const customer = await createStripeCustomer(params.stripeSecretKey, {
      name: workspaceRow.name,
      metadata: {
        workspaceId: workspaceRow.id,
        clerkOrgId: workspaceRow.clerkOrgId ?? params.workspaceId,
      },
    });
    customerId = customer.id;
    await masterDb
      .update(masterSchema.workspaces)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(masterSchema.workspaces.id, workspaceRow.id));
  }

  const registrationIds = await insertOrReusePendingCheckoutRows(db, names, {
    contact: params.input.contact,
    autoRenew: params.input.autoRenew,
    years,
  });

  const successUrl = `${params.origin}/weldhost/domains/purchase/success?session_id={CHECKOUT_SESSION_ID}&registration_ids=${registrationIds.join(',')}`;
  const cancelUrl = `${params.origin}/weldhost/domains/purchase/cancel?registration_ids=${registrationIds.join(',')}`;

  let session: { id: string; url: string };
  try {
    session = await createDomainCheckoutSession(params.stripeSecretKey, {
      customerId,
      lineItems,
      successUrl,
      cancelUrl,
      idempotencyKey: `weldhost-checkout:${[...registrationIds].sort().join(',')}`,
      metadata: {
        kind: 'domain_registration',
        registrationIds: JSON.stringify(registrationIds),
        workspaceId: params.workspaceId,
        registrationYears: String(years),
      },
    });
  } catch (err) {
    if (isDefiniteStripeFailure(err)) {
      await db.delete(hostDomains).where(inArray(hostDomains.id, registrationIds));
    }
    throw err;
  }

  await db
    .update(hostDomains)
    .set({ stripeSessionId: session.id, updatedAt: new Date() })
    .where(inArray(hostDomains.id, registrationIds));

  return {
    ok: true,
    sessionId: session.id,
    url: session.url,
    registrationIds,
    domains: names,
  };
}

/**
 * Poll an RTR process for a pending registration and mark the domain active
 * when the process completes.
 */
export async function pollRegistrationProcess(
  db: Database,
  rtr: RealtimeRegistrar,
  domainId: string,
): Promise<typeof hostDomains.$inferSelect | null> {
  const [domain] = await db
    .select()
    .from(hostDomains)
    .where(and(eq(hostDomains.id, domainId), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (!domain) return null;
  // Renewal processes are tracked separately so they cannot hijack registration polling.
  if (
    domain.registrationStatus === 'pending_renewal' ||
    domain.registrationStatus === 'renewed'
  ) {
    return domain;
  }
  if (!domain.rtrProcessId) return domain;

  const processId = Number.parseInt(domain.rtrProcessId, 10);
  if (!Number.isFinite(processId) || processId <= 0) return domain;

  let outcome: 'completed' | 'pending' | 'failed';
  try {
    outcome = await rtr.pollProcess(processId);
  } catch (err) {
    console.error('[domains.service] pollRegistrationProcess pollProcess failed:', err);
    return domain;
  }
  if (outcome === 'pending') return domain;

  if (outcome === 'failed') {
    const [updated] = await db
      .update(hostDomains)
      .set({
        registrationStatus: 'registration_failed',
        status: 'cancelled',
        updatedAt: new Date(),
      })
      .where(eq(hostDomains.id, domainId))
      .returning();
    return updated ?? null;
  }

  try {
    const remote = await rtr.getDomain(domain.fullDomain);
    const [updated] = await db
      .update(hostDomains)
      .set({
        status: 'active',
        registrationStatus: 'registered',
        externalRegistrarId: remote.id,
        registrarStatus: remote.status.join(','),
        registeredAt: new Date(),
        expiresAt: remote.expiresAt ? new Date(remote.expiresAt) : null,
        locked: remote.locked,
        autoRenew: remote.autoRenew,
        privacyProtection: remote.privacyProtect,
        registrarSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(hostDomains.id, domainId))
      .returning();
    return updated ?? null;
  } catch (err) {
    console.error('[domains.service] pollRegistrationProcess getDomain failed:', err);
    return domain;
  }
}

export async function renewDomain(
  db: Database,
  clients: {
    rtr: RealtimeRegistrar | null;
    cf: CloudflareRegistrar | null;
  },
  params: { domainId: string; periodMonths?: number },
) {
  const [domain] = await db
    .select()
    .from(hostDomains)
    .where(and(eq(hostDomains.id, params.domainId), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (!domain) return null;
  if (domain.registrar === 'cloudflare') {
    void clients.cf;
    throw new Error(
      'Renewal is not available via API for domains registered through Cloudflare Registrar',
    );
  }
  if (domain.registrar !== 'realtimeregister') {
    throw new Error('Renewal is only supported for Realtime Register domains');
  }
  if (!clients.rtr) throw new Error('Realtime Register is not configured');

  const result = await clients.rtr.renew(domain.fullDomain, params.periodMonths ?? 12);
  if (result.status === 'failed') {
    throw new Error(result.message);
  }

  const patch: Partial<typeof hostDomains.$inferInsert> = {
    registrationStatus: result.status === 'pending' ? 'pending_renewal' : 'renewed',
    updatedAt: new Date(),
  };
  if (result.status === 'pending') {
    // Keep registration rtrProcessId intact; store renewal process under metadata.
    const metadata = {
      ...(domain.metadata ?? {}),
      rtrRenewalProcessId: String(result.processId),
    };
    patch.metadata = metadata;
  } else if (result.status === 'completed') {
    patch.renewedAt = new Date();
    patch.expiresAt = result.domain.expiresAt ? new Date(result.domain.expiresAt) : domain.expiresAt;
    patch.registrarStatus = result.domain.status.join(',');
    patch.registrarSyncedAt = new Date();
  }

  const [updated] = await db
    .update(hostDomains)
    .set(patch)
    .where(eq(hostDomains.id, params.domainId))
    .returning();
  return updated ?? null;
}

/** Re-export contact input type for transfer/register helpers. */
export type { DomainContactInput };

// ============================================================================
// Completion (post-checkout, called by polling or webhook flow)
// ============================================================================

export async function completeRegistration(
  db: Database,
  registrationId: string,
  contactInfo?: Record<string, unknown>,
) {
  const [domain] = await db
    .select()
    .from(hostDomains)
    .where(eq(hostDomains.id, registrationId))
    .limit(1);
  if (!domain) return null;
  await db
    .update(hostDomains)
    .set({
      status: 'active',
      registrationStatus: 'registered',
      registeredAt: new Date(),
      registrantContact: (contactInfo as never) ?? domain.registrantContact ?? null,
      updatedAt: new Date(),
    })
    .where(eq(hostDomains.id, registrationId));
  const [updated] = await db
    .select()
    .from(hostDomains)
    .where(eq(hostDomains.id, registrationId))
    .limit(1);
  return updated ?? null;
}

// ============================================================================
// Registration status — used by the post-checkout polling page
// ============================================================================

export interface RegistrationStatusRow {
  registrationId: string;
  domainId: string | null;
  domainName: string;
  status: 'pending' | 'payment_complete' | 'registering' | 'completed' | 'failed';
  totalPrice: number | null;
  failureReason: string | null;
}

type RegistrationStatusSource = {
  id: string;
  fullDomain: string;
  status: string;
  registrationStatus: string | null;
  metadata: Record<string, unknown> | null;
};

export function registrationStatusFromDomain(row: RegistrationStatusSource): RegistrationStatusRow {
  let status: RegistrationStatusRow['status'] = 'pending';
  switch (row.registrationStatus) {
    case 'pending_payment':
      status = 'pending';
      break;
    case 'pending_registration':
    case 'pending_workflow':
      status = 'registering';
      break;
    case 'registered':
      status = 'completed';
      break;
    case 'failed':
    case 'registration_failed':
      status = 'failed';
      break;
    default:
      if (row.status === 'active') status = 'completed';
      else if (row.status === 'cancelled') status = 'failed';
      else status = 'pending';
  }

  const metadataError =
    row.metadata && typeof row.metadata === 'object' && 'error' in row.metadata
      ? String((row.metadata as { error?: unknown }).error ?? '')
      : '';

  return {
    registrationId: row.id,
    domainId: row.status === 'active' ? row.id : null,
    domainName: row.fullDomain,
    status,
    totalPrice: null,
    failureReason: status === 'failed' && metadataError ? metadataError : null,
  };
}

export async function getRegistrationStatus(
  db: Database,
  registrationId: string,
): Promise<RegistrationStatusRow | null> {
  const [row] = await db
    .select()
    .from(hostDomains)
    .where(eq(hostDomains.id, registrationId))
    .limit(1);
  if (!row) return null;
  return registrationStatusFromDomain(row);
}

// ============================================================================
// Dashboard
// ============================================================================

export async function getDashboardStats(db: Database) {
  const [stats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${hostDomains.status} = 'active')::int`,
      pending: sql<number>`count(*) filter (where ${hostDomains.status} = 'pending')::int`,
      expired: sql<number>`count(*) filter (where ${hostDomains.status} = 'expired')::int`,
      expiringSoon: sql<number>`count(*) filter (where ${hostDomains.expiresAt} is not null and ${hostDomains.expiresAt} <= now() + interval '30 days')::int`,
      sslEnabled: sql<number>`count(*) filter (where ${hostDomains.sslEnabled} = true)::int`,
      autoRenewEnabled: sql<number>`count(*) filter (where ${hostDomains.autoRenew} = true)::int`,
    })
    .from(hostDomains)
    .where(and(isNull(hostDomains.deletedAt), isListedDomainSql()));

  return {
    totalDomains: stats?.total ?? 0,
    activeDomains: stats?.active ?? 0,
    pendingDomains: stats?.pending ?? 0,
    expiredDomains: stats?.expired ?? 0,
    expiringSoon: stats?.expiringSoon ?? 0,
    sslEnabled: stats?.sslEnabled ?? 0,
    autoRenewEnabled: stats?.autoRenewEnabled ?? 0,
  };
}

export async function getDashboardChart(db: Database, days: number) {
  const domains = await db
    .select({
      registeredAt: hostDomains.registeredAt,
      renewedAt: hostDomains.renewedAt,
      expiresAt: hostDomains.expiresAt,
      status: hostDomains.status,
    })
    .from(hostDomains)
    .where(and(isNull(hostDomains.deletedAt), isListedDomainSql()));

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  interface Point { date: string; registrations: number; renewals: number; expirations: number }
  const dateMap = new Map<string, Point>();
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    dateMap.set(dateStr, { date: dateStr, registrations: 0, renewals: 0, expirations: 0 });
  }

  for (const domain of domains) {
    if (domain.registeredAt) {
      const k = new Date(domain.registeredAt).toISOString().split('T')[0];
      const p = dateMap.get(k);
      if (p) p.registrations++;
    }
    if (domain.renewedAt) {
      const k = new Date(domain.renewedAt).toISOString().split('T')[0];
      const p = dateMap.get(k);
      if (p) p.renewals++;
    }
    if (domain.expiresAt && domain.status === 'expired') {
      const k = new Date(domain.expiresAt).toISOString().split('T')[0];
      const p = dateMap.get(k);
      if (p) p.expirations++;
    }
  }

  return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export async function getDashboardRecent(db: Database, limit: number) {
  const rows = await db
    .select()
    .from(hostDomains)
    .where(and(isNull(hostDomains.deletedAt), isListedDomainSql()))
    .orderBy(desc(hostDomains.createdAt))
    .limit(limit);
  return rows.map(toPublicDomain);
}
