//! `campaigns.ts` and `campaign-completion.ts`: the campaign reads, the
//! state changes and the operations the API exposes (create, edit, steps,
//! mailboxes, enrol, launch, pause, resume, preview, stats).

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, REACH_CAMPAIGN_COMPLETED, REACH_CAMPAIGN_CREATED, REACH_CAMPAIGN_DELETED, REACH_CAMPAIGN_LAUNCHED,
    REACH_CAMPAIGN_PAUSED, REACH_CAMPAIGN_UPDATED,
};
use weldsuite_kit::generate_id;

use crate::enrollments::{
    add_prospects_to_campaign, bulk_set_next_send_at, count_active_campaign_mailboxes, count_campaign_enrollments,
    list_campaign_enrollments, remove_enrollment, to_enrollment,
};
use crate::lists::{Page, PageQuery, cursor_row, find_list, like_pattern, page_result, parse_limit};
use crate::render::{RenderProspect, RenderSender, compose_body, email_footer, render_step, template_values};
use crate::send_window::{SendSchedule, is_valid_time_zone, parse_hhmm, spread_send_times};
use crate::{DuePort, EventSink, ReachError, ReachEvent, ReachResult, epoch_ms, field, int, iso, js_rows, now, parse_iso, text};

const CAMPAIGN_STATUSES: &[&str] = &["draft", "active", "paused", "completed", "archived"];
const ENROLLMENT_STATUSES: &[&str] = &[
    "queued",
    "active",
    "replied",
    "bounced",
    "unsubscribed",
    "completed",
    "paused",
    "failed",
];

/// `toCampaign(row)`.
pub fn to_campaign(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "name": field(row, "name"),
        "status": field(row, "status"),
        "timezone": field(row, "timezone"),
        "sendDays": field(row, "sendDays"),
        "windowStart": field(row, "windowStart"),
        "windowEnd": field(row, "windowEnd"),
        "dailyLimit": field(row, "dailyLimit"),
        "minGapMinutes": field(row, "minGapMinutes"),
        "stopOnAutoReply": field(row, "stopOnAutoReply"),
        "stats": field(row, "stats"),
        "pausedReason": field(row, "pausedReason"),
        "launchedAt": field(row, "launchedAt"),
        "completedAt": field(row, "completedAt"),
        "ownerId": field(row, "ownerId"),
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// `toStep(row)`.
pub fn to_step(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "order": field(row, "order"),
        "delayDays": field(row, "delayDays"),
        "delayHours": field(row, "delayHours"),
        "subject": field(row, "subject"),
        "body": field(row, "body"),
        "replyInThread": field(row, "replyInThread"),
    })
}

/// `scheduleOf(row)`.
pub fn schedule_of(row: &Value) -> SendSchedule {
    SendSchedule {
        timezone: crate::text_or_empty(row, "timezone").to_owned(),
        send_days: row
            .get("sendDays")
            .and_then(Value::as_array)
            .map(|days| days.iter().filter_map(Value::as_i64).collect())
            .unwrap_or_default(),
        window_start: crate::text_or_empty(row, "windowStart").to_owned(),
        window_end: crate::text_or_empty(row, "windowEnd").to_owned(),
    }
}

