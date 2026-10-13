/**
 * The WeldReach overview numbers, and the "sent today" counts the send
 * engine and the overview share.
 *
 * "Today" starts at midnight in the workspace's default timezone
 * (`reach_settings.default_timezone`). A send counts from the moment its
 * message row exists, so a crash mid-send still uses up the day's allowance.
 */

import { and, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit';
import type { ReachOverview } from '@weldsuite/app-api-client/schemas/reach';
import { reachCampaigns, reachEnrollments, reachMailboxes, reachMessages } from '@weldsuite/db/schema';
import { addMinutes, getZonedParts, startOfZonedDay, zonedTimeToUtc } from '../lib/send-window';
import { loadReachSettings } from './campaigns';

export const DEFAULT_DAY_TIMEZONE = 'Europe/Amsterdam';

/** Outbound emails that left, or may have left, since `dayStart`. */
export function sentTodayCondition(dayStart: Date) {
  return and(
    eq(reachMessages.direction, 'out'),
    or(
      gte(reachMessages.sentAt, dayStart),
      and(
        isNull(reachMessages.sentAt),
        inArray(reachMessages.status, ['sending', 'unknown']),
        gte(reachMessages.createdAt, dayStart),
      ),
    ),
  );
}

export interface SentToday {
  byMailbox: Map<string, number>;
  /** Campaign emails only (replies typed in the inbox have no campaign). */
  byCampaign: Map<string, number>;
  total: number;
}

export async function countSentToday(db: Database, dayStart: Date): Promise<SentToday> {
  const rows = await db
    .select({
      mailboxId: reachMessages.mailboxId,
      campaignId: reachMessages.campaignId,
      n: sql<number>`count(*)::int`,
    })
    .from(reachMessages)
    .where(sentTodayCondition(dayStart))
    .groupBy(reachMessages.mailboxId, reachMessages.campaignId);

  const out: SentToday = { byMailbox: new Map(), byCampaign: new Map(), total: 0 };
  for (const row of rows) {
    const n = Number(row.n);
    out.total += n;
    out.byMailbox.set(row.mailboxId, (out.byMailbox.get(row.mailboxId) ?? 0) + n);
    if (row.campaignId) out.byCampaign.set(row.campaignId, (out.byCampaign.get(row.campaignId) ?? 0) + n);
  }
  return out;
}

const ratio = (num: number, den: number): number => (den <= 0 ? 0 : Math.min(1, Math.round((num / den) * 10_000) / 10_000));

/** `YYYY-MM-DD` of the wall-clock day of `date` in `timeZone`. */
function localDateKey(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

const SERIES_DAYS = 14;
const WINDOW_DAYS = 7;

export async function buildOverview(db: Database, now: Date = new Date()): Promise<ReachOverview> {
  const settings = await loadReachSettings(db);
  const tz = settings?.defaultTimezone ?? DEFAULT_DAY_TIMEZONE;

  const today = startOfZonedDay(now, tz);
  // Day starts, oldest first, built from the wall-clock calendar so a DST day is not 23 or 25 hours off.
  const local = getZonedParts(now, tz);
  const dayStarts: Date[] = [];
  for (let back = SERIES_DAYS - 1; back >= 0; back--) {
    const d = new Date(Date.UTC(local.year, local.month - 1, local.day - back));
    dayStarts.push(zonedTimeToUtc({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }, tz));
  }
  const seriesStart = dayStarts[0] ?? today;
  const windowStart = dayStarts[SERIES_DAYS - WINDOW_DAYS] ?? today;

  const dayOf = (col: typeof reachMessages.sentAt | typeof reachMessages.receivedAt) =>
    sql<string>`to_char(timezone(${tz}, ${col}), 'YYYY-MM-DD')`;

  const [sentRows, replyRows, interestedRows, bouncedRows, activeCampaignRows, mailboxRows, unreadRows] = await Promise.all([
    db
      .select({ day: dayOf(reachMessages.sentAt), n: sql<number>`count(*)::int` })
      .from(reachMessages)
      .where(and(eq(reachMessages.direction, 'out'), eq(reachMessages.status, 'sent'), gte(reachMessages.sentAt, seriesStart)))
      .groupBy(sql`1`),
    db
      .select({ day: dayOf(reachMessages.receivedAt), n: sql<number>`count(*)::int` })
      .from(reachMessages)
      .where(and(eq(reachMessages.direction, 'in'), eq(reachMessages.kind, 'reply'), gte(reachMessages.receivedAt, seriesStart)))
      .groupBy(sql`1`),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(reachMessages)
      .where(
        and(
          eq(reachMessages.direction, 'in'),
          eq(reachMessages.kind, 'reply'),
          inArray(reachMessages.label, ['interested', 'meeting_request']),
          gte(reachMessages.receivedAt, windowStart),
        ),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(reachEnrollments)
      .where(and(eq(reachEnrollments.status, 'bounced'), gte(reachEnrollments.updatedAt, windowStart))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(reachCampaigns)
      .where(and(eq(reachCampaigns.status, 'active'), isNull(reachCampaigns.deletedAt))),
    db
      .select({ status: reachMailboxes.status, n: sql<number>`count(*)::int` })
      .from(reachMailboxes)
      .where(and(isNull(reachMailboxes.deletedAt), ne(reachMailboxes.status, 'deleted')))
      .groupBy(reachMailboxes.status),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(reachMessages)
      .where(and(eq(reachMessages.direction, 'in'), eq(reachMessages.kind, 'reply'), isNull(reachMessages.readAt))),
  ]);

  const sentByDay = new Map(sentRows.map((r) => [r.day, Number(r.n)]));
  const repliesByDay = new Map(replyRows.map((r) => [r.day, Number(r.n)]));

  const daily = dayStarts.map((start) => {
    // Noon is inside the wall-clock day whatever the DST shift, so the key is the right date.
    const date = localDateKey(addMinutes(start, 12 * 60), tz);
    return { date, sent: sentByDay.get(date) ?? 0, replies: repliesByDay.get(date) ?? 0 };
  });

  const windowDays = daily.slice(-WINDOW_DAYS);
  const sent7d = windowDays.reduce((sum, d) => sum + d.sent, 0);
  const replies7d = windowDays.reduce((sum, d) => sum + d.replies, 0);
  const bounced7d = Number(bouncedRows[0]?.n ?? 0);

  const mailboxes = { active: 0, warming: 0, paused: 0, error: 0 };
  for (const row of mailboxRows) {
    const n = Number(row.n);
    if (row.status === 'active') mailboxes.active += n;
    else if (row.status === 'warming') mailboxes.warming += n;
    else if (row.status === 'paused' || row.status === 'suspended') mailboxes.paused += n;
    else if (row.status === 'error') mailboxes.error += n;
  }

  return {
    sentToday: daily[daily.length - 1]?.sent ?? 0,
    sent7d,
    replies7d,
    interested7d: Number(interestedRows[0]?.n ?? 0),
    bounceRate7d: ratio(bounced7d, sent7d),
    replyRate7d: ratio(replies7d, sent7d),
    activeCampaigns: Number(activeCampaignRows[0]?.n ?? 0),
    mailboxes,
    unreadReplies: Number(unreadRows[0]?.n ?? 0),
    daily,
  };
}
