/**
 * What a workspace may do in WeldReach right now: the access summary
 * (`GET /reach/access`: status, staff-set limits, live usage), and whether
 * sending may run at all (`maySend`: the approval and the billing state).
 *
 * The status, limits and billing state come from the master-DB access row
 * (`readAppAccess` / `getAppAccess` in worker-kit, handed in by the caller);
 * usage is counted in the tenant DB.
 */

import { and, count, eq, gte, isNull, ne } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import type { AppAccess } from '@weldsuite/worker-kit/app-access';
import {
  resolveWeldReachLimits,
  type AppAccessStatus,
  type ReachAccessSummary,
} from '@weldsuite/app-api-client/schemas/reach';
import { reachDomains, reachMailboxes, reachMessages } from '@weldsuite/db/schema';

/** Days a past-due WeldReach subscription keeps sending before campaigns pause. */
export const BILLING_GRACE_DAYS = 7;

/** Whether sending may run for this workspace right now. */
export function maySend(
  access: Pick<AppAccess, 'status' | 'billingStatus' | 'billingStatusAt'>,
  now = new Date(),
): { ok: true } | { ok: false; reason: string } {
  if (access.status !== 'approved') return { ok: false, reason: `access_${access.status}` };
  if (access.billingStatus === 'canceled') return { ok: false, reason: 'billing_canceled' };
  if (access.billingStatus === 'past_due') {
    const since = access.billingStatusAt ? new Date(access.billingStatusAt).getTime() : now.getTime();
    if (now.getTime() - since > BILLING_GRACE_DAYS * 86_400_000) return { ok: false, reason: 'billing_past_due' };
  }
  return { ok: true };
}

/** 00:00 UTC of `now`'s day: the boundary for "sends today". */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** 00:00 UTC of the day after `now`. Due-index times use it: the daily cron picks them up after midnight. */
export function utcTomorrow(now: Date): Date {
  return new Date(utcDayStart(now).getTime() + 86_400_000);
}

export interface ReachUsage {
  domains: number;
  /** Mailboxes that still exist (any status but deleted). */
  mailboxes: number;
  /** Outbound messages sent since 00:00 UTC. */
  sendsToday: number;
}

export async function getReachUsage(db: Database, now: Date = new Date()): Promise<ReachUsage> {
  const [domains, mailboxes, sends] = await Promise.all([
    db.select({ value: count() }).from(reachDomains),
    db
      .select({ value: count() })
      .from(reachMailboxes)
      .where(and(ne(reachMailboxes.status, 'deleted'), isNull(reachMailboxes.deletedAt))),
    db
      .select({ value: count() })
      .from(reachMessages)
      .where(
        and(
          eq(reachMessages.direction, 'out'),
          eq(reachMessages.status, 'sent'),
          gte(reachMessages.sentAt, utcDayStart(now)),
        ),
      ),
  ]);

  return {
    domains: domains[0]?.value ?? 0,
    mailboxes: mailboxes[0]?.value ?? 0,
    sendsToday: sends[0]?.value ?? 0,
  };
}

export interface AccessSummaryInput {
  db: Database;
  access: Pick<AppAccess, 'status' | 'limits'>;
  /** Flagship `weldreach-sending` (the global kill switch). */
  sendingEnabled: boolean;
  now?: Date;
}

export async function buildAccessSummary(input: AccessSummaryInput): Promise<ReachAccessSummary> {
  const usage = await getReachUsage(input.db, input.now);
  // The gate only lets approved workspaces through; 'none' cannot reach here.
  const status: AppAccessStatus = input.access.status === 'none' ? 'requested' : input.access.status;
  return {
    status,
    limits: resolveWeldReachLimits(input.access.limits),
    usage,
    sendingEnabled: input.sendingEnabled,
  };
}