/// `loadReachSettings(db)`: the settings row, if any.
pub async fn load_settings(db: &PgPool) -> ReachResult<Option<Value>> {
    let row: Option<Value> = sqlx::query_scalar("select to_jsonb(t) from reach_settings t limit 1")
        .fetch_optional(db)
        .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// `findCampaign(db, id)`.
pub async fn find_campaign(db: &PgPool, id: &str) -> ReachResult<Option<Value>> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from reach_campaigns t where t.id = $1 and t.deleted_at is null limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// `loadSteps(db, campaignId)`.
pub async fn load_steps(db: &PgPool, campaign_id: &str) -> ReachResult<Vec<Value>> {
    let rows: Vec<Value> =
        sqlx::query_scalar(r#"select to_jsonb(t) from reach_campaign_steps t where t.campaign_id = $1 order by t."order" asc"#)
            .bind(campaign_id)
            .fetch_all(db)
            .await?;
    Ok(js_rows(rows))
}

/// `loadCampaignMailboxIds(db, campaignId)`.
pub async fn load_mailbox_ids(db: &PgPool, campaign_id: &str) -> ReachResult<Vec<String>> {
    Ok(
        sqlx::query_scalar("select mailbox_id from reach_campaign_mailboxes where campaign_id = $1")
            .bind(campaign_id)
            .fetch_all(db)
            .await?,
    )
}

/// `loadCampaignDetail(db, id)`.
pub async fn load_detail(db: &PgPool, id: &str) -> ReachResult<Option<Value>> {
    let Some(campaign) = find_campaign(db, id).await? else {
        return Ok(None);
    };
    let steps = load_steps(db, id).await?;
    let mailbox_ids = load_mailbox_ids(db, id).await?;
    let mut detail = to_campaign(&campaign);
    if let Some(map) = detail.as_object_mut() {
        map.insert("steps".to_owned(), Value::Array(steps.iter().map(to_step).collect()));
        map.insert("mailboxIds".to_owned(), json!(mailbox_ids));
    }
    Ok(Some(detail))
}

/// `scheduleProblem(s)`.
pub fn schedule_problem(timezone: &str, window_start: &str, window_end: &str) -> Option<String> {
    if !is_valid_time_zone(timezone) {
        return Some(format!("Unknown timezone '{timezone}'"));
    }
    let (Some(start), Some(end)) = (parse_hhmm(window_start), parse_hhmm(window_end)) else {
        return Some("The sending window must be HH:MM".to_owned());
    };
    (end <= start).then(|| "The sending window must end after it starts".to_owned())
}

/// `recountCampaignProspects(db, campaignId)`.
pub async fn recount_prospects(db: &PgPool, campaign_id: &str) -> ReachResult<i64> {
    let n: i64 = sqlx::query_scalar("select count(*) from reach_enrollments where campaign_id = $1")
        .bind(campaign_id)
        .fetch_one(db)
        .await?;
    sqlx::query("update reach_campaigns set stats = stats || jsonb_build_object('prospects', $2::int) where id = $1")
        .bind(campaign_id)
        .bind(i32::try_from(n).unwrap_or(i32::MAX))
        .execute(db)
        .await?;
    Ok(n)
}

/// `activateQueuedEnrollments(db, campaign, now)`: (activated, earliest).
pub async fn activate_queued(db: &PgPool, campaign: &Value, at: OffsetDateTime) -> ReachResult<(usize, Option<OffsetDateTime>)> {
    let campaign_id = crate::text_or_empty(campaign, "id");
    let queued: Vec<String> = sqlx::query_scalar(
        "select id from reach_enrollments where campaign_id = $1 and status = 'queued' order by created_at asc, id asc",
    )
    .bind(campaign_id)
    .fetch_all(db)
    .await?;
    if queued.is_empty() {
        return Ok((0, None));
    }
    let times = spread_send_times(
        queued.len(),
        at,
        &schedule_of(campaign),
        int(campaign, "minGapMinutes") * 60_000,
    );
    let items: Vec<(String, OffsetDateTime)> = queued.iter().cloned().zip(times.iter().copied()).collect();
    bulk_set_next_send_at(db, &items, true, at).await?;
    Ok((queued.len(), times.first().copied()))
}

/// `launchProblems(db, campaignId)`.
pub async fn launch_problems(db: &PgPool, campaign_id: &str) -> ReachResult<Vec<&'static str>> {
    let step: Option<String> = sqlx::query_scalar("select id from reach_campaign_steps where campaign_id = $1 limit 1")
        .bind(campaign_id)
        .fetch_optional(db)
        .await?;
    let active = count_active_campaign_mailboxes(db, campaign_id).await?;
    let queued = count_campaign_enrollments(db, campaign_id, Some("queued")).await?;
    let settings = load_settings(db).await?;
    let filled = |key: &str| {
        settings
            .as_ref()
            .and_then(|s| text(s, key))
            .is_some_and(|v| !crate::text::js_trim(v).is_empty())
    };
    let mut problems = Vec::new();
    if step.is_none() {
        problems.push("no_steps");
    }
    if active == 0 {
        problems.push("no_active_mailbox");
    }
    if !filled("senderCompanyName") || !filled("senderAddress") {
        problems.push("no_sender_identity");
    }
    if queued == 0 {
        problems.push("no_prospects");
    }
    Ok(problems)
}

/// `earliestDueAt(db, campaignId)`.
pub async fn earliest_due_at(db: &PgPool, campaign_id: &str) -> ReachResult<Option<OffsetDateTime>> {
    let at: Option<String> = sqlx::query_scalar(
        "select to_char(min(next_send_at) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
         from reach_enrollments where campaign_id = $1 and status = 'active'",
    )
    .bind(campaign_id)
    .fetch_one(db)
    .await?;
    Ok(at.as_deref().and_then(parse_iso))
}

/// `campaignStepStats(db, campaignId)`.
pub async fn step_stats(db: &PgPool, campaign_id: &str) -> ReachResult<Vec<Value>> {
    let steps = load_steps(db, campaign_id).await?;
    let sent: Vec<(Option<String>, i64)> = sqlx::query_as(
        "select step_id, count(*) from reach_messages
         where campaign_id = $1 and direction = 'out' and status = 'sent' group by step_id",
    )
    .bind(campaign_id)
    .fetch_all(db)
    .await?;
    let outcomes: Vec<(Option<String>, String)> = sqlx::query_as(
        "select distinct on (m.enrollment_id) m.step_id, e.status from reach_messages m
         join reach_enrollments e on e.id = m.enrollment_id
         where m.campaign_id = $1 and m.direction = 'out' and e.status in ('replied', 'bounced')
           and m.status in ('sent', 'unknown', 'failed')
         order by m.enrollment_id, m.created_at desc",
    )
    .bind(campaign_id)
    .fetch_all(db)
    .await?;
    let count_of = |step: &str, wanted: &str| {
        i64::try_from(
            outcomes
                .iter()
                .filter(|(s, status)| s.as_deref() == Some(step) && status == wanted)
                .count(),
        )
        .unwrap_or_default()
    };
    Ok(steps
        .iter()
        .map(|s| {
            let id = crate::text_or_empty(s, "id");
            json!({
                "stepId": id,
                "order": field(s, "order"),
                "sent": sent.iter().find(|(step, _)| step.as_deref() == Some(id)).map_or(0, |(_, n)| *n),
                "replied": count_of(id, "replied"),
                "bounced": count_of(id, "bounced"),
            })
        })
        .collect())
}

/// `completeCampaignIfDone(db, campaignId)`: the campaign when it was
/// completed now.
pub async fn complete_if_done(db: &PgPool, campaign_id: &str) -> ReachResult<Option<Value>> {
    let pending: Option<String> = sqlx::query_scalar(
        "select id from reach_enrollments where campaign_id = $1 and status in ('queued', 'active') limit 1",
    )
    .bind(campaign_id)
    .fetch_optional(db)
    .await?;
    if pending.is_some() {
        return Ok(None);
    }
    let at = iso(now());
    let row: Option<Value> = sqlx::query_scalar(
        "update reach_campaigns set status = 'completed', completed_at = $2::timestamptz, updated_at = $2::timestamptz
         where id = $1 and status = 'active' and deleted_at is null returning to_jsonb(reach_campaigns)",
    )
    .bind(campaign_id)
    .bind(at)
    .fetch_optional(db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// `completeAndPublishCampaigns(db, emit, campaignIds)`.
pub async fn complete_and_publish(db: &PgPool, emit: &dyn EventSink, campaign_ids: &[String]) -> ReachResult<()> {
    let mut done = Vec::new();
    for id in crate::unique(campaign_ids) {
        if let Some(row) = complete_if_done(db, &id).await? {
            done.push(row);
        }
    }
    for campaign in done {
        let id = crate::text_or_empty(&campaign, "id").to_owned();
        emit.emit(ReachEvent::new(REACH_CAMPAIGN_COMPLETED, id, campaign));
    }
    Ok(())
}

fn emit_campaign(emit: &dyn EventSink, event: EventName, row: &Value) {
    let id = crate::text_or_empty(row, "id").to_owned();
    emit.emit(ReachEvent::new(event, id, row.clone()));
}

/// `wake(deps, at)`: never in the past.
async fn wake(due: Option<&dyn DuePort>, at: Option<OffsetDateTime>) {
    let Some(due) = due else {
        return;
    };
    let current = now();
    let at = match at {
        Some(at) if epoch_ms(at) > epoch_ms(current) => at,
        _ => current,
    };
    due.due(at).await;
}

async fn require_campaign(db: &PgPool, id: &str) -> ReachResult<Value> {
    find_campaign(db, id)
        .await?
        .ok_or_else(|| ReachError::not_found("Campaign", Some(id)))
}

/// `getCampaignDetail(db, id)`.
pub async fn get_detail(db: &PgPool, id: &str) -> ReachResult<Value> {
    load_detail(db, id)
        .await?
        .ok_or_else(|| ReachError::not_found("Campaign", Some(id)))
}

/// `listCampaigns(db, q)`.
pub async fn list(db: &PgPool, query: &PageQuery) -> ReachResult<Page> {
    let limit = parse_limit(query.limit.as_deref());
    let status = match query.status.as_deref().filter(|s| !s.is_empty()) {
        Some(status) if CAMPAIGN_STATUSES.contains(&status) => Some(status.to_owned()),
        Some(_) => return Err(ReachError::bad_request("Unknown status filter")),
        None => None,
    };
    let search = query
        .search
        .as_deref()
        .filter(|s| !crate::text::js_trim(s).is_empty())
        .map(like_pattern);
    let cursor = cursor_row(db, "reach_campaigns", query.cursor.as_deref()).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from reach_campaigns t
         where t.deleted_at is null and ($1::text is null or t.status = $1) and ($2::text is null or t.name ilike $2)
           and ($3::timestamptz is null or t.created_at < $3::timestamptz or (t.created_at = $3::timestamptz and t.id < $4))
         order by t.created_at desc, t.id desc limit $5",
    )
    .bind(&status)
    .bind(&search)
    .bind(cursor.as_ref().map(|c| c.0.clone()))
    .bind(cursor.as_ref().map(|c| c.1.clone()))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from reach_campaigns t
         where t.deleted_at is null and ($1::text is null or t.status = $1) and ($2::text is null or t.name ilike $2)",
    )
    .bind(&status)
    .bind(&search)
    .fetch_one(db)
    .await?;
    Ok(page_result(&js_rows(rows), limit, total, to_campaign))
}

/// The schedule fields of a create or update body (`campaignScheduleSchema`).
#[derive(Debug, Clone, Default)]
pub struct CampaignInput {
    pub name: Option<String>,
    pub timezone: Option<String>,
    pub send_days: Option<Vec<i64>>,
    pub window_start: Option<String>,
    pub window_end: Option<String>,
    pub daily_limit: Option<i64>,
    pub min_gap_minutes: Option<i64>,
    pub stop_on_auto_reply: Option<bool>,
    /// `Some(None)`: set to null.
    pub owner_id: Option<Option<String>>,
}

/// `createCampaign(deps, input)`.
pub async fn create(db: &PgPool, emit: &dyn EventSink, user_id: &str, input: CampaignInput) -> ReachResult<Value> {
    let settings = load_settings(db).await?;
    let default = |key: &str| settings.as_ref().and_then(|s| s.get(key)).cloned();
    let timezone = input
        .timezone
        .clone()
        .or_else(|| default("defaultTimezone").and_then(|v| v.as_str().map(str::to_owned)));
    let send_days: Option<Value> = input.send_days.as_ref().map(|d| json!(d)).or_else(|| default("defaultSendDays"));
    let window_start = input
        .window_start
        .clone()
        .or_else(|| default("defaultWindowStart").and_then(|v| v.as_str().map(str::to_owned)));
    let window_end = input
        .window_end
        .clone()
        .or_else(|| default("defaultWindowEnd").and_then(|v| v.as_str().map(str::to_owned)));
    let min_gap = input
        .min_gap_minutes
        .or_else(|| settings.as_ref().map(|_| crate::schemas::sending::MIN_GAP_MINUTES));
    if let Some(problem) = schedule_problem(
        timezone.as_deref().unwrap_or("Europe/Amsterdam"),
        window_start.as_deref().unwrap_or("09:00"),
        window_end.as_deref().unwrap_or("17:00"),
    ) {
        return Err(ReachError::bad_request(problem));
    }
    let row: Value = sqlx::query_scalar(
        "insert into reach_campaigns (id, name, status, timezone, send_days, window_start, window_end, daily_limit,
             min_gap_minutes, stop_on_auto_reply, stats, owner_id, created_by)
         values ($1, $2, 'draft', coalesce($3, 'Europe/Amsterdam'), coalesce($4::jsonb, '[1, 2, 3, 4, 5]'::jsonb),
             coalesce($5, '09:00'), coalesce($6, '17:00'), coalesce($7, 100), coalesce($8, 8), coalesce($9, false),
             '{\"prospects\":0,\"sent\":0,\"replied\":0,\"interested\":0,\"bounced\":0,\"unsubscribed\":0}'::jsonb, $10, $10)
         returning to_jsonb(reach_campaigns)",
    )
    .bind(generate_id("rcmp"))
    .bind(input.name.as_deref().unwrap_or_default())
    .bind(&timezone)
    .bind(&send_days)
    .bind(&window_start)
    .bind(&window_end)
    .bind(input.daily_limit.map(|n| i32::try_from(n).unwrap_or(i32::MAX)))
    .bind(min_gap.map(|n| i32::try_from(n).unwrap_or(i32::MAX)))
    .bind(input.stop_on_auto_reply)
    .bind(user_id)
    .fetch_one(db)
    .await?;
    let row = weldsuite_db::js_row(row);
    emit_campaign(emit, REACH_CAMPAIGN_CREATED, &row);
    let mut detail = to_campaign(&row);
    if let Some(map) = detail.as_object_mut() {
        map.insert("steps".to_owned(), json!([]));
        map.insert("mailboxIds".to_owned(), json!([]));
    }
    Ok(detail)
}

