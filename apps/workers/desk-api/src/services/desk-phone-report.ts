/**
 * WeldDesk call KPIs: how the phone queue did over a period (inbound calls
 * offered to the team, answered, missed, abandoned, left on voicemail, how
 * long callers waited and agents talked), aggregated from `voip_calls`.
 *
 * Same rules as the other reports (ADR DESK-011): periods are whole UTC days,
 * `start` inclusive and `end` exclusive, every value is computed and rounded
 * in SQL (the Rust backend runs the same statements), durations are whole
 * seconds. A call belongs to the period its caller started waiting in
 * (`queue_entered_at`); calls that never reached the team (no
 * `queue_entered_at`) are not counted.
 *
 * - wait time of an answered call: `agent_answered_at - queue_entered_at`;
 * - time to abandon: `ended_at - queue_entered_at`;
 * - handle time of an answered call: `ended_at - agent_answered_at`;
 * - longest wait: the longest of those waits (answered, or ended unanswered).
 */

import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import {
  deskOverviewUnit,
  deskReportPeriod,
  deskReportRangeOf,
  previousDeskReportPeriod,
  type DeskReportPair,
  type DeskReportPeriod,
  type DeskReportRange,
} from './desk-reports';

export interface DeskPhoneReport {
  range: DeskReportRange;
  /** UTC day, inclusive. */
  start: string;
  /** UTC day, exclusive. */
  end: string;
  bucket: 'day' | 'week' | 'month';
  kpis: {
    offered: DeskReportPair<number>;
    answered: DeskReportPair<number>;
    missed: DeskReportPair<number>;
    abandoned: DeskReportPair<number>;
    voicemail: DeskReportPair<number>;
    answerRate: DeskReportPair<number | null>;
    waitAvg: DeskReportPair<number | null>;
    waitMedian: DeskReportPair<number | null>;
    abandonAvg: DeskReportPair<number | null>;
    handleAvg: DeskReportPair<number | null>;
    handleMedian: DeskReportPair<number | null>;
    longestWait: DeskReportPair<number | null>;
  };
  series: Array<{ date: string; offered: number; answered: number; missed: number; abandoned: number }>;
  agents: Array<{ id: string; name: string; answered: number; handleAvg: number | null; handleTotal: number }>;
  teams: Array<{
    id: string | null;
    name: string | null;
    offered: number;
    answered: number;
    missed: number;
    abandoned: number;
    waitAvg: number | null;
  }>;
  hours: Array<{ hour: number; offered: number; answered: number }>;
}

const AGENTS_LIMIT = 50;

type Row = Record<string, unknown>;

async function rowsOf(db: Database, query: SQL): Promise<Row[]> {
  const result = await db.execute(query);
  return ((result as unknown as { rows?: Row[] }).rows ?? (result as unknown as Row[])) || [];
}

const num = (value: unknown): number => (value == null ? 0 : Number(value));
const numOrNull = (value: unknown): number | null => (value == null ? null : Number(value));
const stringOrNull = (value: unknown): string | null => (value == null ? null : String(value));
const dateKey = (d: Date) => d.toISOString().slice(0, 10);

const ENTERED = sql`v.queue_entered_at`;

const inPeriod = (period: DeskReportPeriod) =>
  sql`(${ENTERED} >= ${period.start.toISOString()}::timestamp and ${ENTERED} < ${period.end.toISOString()}::timestamp)`;

/** Seconds from one timestamp column to another. */
const secondsBetween = (from: SQL, to: SQL) => sql`extract(epoch from (${to} - ${from}))`;

const WAIT = secondsBetween(ENTERED, sql`v.agent_answered_at`);
const ABANDON_WAIT = secondsBetween(ENTERED, sql`v.ended_at`);
const HANDLE = secondsBetween(sql`v.agent_answered_at`, sql`v.ended_at`);
const ANY_WAIT = secondsBetween(ENTERED, sql`coalesce(v.agent_answered_at, v.ended_at)`);

