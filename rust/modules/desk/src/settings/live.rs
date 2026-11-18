//! The live WeldDesk reports (`routes/helpdesk-analytics/live.ts`), under
//! `/api/helpdesk-analytics`:
//!
//! - `GET /wallboard?teamId=`: the queue right now, for a screen the whole
//!   team looks at (`conversations:read`, `services/desk-wallboard.ts`);
//! - `GET /phone?range=`: call KPIs for a period (`settings:read`,
//!   `services/desk-phone-report.ts`).
//!
//! Read-only, so no entity events. Like the other reports (ADR DESK-011) the
//! statements are the worker's, text for text: every number is computed and
//! rounded in SQL against one `now`, bound as text and cast with
//! `::timestamp` like Drizzle does. Durations are whole seconds; "today" is
//! the current UTC day; merged duplicates are never counted.

use axum::extract::RawQuery;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::Row;
use sqlx::postgres::PgRow;
use weldsuite_db::PgPool;
use weldsuite_kit::Data;
use weldsuite_kit::validation::js_trim;

use super::reports::{
    self, Binds, Period, Unit, date_key, day_start, float_or_null, int, int_or_null, iso_of,
    opt_int, overview_unit, pair, period_of, previous_of, range_of, rows, trunc,
};
use crate::js::query_param;
use crate::{Caller, Refusal};

const DUE_SOON_LIMIT: u32 = 8;
const AGENTS_LIMIT: u32 = 50;

/// `num(value)`: a count, 0 when the row has none.
fn count(row: &PgRow, column: &str) -> Result<i32, sqlx::Error> {
    Ok(row.try_get::<Option<i32>, _>(column)?.unwrap_or_default())
}

fn text(row: &PgRow, column: &str) -> Result<Option<String>, sqlx::Error> {
    row.try_get::<Option<String>, _>(column)
}

// ── wallboard ───────────────────────────────────────────────────────────────