/// `updateCampaign(deps, id, input)`.
pub async fn update(db: &PgPool, emit: &dyn EventSink, id: &str, input: CampaignInput) -> ReachResult<Value> {
    let current = require_campaign(db, id).await?;
    let timezone = input.timezone.clone().unwrap_or_else(|| crate::text_or_empty(&current, "timezone").to_owned());
    let start = input.window_start.clone().unwrap_or_else(|| crate::text_or_empty(&current, "windowStart").to_owned());
    let end = input.window_end.clone().unwrap_or_else(|| crate::text_or_empty(&current, "windowEnd").to_owned());
    if let Some(problem) = schedule_problem(&timezone, &start, &end) {
        return Err(ReachError::bad_request(problem));
    }
    let i32_of = |n: Option<i64>| n.map(|n| i32::try_from(n).unwrap_or(i32::MAX));
    let row: Option<Value> = sqlx::query_scalar(
        "update reach_campaigns set
             name = case when $2 then $3 else name end,
             timezone = case when $4 then $5 else timezone end,
             send_days = case when $6 then $7::jsonb else send_days end,
             window_start = case when $8 then $9 else window_start end,
             window_end = case when $10 then $11 else window_end end,
             daily_limit = case when $12 then $13 else daily_limit end,
             min_gap_minutes = case when $14 then $15 else min_gap_minutes end,
             stop_on_auto_reply = case when $16 then $17 else stop_on_auto_reply end,
             owner_id = case when $18 then $19 else owner_id end,
             updated_at = $20::timestamptz
         where id = $1 and deleted_at is null
         returning to_jsonb(reach_campaigns)",
    )
    .bind(id)
    .bind(input.name.is_some())
    .bind(&input.name)
    .bind(input.timezone.is_some())
    .bind(&input.timezone)
    .bind(input.send_days.is_some())
    .bind(input.send_days.as_ref().map(|d| json!(d)))
    .bind(input.window_start.is_some())
    .bind(&input.window_start)
    .bind(input.window_end.is_some())
    .bind(&input.window_end)
    .bind(input.daily_limit.is_some())
    .bind(i32_of(input.daily_limit))
    .bind(input.min_gap_minutes.is_some())
    .bind(i32_of(input.min_gap_minutes))
    .bind(input.stop_on_auto_reply.is_some())
    .bind(input.stop_on_auto_reply)
    .bind(input.owner_id.is_some())
    .bind(input.owner_id.clone().flatten())
    .bind(iso(now()))
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Err(ReachError::not_found("Campaign", Some(id)));
    };
    emit_campaign(emit, REACH_CAMPAIGN_UPDATED, &weldsuite_db::js_row(row));
    get_detail(db, id).await
}

