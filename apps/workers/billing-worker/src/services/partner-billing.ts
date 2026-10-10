/**
 * Partner statements: the Stripe invoice for a monthly statement, voiding it,
 * and what an `invoice.paid` does to the partner.
 *
 * Reseller licensing (docs/plans/reseller-licensing.md). The pricing itself is
 * `buildStatement` in @weldsuite/core-domain/partners; this file turns a saved
 * statement into a `send_invoice` Stripe invoice on the partner's customer and
 * keeps the statement row in step with it. Every step is safe to repeat: a
 * statement that already has a draft invoice replaces it, one that has an open
 * invoice adopts it.
 */

import { and, eq } from 'drizzle-orm';
import {
  buildStatement,
  invalidateWorkspaceContexts,
  getPartner,
  loadStatementView,
  markStatementPaidByInvoice,
  partnerWorkspaceOrgIds,
  recomputePartnerStatus,
  saveStatement,
} from '@weldsuite/core-domain/partners';
import { fromCents, toCents } from '@weldsuite/app-api-client/schemas/partners';
import type { Env } from '../index';
import { type getMasterDb, masterSchema } from '../lib/db';
import { PARTNER_TARGET, SYSTEM_ACTOR, recordAdminAudit } from '../lib/admin-audit';
import { createStripeCustomer, updateStripeCustomer } from '../lib/stripe';
import {
  type PartnerStripeInvoice,
  createPartnerDraftInvoice,
  createPartnerInvoiceItem,
  deletePartnerDraftInvoice,
  finalizePartnerInvoice,
  retrievePartnerInvoice,
  sendPartnerInvoice,
  voidPartnerInvoice,
} from '../lib/stripe-partner';
import { AdminBillingError } from './admin-billing';

const { partnerStatements, partnerStatementLines } = masterSchema;

type MasterDb = ReturnType<typeof getMasterDb>;
type StatementRow = typeof partnerStatements.$inferSelect;
type PartnerRow = NonNullable<Awaited<ReturnType<typeof getPartner>>>;

/** Invoice items are created a few at a time: fast enough, gentle on Stripe's rate limit. */
const ITEM_BATCH = 8;

function stripeKey(env: Env): string {
  if (!env.STRIPE_SECRET_KEY) throw new AdminBillingError('NOT_CONFIGURED', 'Stripe is not configured');
  return env.STRIPE_SECRET_KEY;
}

function isStripeNotFound(err: unknown): boolean {
  return err instanceof Error && /^Stripe API \S+ \S+ failed \(404\)/.test(err.message);
}

// ============================================================================
// Periods
// ============================================================================