/// `deskTeamExists(db, teamId)`: whether `team_id` names a team
/// (`helpdesk_departments` row) that is not deleted.
async fn team_exists(db: &PgPool, team_id: &str) -> Result<bool, sqlx::Error> {
    let found: Option<i32> = sqlx::query_scalar(
        "select 1 as found from helpdesk_departments where id = $1 and deleted_at is null",
    )
    .bind(team_id)
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

/// `deskWallboard(db, now, teamId)`.
#[allow(clippy::too_many_lines)] // one statement per block of the wallboard
async fn wallboard(db: &PgPool, now: i64, team_id: Option<&str>) -> Result<Value, sqlx::Error> {
    let today = period_of("today", now, None);

    let mut binds = Binds::default();
    let now_at = binds.ts(now);
    let team = team_id.map_or_else(String::new, |id| {
        format!("and c.department_id = {}", binds.text(id))
    });
    let queue_sql = format!(
        "select
          count(*)::int as open,
          count(*) filter (where c.assignee_id is null)::int as unassigned,
          count(*) filter (where c.waiting_since is not null)::int as waiting,
          case when count(c.waiting_since) = 0 then null else greatest(0, round(extract(epoch from {now_at} - min(c.waiting_since)))::int) end as oldest,
          count(*) filter (where c.sla_status = 'breached')::int as breached,
          count(*) filter (where c.sla_status = 'warning')::int as at_risk
        from desk_conversations c
        where c.state = 'open' and c.merged_into_id is null {team}"
    );
    let queue_rows = rows(db, &queue_sql, binds).await?;

    let mut binds = Binds::default();
    let team = team_id.map_or_else(String::new, |id| {
        format!("and c.department_id = {}", binds.text(id))
    });
    let due_sql = format!(
        "select c.id, c.conversation_number, c.name, to_char(c.sla_due_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as due_at,
          c.sla_metric as metric, c.sla_status as status,
          case when c.assignee_id is null then null else coalesce(wm.name, wm.email, c.assignee_id) end as assignee_name
        from desk_conversations c
        left join workspace_members wm on wm.user_id = c.assignee_id
        where c.state = 'open' and c.merged_into_id is null {team}
          and c.sla_due_at is not null and c.sla_status in ('active', 'warning', 'breached')
        order by c.sla_due_at asc, c.id asc
        limit {DUE_SOON_LIMIT}"
    );
    let due_rows = rows(db, &due_sql, binds).await?;

    let mut binds = Binds::default();
    let created = binds.in_period("c.created_at", today);
    let resolved = binds.in_period("c.resolved_at", today);
    let answered = binds.in_period("c.first_response_at", today);
    let team = team_id.map_or_else(String::new, |id| {
        format!("and c.department_id = {}", binds.text(id))
    });
    let since = [
        binds.ts(today.start),
        binds.ts(today.start),
        binds.ts(today.start),
    ];
    let today_sql = format!(
        "select
          count(*) filter (where {created})::int as created,
          count(*) filter (where {resolved})::int as resolved,
          round(percentile_cont(0.5) within group (order by c.first_response_seconds)
            filter (where {answered} and c.first_response_seconds is not null))::int as frt_median
        from desk_conversations c
        where c.merged_into_id is null {team}
          and (c.created_at >= {} or c.resolved_at >= {} or c.first_response_at >= {})",
        since[0], since[1], since[2]
    );
    let today_rows = rows(db, &today_sql, binds).await?;

    let mut binds = Binds::default();
    let department =
        team_id.map_or_else(String::new, |id| format!("and d.id = {}", binds.text(id)));
    let team_sql = format!(
        "select d.id, d.name,
          count(c.id)::int as open,
          count(c.id) filter (where c.assignee_id is null)::int as unassigned,
          count(c.id) filter (where c.waiting_since is not null)::int as waiting,
          count(c.id) filter (where c.sla_status = 'breached')::int as breached
        from helpdesk_departments d
        left join desk_conversations c on c.department_id = d.id and c.state = 'open' and c.merged_into_id is null
        where d.deleted_at is null and d.is_active {department}
        group by d.id, d.name
        order by 3 desc, d.name asc, d.id asc"
    );
    let team_rows = rows(db, &team_sql, binds).await?;

    let mut binds = Binds::default();
    let team = team_id.map_or_else(String::new, |id| {
        format!("and c.department_id = {}", binds.text(id))
    });
    let agent_sql = format!(
        "with away as (
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
        left join desk_conversations c on c.assignee_id = wm.user_id and c.state = 'open' and c.merged_into_id is null {team}
        where wm.status = 'ACTIVE' and wm.member_type = 'INTERNAL' and wm.deleted_at is null
        group by wm.user_id, wm.name, wm.email
        order by 3 desc, 2 asc, 1 asc
        limit {AGENTS_LIMIT}"
    );
    let agent_rows = rows(db, &agent_sql, binds).await?;

    let route_rows = rows(
        db,
        "select count(*)::int as routes from desk_phone_routes where action in ('agents', 'menu')",
        Binds::default(),
    )
    .await?;

    let mut binds = Binds::default();
    let now_at = binds.ts(now);
    let answered_today = binds.in_period("v.queue_entered_at", today);
    let missed_today = binds.in_period("v.queue_entered_at", today);
    let abandoned_today = binds.in_period("v.queue_entered_at", today);
    let call_team = team_id.map_or_else(String::new, |id| {
        format!("and v.department_id = {}", binds.text(id))
    });
    let since = binds.ts(today.start);
    let call_sql = format!(
        "select
          count(*) filter (where v.agent_answered_at is null and v.ended_at is null and v.outcome is null)::int as waiting,
          max(round(extract(epoch from {now_at} - v.queue_entered_at))::int)
            filter (where v.agent_answered_at is null and v.ended_at is null and v.outcome is null) as longest,
          count(*) filter (where {answered_today} and v.outcome = 'answered')::int as answered_today,
          count(*) filter (where {missed_today} and v.outcome in ('missed', 'voicemail'))::int as missed_today,
          count(*) filter (where {abandoned_today} and v.outcome = 'abandoned')::int as abandoned_today,
          (select count(*)::int from desk_phone_agents pa where pa.available) as available_agents
        from voip_calls v
        where v.queue_entered_at is not null {call_team}
          and (v.queue_entered_at >= {since} or (v.agent_answered_at is null and v.ended_at is null and v.outcome is null))"
    );
    let call_rows = rows(db, &call_sql, binds).await?;

    let q = queue_rows.first();
    let t = today_rows.first();
    let p = call_rows.first();
    let phone_enabled = int(route_rows.first(), "routes")? > 0;

    let mut due_soon = Vec::with_capacity(due_rows.len());
    for row in &due_rows {
        due_soon.push(json!({
            "conversationId": text(row, "id")?.unwrap_or_default(),
            "conversationNumber": count(row, "conversation_number")?,
            "name": text(row, "name")?,
            "dueAt": text(row, "due_at")?.unwrap_or_default(),
            "metric": text(row, "metric")?,
            "status": text(row, "status")?.unwrap_or_default(),
            "assigneeName": text(row, "assignee_name")?,
        }));
    }
    let mut teams = Vec::with_capacity(team_rows.len());
    for row in &team_rows {
        teams.push(json!({
            "id": text(row, "id")?.unwrap_or_default(),
            "name": text(row, "name")?.unwrap_or_default(),
            "open": count(row, "open")?,
            "unassigned": count(row, "unassigned")?,
            "waiting": count(row, "waiting")?,
            "breached": count(row, "breached")?,
        }));
    }
    let mut agents = Vec::with_capacity(agent_rows.len());
    for row in &agent_rows {
        agents.push(json!({
            "id": text(row, "id")?.unwrap_or_default(),
            "name": text(row, "name")?.unwrap_or_default(),
            "open": count(row, "open")?,
            "away": row.try_get::<Option<bool>, _>("away")? == Some(true),
        }));
    }
    let phone = if phone_enabled {
        json!({
            "waiting": int(p, "waiting")?,
            "longestWaitSeconds": int_or_null(p, "longest")?,
            "availableAgents": int(p, "available_agents")?,
            "answeredToday": int(p, "answered_today")?,
            "missedToday": int(p, "missed_today")?,
            "abandonedToday": int(p, "abandoned_today")?,
        })
    } else {
        Value::Null
    };

    Ok(json!({
        "generatedAt": iso_of(now),
        "queue": {
            "open": int(q, "open")?,
            "unassigned": int(q, "unassigned")?,
            "waiting": int(q, "waiting")?,
            "oldestWaitingSeconds": int_or_null(q, "oldest")?,
        },
        "sla": {
            "breached": int(q, "breached")?,
            "atRisk": int(q, "at_risk")?,
            "dueSoon": due_soon,
        },
        "today": {
            "created": int(t, "created")?,
            "resolved": int(t, "resolved")?,
            "firstResponseMedianSeconds": int_or_null(t, "frt_median")?,
        },
        "teams": teams,
        "agents": agents,
        "phone": phone,
    }))
}

/// `GET /wallboard?teamId=`: an unknown team is a 400.
pub(super) async fn wallboard_route(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let message = "Failed to fetch the wallboard";
    // `c.req.query('teamId')?.trim() || null`
    let team_id = query_param(query.as_deref(), "teamId")
        .map(|id| js_trim(&id).to_owned())
        .filter(|id| !id.is_empty());
    if let Some(id) = &team_id {
        match team_exists(&caller.db, id).await {
            Ok(true) => {}
            Ok(false) => return Refusal::bad_request("Unknown team").respond(message),
            Err(error) => return Refusal::Database(error).respond(message),
        }
    }
    match wallboard(&caller.db, reports::clock_ms(&caller), team_id.as_deref()).await {
        Ok(data) => Data(data).into_response(),
        Err(error) => Refusal::Database(error).respond(message),
    }
}

// ── phone report ────────────────────────────────────────────────────────────

const ENTERED: &str = "v.queue_entered_at";
const WAIT: &str = "extract(epoch from (v.agent_answered_at - v.queue_entered_at))";
const ABANDON_WAIT: &str = "extract(epoch from (v.ended_at - v.queue_entered_at))";
const HANDLE: &str = "extract(epoch from (v.ended_at - v.agent_answered_at))";
const ANY_WAIT: &str =
    "extract(epoch from (coalesce(v.agent_answered_at, v.ended_at) - v.queue_entered_at))";

const OUTCOME_ANSWERED: &str = "v.outcome = 'answered'";
const ANSWERED_WITH_WAIT: &str = "v.outcome = 'answered' and v.agent_answered_at is not null";
const ANSWERED_WITH_HANDLE: &str =
    "v.outcome = 'answered' and v.agent_answered_at is not null and v.ended_at is not null";
const ABANDONED_WITH_WAIT: &str = "v.outcome = 'abandoned' and v.ended_at is not null";

/// The first day a call waited, for `all_time`.
async fn first_call(db: &PgPool) -> Result<Option<i64>, sqlx::Error> {
    let first: Option<String> = sqlx::query_scalar(
        "select to_char(min(queue_entered_at), 'YYYY-MM-DD') as first from voip_calls",
    )
    .fetch_one(db)
    .await?;
    Ok(first.as_deref().and_then(day_start))
}

/// `kpiColumns(period, suffix)`: the KPI aggregates of one period, as SQL
/// select items suffixed `_<suffix>`. Every `${within}` is its own pair of
/// binds, as in the worker's statement.
fn kpi_columns(binds: &mut Binds, period: Period, s: &str) -> String {
    let mut within = || binds.in_period(ENTERED, period);
    let offered = within();
    let answered = within();
    let missed = within();
    let abandoned = within();
    let voicemail = within();
    let rate_answered = within();
    let rate_offered = within();
    let wait_avg = within();
    let wait_median = within();
    let abandon_avg = within();
    let handle_avg = within();
    let handle_median = within();
    let longest = within();
    format!(
        "
    count(*) filter (where {offered})::int as offered_{s},
    count(*) filter (where {answered} and {OUTCOME_ANSWERED})::int as answered_{s},
    count(*) filter (where {missed} and v.outcome = 'missed')::int as missed_{s},
    count(*) filter (where {abandoned} and v.outcome = 'abandoned')::int as abandoned_{s},
    count(*) filter (where {voicemail} and v.outcome = 'voicemail')::int as voicemail_{s},
    round(100.0 * count(*) filter (where {rate_answered} and {OUTCOME_ANSWERED}) / nullif(count(*) filter (where {rate_offered}), 0), 1)::float8 as rate_{s},
    round(avg({WAIT}) filter (where {wait_avg} and {ANSWERED_WITH_WAIT}))::int as wait_avg_{s},
    round(percentile_cont(0.5) within group (order by {WAIT}) filter (where {wait_median} and {ANSWERED_WITH_WAIT}))::int as wait_median_{s},
    round(avg({ABANDON_WAIT}) filter (where {abandon_avg} and {ABANDONED_WITH_WAIT}))::int as abandon_avg_{s},
    round(avg({HANDLE}) filter (where {handle_avg} and {ANSWERED_WITH_HANDLE}))::int as handle_avg_{s},
    round(percentile_cont(0.5) within group (order by {HANDLE}) filter (where {handle_median} and {ANSWERED_WITH_HANDLE}))::int as handle_median_{s},
    round(max({ANY_WAIT}) filter (where {longest} and coalesce(v.agent_answered_at, v.ended_at) is not null))::int as longest_{s}"
    )
}

/// `deskPhoneReport(db, range, now)`.
#[allow(clippy::too_many_lines)] // one statement per block of the report
async fn phone_report(db: &PgPool, range: Option<&str>, now: i64) -> Result<Value, sqlx::Error> {
    let range = range_of(range);
    let first = if range == "all_time" {
        first_call(db).await?
    } else {
        None
    };
    let period = period_of(range, now, first);
    let previous = previous_of(period);
    let unit = overview_unit(period);

    let mut binds = Binds::default();
    let current = kpi_columns(&mut binds, period, "cur");
    let before = kpi_columns(&mut binds, previous, "prev");
    let since = binds.ts(previous.start);
    let until = binds.ts(period.end);
    let totals_sql = format!(
        "select {current}, {before}
        from voip_calls v
        where {ENTERED} >= {since} and {ENTERED} < {until}"
    );
    let totals = rows(db, &totals_sql, binds).await?;

    let mut binds = Binds::default();
    let buckets = binds.buckets(unit, period);
    let within = binds.in_period(ENTERED, period);
    let series_sql = format!(
        "with {buckets},
        calls as (
          select {bucket} as bucket,
            count(*)::int as offered,
            count(*) filter (where {OUTCOME_ANSWERED})::int as answered,
            count(*) filter (where v.outcome = 'missed')::int as missed,
            count(*) filter (where v.outcome = 'abandoned')::int as abandoned
          from voip_calls v where {within} group by 1
        )
        select to_char(b.bucket, 'YYYY-MM-DD') as date,
          coalesce(c.offered, 0) as offered, coalesce(c.answered, 0) as answered,
          coalesce(c.missed, 0) as missed, coalesce(c.abandoned, 0) as abandoned
        from buckets b left join calls c on c.bucket = b.bucket
        order by b.bucket",
        bucket = trunc(unit, ENTERED),
    );
    let series_rows = rows(db, &series_sql, binds).await?;

    let mut binds = Binds::default();
    let within = binds.in_period(ENTERED, period);
    let agent_sql = format!(
        "select v.answered_by_user_id as id, coalesce(max(wm.name), max(wm.email), v.answered_by_user_id) as name,
          count(*)::int as answered,
          round(avg({HANDLE}) filter (where {ANSWERED_WITH_HANDLE}))::int as handle_avg,
          coalesce(round(sum({HANDLE}) filter (where {ANSWERED_WITH_HANDLE}))::int, 0) as handle_total
        from voip_calls v
        left join workspace_members wm on wm.user_id = v.answered_by_user_id
        where {within} and {OUTCOME_ANSWERED} and v.answered_by_user_id is not null
        group by v.answered_by_user_id
        order by 3 desc, 2 asc, 1 asc
        limit {AGENTS_LIMIT}"
    );
    let agent_rows = rows(db, &agent_sql, binds).await?;

    let mut binds = Binds::default();
    let within = binds.in_period(ENTERED, period);
    let team_sql = format!(
        "select v.department_id as id, max(dp.name) as name,
          count(*)::int as offered,
          count(*) filter (where {OUTCOME_ANSWERED})::int as answered,
          count(*) filter (where v.outcome = 'missed')::int as missed,
          count(*) filter (where v.outcome = 'abandoned')::int as abandoned,
          round(avg({WAIT}) filter (where {ANSWERED_WITH_WAIT}))::int as wait_avg
        from voip_calls v
        left join helpdesk_departments dp on dp.id = v.department_id
        where {within}
        group by v.department_id
        order by 3 desc, 2 asc nulls last, 1 asc nulls last"
    );
    let team_rows = rows(db, &team_sql, binds).await?;

    let mut binds = Binds::default();
    let within = binds.in_period(ENTERED, period);
    let hour_sql = format!(
        "with calls as (
          select extract(hour from {ENTERED})::int as hour,
            count(*)::int as offered,
            count(*) filter (where {OUTCOME_ANSWERED})::int as answered
          from voip_calls v where {within} group by 1
        )
        select h.hour, coalesce(c.offered, 0) as offered, coalesce(c.answered, 0) as answered
        from generate_series(0, 23) as h(hour)
        left join calls c on c.hour = h.hour
        order by h.hour"
    );
    let hour_rows = rows(db, &hour_sql, binds).await?;

    let t = totals.first();
    let counts = |key: &str| -> Result<Value, sqlx::Error> {
        Ok(pair(
            int(t, &format!("{key}_cur"))?.into(),
            int(t, &format!("{key}_prev"))?.into(),
        ))
    };
    let seconds = |key: &str| -> Result<Value, sqlx::Error> {
        Ok(pair(
            int_or_null(t, &format!("{key}_cur"))?,
            int_or_null(t, &format!("{key}_prev"))?,
        ))
    };

    let mut series = Vec::with_capacity(series_rows.len());
    for row in &series_rows {
        series.push(json!({
            "date": text(row, "date")?.unwrap_or_default(),
            "offered": count(row, "offered")?,
            "answered": count(row, "answered")?,
            "missed": count(row, "missed")?,
            "abandoned": count(row, "abandoned")?,
        }));
    }
    let mut agents = Vec::with_capacity(agent_rows.len());
    for row in &agent_rows {
        agents.push(json!({
            "id": text(row, "id")?.unwrap_or_default(),
            "name": text(row, "name")?.unwrap_or_default(),
            "answered": count(row, "answered")?,
            "handleAvg": opt_int(row.try_get("handle_avg")?),
            "handleTotal": count(row, "handle_total")?,
        }));
    }
    let mut teams = Vec::with_capacity(team_rows.len());
    for row in &team_rows {
        teams.push(json!({
            "id": text(row, "id")?,
            "name": text(row, "name")?,
            "offered": count(row, "offered")?,
            "answered": count(row, "answered")?,
            "missed": count(row, "missed")?,
            "abandoned": count(row, "abandoned")?,
            "waitAvg": opt_int(row.try_get("wait_avg")?),
        }));
    }
    let mut hours = Vec::with_capacity(hour_rows.len());
    for row in &hour_rows {
        hours.push(json!({
            "hour": count(row, "hour")?,
            "offered": count(row, "offered")?,
            "answered": count(row, "answered")?,
        }));
    }

    Ok(json!({
        "range": range,
        "start": date_key(period.start),
        "end": date_key(period.end),
        "bucket": match unit {
            Unit::Week | Unit::Month => unit.name(),
            _ => "day",
        },
        "kpis": {
            "offered": counts("offered")?,
            "answered": counts("answered")?,
            "missed": counts("missed")?,
            "abandoned": counts("abandoned")?,
            "voicemail": counts("voicemail")?,
            "answerRate": pair(float_or_null(t, "rate_cur")?, float_or_null(t, "rate_prev")?),
            "waitAvg": seconds("wait_avg")?,
            "waitMedian": seconds("wait_median")?,
            "abandonAvg": seconds("abandon_avg")?,
            "handleAvg": seconds("handle_avg")?,
            "handleMedian": seconds("handle_median")?,
            "longestWait": seconds("longest")?,
        },
        "series": series,
        "agents": agents,
        "teams": teams,
        "hours": hours,
    }))
}

/// `GET /phone?range=`: anything but a known range is the last 30 days.
pub(super) async fn phone_route(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let range = query_param(query.as_deref(), "range");
    match phone_report(&caller.db, range.as_deref(), reports::clock_ms(&caller)).await {
        Ok(data) => Data(data).into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to fetch the phone report"),
    }
}