/// `deleteCampaign(deps, id)`.
pub async fn delete(db: &PgPool, emit: &dyn EventSink, id: &str) -> ReachResult<()> {
    let current = require_campaign(db, id).await?;
    if text(&current, "status") == Some("active") {
        return Err(ReachError::state("CAMPAIGN_ACTIVE", "Pause the campaign before deleting it"));
    }
    let at = iso(now());
    sqlx::query("update reach_campaigns set deleted_at = $2::timestamptz, updated_at = $2::timestamptz where id = $1")
        .bind(id)
        .bind(&at)
        .execute(db)
        .await?;
    sqlx::query(
        "update reach_enrollments set status = 'paused', stopped_reason = 'campaign_deleted', claimed_at = null,
             next_send_at = null, updated_at = $2::timestamptz
         where campaign_id = $1 and status in ('queued', 'active')",
    )
    .bind(id)
    .bind(&at)
    .execute(db)
    .await?;
    emit.emit(ReachEvent::new(REACH_CAMPAIGN_DELETED, id, json!({ "id": id })));
    Ok(())
}

/// One step of `PUT /:id/steps` (`reachStepInputSchema`).
#[derive(Debug, Clone)]
pub struct StepInput {
    pub delay_days: i64,
    pub delay_hours: i64,
    pub subject: String,
    pub body: String,
    pub reply_in_thread: bool,
}

