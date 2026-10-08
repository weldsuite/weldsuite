/**
 * Stripe-billed domain auto-renewal.
 *
 * Year 1 is a one-off Checkout (`mode=payment`). Auto-renew is a daily sweep
 * that invoices the workspace customer ~14 days before expiry, then calls
 * Realtime Register only after Stripe reports the invoice paid. Registrar
 * auto-renew stays off so RTR cannot bill WeldSuite independently.
 */

import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { schema, masterSchema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { RealtimeRegistrar } from '@weldsuite/realtime-registrar';
import {
  createDomainRenewalInvoice,
  payInvoiceOffSession,
  retrieveInvoice,
  voidInvoice,
  isDefiniteStripeFailure,
  type StripeInvoice,
} from '@weldsuite/stripe';
import { applyMarkup, pollRenewalProcess, renewDomain } from '@weldsuite/host-domain/domains';

const { hostDomains } = schema;

/** How far ahead of expiry we raise the renewal invoice. */
export const DOMAIN_AUTO_RENEW_WINDOW_DAYS = 14;
/** Don't chase domains that expired this many days ago (redemption is manual). */
export const DOMAIN_AUTO_RENEW_GRACE_DAYS = 7;

export const DOMAIN_RENEWAL_INVOICE_KIND = 'domain_renewal';

export type DomainRenewalChargeResult =
  | { ok: true; invoiceId: string; renewed: boolean; pending: boolean }
  | { ok: false; reason: 'not_found' | 'unsupported' | 'no_price' | 'no_customer' | 'payment_failed' | 'already_renewed' };

function tldOf(name: string): string {
  return name.split('.').slice(1).join('.').replace(/^\./, '').toLowerCase();
}

function expiresAtKey(expiresAt: Date): string {
  return expiresAt.toISOString().slice(0, 10);
}

export function renewalMeta(metadata: Record<string, unknown> | null | undefined): {
  stripeRenewalInvoiceId: string | null;
  stripeRenewalForExpiresAt: string | null;
  stripeRenewalProcessedInvoiceId: string | null;
  rtrRenewalProcessId: string | null;
} {
  const meta = metadata ?? {};
  return {
    stripeRenewalInvoiceId:
      typeof meta.stripeRenewalInvoiceId === 'string' ? meta.stripeRenewalInvoiceId : null,
    stripeRenewalForExpiresAt:
      typeof meta.stripeRenewalForExpiresAt === 'string' ? meta.stripeRenewalForExpiresAt : null,
    stripeRenewalProcessedInvoiceId:
      typeof meta.stripeRenewalProcessedInvoiceId === 'string'
        ? meta.stripeRenewalProcessedInvoiceId
        : null,
    rtrRenewalProcessId:
      typeof meta.rtrRenewalProcessId === 'string' ? meta.rtrRenewalProcessId : null,
  };
}

/** Stored invoice may be reused only for the expiry it was raised against. */
export function storedInvoiceAppliesToExpiry(
  meta: ReturnType<typeof renewalMeta>,
  expiresAt: Date,
): boolean {
  return (
    Boolean(meta.stripeRenewalInvoiceId) &&
    meta.stripeRenewalForExpiresAt === expiresAtKey(expiresAt)
  );
}

export function isDueForStripeAutoRenew(
  domain: {
    autoRenew: boolean | null;
    status: string;
    registrar: string | null;
    expiresAt: Date | null;
    deletedAt: Date | null;
    registrationStatus: string | null;
  },
  now: Date,
  windowDays = DOMAIN_AUTO_RENEW_WINDOW_DAYS,
  graceDays = DOMAIN_AUTO_RENEW_GRACE_DAYS,
): boolean {
  if (domain.deletedAt) return false;
  if (!domain.autoRenew) return false;
  if (domain.registrar !== 'realtimeregister') return false;
  if (domain.status !== 'active' && domain.status !== 'expired') return false;
  if (!domain.expiresAt) return false;
  if (domain.registrationStatus === 'pending_renewal') return true;
  const expires = domain.expiresAt.getTime();
  const windowEnd = now.getTime() + windowDays * 86_400_000;
  const windowStart = now.getTime() - graceDays * 86_400_000;
  return expires >= windowStart && expires <= windowEnd;
}

export function listDomainsDueForAutoRenew(
  db: Database,
  now: Date,
  windowDays = DOMAIN_AUTO_RENEW_WINDOW_DAYS,
  graceDays = DOMAIN_AUTO_RENEW_GRACE_DAYS,
) {
  const windowEnd = new Date(now.getTime() + windowDays * 86_400_000);
  const windowStart = new Date(now.getTime() - graceDays * 86_400_000);
  return db
    .select()
    .from(hostDomains)
    .where(
      and(
        isNull(hostDomains.deletedAt),
        eq(hostDomains.autoRenew, true),
        eq(hostDomains.registrar, 'realtimeregister'),
        or(eq(hostDomains.status, 'active'), eq(hostDomains.status, 'expired')),
        or(
          eq(hostDomains.registrationStatus, 'pending_renewal'),
          and(gte(hostDomains.expiresAt, windowStart), lte(hostDomains.expiresAt, windowEnd)),
        ),
      ),
    );
}

// ── When to look at a workspace again (D1 due index, kind domain_renew) ──

/**
 * While a registration or transfer settles, look daily — for at most this
 * long. Covers delayed Stripe payment methods (SEPA, Bacs) that clear days
 * after checkout: billing-worker activates those rows without touching the
 * index, so this daily look is what picks them up.
 */
export const DOMAIN_IN_FLIGHT_RECHECK_DAYS = 30;

const IN_FLIGHT_REGISTRATION_STATUSES = new Set([
  'pending_payment',
  'pending_registration',
  'pending_workflow',
  'pending_transfer',
]);

type DomainRenewFields = Parameters<typeof isDueForStripeAutoRenew>[0] & { updatedAt: Date };

function isInFlight(domain: DomainRenewFields, now: Date): boolean {
  const pending =
    domain.status === 'pending' ||
    (domain.registrationStatus != null && IN_FLIGHT_REGISTRATION_STATUSES.has(domain.registrationStatus));
  if (!pending) return false;
  return now.getTime() - domain.updatedAt.getTime() <= DOMAIN_IN_FLIGHT_RECHECK_DAYS * 86_400_000;
}

/**
 * When the daily auto-renew sweep next needs to open this workspace, from its
 * Realtime Register domains (`null`: never, drop it from the index):
 *
 * - now, when a domain is due by `isDueForStripeAutoRenew` (a renewal still
 *   awaiting payment stays due, so it is retried daily as before);
 * - tomorrow, while a registration / transfer is settling, so a domain that
 *   becomes active is picked up even if no other write marks the workspace;
 * - otherwise when the first auto-renewing domain enters the renewal window.
 *
 * Domains past the grace period are ignored (redemption is manual), as are
 * other registrars. Errs early: an extra visit costs one tenant wake, a late
 * one a lapsed domain.
 */
export function nextDomainRenewCheckAt(
  domains: DomainRenewFields[],
  now: Date,
  windowDays = DOMAIN_AUTO_RENEW_WINDOW_DAYS,
  graceDays = DOMAIN_AUTO_RENEW_GRACE_DAYS,
): Date | null {
  const day = 86_400_000;
  let next: number | null = null;
  const consider = (at: number) => {
    next = next == null ? at : Math.min(next, at);
  };

  for (const domain of domains) {
    if (domain.deletedAt || domain.registrar !== 'realtimeregister') continue;
    if (isDueForStripeAutoRenew(domain, now, windowDays, graceDays)) {
      consider(now.getTime());
    } else if (isInFlight(domain, now)) {
      consider(now.getTime() + day);
    } else if (
      domain.autoRenew &&
      domain.expiresAt &&
      (domain.status === 'active' || domain.status === 'expired') &&
      domain.expiresAt.getTime() >= now.getTime() - graceDays * day
    ) {
      consider(domain.expiresAt.getTime() - windowDays * day);
    }
  }
  return next == null ? null : new Date(next);
}

/** `nextDomainRenewCheckAt` over the workspace's Realtime Register domains. */
export async function loadNextDomainRenewCheckAt(db: Database, now: Date): Promise<Date | null> {
  const domains = await db
    .select({
      autoRenew: hostDomains.autoRenew,
      status: hostDomains.status,
      registrar: hostDomains.registrar,
      expiresAt: hostDomains.expiresAt,
      deletedAt: hostDomains.deletedAt,
      registrationStatus: hostDomains.registrationStatus,
      updatedAt: hostDomains.updatedAt,
    })
    .from(hostDomains)
    .where(and(isNull(hostDomains.deletedAt), eq(hostDomains.registrar, 'realtimeregister')));
  return nextDomainRenewCheckAt(domains, now);
}

async function loadPricingMap(
  masterDb: MasterDatabase,
): Promise<Map<string, typeof masterSchema.hostDomainPricing.$inferSelect>> {
  const rows = await masterDb
    .select()
    .from(masterSchema.hostDomainPricing)
    .where(eq(masterSchema.hostDomainPricing.isActive, true));
  return new Map(rows.map((r) => [r.tld.replace(/^\./, '').toLowerCase(), r]));
}

export function renewalPriceCents(params: {
  tld: string;
  pricing: typeof masterSchema.hostDomainPricing.$inferSelect | undefined;
}): number | null {
  return applyMarkup(null, params.pricing, null, 'renewal');
}

async function lookupWorkspaceStripeCustomer(
  masterDb: MasterDatabase,
  workspaceId: string,
): Promise<{ stripeCustomerId: string; clerkOrgId: string | null } | null> {
  const [workspaceRow] = await masterDb
    .select({
      stripeCustomerId: masterSchema.workspaces.stripeCustomerId,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
    })
    .from(masterSchema.workspaces)
    .where(
      or(
        eq(masterSchema.workspaces.id, workspaceId),
        eq(masterSchema.workspaces.clerkOrgId, workspaceId),
      ),
    )
    .limit(1);
  if (!workspaceRow?.stripeCustomerId) return null;
  return {
    stripeCustomerId: workspaceRow.stripeCustomerId,
    clerkOrgId: workspaceRow.clerkOrgId,
  };
}

async function persistRenewalInvoiceMeta(
  db: Database,
  domainId: string,
  metadata: Record<string, unknown>,
  invoiceId: string,
  expiresAt: Date,
  extra?: { processedInvoiceId?: string },
) {
  await db
    .update(hostDomains)
    .set({
      metadata: {
        ...metadata,
        stripeRenewalInvoiceId: invoiceId,
        stripeRenewalForExpiresAt: expiresAtKey(expiresAt),
        ...(extra?.processedInvoiceId
          ? { stripeRenewalProcessedInvoiceId: extra.processedInvoiceId }
          : {}),
      },
      updatedAt: new Date(),
    })
    .where(eq(hostDomains.id, domainId));
}

type HostDomainRow = typeof hostDomains.$inferSelect;
type RenewalDeps = { db: Database; rtr: RealtimeRegistrar };

function renewalOutcome(
  invoiceId: string,
  registrationStatus: string | null | undefined,
): DomainRenewalChargeResult {
  return {
    ok: true,
    invoiceId,
    renewed: registrationStatus === 'renewed',
    pending: registrationStatus === 'pending_renewal',
  };
}

/** Settles a domain already waiting on Realtime Register; null when it still needs a charge. */
async function settlePendingRenewal(
  { db, rtr }: RenewalDeps,
  domain: HostDomainRow,
): Promise<DomainRenewalChargeResult | null> {
  const polled = await pollRenewalProcess(db, rtr, domain.id);
  if (polled?.registrationStatus !== 'renewed' && polled?.registrationStatus !== 'pending_renewal') {
    return null;
  }
  return renewalOutcome(
    renewalMeta(domain.metadata).stripeRenewalInvoiceId ?? '',
    polled.registrationStatus,
  );
}

function isAlreadyRenewed(
  domain: HostDomainRow,
  expiresAt: Date,
  alreadyPaidInvoiceId: string | undefined,
): boolean {
  const meta = renewalMeta(domain.metadata);
  if (alreadyPaidInvoiceId && meta.stripeRenewalProcessedInvoiceId === alreadyPaidInvoiceId) {
    return true;
  }
  return (
    meta.stripeRenewalForExpiresAt === expiresAtKey(expiresAt) &&
    domain.registrationStatus === 'renewed'
  );
}

/**
 * Loads the invoice stored for this expiry (unless the webhook already hands
 * us a paid one). A void/uncollectible or definitively missing invoice is
 * dropped so a fresh one is raised.
 */
async function loadStoredInvoice(
  stripeSecretKey: string,
  invoiceId: string | null,
  alreadyPaidInvoiceId: string | undefined,
): Promise<{ invoiceId: string | null; invoice: StripeInvoice | null }> {
  if (!invoiceId || alreadyPaidInvoiceId) return { invoiceId, invoice: null };
  let invoice: StripeInvoice;
  try {
    invoice = await retrieveInvoice(stripeSecretKey, invoiceId);
  } catch (err) {
    if (!isDefiniteStripeFailure(err)) throw err;
    return { invoiceId: null, invoice: null };
  }
  if (invoice.status === 'void' || invoice.status === 'uncollectible') {
    return { invoiceId: null, invoice: null };
  }
  return { invoiceId, invoice };
}

/** Renews at the registrar after payment and records the processed invoice. */
async function renewPaidDomain(
  { db, rtr }: RenewalDeps,
  domain: HostDomainRow,
  expiresAt: Date,
  paidId: string,
): Promise<DomainRenewalChargeResult> {
  const updated = await renewDomain(db, { rtr, cf: null }, { domainId: domain.id });
  if (!updated) return { ok: false, reason: 'not_found' };
  await persistRenewalInvoiceMeta(db, domain.id, updated.metadata ?? {}, paidId, expiresAt, {
    processedInvoiceId: paidId,
  });
  return renewalOutcome(paidId, updated.registrationStatus);
}

/** Tries the off-session charge; falls back to re-reading the invoice if Stripe errored. */
async function payRenewalInvoice(
  stripeSecretKey: string,
  invoiceId: string,
  invoice: StripeInvoice,
): Promise<StripeInvoice> {
  if (invoice.status === 'paid') return invoice;
  try {
    return await payInvoiceOffSession(stripeSecretKey, invoiceId);
  } catch (err) {
    let latest = invoice;
    try {
      latest = await retrieveInvoice(stripeSecretKey, invoiceId);
    } catch {
      // Keep the last known invoice and fall through to the paid check.
    }
    if (latest.status !== 'paid') console.error('[domain-renewal] off-session pay failed:', err);
    return latest;
  }
}

/**
 * Invoice the workspace for one year of renewal and, on a successful
 * off-session charge, renew at Realtime Register.
 */
export async function chargeAndRenewDomain(
  db: Database,
  rtr: RealtimeRegistrar,
  masterDb: MasterDatabase,
  params: {
    domainId: string;
    workspaceId: string;
    stripeSecretKey: string;
    /** Skip the charge when the invoice is already paid (webhook path). */
    alreadyPaidInvoiceId?: string;
  },
): Promise<DomainRenewalChargeResult> {
  const deps: RenewalDeps = { db, rtr };
  const [domain] = await db
    .select()
    .from(hostDomains)
    .where(and(eq(hostDomains.id, params.domainId), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (!domain) return { ok: false, reason: 'not_found' };
  const expiresAt = domain.expiresAt;
  if (domain.registrar !== 'realtimeregister' || !expiresAt) {
    return { ok: false, reason: 'unsupported' };
  }

  if (domain.registrationStatus === 'pending_renewal') {
    const settled = await settlePendingRenewal(deps, domain);
    if (settled) return settled;
  }

  if (isAlreadyRenewed(domain, expiresAt, params.alreadyPaidInvoiceId)) {
    return { ok: false, reason: 'already_renewed' };
  }

  const pricingMap = await loadPricingMap(masterDb);
  const tld = tldOf(domain.fullDomain);
  const pricing = pricingMap.get(tld);
  const amountCents = renewalPriceCents({ tld, pricing });
  if (amountCents === null || amountCents <= 0) return { ok: false, reason: 'no_price' };
  const currency = (pricing?.currency ?? 'usd').toLowerCase();

  const meta = renewalMeta(domain.metadata);
  const stored = await loadStoredInvoice(
    params.stripeSecretKey,
    params.alreadyPaidInvoiceId ??
      (storedInvoiceAppliesToExpiry(meta, expiresAt) ? meta.stripeRenewalInvoiceId : null),
    params.alreadyPaidInvoiceId,
  );
  let { invoiceId, invoice } = stored;

  if (params.alreadyPaidInvoiceId || invoice?.status === 'paid') {
    const paidId = params.alreadyPaidInvoiceId ?? invoice!.id;
    await persistRenewalInvoiceMeta(db, domain.id, domain.metadata ?? {}, paidId, expiresAt);
    return renewPaidDomain(deps, domain, expiresAt, paidId);
  }

  const customer = await lookupWorkspaceStripeCustomer(masterDb, params.workspaceId);
  if (!customer) return { ok: false, reason: 'no_customer' };

  if (!invoiceId || !invoice) {
    invoice = await createDomainRenewalInvoice(params.stripeSecretKey, {
      customerId: customer.stripeCustomerId,
      amountCents,
      currency,
      description: `Domain renewal: ${domain.fullDomain} (1 year)`,
      idempotencyKey: `weldhost-renew:${domain.id}:${expiresAtKey(expiresAt)}`,
      metadata: {
        kind: DOMAIN_RENEWAL_INVOICE_KIND,
        domainId: domain.id,
        workspaceId: params.workspaceId,
        fullDomain: domain.fullDomain,
        renewalForExpiresAt: expiresAtKey(expiresAt),
      },
    });
    invoiceId = invoice.id;
    await persistRenewalInvoiceMeta(db, domain.id, domain.metadata ?? {}, invoiceId, expiresAt);
  }

  if (!invoiceId) return { ok: false, reason: 'payment_failed' };

  const paid = await payRenewalInvoice(params.stripeSecretKey, invoiceId, invoice);
  if (paid.status !== 'paid') return { ok: false, reason: 'payment_failed' };

  return renewPaidDomain(deps, domain, expiresAt, invoiceId);
}

/** Drop a pending renewal invoice when the customer turns auto-renew off. */
export async function voidPendingRenewalInvoice(
  db: Database,
  stripeSecretKey: string,
  domainId: string,
): Promise<void> {
  const [domain] = await db
    .select({ metadata: hostDomains.metadata })
    .from(hostDomains)
    .where(and(eq(hostDomains.id, domainId), isNull(hostDomains.deletedAt)))
    .limit(1);
  const invoiceId = renewalMeta(domain?.metadata).stripeRenewalInvoiceId;
  if (!invoiceId) return;
  try {
    const invoice = await retrieveInvoice(stripeSecretKey, invoiceId);
    if (invoice.status === 'open' || invoice.status === 'draft') {
      await voidInvoice(stripeSecretKey, invoiceId);
    }
  } catch (err) {
    if (isDefiniteStripeFailure(err)) {
      console.warn('[domain-renewal] pending invoice already gone:', err);
      return;
    }
    throw err;
  }
}
