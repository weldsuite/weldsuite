/**
 * Clerk's side of the seat limit.
 *
 * Clerk's `max_allowed_memberships` is the hard gate behind every invite, but
 * only the billing paths (onboarding, Stripe webhooks, POST /billing/seats)
 * ever write it. A plan or seat change made any other way (SQL, the admin
 * console, a comped plan) leaves the old cap in Clerk, typically Free's single
 * seat, and the invite dialog then offers seats that Clerk refuses.
 *
 * Clerk counts memberships AND pending invitations against that cap, guests
 * included. Guests don't use a paid seat, so they are counted apart.
 */

import type { Env } from '../types';
import { logSafe } from '@weldsuite/worker-kit/log-safe';
import { syncClerkSeatLimit } from './billing';

const CLERK_API = 'https://api.clerk.com/v1';
const PAGE_SIZE = 100;

type ClerkListItem = { public_metadata?: Record<string, unknown> | null };

function isGuest(item: ClerkListItem): boolean {
  return item.public_metadata?.member_type === 'EXTERNAL_GUEST';
}

/**
 * Walk a Clerk list endpoint (memberships or invitations) and count its items,
 * guests apart from everyone else. Throws when Clerk can't be read.
 */
async function countClerkList(
  secretKey: string,
  url: string,
): Promise<{ guests: number; others: number }> {
  const separator = url.includes('?') ? '&' : '?';
  let guests = 0;
  let others = 0;
  let offset = 0;

  for (;;) {
    const res = await fetch(`${url}${separator}limit=${PAGE_SIZE}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    if (!res.ok) throw new Error(`Clerk list request failed: ${res.status}`);

    const page = (await res.json()) as { data?: ClerkListItem[]; total_count?: number };
    const items = page.data ?? [];
    for (const item of items) {
      if (isGuest(item)) guests += 1;
      else others += 1;
    }

    offset += items.length;
    if (items.length < PAGE_SIZE || offset >= (page.total_count ?? 0)) break;
  }

  return { guests, others };
}

/**
 * Pending invitations that will take a paid seat once accepted (guest
 * invitations excluded). Null when Clerk can't be read.
 */
export async function countPendingSeatInvitations(env: Env, orgId: string): Promise<number | null> {
  try {
    const { others } = await countClerkList(
      env.CLERK_SECRET_KEY,
      `${CLERK_API}/organizations/${orgId}/invitations?status=pending`,
    );
    return others;
  } catch (err) {
    console.warn('[clerk-seat-cap] Could not count pending invitations:', err);
    return null;
  }
}

/**
 * The `max_allowed_memberships` to write so Clerk allows what the plan allows,
 * or null when it already does.
 *
 * - No cap in Clerk: nothing to raise.
 * - No seat limit on the plan (`paidLimit` null): the cap goes. 0 clears it,
 *   which is what billing's calculateEffectiveSeatLimit writes for such a plan.
 * - Otherwise the plan's seats plus the slots guests take, since guests count
 *   against Clerk's cap but not against the plan.
 *
 * Only ever raises. A cap above the plan is left for billing to tighten.
 */
export function clerkCapForPlan(
  cap: number | null | undefined,
  paidLimit: number | null,
  guestSlots: number,
): number | null {
  if (!cap || cap <= 0) return null;
  if (paidLimit === null) return 0;
  const needed = paidLimit + guestSlots;
  return cap < needed ? needed : null;
}

/**
 * Raise Clerk's cap to what the plan allows, so a stale cap can't refuse a seat
 * the plan has. Called before an internal invite, once app-api's own seat check
 * has passed. Best effort: if Clerk can't be read or written the invite still
 * runs and Clerk's own answer is reported as before.
 */
export async function alignClerkCapWithPlan(
  env: Env,
  orgId: string,
  paidLimit: number | null,
): Promise<void> {
  try {
    const base = `${CLERK_API}/organizations/${orgId}`;
    const orgRes = await fetch(base, {
      headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
    });
    if (!orgRes.ok) return;
    const org = (await orgRes.json()) as { max_allowed_memberships?: number | null };
    const cap = org.max_allowed_memberships;
    if (!cap || cap <= 0) return;

    let guestSlots = 0;
    if (paidLimit !== null) {
      const [members, invitations] = await Promise.all([
        countClerkList(env.CLERK_SECRET_KEY, `${base}/memberships`),
        countClerkList(env.CLERK_SECRET_KEY, `${base}/invitations?status=pending`),
      ]);
      guestSlots = members.guests + invitations.guests;
    }

    const nextCap = clerkCapForPlan(cap, paidLimit, guestSlots);
    if (nextCap === null) return;

    console.warn(
      `[clerk-seat-cap] Clerk cap ${cap} for ${logSafe(orgId)} is below the plan, setting ${nextCap || 'no cap'}`,
    );
    await syncClerkSeatLimit(env.CLERK_SECRET_KEY, orgId, nextCap);
  } catch (err) {
    console.error('[clerk-seat-cap] Could not align the Clerk seat cap with the plan:', err);
  }
}
