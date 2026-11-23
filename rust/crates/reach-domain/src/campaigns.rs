//! `campaigns.ts` and `campaign-completion.ts`: the campaign reads, the
//! state changes and the operations the API exposes (create, edit, steps,
//! mailboxes, enrol, launch, pause, resume, preview, stats).

use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, JoinType, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, RelationDef, Set,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::{OrmConn, orm};
use weldsuite_schema::tenant::{
    reach_campaign_mailboxes as campaign_mailboxes, reach_campaign_steps as steps,
    reach_campaigns as campaigns, reach_enrollments as enrollments, reach_mailboxes,
    reach_messages as messages, reach_prospects, reach_settings,
};
use weldsuite_catalogs::entity_events::{
    EventName, REACH_CAMPAIGN_COMPLETED, REACH_CAMPAIGN_CREATED, REACH_CAMPAIGN_DELETED,
    REACH_CAMPAIGN_LAUNCHED, REACH_CAMPAIGN_PAUSED, REACH_CAMPAIGN_UPDATED,
};
use weldsuite_kit::generate_id;

use crate::enrollments::{
    add_prospects_to_campaign, bulk_set_next_send_at, count_active_campaign_mailboxes,
    count_campaign_enrollments, list_campaign_enrollments, remove_enrollment, to_enrollment,
};
use crate::lists::{
    Page, PageQuery, before, cursor_row, find_list, like_pattern, page_result, parse_limit, probe,
};
use crate::render::{
    RenderProspect, RenderSender, compose_body, email_footer, render_step, template_values,
};
use crate::send_window::{SendSchedule, is_valid_time_zone, parse_hhmm, spread_send_times};
use crate::{
    DuePort, EventSink, ReachError, ReachEvent, ReachResult, epoch_ms, field, int, js, js_all,
    now, stamp, text,
};

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
    let row = reach_settings::Entity::find().one(&orm(db)).await?;
    Ok(row.map(serde_json::to_value).map(js).transpose()?)
}

