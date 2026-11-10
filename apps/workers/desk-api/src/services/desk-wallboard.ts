/**
 * The WeldDesk wallboard: the queue as it is right now (open conversations,
 * who is waiting, SLA risk, the teams and agents carrying it, the phone
 * queue), for a screen the whole team looks at.
 *
 * Like the reports (ADR DESK-011) every number is computed and rounded in SQL
 * against one `now` that is passed in as a parameter, so the Rust backend,
 * which runs the same statements, answers alike. Durations are whole seconds;
 * "today" is the current UTC day, as the overview's `today` range counts it.
 * Merged duplicates (`merged_into_id` set) are never counted.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { deskReportPeriod } from './desk-reports';

export interface DeskWallboardDue {
  conversationId: string;
  conversationNumber: number;
  name: string | null;
  dueAt: string;
  metric: string | null;
  status: 'active' | 'warning' | 'breached';
  assigneeName: string | null;
}

export interface DeskWallboardPhone {
  waiting: number;
  longestWaitSeconds: number | null;
  availableAgents: number;
  answeredToday: number;
  /** Outcome `missed` plus `voicemail`. */
  missedToday: number;
  abandonedToday: number;
}

export interface DeskWallboard {
  generatedAt: string;
  queue: { open: number; unassigned: number; waiting: number; oldestWaitingSeconds: number | null };
  sla: { breached: number; atRisk: number; dueSoon: DeskWallboardDue[] };
  today: { created: number; resolved: number; firstResponseMedianSeconds: number | null };
  teams: Array<{ id: string; name: string; open: number; unassigned: number; waiting: number; breached: number }>;
  agents: Array<{ id: string; name: string; open: number; away: boolean }>;
  phone: DeskWallboardPhone | null;
}

const DUE_SOON_LIMIT = 8;
const AGENTS_LIMIT = 50;

type Row = Record<string, unknown>;

async function rowsOf(db: Database, query: SQL): Promise<Row[]> {
  const result = await db.execute(query);
  return ((result as unknown as { rows?: Row[] }).rows ?? (result as unknown as Row[])) || [];
}

const num = (value: unknown): number => (value == null ? 0 : Number(value));
const numOrNull = (value: unknown): number | null => (value == null ? null : Number(value));
const stringOrNull = (value: unknown): string | null => (value == null ? null : String(value));

const at = (date: Date) => sql`${date.toISOString()}::timestamp`;

/** Whether `teamId` names a team (helpdesk_departments row) that is not deleted. */
export async function deskTeamExists(db: Database, teamId: string): Promise<boolean> {
  const rows = await rowsOf(db, sql`select 1 as found from helpdesk_departments where id = ${teamId} and deleted_at is null`);
  return rows.length > 0;
}

