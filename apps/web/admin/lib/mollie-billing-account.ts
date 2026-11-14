// The Mollie side of a workspace on a Kubernetes edition (ADR BILL-014), from
// its master `billing_accounts` row and the open charge joined to it. Kept out
// of billing-data.ts (server-only) so it can be tested on its own.

import type { MollieBillingAccount } from './billing-types';

/** The `billing_accounts` columns the console reads, and the joined plan and charge. */
export interface MollieAccountRow {
  account: {
    customerId: string | null;
    mandateId: string | null;
    mandateMethod: string | null;
    mandateLabel: string | null;
    unitAmount: number | null;
    currency: string;
    anchorDay: number | null;
    nextChargeAt: Date | null;
    scheduledPlanId: string | null;
    scheduledSeats: number | null;
    scheduledCycle: string | null;
    pastDueSince: Date | null;
    pastDuePaymentId: string | null;
    dunningRemindedAt: Date | null;
  };
  scheduledPlanName: string | null;
  chargeId: string | null;
  chargeProviderPaymentId: string | null;
  chargeAmount: number | null;
  chargeCurrency: string | null;
  chargeStatus: string | null;
  chargeFailureMessage: string | null;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toMollieBillingAccount(row: MollieAccountRow): MollieBillingAccount {
  const a = row.account;
  const hasSchedule = a.scheduledPlanId !== null || a.scheduledSeats !== null || a.scheduledCycle !== null;
  // The open charge's row may be gone; its id is still worth showing.
  const chargeId = row.chargeId ?? a.pastDuePaymentId;
  return {
    customerId: a.customerId,
    mandateId: a.mandateId,
    mandateMethod: a.mandateMethod,
    mandateLabel: a.mandateLabel,
    unitAmount: a.unitAmount,
    currency: a.currency,
    anchorDay: a.anchorDay,
    nextChargeAt: iso(a.nextChargeAt),
    scheduled: hasSchedule
      ? { planId: a.scheduledPlanId, planName: row.scheduledPlanName, seats: a.scheduledSeats, cycle: a.scheduledCycle }
      : null,
    pastDue: a.pastDueSince
      ? {
          since: a.pastDueSince.toISOString(),
          remindedAt: iso(a.dunningRemindedAt),
          charge: chargeId
            ? {
                id: chargeId,
                providerPaymentId: row.chargeProviderPaymentId,
                amount: row.chargeAmount,
                currency: row.chargeCurrency,
                status: row.chargeStatus,
                failureMessage: row.chargeFailureMessage,
              }
            : null,
        }
      : null,
  };
}
