/**
 * Daily Mailpool slot reconciliation. MASTER DB ONLY: it never opens a tenant.
 *
 * WeldSuite's one Mailpool account pays for slots per mailbox type. The active
 * `mailpool_mailbox` rows in master `reach_routes` are what those slots should
 * cover; this gives back slots that exceed the need by more than
 * SLOT_SURPLUS_TOLERANCE and logs drift (a shortage, or Mailpool counting
 * another number of mailboxes than we do) so it can be looked at.
 *
 * It also logs the monthly Mailpool cost against the Stripe revenue of the same
 * mailboxes (plan: margin check).
 */

import { and, count, eq, isNotNull } from 'drizzle-orm';
import { getMasterDb, masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { WELDREACH_INBOX_PRICE_CENTS } from '@weldsuite/app-api-client/schemas/reach';
import { createMailpoolClient, type MailpoolClient } from '../lib/mailpool/client';
import { MailpoolNotConfiguredError } from '../lib/mailpool/errors';
import { computeSlotAdjustments, type SlotAdjustment } from '../services/slots';
import type { Env } from '../types';

/** What a mailbox costs WeldSuite per month at Mailpool, by type (docs/plans/weldreach.md, Billing). */
export const MAILPOOL_COST_CENTS_PER_MAILBOX: Readonly<Record<string, number>> = {
  shared: 300,
  google: 400,
};

export interface SlotReconciliationDeps {
  master?: MasterDatabase;
  mailpool?: MailpoolClient;
}

export interface SlotReconciliationReport {
  need: Record<string, number>;
  adjustments: SlotAdjustment[];
  /** Slots actually given back: type -> count. */
  decreased: Record<string, number>;
  failed: string[];
  monthlyCostCents: number;
  monthlyRevenueCents: number;
}

export async function activeMailboxesByType(master: MasterDatabase): Promise<Record<string, number>> {
  const rows = await master
    .select({ type: masterSchema.reachRoutes.mailboxType, value: count() })
    .from(masterSchema.reachRoutes)
    .where(
      and(
        eq(masterSchema.reachRoutes.kind, 'mailpool_mailbox'),
        eq(masterSchema.reachRoutes.status, 'active'),
        isNotNull(masterSchema.reachRoutes.mailboxType),
      ),
    )
    .groupBy(masterSchema.reachRoutes.mailboxType);

  const need: Record<string, number> = {};
  for (const row of rows) if (row.type) need[row.type] = row.value;
  return need;
}

export async function runSlotReconciliation(env: Env, deps: SlotReconciliationDeps = {}): Promise<SlotReconciliationReport | null> {
  let mailpool: MailpoolClient;
  try {
    mailpool = deps.mailpool ?? createMailpoolClient(env);
  } catch (err) {
    if (err instanceof MailpoolNotConfiguredError) {
      console.warn('[ReachSlots] MAILPOOL_API_KEY is not set; skipping');
      return null;
    }
    throw err;
  }
  const master = deps.master ?? getMasterDb(env);

  const need = await activeMailboxesByType(master);
  const adjustments = computeSlotAdjustments(need, await mailpool.getSlots());

  const decreased: Record<string, number> = {};
  const failed: string[] = [];
  for (const adjustment of adjustments) {
    if (adjustment.drift) {
      console.warn(
        `[ReachSlots] drift for ${adjustment.type}: need=${adjustment.need} slots=${adjustment.slots} usedAtMailpool=${adjustment.usedAtMailpool ?? 'unknown'}`,
      );
    }
    if (adjustment.decreaseBy <= 0) continue;
    try {
      await mailpool.decreaseSlots(adjustment.type, adjustment.decreaseBy);
      decreased[adjustment.type] = adjustment.decreaseBy;
      console.log(`[ReachSlots] gave back ${adjustment.decreaseBy} ${adjustment.type} slot(s) (need ${adjustment.need}, had ${adjustment.slots})`);
    } catch (err) {
      failed.push(adjustment.type);
      console.error(`[ReachSlots] could not decrease ${adjustment.type} slots by ${adjustment.decreaseBy}:`, err);
    }
  }

  const monthlyCostCents = Object.entries(need).reduce(
    (sum, [type, mailboxes]) => sum + mailboxes * (MAILPOOL_COST_CENTS_PER_MAILBOX[type] ?? 0),
    0,
  );
  const mailboxTotal = Object.values(need).reduce((sum, n) => sum + n, 0);
  const monthlyRevenueCents = mailboxTotal * WELDREACH_INBOX_PRICE_CENTS;
  console.log(
    `[ReachSlots] mailboxes=${mailboxTotal} mailpoolCost=$${(monthlyCostCents / 100).toFixed(2)}/mo revenue=$${(monthlyRevenueCents / 100).toFixed(2)}/mo`,
  );

  return { need, adjustments, decreased, failed, monthlyCostCents, monthlyRevenueCents };
}
