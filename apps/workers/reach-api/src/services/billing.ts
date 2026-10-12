/**
 * Billing helpers for the account surface (the $5 per inbox subscription lives
 * in billing-worker; see lib/billing.ts for the contract).
 */

import type { ReachBilling } from '../lib/billing';

/**
 * Give an inbox back (Stripe quantity -1), trying a few times: by the time
 * this runs the mailbox is already gone (or never existed), so a lost
 * decrement means billing the customer for an inbox they do not have.
 * Never throws; a final failure is logged for the operator.
 */
export async function releaseInbox(billing: ReachBilling, mailboxId: string, attempts = 3): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      await billing.adjustInboxes(-1, mailboxId);
      return true;
    } catch (err) {
      if (i === attempts - 1) {
        console.error(`[reach-billing] could not release inbox ${mailboxId} after ${attempts} attempts:`, err);
      }
    }
  }
  return false;
}
