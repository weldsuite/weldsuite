import 'server-only';

import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { getMasterDb, masterSchema } from './db';
import {
  PARTICIPATING_STATUSES,
  STALLED_STATUSES,
  fillPlacementDays,
  isPoolStatus,
  lastUtcDays,
  likePattern,
  startOfUtcDay,
  type PlacementDay,
  type PoolStatus,
} from './warmup-network';

const pool = masterSchema.reachWarmupMailboxes;
const messages = masterSchema.reachWarmupMessages;
const workspaces = masterSchema.workspaces;

/**
 * Read side of the Warmup network screen (docs/plans/weldreach-warmup.md). The
 * pool and its messages live in the master DB, so everything here is a master
 * query; the warmup worker is the only writer besides the pause and resume
 * actions of this console.
 *
 * The mailbox logins (`smtp_credentials`, `imap_credentials`) are sealed with a
 * key this console does not have, and no query below selects them: every
 * column is listed explicitly instead of selecting the table.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows the long tables show; the screen says when there are more. */
export const MAILBOX_TABLE_LIMIT = 200;
const GROUP_TABLE_LIMIT = 100;
const PROBLEM_TABLE_LIMIT = 100;
export const TREND_DAYS = 7;

const participating = sql<number>`count(*) filter (where ${inArray(pool.status, [...PARTICIPATING_STATUSES])})::int`;
const stalled = sql<number>`count(*) filter (where ${inArray(pool.status, [...STALLED_STATUSES])})::int`;

export interface PoolGroupRow {
  key: string;
  label: string;
  /** Mailboxes taking part: waiting, warming or maintaining. */
  participating: number;
  /** Mailboxes in the pool that are not: paused or in error. */
  stalled: number;
}

export interface PoolOverview {
  byStatus: Record<PoolStatus, number>;
  /** Distinct domains among the mailboxes that take part (what the planner needs 3 of). */
  participatingDomains: number;
  byDomain: PoolGroupRow[];
  byType: PoolGroupRow[];
  byWorkspace: PoolGroupRow[];
  /** Domains and workspaces beyond the table limit. */
  hiddenDomains: number;
  hiddenWorkspaces: number;
}

function byParticipating(a: PoolGroupRow, b: PoolGroupRow): number {
  return b.participating - a.participating || b.stalled - a.stalled || a.label.localeCompare(b.label);
}

export async function getPoolOverview(): Promise<PoolOverview> {
  const db = getMasterDb();
  const inPool = ne(pool.status, 'removed');

  const [statusRows, domainRows, typeRows, workspaceRows] = await Promise.all([
    db.select({ status: pool.status, n: sql<number>`count(*)::int` }).from(pool).groupBy(pool.status),
    db.select({ domain: pool.domain, participating, stalled }).from(pool).where(inPool).groupBy(pool.domain),
    db.select({ type: pool.mailboxType, participating, stalled }).from(pool).where(inPool).groupBy(pool.mailboxType),
    db
      .select({ workspaceId: pool.workspaceId, name: workspaces.name, participating, stalled })
      .from(pool)
      .leftJoin(workspaces, eq(workspaces.id, pool.workspaceId))
      .where(inPool)
      .groupBy(pool.workspaceId, workspaces.name),
  ]);

  const byStatus: Record<PoolStatus, number> = {
    waiting: 0,
    warming: 0,
    maintaining: 0,
    paused: 0,
    error: 0,
    removed: 0,
  };
  for (const row of statusRows) if (isPoolStatus(row.status)) byStatus[row.status] = Number(row.n);

  const domains = domainRows
    .map((row) => ({ key: row.domain, label: row.domain, participating: Number(row.participating), stalled: Number(row.stalled) }))
    .sort(byParticipating);
  const types = typeRows
    .map((row) => ({ key: row.type, label: row.type, participating: Number(row.participating), stalled: Number(row.stalled) }))
    .sort(byParticipating);
  const workspaceGroups = workspaceRows
    .map((row) => ({
      key: row.workspaceId,
      label: row.name ?? row.workspaceId,
      participating: Number(row.participating),
      stalled: Number(row.stalled),
    }))
    .sort(byParticipating);

  return {
    byStatus,
    participatingDomains: domains.filter((row) => row.participating > 0).length,
    byDomain: domains.slice(0, GROUP_TABLE_LIMIT),
    byType: types,
    byWorkspace: workspaceGroups.slice(0, GROUP_TABLE_LIMIT),
    hiddenDomains: Math.max(0, domains.length - GROUP_TABLE_LIMIT),
    hiddenWorkspaces: Math.max(0, workspaceGroups.length - GROUP_TABLE_LIMIT),
  };
}