/// `replaceCampaignSteps(deps, id, steps)`.
pub async fn replace_steps(db: &PgPool, emit: &dyn EventSink, id: &str, steps: Vec<StepInput>) -> ReachResult<Value> {
    let campaign = require_campaign(db, id).await?;
    if text(&campaign, "status") == Some("active") {
        return Err(ReachError::state("CAMPAIGN_ACTIVE", "Pause the campaign before changing its steps"));
    }
    let existing = load_steps(db, id).await?;
    let at = iso(now());
    let campaign_id = id.to_owned();
    weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            let count = steps.len();
            for (order, step) in steps.into_iter().enumerate() {
                let order = i64::try_from(order).unwrap_or_default();
                let previous = existing.iter().find(|s| int(s, "order") == order).and_then(|s| text(s, "id"));
                let to_i32 = |n: i64| i32::try_from(n).unwrap_or(i32::MAX);
                match previous {
                    Some(previous) => {
                        sqlx::query(
                            "update reach_campaign_steps set delay_days = $2, delay_hours = $3, subject = $4, body = $5,
                                 reply_in_thread = $6, updated_at = $7::timestamptz where id = $1",
                        )
                        .bind(previous)
                        .bind(to_i32(step.delay_days))
                        .bind(to_i32(step.delay_hours))
                        .bind(&step.subject)
                        .bind(&step.body)
                        .bind(step.reply_in_thread)
                        .bind(&at)
                        .execute(&mut *conn)
                        .await?;
                    }
                    None => {
                        sqlx::query(
                            r#"insert into reach_campaign_steps (id, campaign_id, "order", delay_days, delay_hours, subject, body, reply_in_thread)
                               values ($1, $2, $3, $4, $5, $6, $7, $8)"#,
                        )
                        .bind(generate_id("rstp"))
                        .bind(&campaign_id)
                        .bind(to_i32(order))
                        .bind(to_i32(step.delay_days))
                        .bind(to_i32(step.delay_hours))
                        .bind(&step.subject)
                        .bind(&step.body)
                        .bind(step.reply_in_thread)
                        .execute(&mut *conn)
                        .await?;
                    }
                }
            }
            let surplus: Vec<String> = existing
                .iter()
                .filter(|s| int(s, "order") >= i64::try_from(count).unwrap_or_default())
                .filter_map(|s| text(s, "id").map(str::to_owned))
                .collect();
            if !surplus.is_empty() {
                sqlx::query("delete from reach_campaign_steps where id = any($1)")
                    .bind(&surplus)
                    .execute(&mut *conn)
                    .await?;
            }
            Ok::<_, sqlx::Error>(())
        })
    })
    .await?;
    emit_campaign(emit, REACH_CAMPAIGN_UPDATED, &campaign);
    get_detail(db, id).await
}

