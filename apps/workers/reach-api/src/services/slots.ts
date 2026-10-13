/**
 * Mailpool subscription slots.
 *
 * WeldSuite's single Mailpool account must hold a slot for every mailbox of
 * every workspace. Creating a mailbox first makes sure a slot is free
 * (`ensureSlotAvailable`); the daily reconciliation trims slots nobody uses any
 * more (`computeSlotAdjustments`, run by `cron/slot-reconciliation.ts`).
 *
 * Mailpool's published slot types are google | private | outlook. A type it does
 * not report a slot count for (`shared` today) is not slot-managed: nothing to
 * check on create, nothing to trim.
 */

import type { MailpoolClient } from '../lib/mailpool/client';
import type { MailpoolSlotType, MailpoolSubscriptionSlots } from '../lib/mailpool/types';

/** Slots beyond what is in use that the reconciliation leaves alone (in-flight creates, a mailbox just deleted). */
export const SLOT_SURPLUS_TOLERANCE = 2;

export const SLOT_TYPES: readonly MailpoolSlotType[] = ['google', 'shared', 'private', 'outlook'];

function isSlotType(value: string): value is MailpoolSlotType {
  return (SLOT_TYPES as readonly string[]).includes(value);
}

export interface SlotCheck {
  /** Mailpool reports slots for this type. */
  managed: boolean;
  /** A slot was added for the mailbox about to be created. */
  increased: boolean;
}

/** Make sure one more mailbox of `type` fits; adds a slot when the account is full. */
export async function ensureSlotAvailable(client: MailpoolClient, type: MailpoolSlotType): Promise<SlotCheck> {
  const { slots, mailboxes } = await client.getSlots();
  const total = slots[type];
  if (typeof total !== 'number') return { managed: false, increased: false };

  const used = mailboxes[type] ?? 0;
  if (used < total) return { managed: true, increased: false };

  await client.increaseSlots(type, 1);
  return { managed: true, increased: true };
}

export interface SlotAdjustment {
  type: MailpoolSlotType;
  /** Active WeldReach mailboxes of this type (master reach_routes). */
  need: number;
  /** Slots Mailpool says we pay for. */
  slots: number;
  /** Mailboxes Mailpool counts as in use, when it says. */
  usedAtMailpool: number | null;
  /** slots - need. Negative = we are short. */
  surplus: number;
  /** Slots to give back (0 unless the surplus exceeds the tolerance). */
  decreaseBy: number;
  /** Mailpool's in-use count differs from ours: logged for review. */
  drift: boolean;
}

/**
 * The slot adjustments for today: per type Mailpool reports slots for, decrease
 * the surplus when it exceeds SLOT_SURPLUS_TOLERANCE. A shortage is never
 * topped up here (creating a mailbox does that); it is reported as drift.
 */
export function computeSlotAdjustments(
  need: Readonly<Record<string, number>>,
  mailpool: MailpoolSubscriptionSlots,
): SlotAdjustment[] {
  const adjustments: SlotAdjustment[] = [];
  for (const [type, slots] of Object.entries(mailpool.slots)) {
    if (!isSlotType(type) || typeof slots !== 'number') continue;
    const wanted = need[type] ?? 0;
    const surplus = slots - wanted;
    const used = mailpool.mailboxes[type];
    adjustments.push({
      type,
      need: wanted,
      slots,
      usedAtMailpool: typeof used === 'number' ? used : null,
      surplus,
      decreaseBy: surplus > SLOT_SURPLUS_TOLERANCE ? surplus : 0,
      drift: surplus < 0 || (typeof used === 'number' && used !== wanted),
    });
  }
  return adjustments;
}