const OUTCOME_ANSWERED = sql`v.outcome = 'answered'`;
const ANSWERED_WITH_WAIT = sql`v.outcome = 'answered' and v.agent_answered_at is not null`;
const ANSWERED_WITH_HANDLE = sql`v.outcome = 'answered' and v.agent_answered_at is not null and v.ended_at is not null`;
const ABANDONED_WITH_WAIT = sql`v.outcome = 'abandoned' and v.ended_at is not null`;

/** The first day a call waited, for `all_time`. */
async function firstCall(db: Database): Promise<Date | null> {
  const [row] = await rowsOf(db, sql`select to_char(min(queue_entered_at), 'YYYY-MM-DD') as first from voip_calls`);
  const first = row?.first;
  return first == null ? null : new Date(`${String(first)}T00:00:00.000Z`);
}

/** The KPI aggregates of one period, as SQL select items suffixed `_<suffix>`. */
function kpiColumns(period: DeskReportPeriod, suffix: string): SQL {
  const s = sql.raw(suffix);
  const within = inPeriod(period);
  return sql`
    count(*) filter (where ${within})::int as offered_${s},
    count(*) filter (where ${within} and ${OUTCOME_ANSWERED})::int as answered_${s},
    count(*) filter (where ${within} and v.outcome = 'missed')::int as missed_${s},
    count(*) filter (where ${within} and v.outcome = 'abandoned')::int as abandoned_${s},
    count(*) filter (where ${within} and v.outcome = 'voicemail')::int as voicemail_${s},
    round(100.0 * count(*) filter (where ${within} and ${OUTCOME_ANSWERED}) / nullif(count(*) filter (where ${within}), 0), 1)::float8 as rate_${s},
    round(avg(${WAIT}) filter (where ${within} and ${ANSWERED_WITH_WAIT}))::int as wait_avg_${s},
    round(percentile_cont(0.5) within group (order by ${WAIT}) filter (where ${within} and ${ANSWERED_WITH_WAIT}))::int as wait_median_${s},
    round(avg(${ABANDON_WAIT}) filter (where ${within} and ${ABANDONED_WITH_WAIT}))::int as abandon_avg_${s},
    round(avg(${HANDLE}) filter (where ${within} and ${ANSWERED_WITH_HANDLE}))::int as handle_avg_${s},
    round(percentile_cont(0.5) within group (order by ${HANDLE}) filter (where ${within} and ${ANSWERED_WITH_HANDLE}))::int as handle_median_${s},
    round(max(${ANY_WAIT}) filter (where ${within} and coalesce(v.agent_answered_at, v.ended_at) is not null))::int as longest_${s}`;
}