export async function deskWallboard(db: Database, now: Date, teamId: string | null): Promise<DeskWallboard> {
  const nowAt = at(now);
  const today = deskReportPeriod('today', now, null);
  const todayStart = at(today.start);
  const todayEnd = at(today.end);
  const team = teamId ? sql`and c.department_id = ${teamId}` : sql.empty();
  const callTeam = teamId ? sql`and v.department_id = ${teamId}` : sql.empty();
  const departmentTeam = teamId ? sql`and d.id = ${teamId}` : sql.empty();

  const [queueRows, dueRows, todayRows, teamRows, agentRows, routeRows, callRows] = await Promise.all([
    rowsOf(
      db,
      sql`select
          count(*)::int as open,
          count(*) filter (where c.assignee_id is null)::int as unassigned,
          count(*) filter (where c.waiting_since is not null)::int as waiting,
          case when count(c.waiting_since) = 0 then null else greatest(0, round(extract(epoch from ${nowAt} - min(c.waiting_since)))::int) end as oldest,
          count(*) filter (where c.sla_status = 'breached')::int as breached,
          count(*) filter (where c.sla_status = 'warning')::int as at_risk
        from desk_conversations c
        where c.state = 'open' and c.merged_into_id is null ${team}`,
    ),
    rowsOf(
      db,
      sql`select c.id, c.conversation_number, c.name, to_char(c.sla_due_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as due_at,
          c.sla_metric as metric, c.sla_status as status,
          case when c.assignee_id is null then null else coalesce(wm.name, wm.email, c.assignee_id) end as assignee_name
        from desk_conversations c
        left join workspace_members wm on wm.user_id = c.assignee_id
        where c.state = 'open' and c.merged_into_id is null ${team}
          and c.sla_due_at is not null and c.sla_status in ('active', 'warning', 'breached')
        order by c.sla_due_at asc, c.id asc
        limit ${sql.raw(String(DUE_SOON_LIMIT))}`,
    ),
    rowsOf(
      db,
      sql`select
          count(*) filter (where c.created_at >= ${todayStart} and c.created_at < ${todayEnd})::int as created,
          count(*) filter (where c.resolved_at >= ${todayStart} and c.resolved_at < ${todayEnd})::int as resolved,
          round(percentile_cont(0.5) within group (order by c.first_response_seconds)
            filter (where c.first_response_at >= ${todayStart} and c.first_response_at < ${todayEnd} and c.first_response_seconds is not null))::int as frt_median
        from desk_conversations c
        where c.merged_into_id is null ${team}
          and (c.created_at >= ${todayStart} or c.resolved_at >= ${todayStart} or c.first_response_at >= ${todayStart})`,
    ),
    rowsOf(
      db,
      sql`select d.id, d.name,
          count(c.id)::int as open,
          count(c.id) filter (where c.assignee_id is null)::int as unassigned,
          count(c.id) filter (where c.waiting_since is not null)::int as waiting,
          count(c.id) filter (where c.sla_status = 'breached')::int as breached
        from helpdesk_departments d
        left join desk_conversations c on c.department_id = d.id and c.state = 'open' and c.merged_into_id is null
        where d.deleted_at is null and d.is_active ${departmentTeam}
        group by d.id, d.name
        order by 3 desc, d.name asc, d.id asc`,
    ),
    rowsOf(
      db,
      sql`with away as (
          select coalesce(
            (select hs.automation->'deskAssignment'->'awayMemberIds' from helpdesk_settings hs where hs.deleted_at is null limit 1),
            '[]'::jsonb
          ) as ids
        )
        select wm.user_id as id, coalesce(wm.name, wm.email, wm.user_id) as name,
          count(c.id)::int as open,
          coalesce(bool_or(away.ids @> to_jsonb(wm.user_id::text)), false) as away
        from workspace_members wm
        cross join away
        left join desk_conversations c on c.assignee_id = wm.user_id and c.state = 'open' and c.merged_into_id is null ${team}
        where wm.status = 'ACTIVE' and wm.member_type = 'INTERNAL' and wm.deleted_at is null
        group by wm.user_id, wm.name, wm.email
        order by 3 desc, 2 asc, 1 asc
        limit ${sql.raw(String(AGENTS_LIMIT))}`,
    ),
    rowsOf(db, sql`select count(*)::int as routes from desk_phone_routes where action in ('agents', 'menu')`),
    rowsOf(
      db,
      sql`select
          count(*) filter (where v.agent_answered_at is null and v.ended_at is null and v.outcome is null)::int as waiting,
          max(round(extract(epoch from ${nowAt} - v.queue_entered_at))::int)
            filter (where v.agent_answered_at is null and v.ended_at is null and v.outcome is null) as longest,
          count(*) filter (where v.queue_entered_at >= ${todayStart} and v.queue_entered_at < ${todayEnd} and v.outcome = 'answered')::int as answered_today,
          count(*) filter (where v.queue_entered_at >= ${todayStart} and v.queue_entered_at < ${todayEnd} and v.outcome in ('missed', 'voicemail'))::int as missed_today,
          count(*) filter (where v.queue_entered_at >= ${todayStart} and v.queue_entered_at < ${todayEnd} and v.outcome = 'abandoned')::int as abandoned_today,
          (select count(*)::int from desk_phone_agents pa where pa.available) as available_agents
        from voip_calls v
        where v.queue_entered_at is not null ${callTeam}
          and (v.queue_entered_at >= ${todayStart} or (v.agent_answered_at is null and v.ended_at is null and v.outcome is null))`,
    ),
  ]);

  const q = queueRows[0] ?? {};
  const t = todayRows[0] ?? {};
  const p = callRows[0] ?? {};
  const phoneEnabled = num(routeRows[0]?.routes) > 0;

  return {
    generatedAt: now.toISOString(),
    queue: {
      open: num(q.open),
      unassigned: num(q.unassigned),
      waiting: num(q.waiting),
      oldestWaitingSeconds: numOrNull(q.oldest),
    },
    sla: {
      breached: num(q.breached),
      atRisk: num(q.at_risk),
      dueSoon: dueRows.map((row) => ({
        conversationId: String(row.id),
        conversationNumber: num(row.conversation_number),
        name: stringOrNull(row.name),
        dueAt: String(row.due_at),
        metric: stringOrNull(row.metric),
        status: String(row.status) as DeskWallboardDue['status'],
        assigneeName: stringOrNull(row.assignee_name),
      })),
    },
    today: {
      created: num(t.created),
      resolved: num(t.resolved),
      firstResponseMedianSeconds: numOrNull(t.frt_median),
    },
    teams: teamRows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      open: num(row.open),
      unassigned: num(row.unassigned),
      waiting: num(row.waiting),
      breached: num(row.breached),
    })),
    agents: agentRows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      open: num(row.open),
      away: row.away === true,
    })),
    phone: phoneEnabled
      ? {
          waiting: num(p.waiting),
          longestWaitSeconds: numOrNull(p.longest),
          availableAgents: num(p.available_agents),
          answeredToday: num(p.answered_today),
          missedToday: num(p.missed_today),
          abandonedToday: num(p.abandoned_today),
        }
      : null,
  };
}