/// `setCampaignMailboxes(deps, id, mailboxIds)`.
pub async fn set_mailboxes(db: &PgPool, emit: &dyn EventSink, id: &str, mailbox_ids: &[String]) -> ReachResult<Value> {
    let mailbox_ids = crate::unique(mailbox_ids);
    let campaign = require_campaign(db, id).await?;
    if !mailbox_ids.is_empty() {
        let found: Vec<String> = sqlx::query_scalar(
            "select id from reach_mailboxes where id = any($1) and deleted_at is null and status <> 'deleted'",
        )
        .bind(&mailbox_ids)
        .fetch_all(db)
        .await?;
        let unknown: Vec<&String> = mailbox_ids.iter().filter(|m| !found.contains(m)).collect();
        if !unknown.is_empty() {
            return Err(ReachError::bad_request("Some mailboxes do not exist").with_details(json!({ "unknown": unknown })));
        }
    }
    let campaign_id = id.to_owned();
    let ids: Vec<String> = mailbox_ids.iter().map(|_| generate_id("rcmb")).collect();
    weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            sqlx::query("delete from reach_campaign_mailboxes where campaign_id = $1")
                .bind(&campaign_id)
                .execute(&mut *conn)
                .await?;
            if !mailbox_ids.is_empty() {
                sqlx::query(
                    "insert into reach_campaign_mailboxes (id, campaign_id, mailbox_id)
                     select id, $2, mailbox_id from unnest($1::varchar[], $3::varchar[]) as v(id, mailbox_id)",
                )
                .bind(&ids)
                .bind(&campaign_id)
                .bind(&mailbox_ids)
                .execute(&mut *conn)
                .await?;
            }
            Ok::<_, sqlx::Error>(())
        })
    })
    .await?;
    emit_campaign(emit, REACH_CAMPAIGN_UPDATED, &campaign);
    get_detail(db, id).await
}

/// `enrollCampaignProspects(deps, id, input)`.
pub async fn enroll(
    db: &PgPool,
    emit: &dyn EventSink,
    due: Option<&dyn DuePort>,
    allow_consumer: bool,
    id: &str,
    prospect_ids: &[String],
    list_id: Option<&str>,
) -> ReachResult<Value> {
    let campaign = require_campaign(db, id).await?;
    if matches!(text(&campaign, "status"), Some("completed" | "archived")) {
        return Err(ReachError::state(
            "CAMPAIGN_CLOSED",
            "This campaign has finished; add the prospects to a new campaign",
        ));
    }
    if let Some(list_id) = list_id
        && find_list(db, list_id).await?.is_none()
    {
        return Err(ReachError::not_found("List", Some(list_id)));
    }
    let (report, _) = add_prospects_to_campaign(db, id, prospect_ids, list_id, allow_consumer).await?;
    recount_prospects(db, id).await?;
    if text(&campaign, "status") == Some("active") && report.get("added").and_then(Value::as_i64).unwrap_or_default() > 0 {
        let (_, earliest) = activate_queued(db, &campaign, now()).await?;
        wake(due, earliest).await;
    }
    emit_campaign(emit, REACH_CAMPAIGN_UPDATED, &campaign);
    Ok(report)
}

/// `listEnrollments(db, campaignId, q)`.
pub async fn list_enrollments(db: &PgPool, campaign_id: &str, query: &PageQuery) -> ReachResult<Page> {
    require_campaign(db, campaign_id).await?;
    let limit = parse_limit(query.limit.as_deref());
    let status = match query.status.as_deref().filter(|s| !s.is_empty()) {
        Some(status) if ENROLLMENT_STATUSES.contains(&status) => Some(status.to_owned()),
        Some(_) => return Err(ReachError::bad_request("Unknown status filter")),
        None => None,
    };
    let cursor = cursor_row(db, "reach_enrollments", query.cursor.as_deref()).await?;
    let rows = list_campaign_enrollments(db, campaign_id, status.as_deref(), cursor.as_ref(), limit).await?;
    let total = count_campaign_enrollments(db, campaign_id, status.as_deref()).await?;
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|(e, p, m)| {
            json!({ "id": field(&e, "id"), "row": e, "prospect": p, "mailboxEmail": m })
        })
        .collect();
    Ok(page_result(&rows, limit, total, |r| {
        to_enrollment(&field(r, "row"), &field(r, "prospect"), text(r, "mailboxEmail"))
    }))
}

