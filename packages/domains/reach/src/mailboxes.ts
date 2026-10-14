/**
 * Mailbox reads: the DTO a mailbox is shown as (warmup numbers from the
 * master pool included) and the "why is it not sending yet" blocker. The
 * lifecycle (create, rename, pause, delete: billing, Mailpool, the warmup pool)
 * is reach-api's.
 *
 * The warmup pool is read from the master DB, opened lazily through
 * `WarmupSource.master` so a list with no mailboxes (or a master outage) costs
 * nothing, and a worker that reaches master over Hyperdrive (external-api) can
 * hand in its own handle.
 */

import { and, count, eq, getTableColumns, gte, inArray, isNull, ne } from 'drizzle-orm';
import { omitSensitive } from '@weldsuite/db/lib/sensitive-columns';
import type { AnyMasterDatabase, Database } from '@weldsuite/worker-kit/db';
import {
  type ReachMailbox,
  type ReachMailboxStatus,
  type ReachWarmupBlocker,
} from '@weldsuite/app-api-client/schemas/reach';
import { reachDomains, reachMailboxes, reachMessages } from '@weldsuite/db/schema';
import { utcDayStart } from './access';
import { WARMUP_MIN_POOL_DOMAINS, warmupGate } from './warmup';
import { activePoolDomainCount, readPoolMailboxes, type PoolMailboxView } from './warmup-pool';

export type MailboxRow = typeof reachMailboxes.$inferSelect;
/** A mailbox row without its sealed logins. */
export type SafeMailboxRow = ReturnType<typeof withoutCredentials>;

export function withoutCredentials(row: MailboxRow) {
  return omitSensitive('reach_mailboxes', row);
}

const mailboxColumns = omitSensitive('reach_mailboxes', getTableColumns(reachMailboxes));

// ---------------------------------------------------------------------------
// What the pool says
// ---------------------------------------------------------------------------

/**
 * A login failed and has not been cleared. The warmup worker clears
 * `lastLoginError` (and its timestamp) when a login works again, so a set error
 * is a current one.
 */
export function hasLoginError(pool: Pick<PoolMailboxView, 'lastLoginError'>): boolean {
  return pool.lastLoginError !== null && pool.lastLoginError !== '';
}

/**
 * Why a warming mailbox may not join campaigns yet; null when it may (or is not
 * warming). `poolDomains` is the number of domains in the pool (null when
 * unknown): below WARMUP_MIN_POOL_DOMAINS the planner has nobody to pair with.
 */
