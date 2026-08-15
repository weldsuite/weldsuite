/**
 * Stripe-billed domain auto-renewal.
 *
 * Year 1 is a one-off Checkout (`mode=payment`). Auto-renew is a daily sweep
 * that invoices the workspace customer ~14 days before expiry, then calls
 * Realtime Register only after Stripe reports the invoice paid. Registrar
 * auto-renew stays off so RTR cannot bill WeldSuite independently.
 */

import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { schema, masterSchema, type Database, type MasterDatabase } from '../db';
import type { RealtimeRegistrar } from '@weldsuite/realtime-registrar';
import {
  createDomainRenewalInvoice,
  payInvoiceOffSession,
  retrieveInvoice,
  voidInvoice,
  isDefiniteStripeFailure,
  type StripeInvoice,
} from '../lib/stripe';
import { applyMarkup, pollRenewalProcess, renewDomain } from './domains';

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
  rtrRenewalProcessId: string | null;
} {
  const meta = metadata ?? {};
  return {
    stripeRenewalInvoiceId:
      typeof meta.stripeRenewalInvoiceId === 'string' ? meta.stripeRenewalInvoiceId : null,
    stripeRenewalForExpiresAt:
      typeof meta.stripeRenewalForExpiresAt === 'string' ? meta.stripeRenewalForExpiresAt : null,
    rtrRenewalProcessId:
      typeof meta.rtrRenewalProcessId === 'string' ? meta.rtrRenewalProcessId : null,
  };
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

export async function listDomainsDueForAutoRenew(
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
) {
  await db
    .update(hostDomains)
    .set({
      metadata: {
        ...metadata,
        stripeRenewalInvoiceId: invoiceId,
        stripeRenewalForExpiresAt: expiresAtKey(expiresAt),
      },
      updatedAt: new Date(),
    })
    .where(eq(hostDomains.id, domainId));
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
  const [domain] = await db
    .select()
    .from(hostDomains)
    .where(and(eq(hostDomains.id, params.domainId), isNull(hostDomains.deletedAt)))
    .limit(1);
  if (!domain) return { ok: false, reason: 'not_found' };
  if (domain.registrar !== 'realtimeregister') return { ok: false, reason: 'unsupported' };
  if (!domain.expiresAt) return { ok: false, reason: 'unsupported' };

  if (domain.registrationStatus === 'pending_renewal') {
    const polled = await pollRenewalProcess(db, rtr, domain.id);
    if (polled?.registrationStatus === 'renewed') {
      return { ok: true, invoiceId: renewalMeta(domain.metadata).stripeRenewalInvoiceId ?? '', renewed: true, pending: false };
    }
    if (polled?.registrationStatus === 'pending_renewal') {
      return {
        ok: true,
        invoiceId: renewalMeta(domain.metadata).stripeRenewalInvoiceId ?? '',
        renewed: false,
        pending: true,
      };
    }
  }

  const meta = renewalMeta(domain.metadata);
  if (
    meta.stripeRenewalForExpiresAt === expiresAtKey(domain.expiresAt) &&
    domain.registrationStatus === 'renewed'
  ) {
    return { ok: false, reason: 'already_renewed' };
  }

  const pricingMap = await loadPricingMap(masterDb);
  const tld = tldOf(domain.fullDomain);
  const pricing = pricingMap.get(tld);
  const amountCents = renewalPriceCents({ tld, pricing });
  if (amountCents === null || amountCents <= 0) return { ok: false, reason: 'no_price' };
  const currency = (pricing?.currency ?? 'usd').toLowerCase();

  let invoiceId = params.alreadyPaidInvoiceId ?? meta.stripeRenewalInvoiceId;
  let invoice: StripeInvoice | null = null;

  if (invoiceId && !params.alreadyPaidInvoiceId) {
    try {
      invoice = await retrieveInvoice(params.stripeSecretKey, invoiceId);
    } catch (err) {
      if (!isDefiniteStripeFailure(err)) throw err;
      invoiceId = null;
    }
  }

  if (invoice && (invoice.status === 'void' || invoice.status === 'uncollectible')) {
    invoiceId = null;
    invoice = null;
  }

  if (params.alreadyPaidInvoiceId || invoice?.status === 'paid') {
    const paidId = params.alreadyPaidInvoiceId ?? invoice!.id;
    await persistRenewalInvoiceMeta(
      db,
      domain.id,
      domain.metadata ?? {},
      paidId,
      domain.expiresAt,
    );
    const updated = await renewDomain(db, { rtr, cf: null }, { domainId: domain.id });
    if (!updated) return { ok: false, reason: 'not_found' };
    return {
      ok: true,
      invoiceId: paidId,
      renewed: updated.registrationStatus === 'renewed',
      pending: updated.registrationStatus === 'pending_renewal',
    };
  }

  const customer = await lookupWorkspaceStripeCustomer(masterDb, params.workspaceId);
  if (!customer) return { ok: false, reason: 'no_customer' };

  if (!invoiceId || !invoice) {
    const description = `Domain renewal: ${domain.fullDomain} (1 year)`;
    invoice = await createDomainRenewalInvoice(params.stripeSecretKey, {
      customerId: customer.stripeCustomerId,
      amountCents,
      currency,
      description,
      idempotencyKey: `weldhost-renew:${domain.id}:${expiresAtKey(domain.expiresAt)}`,
      metadata: {
        kind: DOMAIN_RENEWAL_INVOICE_KIND,
        domainId: domain.id,
        workspaceId: params.workspaceId,
        fullDomain: domain.fullDomain,
        renewalForExpiresAt: expiresAtKey(domain.expiresAt),
      },
    });
    invoiceId = invoice.id;
    await persistRenewalInvoiceMeta(
      db,
      domain.id,
      domain.metadata ?? {},
      invoiceId,
      domain.expiresAt,
    );
  }

  if (invoice.status !== 'paid') {
    try {
      invoice = await payInvoiceOffSession(params.stripeSecretKey, invoiceId);
    } catch (err) {
      try {
        invoice = await retrieveInvoice(params.stripeSecretKey, invoiceId);
      } catch {
        invoice = invoice;
      }
      if (invoice.status !== 'paid') {
        console.error('[domain-renewal] off-session pay failed:', err);
        return { ok: false, reason: 'payment_failed' };
      }
    }
  }

  if (invoice.status !== 'paid') {
    return { ok: false, reason: 'payment_failed' };
  }

  const updated = await renewDomain(db, { rtr, cf: null }, { domainId: domain.id });
  if (!updated) return { ok: false, reason: 'not_found' };
  return {
    ok: true,
    invoiceId,
    renewed: updated.registrationStatus === 'renewed',
    pending: updated.registrationStatus === 'pending_renewal',
  };
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
    console.warn('[domain-renewal] void pending invoice failed:', err);
  }
}