/// `removeCampaignEnrollment(deps, campaignId, enrollmentId)`.
pub async fn remove_campaign_enrollment(db: &PgPool, emit: &dyn EventSink, campaign_id: &str, enrollment_id: &str) -> ReachResult<()> {
    let campaign = require_campaign(db, campaign_id).await?;
    if !remove_enrollment(db, campaign_id, enrollment_id).await? {
        return Err(ReachError::not_found("Enrollment", Some(enrollment_id)));
    }
    recount_prospects(db, campaign_id).await?;
    emit_campaign(emit, REACH_CAMPAIGN_UPDATED, &campaign);
    complete_and_publish(db, emit, &[campaign_id.to_owned()]).await
}

/// `launchCampaign(deps, id)`.
pub async fn launch(db: &PgPool, emit: &dyn EventSink, due: Option<&dyn DuePort>, id: &str) -> ReachResult<Value> {
    let campaign = require_campaign(db, id).await?;
    match text(&campaign, "status") {
        Some("active") => return Err(ReachError::state("CAMPAIGN_ACTIVE", "This campaign is already running")),
        Some("paused") => {
            return Err(ReachError::state("CAMPAIGN_PAUSED", "This campaign is paused; resume it instead"));
        }
        Some("archived") => return Err(ReachError::state("CAMPAIGN_CLOSED", "This campaign is archived")),
        _ => {}
    }
    let problems = launch_problems(db, id).await?;
    if !problems.is_empty() {
        return Err(
            ReachError::bad_request("This campaign cannot be launched yet").with_details(json!({ "problems": problems })),
        );
    }
    let at = now();
    let (_, earliest) = activate_queued(db, &campaign, at).await?;
    let launched_at = text(&campaign, "launchedAt").map_or_else(|| iso(at), str::to_owned);
    let row: Option<Value> = sqlx::query_scalar(
        "update reach_campaigns set status = 'active', launched_at = $2::timestamptz, completed_at = null,
             paused_reason = null, updated_at = $3::timestamptz
         where id = $1 and status in ('draft', 'completed') returning to_jsonb(reach_campaigns)",
    )
    .bind(id)
    .bind(launched_at)
    .bind(iso(at))
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Err(ReachError::state("CAMPAIGN_ACTIVE", "This campaign was changed by someone else"));
    };
    wake(due, earliest).await;
    emit_campaign(emit, REACH_CAMPAIGN_LAUNCHED, &weldsuite_db::js_row(row));
    get_detail(db, id).await
}

/// `pauseCampaign(deps, id)`.
pub async fn pause(db: &PgPool, emit: &dyn EventSink, id: &str) -> ReachResult<Value> {
    require_campaign(db, id).await?;
    let row: Option<Value> = sqlx::query_scalar(
        "update reach_campaigns set status = 'paused', paused_reason = 'manual', updated_at = $2::timestamptz
         where id = $1 and status = 'active' returning to_jsonb(reach_campaigns)",
    )
    .bind(id)
    .bind(iso(now()))
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Err(ReachError::state("CAMPAIGN_NOT_ACTIVE", "Only a running campaign can be paused"));
    };
    emit_campaign(emit, REACH_CAMPAIGN_PAUSED, &weldsuite_db::js_row(row));
    get_detail(db, id).await
}

/// `resumeCampaign(deps, id)`.
pub async fn resume(db: &PgPool, emit: &dyn EventSink, due: Option<&dyn DuePort>, id: &str) -> ReachResult<Value> {
    let campaign = require_campaign(db, id).await?;
    if text(&campaign, "status") != Some("paused") {
        return Err(ReachError::state("CAMPAIGN_NOT_PAUSED", "Only a paused campaign can be resumed"));
    }
    let at = now();
    let (_, earliest) = activate_queued(db, &campaign, at).await?;
    let row: Option<Value> = sqlx::query_scalar(
        "update reach_campaigns set status = 'active', paused_reason = null, updated_at = $2::timestamptz
         where id = $1 and status = 'paused' returning to_jsonb(reach_campaigns)",
    )
    .bind(id)
    .bind(iso(at))
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Err(ReachError::state("CAMPAIGN_NOT_PAUSED", "This campaign was changed by someone else"));
    };
    let due_at = earliest_due_at(db, id).await?.or(earliest);
    wake(due, due_at).await;
    emit_campaign(emit, REACH_CAMPAIGN_UPDATED, &weldsuite_db::js_row(row));
    get_detail(db, id).await
}

