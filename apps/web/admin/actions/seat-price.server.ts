import '@tanstack/react-start/server-only';

import { and, eq } from 'drizzle-orm';
import { guardWrite } from '@/lib/auth';
import { consoleAuditRow } from '@/lib/audit';
import { formatCents } from '@/lib/billing-format';
import { inMasterTransaction, masterSchema } from '@/lib/db';
import { adminCopy, fill } from '@/lib/i18n';
import { mollieBillingCopy, type MollieBillingCopy } from '@/lib/mollie-billing-copy';
import {
  MAX_SEAT_PRICE_CENTS,
  listSeatPrice,
  seatPriceProblem,
  seatPriceRefusal,
  type SeatPriceProblem,
  type SeatPriceRefusal,
} from '@/lib/seat-price';
import type { ActionResult } from './workspaces';

/**
 * A workspace's seat price on Mollie (the Kubernetes editions, ADR BILL-014).
 * Staff replace `billing_accounts.unit_amount`, which the Rust renewal job
 * charges on every renewal until the customer changes plan or billing cycle
 * (rust/modules/core-billing/src/renewals.rs). The row is locked as the job
 * locks it, so a renewal running now finishes first, and the change and its
 * `admin_audit_events` row commit together. Any admin but a viewer may do it.
 */

const { workspaces, plans, billingAccounts, adminAuditEvents } = masterSchema;

/** The audit action, next to the CLI's `workspace.billing.comp` and the rest. */
export const SEAT_PRICE_AUDIT_ACTION = 'workspace.billing.seat_price';

type Errors = MollieBillingCopy['seatPriceDialog']['errors'];

function problemMessage(e: Errors, problem: SeatPriceProblem): string {
  switch (problem) {
    case 'format':
      return e.format;
    case 'zero':
      return e.zero;
    case 'too_high':
      return fill(e.tooHigh, { max: formatCents(MAX_SEAT_PRICE_CENTS, 'EUR') });
    case 'unchanged':
      return e.unchanged;
  }
}

function refusalMessage(e: Errors, refusal: SeatPriceRefusal, currency: string | undefined): string {
  switch (refusal) {
    case 'not_found':
      return e.notFound;
    case 'no_subscription':
      return e.noSubscription;
    case 'not_eur':
      return fill(e.notEur, { currency: currency ?? '—' });
  }
}

/** Sets the price per seat per billing cycle, in cents before VAT, from the next charge on. */
export async function setSeatPrice(input: {
  workspaceId: string;
  unitAmount: number;
  reason: string;
}): Promise<ActionResult<{ unitAmount: number; previous: number }>> {
  const e = mollieBillingCopy().seatPriceDialog.errors;
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  const reason = input.reason.trim();
  if (reason.length < 3) return { ok: false, error: adminCopy().staff.errors.reason };
  const invalid = seatPriceProblem(input.unitAmount, null);
  if (invalid) return { ok: false, error: problemMessage(e, invalid) };

  return inMasterTransaction(async (tx) => {
    const [account] = await tx
      .select({
        unitAmount: billingAccounts.unitAmount,
        currency: billingAccounts.currency,
        nextChargeAt: billingAccounts.nextChargeAt,
      })
      .from(billingAccounts)
      .where(and(eq(billingAccounts.workspaceId, input.workspaceId), eq(billingAccounts.provider, 'mollie')))
      .limit(1)
      .for('update');
    const [workspace] = await tx
      .select({
        planId: workspaces.planId,
        subscriptionStatus: workspaces.subscriptionStatus,
        subscriptionCycle: workspaces.subscriptionCycle,
        subscriptionCurrentPeriodEnd: workspaces.subscriptionCurrentPeriodEnd,
        purchasedSeats: workspaces.purchasedSeats,
        deletedAt: workspaces.deletedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1);

    const refusal = seatPriceRefusal({ workspace: workspace ?? null, account: account ?? null }, new Date());
    if (refusal || !account || !workspace) {
      return { ok: false as const, error: refusalMessage(e, refusal ?? 'not_found', account?.currency) };
    }
    const previous = account.unitAmount ?? 0;
    const problem = seatPriceProblem(input.unitAmount, previous);
    if (problem) return { ok: false as const, error: problemMessage(e, problem) };

    const [plan] = workspace.planId
      ? await tx
          .select({
            slug: plans.slug,
            priceMonthly: plans.priceMonthly,
            priceYearly: plans.priceYearly,
            currency: plans.currency,
          })
          .from(plans)
          .where(eq(plans.id, workspace.planId))
          .limit(1)
      : [];

    await tx
      .update(billingAccounts)
      .set({ unitAmount: input.unitAmount, updatedAt: new Date() })
      .where(eq(billingAccounts.workspaceId, input.workspaceId));
    await tx.insert(adminAuditEvents).values(
      consoleAuditRow({
        identity: guard.identity,
        action: SEAT_PRICE_AUDIT_ACTION,
        outcome: 'success',
        workspaceId: input.workspaceId,
        reason: reason.slice(0, 500),
        details: {
          from: previous,
          to: input.unitAmount,
          currency: account.currency,
          listPrice: listSeatPrice(plan, workspace.subscriptionCycle),
          planId: workspace.planId,
          cycle: workspace.subscriptionCycle,
          seats: workspace.purchasedSeats,
        },
      }),
    );
    return { ok: true as const, data: { unitAmount: input.unitAmount, previous } };
  });
}