export function warmupBlockerOf(
  mailbox: Pick<MailboxRow, 'status' | 'warmupDay' | 'warmupInboxRate'>,
  pool: PoolMailboxView | undefined,
  poolDomains: number | null,
): ReachWarmupBlocker | null {
  if (mailbox.status !== 'warming') return null;
  const gate = warmupGate({
    rampDay: pool ? pool.rampDay : mailbox.warmupDay,
    inboxRate3d: pool ? (pool.stats?.inboxRate3d ?? null) : mailbox.warmupInboxRate,
    hasLoginError: pool ? hasLoginError(pool) : false,
  });
  if (gate.ready) return null;
  // A login problem needs the customer; a small pool is the more useful news for everything else.
  if (gate.reason !== 'login_error' && poolDomains !== null && poolDomains < WARMUP_MIN_POOL_DOMAINS) return 'pool_too_small';
  return gate.reason;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** What the warmup pool adds to a mailbox's DTO. */
export interface WarmupView {
  sent7d: number;
  spamRescues7d: number;
  blocker: ReachWarmupBlocker | null;
}

const NO_WARMUP: WarmupView = { sent7d: 0, spamRescues7d: 0, blocker: null };

export function toMailboxDto(
  row: SafeMailboxRow,
  domainName: string,
  sentToday: number,
  warmup: WarmupView = NO_WARMUP,
): ReachMailbox {
  return {
    id: row.id,
    domainId: row.domainId,
    domainName,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    signature: row.signature,
    type: row.type,
    status: row.status,
    warmupDay: row.warmupDay,
    warmupStatus: row.warmupStatus,
    warmupInboxRate: row.warmupInboxRate,
    warmupSent7d: warmup.sent7d,
    warmupSpamRescues7d: warmup.spamRescues7d,
    warmupBlocker: warmup.blocker,
    dailyCap: row.dailyCap,
    rampCurrent: row.rampCurrent,
    sentToday,
    lastSentAt: row.lastSentAt ? row.lastSentAt.toISOString() : null,
    pausedReason: row.pausedReason,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

async function sentTodayByMailbox(db: Database, mailboxIds: string[], now: Date): Promise<Map<string, number>> {
  if (mailboxIds.length === 0) return new Map();
  const rows = await db
    .select({ mailboxId: reachMessages.mailboxId, value: count() })
    .from(reachMessages)
    .where(
      and(
        inArray(reachMessages.mailboxId, mailboxIds),
        eq(reachMessages.direction, 'out'),
        eq(reachMessages.status, 'sent'),
        gte(reachMessages.sentAt, utcDayStart(now)),
      ),
    )
    .groupBy(reachMessages.mailboxId);
  return new Map(rows.map((r) => [r.mailboxId, r.value]));
}

/**
 * Where a request reads the warmup pool: the master DB, opened lazily so a
 * list with no mailboxes (or a master outage) costs nothing.
 */
export interface WarmupSource {
  /** Clerk org id (the tenant key). */
  clerkOrgId: string;
  master: () => AnyMasterDatabase;
}

export interface MailboxReadDeps {
  db: Database;
  warmup: WarmupSource;
}

/**
 * The pool rows of the workspace plus the pool's domain count: at most two
 * master queries per request (the count only when a mailbox is warming).
 * Best effort: warmup numbers are decoration, so a master failure shows zeros
 * rather than failing the mailbox list.
 */
async function readWarmupViews(
  source: WarmupSource,
  rows: Array<Pick<MailboxRow, 'status'>>,
): Promise<{ pool: Map<string, PoolMailboxView>; poolDomains: number | null }> {
  const none = { pool: new Map<string, PoolMailboxView>(), poolDomains: null };
  if (rows.length === 0) return none;
  try {
    const master = source.master();
    const views = await readPoolMailboxes(master, source.clerkOrgId);
    const poolDomains = rows.some((r) => r.status === 'warming') ? await activePoolDomainCount(master) : null;
    return { pool: new Map(views.map((v) => [v.tenantMailboxId, v])), poolDomains };
  } catch (err) {
    console.warn('[reach-mailboxes] warmup pool unavailable:', err);
    return none;
  }
}

function warmupViewOf(
  row: SafeMailboxRow,
  views: { pool: Map<string, PoolMailboxView>; poolDomains: number | null },
): WarmupView {
  const pool = views.pool.get(row.id);
  return {
    sent7d: pool?.stats?.sent7d ?? 0,
    spamRescues7d: pool?.stats?.spamRescues7d ?? 0,
    blocker: warmupBlockerOf(row, pool, views.poolDomains),
  };
}

export interface ListMailboxesFilter {
  domainId?: string;
  status?: ReachMailboxStatus;
}

export async function listMailboxes(
  { db, warmup }: MailboxReadDeps,
  filter: ListMailboxesFilter = {},
  now: Date = new Date(),
): Promise<ReachMailbox[]> {
  const where =
    filter.status === 'deleted'
      ? [eq(reachMailboxes.status, 'deleted')]
      : [
          ne(reachMailboxes.status, 'deleted'),
          isNull(reachMailboxes.deletedAt),
          ...(filter.status ? [eq(reachMailboxes.status, filter.status)] : []),
        ];
  if (filter.domainId) where.push(eq(reachMailboxes.domainId, filter.domainId));

  const rows = await db
    .select({ ...mailboxColumns, domainName: reachDomains.name })
    .from(reachMailboxes)
    .leftJoin(reachDomains, eq(reachMailboxes.domainId, reachDomains.id))
    .where(and(...where))
    .orderBy(reachMailboxes.createdAt);

  const sent = await sentTodayByMailbox(db, rows.map((r) => r.id), now);
  const views = await readWarmupViews(warmup, rows);
  return rows.map(({ domainName, ...row }) => toMailboxDto(row, domainName ?? '', sent.get(row.id) ?? 0, warmupViewOf(row, views)));
}

export async function getMailboxDto(
  { db, warmup }: MailboxReadDeps,
  id: string,
  now: Date = new Date(),
): Promise<ReachMailbox | null> {
  const [row] = await db
    .select({ ...mailboxColumns, domainName: reachDomains.name })
    .from(reachMailboxes)
    .leftJoin(reachDomains, eq(reachMailboxes.domainId, reachDomains.id))
    .where(and(eq(reachMailboxes.id, id), ne(reachMailboxes.status, 'deleted')))
    .limit(1);
  if (!row) return null;
  const { domainName, ...mailbox } = row;
  const sent = await sentTodayByMailbox(db, [id], now);
  const views = await readWarmupViews(warmup, [mailbox]);
  return toMailboxDto(mailbox, domainName ?? '', sent.get(id) ?? 0, warmupViewOf(mailbox, views));
}