export interface TodayVolume {
  /** UTC day these counts are for, `YYYY-MM-DD`. */
  day: string;
  /** Emails the planner scheduled for today. */
  planned: number;
  /** Emails actually sent today. */
  sent: number;
  /** Emails an engager has checked today (landed in inbox, spam or missing). */
  engaged: number;
  /** Emails scheduled for today that failed to send. */
  failed: number;
}

export async function getTodayVolume(now: Date = new Date()): Promise<TodayVolume> {
  const db = getMasterDb();
  const start = startOfUtcDay(now);
  const end = new Date(start.getTime() + DAY_MS);
  const today = (column: typeof messages.scheduledAt | typeof messages.sentAt | typeof messages.engagedAt): SQL | undefined =>
    and(gte(column, start), lt(column, end));

  const [row] = await db
    .select({
      planned: sql<number>`count(*) filter (where ${today(messages.scheduledAt)})::int`,
      sent: sql<number>`count(*) filter (where ${today(messages.sentAt)})::int`,
      engaged: sql<number>`count(*) filter (where ${today(messages.engagedAt)})::int`,
      failed: sql<number>`count(*) filter (where ${messages.status} = 'failed' and ${today(messages.scheduledAt)})::int`,
    })
    .from(messages)
    .where(or(gte(messages.scheduledAt, start), gte(messages.sentAt, start), gte(messages.engagedAt, start)));

  return {
    day: start.toISOString().slice(0, 10),
    planned: Number(row?.planned ?? 0),
    sent: Number(row?.sent ?? 0),
    engaged: Number(row?.engaged ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}

/**
 * Where warmup mail landed, per UTC day of sending, for the last `TREND_DAYS`
 * days. Mail sent but not yet checked by an engager counts as `pending`.
 */
export async function getPlacementTrend(now: Date = new Date()): Promise<PlacementDay[]> {
  const db = getMasterDb();
  const days = lastUtcDays(TREND_DAYS, now);
  const since = new Date(`${days[0]}T00:00:00.000Z`);
  const day = sql<string>`to_char(timezone('UTC', ${messages.sentAt}), 'YYYY-MM-DD')`;

  const rows = await db
    .select({
      day,
      inbox: sql<number>`count(*) filter (where ${messages.placement} = 'inbox')::int`,
      spam: sql<number>`count(*) filter (where ${messages.placement} = 'spam')::int`,
      missing: sql<number>`count(*) filter (where ${messages.placement} = 'missing')::int`,
      pending: sql<number>`count(*) filter (where ${messages.placement} is null)::int`,
    })
    .from(messages)
    .where(and(isNotNull(messages.sentAt), gte(messages.sentAt, since)))
    .groupBy(day)
    .orderBy(asc(day));

  return fillPlacementDays(
    rows.map((row) => ({
      day: row.day,
      inbox: Number(row.inbox),
      spam: Number(row.spam),
      missing: Number(row.missing),
      pending: Number(row.pending),
    })),
    days,
  );
}

/** One pool mailbox as the screen shows it. Never carries a login. */
export interface PoolMailboxRow {
  id: string;
  workspaceId: string;
  workspaceName: string | null;
  email: string;
  domain: string;
  mailboxType: string;
  status: PoolStatus;
  rampDay: number;
  dailyTarget: number;
  startedAt: string | null;
  inboxRate3d: number | null;
  inboxRate7d: number | null;
  sent7d: number;
  spamRescues7d: number;
  pausedReason: string | null;
  lastLoginError: string | null;
  lastLoginErrorAt: string | null;
  updatedAt: string;
}

/** The only pool columns this console reads: everything except the sealed logins. */
const mailboxColumns = {
  id: pool.id,
  workspaceId: pool.workspaceId,
  workspaceName: workspaces.name,
  email: pool.email,
  domain: pool.domain,
  mailboxType: pool.mailboxType,
  status: pool.status,
  rampDay: pool.rampDay,
  dailyTarget: pool.dailyTarget,
  startedAt: pool.startedAt,
  stats: pool.stats,
  pausedReason: pool.pausedReason,
  lastLoginError: pool.lastLoginError,
  lastLoginErrorAt: pool.lastLoginErrorAt,
  updatedAt: pool.updatedAt,
};

type MailboxQueryRow = {
  id: string;
  workspaceId: string;
  workspaceName: string | null;
  email: string;
  domain: string;
  mailboxType: string;
  status: PoolStatus;
  rampDay: number;
  dailyTarget: number;
  startedAt: Date | null;
  stats: typeof pool.$inferSelect.stats;
  pausedReason: string | null;
  lastLoginError: string | null;
  lastLoginErrorAt: Date | null;
  updatedAt: Date;
};

function toMailboxRow(row: MailboxQueryRow): PoolMailboxRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    email: row.email,
    domain: row.domain,
    mailboxType: row.mailboxType,
    status: row.status,
    rampDay: row.rampDay,
    dailyTarget: row.dailyTarget,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    inboxRate3d: row.stats?.inboxRate3d ?? null,
    inboxRate7d: row.stats?.inboxRate7d ?? null,
    sent7d: row.stats?.sent7d ?? 0,
    spamRescues7d: row.stats?.spamRescues7d ?? 0,
    pausedReason: row.pausedReason,
    lastLoginError: row.lastLoginError,
    lastLoginErrorAt: row.lastLoginErrorAt ? row.lastLoginErrorAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Mailboxes that are paused or in error, most recently changed first. */
export async function listProblemMailboxes(): Promise<PoolMailboxRow[]> {
  const db = getMasterDb();
  const rows = await db
    .select(mailboxColumns)
    .from(pool)
    .leftJoin(workspaces, eq(workspaces.id, pool.workspaceId))
    .where(inArray(pool.status, [...STALLED_STATUSES]))
    .orderBy(desc(pool.updatedAt))
    .limit(PROBLEM_TABLE_LIMIT);
  return rows.map(toMailboxRow);
}

export interface MailboxListResult {
  rows: PoolMailboxRow[];
  /** Rows that match the search, before the table limit. */
  total: number;
}

/** The pool's mailboxes (not the removed ones), by email, optionally narrowed by a search on email, domain or workspace. */
export async function listPoolMailboxes(search: string): Promise<MailboxListResult> {
  const db = getMasterDb();
  const conditions: SQL[] = [ne(pool.status, 'removed')];
  const term = search.trim();
  if (term) {
    const pattern = likePattern(term);
    const match = or(ilike(pool.email, pattern), ilike(pool.domain, pattern), ilike(workspaces.name, pattern));
    if (match) conditions.push(match);
  }
  const where = and(...conditions);

  const [rows, [count]] = await Promise.all([
    db
      .select(mailboxColumns)
      .from(pool)
      .leftJoin(workspaces, eq(workspaces.id, pool.workspaceId))
      .where(where)
      .orderBy(asc(pool.email))
      .limit(MAILBOX_TABLE_LIMIT),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(pool)
      .leftJoin(workspaces, eq(workspaces.id, pool.workspaceId))
      .where(where),
  ]);

  return { rows: rows.map(toMailboxRow), total: Number(count?.n ?? 0) };
}