/** `YYYY-MM` → the UTC calendar month [start, end). Null when it is not a real month. */
export function parsePeriod(value: string | undefined | null): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec((value ?? '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < 2020 || year > 2100 || month < 1 || month > 12) return null;
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

export function periodKey(start: Date): string {
  return start.toISOString().slice(0, 7);
}

// ============================================================================
// Caches
// ============================================================================

/** Drop the cached workspace contexts of every workspace of a partner (status changes). */
export async function invalidatePartnerWorkspaceCaches(env: Env, masterDb: MasterDb, partnerId: string): Promise<number> {
  const orgIds = await partnerWorkspaceOrgIds(masterDb, partnerId);
  await invalidateWorkspaceContexts(env.WORKSPACE_CACHE, orgIds);
  return orgIds.length;
}

// ============================================================================
// Stripe customer
// ============================================================================

/** The partner's Stripe customer, created on first use. */
export async function ensurePartnerStripeCustomer(
  env: Env,
  masterDb: MasterDb,
  partner: PartnerRow,
  idempotencyKey: string,
): Promise<string> {
  if (partner.stripeCustomerId) return partner.stripeCustomerId;
  const key = stripeKey(env);
  const customer = (await createStripeCustomer(
    key,
    {
      name: partner.legalName || partner.name,
      email: partner.billingEmail,
      metadata: { partnerId: partner.id, kind: 'partner' },
    },
    idempotencyKey,
  )) as { id: string };
  await masterDb
    .update(masterSchema.partners)
    .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
    .where(eq(masterSchema.partners.id, partner.id));
  if (partner.country) {
    try {
      await updateStripeCustomer(key, customer.id, { address: { country: partner.country } });
    } catch (err) {
      console.warn(`[Partner Billing] Could not set the country of Stripe customer ${customer.id}:`, err);
    }
  }
  return customer.id;
}

// ============================================================================
// Invoice a statement
// ============================================================================

export type InvoiceOutcome = 'invoiced' | 'no_charge' | 'paid' | 'already_invoiced';

interface StatementLineItem {
  amountCents: number;
  description: string;
}

/** What one statement becomes on the invoice: the licence charge and extra credits, per workspace. */
export function statementInvoiceItems(
  lines: ReadonlyArray<{
    workspaceName: string;
    daysActive: number;
    daysInPeriod: number;
    due: string;
    extraCreditsAmount: string;
  }>,
  period: string,
): StatementLineItem[] {
  const items: StatementLineItem[] = [];
  for (const line of lines) {
    const due = toCents(line.due);
    const extra = toCents(line.extraCreditsAmount);
    const licence = due - extra;
    if (licence > 0) {
      items.push({
        amountCents: licence,
        description: `${line.workspaceName}, ${period} (${line.daysActive}/${line.daysInPeriod} days)`,
      });
    }
    if (extra > 0) {
      items.push({ amountCents: extra, description: `${line.workspaceName}, extra credits ${period}` });
    }
  }
  return items;
}

function snapshotNumber(statement: StatementRow, key: string): number | null {
  const value = statement.contractSnapshot?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function recordInvoiced(masterDb: MasterDb, statement: StatementRow, invoice: PartnerStripeInvoice, termsDays: number) {
  const dueAt = invoice.due_date ? new Date(invoice.due_date * 1000) : new Date(Date.now() + termsDays * 86_400_000);
  const [updated] = await masterDb
    .update(partnerStatements)
    .set({
      status: 'invoiced',
      stripeInvoiceId: invoice.id,
      stripeInvoiceUrl: invoice.hosted_invoice_url ?? null,
      stripeInvoicePdf: invoice.invoice_pdf ?? null,
      dueAt,
      updatedAt: new Date(),
    })
    .where(eq(partnerStatements.id, statement.id))
    .returning();
  return updated!;
}

/**
 * Turn a `final` statement into a Stripe invoice on the partner's customer:
 * invoice items per line (plus extra credits), `send_invoice` on the
 * contract's net terms, finalised and sent. A statement with nothing to charge
 * stays `final` without an invoice. `keyBase` scopes the Stripe idempotency
 * keys (the admin request id, or a cron-derived key).
 */
export async function invoiceStatement(
  env: Env,
  masterDb: MasterDb,
  statementId: string,
  keyBase: string,
): Promise<{ outcome: InvoiceOutcome; statement: StatementRow }> {
  const [statement] = await masterDb.select().from(partnerStatements).where(eq(partnerStatements.id, statementId)).limit(1);
  if (!statement) throw new AdminBillingError('NOT_FOUND', 'Statement not found');
  if (statement.status === 'invoiced') return { outcome: 'already_invoiced', statement };
  if (statement.status === 'paid') return { outcome: 'paid', statement };
  if (statement.status === 'void') throw new AdminBillingError('CONFLICT', 'This statement was voided');

  const totalCents = toCents(statement.totalDue);
  if (totalCents <= 0) return { outcome: 'no_charge', statement };

  const partner = await getPartner(masterDb, statement.partnerId);
  if (!partner) throw new AdminBillingError('NOT_FOUND', 'Partner not found');

  const key = stripeKey(env);
  const period = periodKey(statement.periodStart);
  const termsDays = snapshotNumber(statement, 'paymentTermsDays') ?? 30;
  const customerId = await ensurePartnerStripeCustomer(env, masterDb, partner, `${keyBase}:customer`);

  // A retry: look at what the previous attempt left in Stripe.
  if (statement.stripeInvoiceId) {
    let existing: PartnerStripeInvoice | null = null;
    try {
      existing = await retrievePartnerInvoice(key, statement.stripeInvoiceId);
    } catch (err) {
      if (!isStripeNotFound(err)) throw err;
    }
    if (existing?.status === 'paid') {
      const paid = await markStatementPaidByInvoice(masterDb, existing.id, new Date());
      if (paid) await afterPaymentOrVoid(env, masterDb, paid.partnerId);
      const [row] = await masterDb.select().from(partnerStatements).where(eq(partnerStatements.id, statement.id));
      return { outcome: 'paid', statement: row! };
    }
    if (existing?.status === 'open') {
      // Finalised before the statement row was updated: adopt it when it is the same amount.
      if ((existing.total ?? existing.amount_due) === totalCents) {
        return { outcome: 'invoiced', statement: await recordInvoiced(masterDb, statement, existing, termsDays) };
      }
      await voidPartnerInvoice(key, existing.id, `${keyBase}:void-stale`);
    } else if (existing?.status === 'draft') {
      await deletePartnerDraftInvoice(key, existing.id);
    }
  }

  const lines = await masterDb
    .select()
    .from(partnerStatementLines)
    .where(eq(partnerStatementLines.statementId, statement.id))
    .orderBy(partnerStatementLines.workspaceName);
  const items = statementInvoiceItems(lines, period);
  const itemsTotal = items.reduce((sum, i) => sum + i.amountCents, 0);
  if (itemsTotal !== totalCents) {
    // Never invoice a total that differs from the statement the partner can see.
    throw new AdminBillingError(
      'CONFLICT',
      `Statement ${statement.id} lines add up to ${fromCents(itemsTotal)}, not ${statement.totalDue}. Re-run the statement.`,
    );
  }

  const draft = await createPartnerDraftInvoice(
    key,
    {
      customerId,
      currency: statement.currency,
      // Stripe wants at least one day on a send_invoice invoice.
      daysUntilDue: Math.max(1, termsDays),
      description: `WeldSuite partner statement ${period}`,
      metadata: { kind: 'partner_statement', statementId: statement.id, partnerId: partner.id, period },
    },
    `${keyBase}:invoice`,
  );
  // Remember the draft before anything else, so a failure below is retried against it.
  await masterDb
    .update(partnerStatements)
    .set({ stripeInvoiceId: draft.id, updatedAt: new Date() })
    .where(eq(partnerStatements.id, statement.id));

  for (let i = 0; i < items.length; i += ITEM_BATCH) {
    await Promise.all(
      items.slice(i, i + ITEM_BATCH).map((item, j) =>
        createPartnerInvoiceItem(
          key,
          {
            customerId,
            invoiceId: draft.id,
            amountCents: item.amountCents,
            currency: statement.currency,
            description: item.description,
          },
          `${keyBase}:item:${i + j}`,
        ),
      ),
    );
  }

  const finalized = await finalizePartnerInvoice(key, draft.id, `${keyBase}:finalize`);
  try {
    await sendPartnerInvoice(key, draft.id, `${keyBase}:send`);
  } catch (err) {
    // The invoice is open and payable from its hosted page; the partner sees it in the portal too.
    console.error(`[Partner Billing] Invoice ${draft.id} finalised but not emailed:`, err);
  }
  return { outcome: 'invoiced', statement: await recordInvoiced(masterDb, statement, finalized, termsDays) };
}

// ============================================================================
// Run a statement
// ============================================================================

export type RunStatementAction = 'invoiced' | 'finalized_no_charge' | 'paid' | 'unchanged' | 'skipped_void';

export interface RunStatementResult {
  action: RunStatementAction;
  statement: StatementRow;
}

/**
 * Build, save as `final` and invoice a partner's statement for a finished
 * period. A statement that is already invoiced or paid is left untouched
 * (`unchanged`); a voided one is only re-run when `reopenVoided` (an admin's
 * explicit run), otherwise it is skipped.
 */
export async function runPartnerStatement(
  env: Env,
  masterDb: MasterDb,
  input: { partnerId: string; period: { start: Date; end: Date }; keyBase: string; reopenVoided: boolean; now?: Date },
): Promise<RunStatementResult> {
  const { partnerId, period } = input;
  const now = input.now ?? new Date();
  if (period.end.getTime() > now.getTime()) {
    throw new AdminBillingError('BAD_REQUEST', 'That month has not ended yet. Statements are run for finished months.');
  }
  const partner = await getPartner(masterDb, partnerId);
  if (!partner) throw new AdminBillingError('NOT_FOUND', 'Partner not found');

  const [existing] = await masterDb
    .select()
    .from(partnerStatements)
    .where(and(eq(partnerStatements.partnerId, partnerId), eq(partnerStatements.periodStart, period.start)))
    .limit(1);
  if (existing && (existing.status === 'invoiced' || existing.status === 'paid')) {
    return { action: 'unchanged', statement: existing };
  }
  if (existing?.status === 'void') {
    if (!input.reopenVoided) return { action: 'skipped_void', statement: existing };
    // Back to a draft so it can be rebuilt; its voided Stripe invoice stays in Stripe.
    await masterDb
      .update(partnerStatements)
      .set({
        status: 'draft',
        stripeInvoiceId: null,
        stripeInvoiceUrl: null,
        stripeInvoicePdf: null,
        dueAt: null,
        paidAt: null,
        updatedAt: new Date(),
      })
      .where(eq(partnerStatements.id, existing.id));
  }

  const built = await buildStatement(masterDb, partnerId, period);
  const saved = await saveStatement(masterDb, built, 'final');
  const { outcome, statement } = await invoiceStatement(env, masterDb, saved.id, input.keyBase);
  const action: RunStatementAction =
    outcome === 'invoiced' ? 'invoiced' : outcome === 'no_charge' ? 'finalized_no_charge' : outcome === 'paid' ? 'paid' : 'unchanged';
  return { action, statement };
}

// ============================================================================
// Void
// ============================================================================

/**
 * Void a statement and its Stripe invoice (a draft invoice is deleted instead).
 * A paid statement cannot be voided. The partner's payment status is
 * recomputed, because the voided invoice may have been the overdue one.
 */
export async function voidPartnerStatement(
  env: Env,
  masterDb: MasterDb,
  input: { partnerId: string; statementId: string; keyBase: string },
): Promise<StatementRow> {
  const [statement] = await masterDb
    .select()
    .from(partnerStatements)
    .where(and(eq(partnerStatements.id, input.statementId), eq(partnerStatements.partnerId, input.partnerId)))
    .limit(1);
  if (!statement) throw new AdminBillingError('NOT_FOUND', 'Statement not found');
  if (statement.status === 'paid') throw new AdminBillingError('CONFLICT', 'A paid statement cannot be voided');
  if (statement.status === 'void') throw new AdminBillingError('CONFLICT', 'This statement is already void');

  if (statement.stripeInvoiceId) {
    const key = stripeKey(env);
    let invoice: PartnerStripeInvoice | null = null;
    try {
      invoice = await retrievePartnerInvoice(key, statement.stripeInvoiceId);
    } catch (err) {
      if (!isStripeNotFound(err)) throw err;
    }
    if (invoice?.status === 'paid') {
      const paid = await markStatementPaidByInvoice(masterDb, invoice.id, new Date());
      if (paid) await afterPaymentOrVoid(env, masterDb, paid.partnerId);
      throw new AdminBillingError('CONFLICT', 'The Stripe invoice has already been paid. The statement is now marked paid.');
    }
    if (invoice?.status === 'open') await voidPartnerInvoice(key, invoice.id, `${input.keyBase}:void`);
    else if (invoice?.status === 'draft') await deletePartnerDraftInvoice(key, invoice.id);
  }

  const [voided] = await masterDb
    .update(partnerStatements)
    .set({ status: 'void', updatedAt: new Date() })
    .where(eq(partnerStatements.id, statement.id))
    .returning();
  await afterPaymentOrVoid(env, masterDb, input.partnerId);
  return voided!;
}

// ============================================================================
// Payment
// ============================================================================

/**
 * Recompute the partner's payment status after a statement was paid or voided:
 * `active` again when nothing is overdue. Drops the workspace caches when the
 * status changed, so read-only lifts at once instead of after the KV TTL.
 */
export async function afterPaymentOrVoid(env: Env, masterDb: MasterDb, partnerId: string): Promise<void> {
  const evaluation = await recomputePartnerStatus(masterDb, partnerId);
  if (!evaluation?.changed) return;
  const workspaces = await invalidatePartnerWorkspaceCaches(env, masterDb, partnerId);
  await recordAdminAudit(masterDb, {
    actor: SYSTEM_ACTOR,
    workspaceId: null,
    targetType: PARTNER_TARGET,
    targetId: partnerId,
    action: 'partner.status.auto',
    outcome: 'success',
    reason: 'Statement paid or voided',
    details: { from: evaluation.previousStatus, to: evaluation.state.status, workspaces },
  });
}

/**
 * `invoice.paid` for a partner statement: mark it paid and recompute the
 * partner's status. A replayed webhook finds the statement already paid, and
 * still recomputes, so a first attempt that died halfway is completed.
 */
export async function handlePartnerInvoicePaid(env: Env, masterDb: MasterDb, stripeInvoiceId: string): Promise<void> {
  const paid = await markStatementPaidByInvoice(masterDb, stripeInvoiceId, new Date());
  let partnerId = paid?.partnerId ?? null;
  if (!partnerId) {
    const [row] = await masterDb
      .select({ partnerId: partnerStatements.partnerId })
      .from(partnerStatements)
      .where(eq(partnerStatements.stripeInvoiceId, stripeInvoiceId))
      .limit(1);
    partnerId = row?.partnerId ?? null;
  }
  if (!partnerId) {
    console.warn(`[Partner Billing] invoice.paid for ${stripeInvoiceId}, but no partner statement has it`);
    return;
  }
  if (paid) {
    await recordAdminAudit(masterDb, {
      actor: SYSTEM_ACTOR,
      workspaceId: null,
      targetType: PARTNER_TARGET,
      targetId: partnerId,
      action: 'statement.paid',
      outcome: 'success',
      details: { statementId: paid.statementId, stripeInvoiceId },
    });
  }
  await afterPaymentOrVoid(env, masterDb, partnerId);
}

/** `invoice.voided` in Stripe (not through the admin console): the statement is void too. */
export async function handlePartnerInvoiceVoided(env: Env, masterDb: MasterDb, stripeInvoiceId: string): Promise<void> {
  const rows = await masterDb
    .update(partnerStatements)
    .set({ status: 'void', updatedAt: new Date() })
    .where(and(eq(partnerStatements.stripeInvoiceId, stripeInvoiceId), eq(partnerStatements.status, 'invoiced')))
    .returning({ id: partnerStatements.id, partnerId: partnerStatements.partnerId });
  const row = rows[0];
  if (!row) return;
  await recordAdminAudit(masterDb, {
    actor: SYSTEM_ACTOR,
    workspaceId: null,
    targetType: PARTNER_TARGET,
    targetId: row.partnerId,
    action: 'statement.void',
    outcome: 'success',
    reason: 'Invoice voided in Stripe',
    details: { statementId: row.id, stripeInvoiceId },
  });
  await afterPaymentOrVoid(env, masterDb, row.partnerId);
}

/** A saved statement with its lines for the admin console. */
export async function statementViewFor(masterDb: MasterDb, partnerId: string, statementId: string) {
  const [row] = await masterDb
    .select({ partnerId: partnerStatements.partnerId })
    .from(partnerStatements)
    .where(eq(partnerStatements.id, statementId))
    .limit(1);
  if (!row || row.partnerId !== partnerId) throw new AdminBillingError('NOT_FOUND', 'Statement not found');
  const view = await loadStatementView(masterDb, statementId);
  if (!view) throw new AdminBillingError('NOT_FOUND', 'Statement not found');
  return view;
}