/// `findCampaign(db, id)`.
pub async fn find_campaign(db: &PgPool, id: &str) -> ReachResult<Option<Value>> {
    let row = campaigns::Entity::find_by_id(id)
        .filter(campaigns::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    Ok(row.map(serde_json::to_value).map(js).transpose()?)
}

/// `loadSteps(db, campaignId)`.
pub async fn load_steps(db: &PgPool, campaign_id: &str) -> ReachResult<Vec<Value>> {
    let rows = steps::Entity::find()
        .filter(steps::Column::CampaignId.eq(campaign_id))
        .order_by_asc(steps::Column::Order)
        .all(&orm(db))
        .await?;
    Ok(js_all(rows.into_iter().map(serde_json::to_value))?)
}

/// `loadCampaignMailboxIds(db, campaignId)`.
pub async fn load_mailbox_ids(db: &PgPool, campaign_id: &str) -> ReachResult<Vec<String>> {
    Ok(campaign_mailboxes::Entity::find()
        .select_only()
        .column(campaign_mailboxes::Column::MailboxId)
        .filter(campaign_mailboxes::Column::CampaignId.eq(campaign_id))
        .into_tuple()
        .all(&orm(db))
        .await?)
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
        map.insert(
            "steps".to_owned(),
            Value::Array(steps.iter().map(to_step).collect()),
        );
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
    let db = orm(db);
    let n = enrollments::Entity::find()
        .filter(enrollments::Column::CampaignId.eq(campaign_id))
        .count(&db)
        .await?;
    let prospects = json!({ "prospects": i32::try_from(n).unwrap_or(i32::MAX) });
    campaigns::Entity::update_many()
        .col_expr(
            campaigns::Column::Stats,
            sea_orm::sea_query::extension::postgres::PgExpr::concat(
                Expr::col(campaigns::Column::Stats),
                Expr::val(prospects),
            ),
        )
        .filter(campaigns::Column::Id.eq(campaign_id))
        .exec(&db)
        .await?;
    Ok(i64::try_from(n).unwrap_or(i64::MAX))
}

/// `activateQueuedEnrollments(db, campaign, now)`: (activated, earliest).
pub async fn activate_queued(
    db: &PgPool,
    campaign: &Value,
    at: OffsetDateTime,
) -> ReachResult<(usize, Option<OffsetDateTime>)> {
    let campaign_id = crate::text_or_empty(campaign, "id");
    let queued: Vec<String> = enrollments::Entity::find()
        .select_only()
        .column(enrollments::Column::Id)
        .filter(enrollments::Column::CampaignId.eq(campaign_id))
        .filter(enrollments::Column::Status.eq("queued"))
        .order_by_asc(enrollments::Column::CreatedAt)
        .order_by_asc(enrollments::Column::Id)
        .into_tuple()
        .all(&orm(db))
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
    let items: Vec<(String, OffsetDateTime)> =
        queued.iter().cloned().zip(times.iter().copied()).collect();
    bulk_set_next_send_at(db, &items, true, at).await?;
    Ok((queued.len(), times.first().copied()))
}

/// `launchProblems(db, campaignId)`.
pub async fn launch_problems(db: &PgPool, campaign_id: &str) -> ReachResult<Vec<&'static str>> {
    let step: Option<String> = steps::Entity::find()
        .select_only()
        .column(steps::Column::Id)
        .filter(steps::Column::CampaignId.eq(campaign_id))
        .into_tuple()
        .one(&orm(db))
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
pub async fn earliest_due_at(
    db: &PgPool,
    campaign_id: &str,
) -> ReachResult<Option<OffsetDateTime>> {
    let at: Option<Option<OffsetDateTime>> = enrollments::Entity::find()
        .select_only()
        .expr(Func::min(Expr::col(enrollments::Column::NextSendAt)))
        .filter(enrollments::Column::CampaignId.eq(campaign_id))
        .filter(enrollments::Column::Status.eq("active"))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(at.flatten().map(stamp))
}

/// `campaignStepStats(db, campaignId)`.
pub async fn step_stats(db: &PgPool, campaign_id: &str) -> ReachResult<Vec<Value>> {
    let steps = load_steps(db, campaign_id).await?;
    let conn = orm(db);
    let sent: Vec<(Option<String>, i64)> = messages::Entity::find()
        .select_only()
        .column(messages::Column::StepId)
        .expr(Func::count(Expr::col(Asterisk)))
        .filter(messages::Column::CampaignId.eq(campaign_id))
        .filter(messages::Column::Direction.eq("out"))
        .filter(messages::Column::Status.eq("sent"))
        .group_by(messages::Column::StepId)
        .into_tuple()
        .all(&conn)
        .await?;
    let outcomes: Vec<(Option<String>, String)> = messages::Entity::find()
        .select_only()
        .distinct_on([messages::Column::EnrollmentId])
        .column(messages::Column::StepId)
        .column(enrollments::Column::Status)
        .join(JoinType::InnerJoin, message_enrollment())
        .filter(messages::Column::CampaignId.eq(campaign_id))
        .filter(messages::Column::Direction.eq("out"))
        .filter(enrollments::Column::Status.is_in(["replied", "bounced"]))
        .filter(messages::Column::Status.is_in(["sent", "unknown", "failed"]))
        .order_by_asc(messages::Column::EnrollmentId)
        .order_by_desc(messages::Column::CreatedAt)
        .into_tuple()
        .all(&conn)
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

/// `join(reachEnrollments, eq(reachEnrollments.id, reachMessages.enrollmentId))`.
fn message_enrollment() -> RelationDef {
    messages::Entity::belongs_to(enrollments::Entity)
        .from(messages::Column::EnrollmentId)
        .to(enrollments::Column::Id)
        .into()
}

/// `completeCampaignIfDone(db, campaignId)`: the campaign when it was
/// completed now.
pub async fn complete_if_done(db: &PgPool, campaign_id: &str) -> ReachResult<Option<Value>> {
    let db = orm(db);
    let pending: Option<String> = enrollments::Entity::find()
        .select_only()
        .column(enrollments::Column::Id)
        .filter(enrollments::Column::CampaignId.eq(campaign_id))
        .filter(enrollments::Column::Status.is_in(["queued", "active"]))
        .into_tuple()
        .one(&db)
        .await?;
    if pending.is_some() {
        return Ok(None);
    }
    let at = now();
    let row = campaigns::Entity::update_many()
        .col_expr(campaigns::Column::Status, Expr::value("completed"))
        .col_expr(campaigns::Column::CompletedAt, Expr::value(at))
        .col_expr(campaigns::Column::UpdatedAt, Expr::value(at))
        .filter(campaigns::Column::Id.eq(campaign_id))
        .filter(campaigns::Column::Status.eq("active"))
        .filter(campaigns::Column::DeletedAt.is_null())
        .exec_with_returning(&db)
        .await?
        .into_iter()
        .next();
    Ok(row.map(serde_json::to_value).map(js).transpose()?)
}

/// `completeAndPublishCampaigns(db, emit, campaignIds)`.
pub async fn complete_and_publish(
    db: &PgPool,
    emit: &dyn EventSink,
    campaign_ids: &[String],
) -> ReachResult<()> {
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
    use campaigns::Column;
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
    let cursor = cursor_row::<campaigns::Entity>(
        db,
        Column::CreatedAt,
        Column::Id,
        query.cursor.as_deref(),
    )
    .await?;
    let mut filters = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(status) = &status {
        filters = filters.add(Column::Status.eq(status.as_str()));
    }
    if let Some(search) = &search {
        filters = filters.add(Column::Name.ilike(search.as_str()));
    }
    let page = match &cursor {
        Some(cursor) => filters
            .clone()
            .add(before(Column::CreatedAt, Column::Id, cursor)),
        None => filters.clone(),
    };
    let conn = orm(db);
    let rows = campaigns::Entity::find()
        .filter(page)
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(probe(limit))
        .all(&conn)
        .await?;
    let total = campaigns::Entity::find().filter(filters).count(&conn).await?;
    let rows = js_all(rows.into_iter().map(serde_json::to_value))?;
    Ok(page_result(
        &rows,
        limit,
        i64::try_from(total).unwrap_or(i64::MAX),
        to_campaign,
    ))
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
pub async fn create(
    db: &PgPool,
    emit: &dyn EventSink,
    user_id: &str,
    input: CampaignInput,
) -> ReachResult<Value> {
    let settings = load_settings(db).await?;
    let default = |key: &str| settings.as_ref().and_then(|s| s.get(key)).cloned();
    let timezone = input
        .timezone
        .clone()
        .or_else(|| default("defaultTimezone").and_then(|v| v.as_str().map(str::to_owned)));
    let send_days: Option<Value> = input
        .send_days
        .as_ref()
        .map(|d| json!(d))
        .or_else(|| default("defaultSendDays"));
    let window_start = input
        .window_start
        .clone()
        .or_else(|| default("defaultWindowStart").and_then(|v| v.as_str().map(str::to_owned)));
    let window_end = input
        .window_end
        .clone()
        .or_else(|| default("defaultWindowEnd").and_then(|v| v.as_str().map(str::to_owned)));
    let min_gap = input.min_gap_minutes.or_else(|| {
        settings
            .as_ref()
            .map(|_| crate::schemas::sending::MIN_GAP_MINUTES)
    });
    if let Some(problem) = schedule_problem(
        timezone.as_deref().unwrap_or("Europe/Amsterdam"),
        window_start.as_deref().unwrap_or("09:00"),
        window_end.as_deref().unwrap_or("17:00"),
    ) {
        return Err(ReachError::bad_request(problem));
    }
    let to_i32 = |n: i64| i32::try_from(n).unwrap_or(i32::MAX);
    let row = campaigns::Entity::insert(campaigns::ActiveModel {
        id: Set(generate_id("rcmp")),
        name: Set(input.name.clone().unwrap_or_default()),
        status: Set("draft".to_owned()),
        timezone: Set(timezone.unwrap_or_else(|| "Europe/Amsterdam".to_owned())),
        send_days: Set(send_days.unwrap_or_else(|| json!([1, 2, 3, 4, 5]))),
        window_start: Set(window_start.unwrap_or_else(|| "09:00".to_owned())),
        window_end: Set(window_end.unwrap_or_else(|| "17:00".to_owned())),
        daily_limit: Set(input.daily_limit.map_or(100, to_i32)),
        min_gap_minutes: Set(min_gap.map_or(8, to_i32)),
        stop_on_auto_reply: Set(input.stop_on_auto_reply.unwrap_or(false)),
        stats: Set(json!({
            "prospects": 0,
            "sent": 0,
            "replied": 0,
            "interested": 0,
            "bounced": 0,
            "unsubscribed": 0,
        })),
        owner_id: Set(Some(user_id.to_owned())),
        created_by: Set(Some(user_id.to_owned())),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    let row = js(serde_json::to_value(row))?;
    emit_campaign(emit, REACH_CAMPAIGN_CREATED, &row);
    let mut detail = to_campaign(&row);
    if let Some(map) = detail.as_object_mut() {
        map.insert("steps".to_owned(), json!([]));
        map.insert("mailboxIds".to_owned(), json!([]));
    }
    Ok(detail)
}

/// `updateCampaign(deps, id, input)`.
pub async fn update(
    db: &PgPool,
    emit: &dyn EventSink,
    id: &str,
    input: CampaignInput,
) -> ReachResult<Value> {
    let current = require_campaign(db, id).await?;
    let timezone = input
        .timezone
        .clone()
        .unwrap_or_else(|| crate::text_or_empty(&current, "timezone").to_owned());
    let start = input
        .window_start
        .clone()
        .unwrap_or_else(|| crate::text_or_empty(&current, "windowStart").to_owned());
    let end = input
        .window_end
        .clone()
        .unwrap_or_else(|| crate::text_or_empty(&current, "windowEnd").to_owned());
    if let Some(problem) = schedule_problem(&timezone, &start, &end) {
        return Err(ReachError::bad_request(problem));
    }
    let Some(row) = update_campaign_row(db, id, input).await? else {
        return Err(ReachError::not_found("Campaign", Some(id)));
    };
    emit_campaign(emit, REACH_CAMPAIGN_UPDATED, &row);
    get_detail(db, id).await
}

/// The `update` of [`update`]: the fields the body sent, and `updated_at`;
/// the changed live row.
async fn update_campaign_row(
    db: &PgPool,
    id: &str,
    input: CampaignInput,
) -> ReachResult<Option<Value>> {
    use campaigns::Column;
    let to_i32 = |n: i64| i32::try_from(n).unwrap_or(i32::MAX);
    let mut update = campaigns::Entity::update_many();
    if let Some(name) = input.name {
        update = update.col_expr(Column::Name, Expr::value(name));
    }
    if let Some(timezone) = input.timezone {
        update = update.col_expr(Column::Timezone, Expr::value(timezone));
    }
    if let Some(send_days) = input.send_days {
        update = update.col_expr(Column::SendDays, Expr::value(json!(send_days)));
    }
    if let Some(window_start) = input.window_start {
        update = update.col_expr(Column::WindowStart, Expr::value(window_start));
    }
    if let Some(window_end) = input.window_end {
        update = update.col_expr(Column::WindowEnd, Expr::value(window_end));
    }
    if let Some(daily_limit) = input.daily_limit {
        update = update.col_expr(Column::DailyLimit, Expr::value(to_i32(daily_limit)));
    }
    if let Some(min_gap) = input.min_gap_minutes {
        update = update.col_expr(Column::MinGapMinutes, Expr::value(to_i32(min_gap)));
    }
    if let Some(stop) = input.stop_on_auto_reply {
        update = update.col_expr(Column::StopOnAutoReply, Expr::value(stop));
    }
    if let Some(owner_id) = input.owner_id {
        update = update.col_expr(Column::OwnerId, Expr::value(owner_id));
    }
    let row = update
        .col_expr(Column::UpdatedAt, Expr::value(now()))
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next();
    Ok(row.map(serde_json::to_value).map(js).transpose()?)
}

/// `deleteCampaign(deps, id)`.
pub async fn delete(db: &PgPool, emit: &dyn EventSink, id: &str) -> ReachResult<()> {
    let current = require_campaign(db, id).await?;
    if text(&current, "status") == Some("active") {
        return Err(ReachError::state(
            "CAMPAIGN_ACTIVE",
            "Pause the campaign before deleting it",
        ));
    }
    let at = now();
    let conn = orm(db);
    campaigns::Entity::update_many()
        .col_expr(campaigns::Column::DeletedAt, Expr::value(at))
        .col_expr(campaigns::Column::UpdatedAt, Expr::value(at))
        .filter(campaigns::Column::Id.eq(id))
        .exec(&conn)
        .await?;
    let never: Option<OffsetDateTime> = None;
    enrollments::Entity::update_many()
        .col_expr(enrollments::Column::Status, Expr::value("paused"))
        .col_expr(
            enrollments::Column::StoppedReason,
            Expr::value("campaign_deleted"),
        )
        .col_expr(enrollments::Column::ClaimedAt, Expr::value(never))
        .col_expr(enrollments::Column::NextSendAt, Expr::value(never))
        .col_expr(enrollments::Column::UpdatedAt, Expr::value(at))
        .filter(enrollments::Column::CampaignId.eq(id))
        .filter(enrollments::Column::Status.is_in(["queued", "active"]))
        .exec(&conn)
        .await?;
    emit.emit(ReachEvent::new(
        REACH_CAMPAIGN_DELETED,
        id,
        json!({ "id": id }),
    ));
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
pub async fn replace_steps(
    db: &PgPool,
    emit: &dyn EventSink,
    id: &str,
    steps: Vec<StepInput>,
) -> ReachResult<Value> {
    let campaign = require_campaign(db, id).await?;
    if text(&campaign, "status") == Some("active") {
        return Err(ReachError::state(
            "CAMPAIGN_ACTIVE",
            "Pause the campaign before changing its steps",
        ));
    }
    let existing = load_steps(db, id).await?;
    let at = now();
    let campaign_id = id.to_owned();
    weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            let db = OrmConn::new(conn);
            let count = steps.len();
            for (order, step) in steps.into_iter().enumerate() {
                let order = i64::try_from(order).unwrap_or_default();
                let previous = existing
                    .iter()
                    .find(|s| int(s, "order") == order)
                    .and_then(|s| text(s, "id"));
                write_step(&db, &campaign_id, previous, order, step, at).await?;
            }
            let surplus: Vec<String> = existing
                .iter()
                .filter(|s| int(s, "order") >= i64::try_from(count).unwrap_or_default())
                .filter_map(|s| text(s, "id").map(str::to_owned))
                .collect();
            if !surplus.is_empty() {
                steps::Entity::delete_many()
                    .filter(steps::Column::Id.is_in(surplus))
                    .exec(&db)
                    .await?;
            }
            Ok::<_, ReachError>(())
        })
    })
    .await?;
    emit_campaign(emit, REACH_CAMPAIGN_UPDATED, &campaign);
    get_detail(db, id).await
}

/// One step of [`replace_steps`]: the step at `order` rewritten in place
/// (`previous`), or a new one.
async fn write_step(
    db: &OrmConn<'_>,
    campaign_id: &str,
    previous: Option<&str>,
    order: i64,
    step: StepInput,
    at: OffsetDateTime,
) -> ReachResult<()> {
    use steps::Column;
    let to_i32 = |n: i64| i32::try_from(n).unwrap_or(i32::MAX);
    match previous {
        Some(previous) => {
            steps::Entity::update_many()
                .col_expr(Column::DelayDays, Expr::value(to_i32(step.delay_days)))
                .col_expr(Column::DelayHours, Expr::value(to_i32(step.delay_hours)))
                .col_expr(Column::Subject, Expr::value(step.subject))
                .col_expr(Column::Body, Expr::value(step.body))
                .col_expr(Column::ReplyInThread, Expr::value(step.reply_in_thread))
                .col_expr(Column::UpdatedAt, Expr::value(at))
                .filter(Column::Id.eq(previous))
                .exec(db)
                .await?;
        }
        None => {
            steps::Entity::insert(steps::ActiveModel {
                id: Set(generate_id("rstp")),
                campaign_id: Set(campaign_id.to_owned()),
                order: Set(to_i32(order)),
                delay_days: Set(to_i32(step.delay_days)),
                delay_hours: Set(to_i32(step.delay_hours)),
                subject: Set(step.subject),
                body: Set(step.body),
                reply_in_thread: Set(step.reply_in_thread),
                ..Default::default()
            })
            .exec_without_returning(db)
            .await?;
        }
    }
    Ok(())
}

/// `setCampaignMailboxes(deps, id, mailboxIds)`.
pub async fn set_mailboxes(
    db: &PgPool,
    emit: &dyn EventSink,
    id: &str,
    mailbox_ids: &[String],
) -> ReachResult<Value> {
    let mailbox_ids = crate::unique(mailbox_ids);
    let campaign = require_campaign(db, id).await?;
    if !mailbox_ids.is_empty() {
        let found: Vec<String> = reach_mailboxes::Entity::find()
            .select_only()
            .column(reach_mailboxes::Column::Id)
            .filter(reach_mailboxes::Column::Id.is_in(&mailbox_ids))
            .filter(reach_mailboxes::Column::DeletedAt.is_null())
            .filter(reach_mailboxes::Column::Status.ne("deleted"))
            .into_tuple()
            .all(&orm(db))
            .await?;
        let unknown: Vec<&String> = mailbox_ids.iter().filter(|m| !found.contains(m)).collect();
        if !unknown.is_empty() {
            return Err(ReachError::bad_request("Some mailboxes do not exist")
                .with_details(json!({ "unknown": unknown })));
        }
    }
    let campaign_id = id.to_owned();
    let links: Vec<campaign_mailboxes::ActiveModel> = mailbox_ids
        .into_iter()
        .map(|mailbox_id| campaign_mailboxes::ActiveModel {
            id: Set(generate_id("rcmb")),
            campaign_id: Set(campaign_id.clone()),
            mailbox_id: Set(mailbox_id),
            ..Default::default()
        })
        .collect();
    weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            let db = OrmConn::new(conn);
            campaign_mailboxes::Entity::delete_many()
                .filter(campaign_mailboxes::Column::CampaignId.eq(campaign_id))
                .exec(&db)
                .await?;
            if !links.is_empty() {
                campaign_mailboxes::Entity::insert_many(links)
                    .exec_without_returning(&db)
                    .await?;
            }
            Ok::<_, ReachError>(())
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
    let (report, _) =
        add_prospects_to_campaign(db, id, prospect_ids, list_id, allow_consumer).await?;
    recount_prospects(db, id).await?;
    if text(&campaign, "status") == Some("active")
        && report
            .get("added")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            > 0
    {
        let (_, earliest) = activate_queued(db, &campaign, now()).await?;
        wake(due, earliest).await;
    }
    emit_campaign(emit, REACH_CAMPAIGN_UPDATED, &campaign);
    Ok(report)
}

/// `listEnrollments(db, campaignId, q)`.
pub async fn list_enrollments(
    db: &PgPool,
    campaign_id: &str,
    query: &PageQuery,
) -> ReachResult<Page> {
    require_campaign(db, campaign_id).await?;
    let limit = parse_limit(query.limit.as_deref());
    let status = match query.status.as_deref().filter(|s| !s.is_empty()) {
        Some(status) if ENROLLMENT_STATUSES.contains(&status) => Some(status.to_owned()),
        Some(_) => return Err(ReachError::bad_request("Unknown status filter")),
        None => None,
    };
    let cursor = cursor_row::<enrollments::Entity>(
        db,
        enrollments::Column::CreatedAt,
        enrollments::Column::Id,
        query.cursor.as_deref(),
    )
    .await?;
    let rows =
        list_campaign_enrollments(db, campaign_id, status.as_deref(), cursor.as_ref(), limit)
            .await?;
    let total = count_campaign_enrollments(db, campaign_id, status.as_deref()).await?;
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|(e, p, m)| {
            json!({ "id": field(&e, "id"), "row": e, "prospect": p, "mailboxEmail": m })
        })
        .collect();
    Ok(page_result(&rows, limit, total, |r| {
        to_enrollment(
            &field(r, "row"),
            &field(r, "prospect"),
            text(r, "mailboxEmail"),
        )
    }))
}

/// `removeCampaignEnrollment(deps, campaignId, enrollmentId)`.
pub async fn remove_campaign_enrollment(
    db: &PgPool,
    emit: &dyn EventSink,
    campaign_id: &str,
    enrollment_id: &str,
) -> ReachResult<()> {
    let campaign = require_campaign(db, campaign_id).await?;
    if !remove_enrollment(db, campaign_id, enrollment_id).await? {
        return Err(ReachError::not_found("Enrollment", Some(enrollment_id)));
    }
    recount_prospects(db, campaign_id).await?;
    emit_campaign(emit, REACH_CAMPAIGN_UPDATED, &campaign);
    complete_and_publish(db, emit, &[campaign_id.to_owned()]).await
}

/// `launchCampaign(deps, id)`.
pub async fn launch(
    db: &PgPool,
    emit: &dyn EventSink,
    due: Option<&dyn DuePort>,
    id: &str,
) -> ReachResult<Value> {
    let campaign = require_campaign(db, id).await?;
    match text(&campaign, "status") {
        Some("active") => {
            return Err(ReachError::state(
                "CAMPAIGN_ACTIVE",
                "This campaign is already running",
            ));
        }
        Some("paused") => {
            return Err(ReachError::state(
                "CAMPAIGN_PAUSED",
                "This campaign is paused; resume it instead",
            ));
        }
        Some("archived") => {
            return Err(ReachError::state(
                "CAMPAIGN_CLOSED",
                "This campaign is archived",
            ));
        }
        _ => {}
    }
    let problems = launch_problems(db, id).await?;
    if !problems.is_empty() {
        return Err(
            ReachError::bad_request("This campaign cannot be launched yet")
                .with_details(json!({ "problems": problems })),
        );
    }
    let at = now();
    let (_, earliest) = activate_queued(db, &campaign, at).await?;
    let launched_at = text(&campaign, "launchedAt")
        .and_then(crate::parse_iso)
        .unwrap_or(at);
    let row = set_status(
        db,
        id,
        &["draft", "completed"],
        campaigns::Entity::update_many()
            .col_expr(campaigns::Column::Status, Expr::value("active"))
            .col_expr(campaigns::Column::LaunchedAt, Expr::value(launched_at))
            .col_expr(
                campaigns::Column::CompletedAt,
                Expr::value(None::<OffsetDateTime>),
            )
            .col_expr(campaigns::Column::PausedReason, Expr::value(None::<String>))
            .col_expr(campaigns::Column::UpdatedAt, Expr::value(at)),
    )
    .await?;
    let Some(row) = row else {
        return Err(ReachError::state(
            "CAMPAIGN_ACTIVE",
            "This campaign was changed by someone else",
        ));
    };
    wake(due, earliest).await;
    emit_campaign(emit, REACH_CAMPAIGN_LAUNCHED, &row);
    get_detail(db, id).await
}

/// `update` of the campaign `id` while its status is one of `from`: the
/// changed row.
async fn set_status(
    db: &PgPool,
    id: &str,
    from: &[&str],
    update: sea_orm::UpdateMany<campaigns::Entity>,
) -> ReachResult<Option<Value>> {
    let row = update
        .filter(campaigns::Column::Id.eq(id))
        .filter(campaigns::Column::Status.is_in(from.iter().copied()))
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next();
    Ok(row.map(serde_json::to_value).map(js).transpose()?)
}

/// `pauseCampaign(deps, id)`.
pub async fn pause(db: &PgPool, emit: &dyn EventSink, id: &str) -> ReachResult<Value> {
    require_campaign(db, id).await?;
    let row = set_status(
        db,
        id,
        &["active"],
        campaigns::Entity::update_many()
            .col_expr(campaigns::Column::Status, Expr::value("paused"))
            .col_expr(campaigns::Column::PausedReason, Expr::value("manual"))
            .col_expr(campaigns::Column::UpdatedAt, Expr::value(now())),
    )
    .await?;
    let Some(row) = row else {
        return Err(ReachError::state(
            "CAMPAIGN_NOT_ACTIVE",
            "Only a running campaign can be paused",
        ));
    };
    emit_campaign(emit, REACH_CAMPAIGN_PAUSED, &row);
    get_detail(db, id).await
}

/// `resumeCampaign(deps, id)`.
pub async fn resume(
    db: &PgPool,
    emit: &dyn EventSink,
    due: Option<&dyn DuePort>,
    id: &str,
) -> ReachResult<Value> {
    let campaign = require_campaign(db, id).await?;
    if text(&campaign, "status") != Some("paused") {
        return Err(ReachError::state(
            "CAMPAIGN_NOT_PAUSED",
            "Only a paused campaign can be resumed",
        ));
    }
    let at = now();
    let (_, earliest) = activate_queued(db, &campaign, at).await?;
    let row = set_status(
        db,
        id,
        &["paused"],
        campaigns::Entity::update_many()
            .col_expr(campaigns::Column::Status, Expr::value("active"))
            .col_expr(campaigns::Column::PausedReason, Expr::value(None::<String>))
            .col_expr(campaigns::Column::UpdatedAt, Expr::value(at)),
    )
    .await?;
    let Some(row) = row else {
        return Err(ReachError::state(
            "CAMPAIGN_NOT_PAUSED",
            "This campaign was changed by someone else",
        ));
    };
    let due_at = earliest_due_at(db, id).await?.or(earliest);
    wake(due, due_at).await;
    emit_campaign(emit, REACH_CAMPAIGN_UPDATED, &row);
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
        (
            input.subject.clone().unwrap_or_default(),
            input.body.clone().unwrap_or_default(),
        )
    } else {
        let steps = load_steps(db, id).await?;
        let step = match input.step_id.as_deref() {
            Some(step_id) if !step_id.is_empty() => {
                steps.iter().find(|s| text(s, "id") == Some(step_id))
            }
            _ => steps.first(),
        };
        match step {
            Some(step) => (
                crate::text_or_empty(step, "subject").to_owned(),
                crate::text_or_empty(step, "body").to_owned(),
            ),
            None => {
                return Err(match input.step_id.as_deref().filter(|s| !s.is_empty()) {
                    Some(step_id) => ReachError::not_found("Step", Some(step_id)),
                    None => ReachError::bad_request("The campaign has no step to preview"),
                });
            }
        }
    };
    let prospect: Option<Value> = if let Some(prospect_id) =
        input.prospect_id.as_deref().filter(|p| !p.is_empty())
    {
        let row = reach_prospects::Entity::find_by_id(prospect_id)
            .filter(reach_prospects::Column::DeletedAt.is_null())
            .one(&orm(db))
            .await?;
        match row {
            Some(row) => Some(js(serde_json::to_value(row))?),
            None => return Err(ReachError::not_found("Prospect", Some(prospect_id))),
        }
    } else {
        let row = reach_prospects::Entity::find()
            .join(
                JoinType::InnerJoin,
                reach_prospects::Entity::belongs_to(enrollments::Entity)
                    .from(reach_prospects::Column::Id)
                    .to(enrollments::Column::ProspectId)
                    .into(),
            )
            .filter(enrollments::Column::CampaignId.eq(id))
            .filter(reach_prospects::Column::DeletedAt.is_null())
            .order_by_asc(enrollments::Column::CreatedAt)
            .one(&orm(db))
            .await?;
        row.map(serde_json::to_value).map(js).transpose()?
    };
    let mailbox_ids = load_mailbox_ids(db, id).await?;
    let mailbox: Option<(String, String, Option<String>)> = if mailbox_ids.is_empty() {
        None
    } else {
        reach_mailboxes::Entity::find()
            .select_only()
            .column(reach_mailboxes::Column::FirstName)
            .column(reach_mailboxes::Column::LastName)
            .column(reach_mailboxes::Column::Signature)
            .filter(reach_mailboxes::Column::Id.is_in(mailbox_ids))
            .filter(reach_mailboxes::Column::DeletedAt.is_null())
            .order_by_asc(reach_mailboxes::Column::CreatedAt)
            .into_tuple()
            .one(&orm(db))
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
pub async fn add_to_stats(
    db: &PgPool,
    campaign_id: &str,
    delta: &[(&str, i64)],
) -> ReachResult<()> {
    use sea_orm::ExprTrait as _;
    use sea_orm::sea_query::extension::postgres::PgExpr;
    let delta: Map<String, Value> = delta
        .iter()
        .filter(|(_, n)| *n != 0)
        .map(|(k, n)| ((*k).to_owned(), json!(n)))
        .collect();
    if delta.is_empty() {
        return Ok(());
    }
    // `stats || jsonb_build_object(key, coalesce((stats->>key)::int, 0) + n, …)`.
    let mut pairs: Vec<Expr> = Vec::with_capacity(delta.len() * 2);
    for (key, n) in delta {
        let current = PgExpr::cast_json_field(Expr::col(campaigns::Column::Stats), key.as_str())
            .cast_as("int");
        pairs.push(Expr::val(key));
        pairs.push(Func::coalesce([current, Expr::val(0)]).add(n.as_i64().unwrap_or_default()));
    }
    campaigns::Entity::update_many()
        .col_expr(
            campaigns::Column::Stats,
            PgExpr::concat(
                Expr::col(campaigns::Column::Stats),
                Func::cust("jsonb_build_object").args(pairs),
            ),
        )
        .filter(campaigns::Column::Id.eq(campaign_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}