/// `getCampaignStats(db, id)`.
pub async fn stats(db: &PgPool, id: &str) -> ReachResult<Vec<Value>> {
    require_campaign(db, id).await?;
    step_stats(db, id).await
}

/// The body of `POST /:id/preview` (`previewReachStepSchema`).
#[derive(Debug, Clone, Default)]
pub struct PreviewInput {
    pub step_id: Option<String>,
    pub prospect_id: Option<String>,
    pub subject: Option<String>,
    pub body: Option<String>,
}

/// `previewCampaignStep(db, id, input)`.
pub async fn preview(db: &PgPool, id: &str, input: &PreviewInput) -> ReachResult<Value> {
    require_campaign(db, id).await?;
    let (subject, body) = if input.subject.is_some() || input.body.is_some() {
        (input.subject.clone().unwrap_or_default(), input.body.clone().unwrap_or_default())
    } else {
        let steps = load_steps(db, id).await?;
        let step = match input.step_id.as_deref() {
            Some(step_id) if !step_id.is_empty() => steps.iter().find(|s| text(s, "id") == Some(step_id)),
            _ => steps.first(),
        };
        match step {
            Some(step) => (crate::text_or_empty(step, "subject").to_owned(), crate::text_or_empty(step, "body").to_owned()),
            None => {
                return Err(match input.step_id.as_deref().filter(|s| !s.is_empty()) {
                    Some(step_id) => ReachError::not_found("Step", Some(step_id)),
                    None => ReachError::bad_request("The campaign has no step to preview"),
                });
            }
        }
    };
    let prospect: Option<Value> = if let Some(prospect_id) = input.prospect_id.as_deref().filter(|p| !p.is_empty()) {
        let row: Option<Value> =
            sqlx::query_scalar("select to_jsonb(t) from reach_prospects t where t.id = $1 and t.deleted_at is null limit 1")
                .bind(prospect_id)
                .fetch_optional(db)
                .await?;
        match row {
            Some(row) => Some(weldsuite_db::js_row(row)),
            None => return Err(ReachError::not_found("Prospect", Some(prospect_id))),
        }
    } else {
        let row: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(p) from reach_enrollments e join reach_prospects p on p.id = e.prospect_id
             where e.campaign_id = $1 and p.deleted_at is null order by e.created_at asc limit 1",
        )
        .bind(id)
        .fetch_optional(db)
        .await?;
        row.map(weldsuite_db::js_row)
    };
    let mailbox_ids = load_mailbox_ids(db, id).await?;
    let mailbox: Option<(String, String, Option<String>)> = if mailbox_ids.is_empty() {
        None
    } else {
        sqlx::query_as(
            "select first_name, last_name, signature from reach_mailboxes
             where id = any($1) and deleted_at is null order by created_at asc limit 1",
        )
        .bind(&mailbox_ids)
        .fetch_optional(db)
        .await?
    };
    let render_prospect = match &prospect {
        Some(row) => RenderProspect::from_row(row),
        None => RenderProspect {
            email: "alex.morgan@example.com".to_owned(),
            first_name: Some("Alex".to_owned()),
            last_name: Some("Morgan".to_owned()),
            company_name: Some("Example Inc".to_owned()),
            title: Some("Operations Manager".to_owned()),
            custom_fields: Vec::new(),
        },
    };
    let sender = match &mailbox {
        Some((first, last, _)) => RenderSender {
            first_name: first.clone(),
            last_name: last.clone(),
        },
        None => RenderSender {
            first_name: "Sam".to_owned(),
            last_name: "Taylor".to_owned(),
        },
    };
    let values = template_values(&render_prospect, Some(&sender));
    let rendered = render_step(&subject, &body, &values);
    let settings = load_settings(db).await?;
    let signature = mailbox.as_ref().and_then(|(_, _, s)| s.as_deref());
    Ok(json!({
        "subject": rendered.subject,
        "body": format!("{}{}", compose_body(&rendered.body, signature), email_footer(settings.as_ref())),
        "missingVariables": rendered.missing,
    }))
}

/// `addToCampaignStats(db, campaignId, delta)`: one atomic `jsonb` update.
pub async fn add_to_stats(db: &PgPool, campaign_id: &str, delta: &[(&str, i64)]) -> ReachResult<()> {
    let delta: Map<String, Value> = delta
        .iter()
        .filter(|(_, n)| *n != 0)
        .map(|(k, n)| ((*k).to_owned(), json!(n)))
        .collect();
    if delta.is_empty() {
        return Ok(());
    }
    sqlx::query(
        "update reach_campaigns set stats = stats || (
             select jsonb_object_agg(d.key, coalesce((stats->>d.key)::int, 0) + d.value::int)
             from jsonb_each_text($2::jsonb) d)
         where id = $1",
    )
    .bind(campaign_id)
    .bind(Value::Object(delta))
    .execute(db)
    .await?;
    Ok(())
}