export async function deskPhoneReport(db: Database, rangeValue: unknown, now: Date): Promise<DeskPhoneReport> {
  const range = deskReportRangeOf(rangeValue);
  const period = deskReportPeriod(range, now, range === 'all_time' ? await firstCall(db) : null);
  const previous = previousDeskReportPeriod(period);
  const unit = deskOverviewUnit(period);
  const within = inPeriod(period);

  const [totalsRows, seriesRows, agentRows, teamRows, hourRows] = await Promise.all([
    rowsOf(
      db,
      sql`select ${kpiColumns(period, 'cur')}, ${kpiColumns(previous, 'prev')}
        from voip_calls v
        where ${ENTERED} >= ${previous.start.toISOString()}::timestamp and ${ENTERED} < ${period.end.toISOString()}::timestamp`,
    ),
    rowsOf(
      db,
      sql`with buckets as (
          select generate_series(
            date_trunc(${sql.raw(`'${unit}'`)}, ${period.start.toISOString()}::timestamp),
            ${period.end.toISOString()}::timestamp - interval '1 millisecond',
            interval ${sql.raw(`'1 ${unit}'`)}
          ) as bucket
        ),
        calls as (
          select date_trunc(${sql.raw(`'${unit}'`)}, ${ENTERED}) as bucket,
            count(*)::int as offered,
            count(*) filter (where ${OUTCOME_ANSWERED})::int as answered,
            count(*) filter (where v.outcome = 'missed')::int as missed,
            count(*) filter (where v.outcome = 'abandoned')::int as abandoned
          from voip_calls v where ${within} group by 1
        )
        select to_char(b.bucket, 'YYYY-MM-DD') as date,
          coalesce(c.offered, 0) as offered, coalesce(c.answered, 0) as answered,
          coalesce(c.missed, 0) as missed, coalesce(c.abandoned, 0) as abandoned
        from buckets b left join calls c on c.bucket = b.bucket
        order by b.bucket`,
    ),
    rowsOf(
      db,
      sql`select v.answered_by_user_id as id, coalesce(max(wm.name), max(wm.email), v.answered_by_user_id) as name,
          count(*)::int as answered,
          round(avg(${HANDLE}) filter (where ${ANSWERED_WITH_HANDLE}))::int as handle_avg,
          coalesce(round(sum(${HANDLE}) filter (where ${ANSWERED_WITH_HANDLE}))::int, 0) as handle_total
        from voip_calls v
        left join workspace_members wm on wm.user_id = v.answered_by_user_id
        where ${within} and ${OUTCOME_ANSWERED} and v.answered_by_user_id is not null
        group by v.answered_by_user_id
        order by 3 desc, 2 asc, 1 asc
        limit ${sql.raw(String(AGENTS_LIMIT))}`,
    ),
    rowsOf(
      db,
      sql`select v.department_id as id, max(dp.name) as name,
          count(*)::int as offered,
          count(*) filter (where ${OUTCOME_ANSWERED})::int as answered,
          count(*) filter (where v.outcome = 'missed')::int as missed,
          count(*) filter (where v.outcome = 'abandoned')::int as abandoned,
          round(avg(${WAIT}) filter (where ${ANSWERED_WITH_WAIT}))::int as wait_avg
        from voip_calls v
        left join helpdesk_departments dp on dp.id = v.department_id
        where ${within}
        group by v.department_id
        order by 3 desc, 2 asc nulls last, 1 asc nulls last`,
    ),
    rowsOf(
      db,
      sql`with calls as (
          select extract(hour from ${ENTERED})::int as hour,
            count(*)::int as offered,
            count(*) filter (where ${OUTCOME_ANSWERED})::int as answered
          from voip_calls v where ${within} group by 1
        )
        select h.hour, coalesce(c.offered, 0) as offered, coalesce(c.answered, 0) as answered
        from generate_series(0, 23) as h(hour)
        left join calls c on c.hour = h.hour
        order by h.hour`,
    ),
  ]);

  const t = totalsRows[0] ?? {};
  const pair = <T>(value: T, previousValue: T): DeskReportPair<T> => ({ value, previous: previousValue });
  const count = (key: string) => pair(num(t[`${key}_cur`]), num(t[`${key}_prev`]));
  const nullable = (key: string) => pair(numOrNull(t[`${key}_cur`]), numOrNull(t[`${key}_prev`]));

  return {
    range,
    start: dateKey(period.start),
    end: dateKey(period.end),
    bucket: unit === 'week' || unit === 'month' ? unit : 'day',
    kpis: {
      offered: count('offered'),
      answered: count('answered'),
      missed: count('missed'),
      abandoned: count('abandoned'),
      voicemail: count('voicemail'),
      answerRate: nullable('rate'),
      waitAvg: nullable('wait_avg'),
      waitMedian: nullable('wait_median'),
      abandonAvg: nullable('abandon_avg'),
      handleAvg: nullable('handle_avg'),
      handleMedian: nullable('handle_median'),
      longestWait: nullable('longest'),
    },
    series: seriesRows.map((row) => ({
      date: String(row.date),
      offered: num(row.offered),
      answered: num(row.answered),
      missed: num(row.missed),
      abandoned: num(row.abandoned),
    })),
    agents: agentRows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      answered: num(row.answered),
      handleAvg: numOrNull(row.handle_avg),
      handleTotal: num(row.handle_total),
    })),
    teams: teamRows.map((row) => ({
      id: stringOrNull(row.id),
      name: stringOrNull(row.name),
      offered: num(row.offered),
      answered: num(row.answered),
      missed: num(row.missed),
      abandoned: num(row.abandoned),
      waitAvg: numOrNull(row.wait_avg),
    })),
    hours: hourRows.map((row) => ({ hour: num(row.hour), offered: num(row.offered), answered: num(row.answered) })),
  };
}

