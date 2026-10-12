/**
 * `GET /api/reach/access`: the workspace's access status, the staff-set limits
 * and live usage against them, for the module header and the limit hints.
 *
 * The status and limits come from the master-DB access row (via the gate's
 * `appAccess`); usage is counted in the tenant DB.
 */

import { and, count, eq, gte, isNull, ne } from 'drizzle-orm';
import type { Context } from 'hono';
import { getMasterDb, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { AppAccess } from '@weldsuite/worker-kit/app-access';
import {
  resolveWeldReachLimits,
  type AppAccessStatus,
  type ReachAccessSummary,
  type WeldReachLimits,
} from '@weldsuite/app-api-client/schemas/reach';
import type { Env, Variables } from '../types';
import { ReachServiceError } from './reach-errors';

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
    db.select({ value: count() }).from(schema.reachDomains),
    db
      .select({ value: count() })
      .from(schema.reachMailboxes)
      .where(and(ne(schema.reachMailboxes.status, 'deleted'), isNull(schema.reachMailboxes.deletedAt))),
    db
      .select({ value: count() })
      .from(schema.reachMessages)
      .where(
        and(
          eq(schema.reachMessages.direction, 'out'),
          eq(schema.reachMessages.status, 'sent'),
          gte(schema.reachMessages.sentAt, utcDayStart(now)),
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

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

/** Who is asking and what they may use, as the account services need it. */
export interface ReachAccountContext {
  db: Database;
  master: MasterDatabase;
  /** Clerk org id: the tenant key (`c.get('workspaceId')`). */
  clerkOrgId: string;
  /** Master `workspaces.id`, the owner of `reach_routes` rows. */
  masterWorkspaceId: string;
  userId: string;
  /** Staff-set limits from the approval. */
  limits: WeldReachLimits;
}

/** The services' context from a request that passed `appAccessGate('weldreach')`. */
export function accountContextOf(c: Context<{ Bindings: Env; Variables: Variables }>): ReachAccountContext {
  const access = c.get('appAccess');
  if (!access.workspaceId) {
    throw new ReachServiceError(403, 'WORKSPACE_NOT_FOUND', 'This workspace is not set up for WeldReach.');
  }
  return {
    db: c.get('tenantDb'),
    master: getMasterDb(c.env),
    clerkOrgId: c.get('workspaceId'),
    masterWorkspaceId: access.workspaceId,
    userId: c.get('userId'),
    limits: resolveWeldReachLimits(access.limits),
  };
}
