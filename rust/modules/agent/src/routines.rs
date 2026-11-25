//! Routines: the data the scheduler and the dispatcher read, and the sweep
//! that starts due cron routines (`packages/domains/agent/src/parity.ts`
//! routines, `apps/workers/agent-api/src/cron/weldagent-routines.ts`).
//!
//! The Cloudflare worker keeps a D1 index of due routines and starts each run
//! in a Workflow. Here the workspace due index (`workspace_due_index`, kind
//! [`DUE_KIND`]) says which tenants have a routine due, and each run is
//! started in the sweep's own process through [`crate::run::run_agent`]. A
//! workspace's routines are re-indexed whenever its sweep runs, as the worker
//! does, so a missed write is repaired.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, JoinType, QueryFilter,
    QueryOrder, QuerySelect, RelationDef,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::weldagent_agents as agents;
use weldsuite_schema::tenant::weldagent_routine_runs as routine_runs;
use weldsuite_schema::tenant::weldagent_routines::{self as routines, Column};

use crate::agents::{js, now_tz, row_limit};

/// The `workspace_due_index` kind of the routine sweep.
pub const DUE_KIND: &str = "weldagent_routine";

/// A routine's final reply is posted in its owner's chat thread
/// (`ROUTINE_RESULT_SYSTEM`).
pub const ROUTINE_RESULT_SYSTEM: &str = "Your final reply is posted in the user's chat with you as this routine's result, and they are notified. \
Write it as the message they should read (for a digest: the digest itself), not a report about running the routine.";

/// `new Date(ms)`, as it is written to a `timestamp with time zone` column.
fn at_ms(ms: i64) -> OffsetDateTime {
    let nanos = i128::from(ms) * 1_000_000;
    OffsetDateTime::from_unix_timestamp_nanos(nanos).unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// `(extract(epoch from at) * 1000)::bigint`: milliseconds since the epoch,
/// rounded half away from zero as Postgres rounds the numeric.
fn epoch_ms(at: OffsetDateTime) -> i64 {
    let micros = at.unix_timestamp_nanos().div_euclid(1_000);
    let millis = micros.div_euclid(1_000);
    let rest = micros.rem_euclid(1_000);
    let rounded = if millis < 0 {
        // Away from zero for a negative value: -1.5 → -2.
        if rest > 500 { millis + 1 } else { millis }
    } else if rest >= 500 {
        millis + 1
    } else {
        millis
    };
    i64::try_from(rounded).unwrap_or_default()
}

/// `computeNextHourlyRun(from)`: the top of the next UTC hour, the fallback
/// when a cron expression can't be parsed.
pub fn compute_next_hourly_run(from_ms: i64) -> i64 {
    const HOUR: i64 = 3_600_000;
    from_ms.div_euclid(HOUR) * HOUR + HOUR
}

/// `computeRoutineNextRun(cronExpr, timezone, from)`: the next due time of a
/// cron routine, honouring its expression and timezone.
pub fn compute_routine_next_run(
    cron_expr: Option<&str>,
    timezone: Option<&str>,
    from_ms: i64,
) -> i64 {
    let expr = cron_expr
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .unwrap_or("0 * * * *");
    let zone = timezone.filter(|z| !z.is_empty()).unwrap_or("UTC");
    weldsuite_connect::compute_next_run_at(expr, zone, from_ms, None, None)
        .unwrap_or_else(|| compute_next_hourly_run(from_ms))
}

/// `routineScheduleError(cronExpr, timezone)`: why a cron schedule can't run
/// as given, or `None` when it can. Without this a typo'd cron or timezone
/// falls back to hourly, so a daily digest would quietly run every hour.
pub fn routine_schedule_error(
    cron_expr: Option<&str>,
    timezone: Option<&str>,
    now_ms: i64,
) -> Option<String> {
    if let Some(zone) = timezone.filter(|z| !z.is_empty())
        && weldsuite_connect::compute_next_run_at("* * * * *", zone, now_ms, None, None).is_none()
    {
        return Some(format!(
            "Unknown timezone \"{zone}\". Use an IANA name such as \"Europe/Amsterdam\"."
        ));
    }
    let expr = cron_expr.map(str::trim).filter(|e| !e.is_empty())?;
    if expr.split_whitespace().count() != 5 {
        return Some(format!(
            "cronExpr \"{expr}\" must have five fields (minute hour day month weekday), e.g. \"0 7 * * 1-5\"."
        ));
    }
    let zone = timezone.filter(|z| !z.is_empty()).unwrap_or("UTC");
    if weldsuite_connect::compute_next_run_at(expr, zone, now_ms, None, None).is_none() {
        return Some(format!(
            "cronExpr \"{expr}\" is not valid or never fires. Use five fields, e.g. \"0 7 * * 1-5\"."
        ));
    }
    None
}

/// `serializeRoutine(row)`.
fn serialize(routine: routines::Model) -> Value {
    let row = js(routine);
    let pick = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": pick("id"), "agentId": pick("agentId"), "name": pick("name"),
        "instructions": pick("instructions"), "skillId": pick("skillId"),
        "scheduleKind": pick("scheduleKind"), "cronExpr": pick("cronExpr"),
        "timezone": pick("timezone"), "eventKey": pick("eventKey"),
        "connectorConfig": pick("connectorConfig"), "enabled": pick("enabled"),
        "requireApproval": pick("requireApproval"), "lastRunAt": pick("lastRunAt"),
        "nextRunAt": pick("nextRunAt"), "createdBy": pick("createdBy"),
        "createdAt": pick("createdAt"), "updatedAt": pick("updatedAt"),
    })
}

/// `join weldagent_agents a on a.id = r.agent_id`.
fn of_agent() -> RelationDef {
    routines::Entity::belongs_to(agents::Entity)
        .from(Column::AgentId)
        .to(agents::Column::Id)
        .into()
}

/// The routine's agent is live: active and not deleted. Pausing an agent
/// pauses its schedule.
fn agent_is_live() -> Condition {
    Condition::all()
        .add(agents::Column::Status.eq("active"))
        .add(agents::Column::DeletedAt.is_null())
}

/// `listDueCronRoutines(db, asOf)`: enabled cron routines whose `next_run_at`
/// has passed. Routines of paused, draft or deleted agents are skipped:
/// pausing an agent pauses its schedule.
///
/// # Errors
///
/// The tenant database fails.
pub async fn list_due_cron_routines(db: &PgPool, as_of_ms: i64) -> Result<Vec<Value>, DbErr> {
    Ok(routines::Entity::find()
        .join(JoinType::InnerJoin, of_agent())
        .filter(Column::Enabled.eq(true))
        .filter(Column::ScheduleKind.eq("cron"))
        .filter(Column::DeletedAt.is_null())
        .filter(Column::NextRunAt.lte(at_ms(as_of_ms)))
        .filter(agent_is_live())
        .limit(50)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(serialize)
        .collect())
}

/// `findEventRoutines(db, eventKey)`: enabled event routines (of active
/// agents) listening for `eventKey`.
///
/// # Errors
///
/// The tenant database fails.
pub async fn find_event_routines(db: &PgPool, event_key: &str) -> Result<Vec<Value>, DbErr> {
    Ok(routines::Entity::find()
        .join(JoinType::InnerJoin, of_agent())
        .filter(Column::Enabled.eq(true))
        .filter(Column::ScheduleKind.eq("event"))
        .filter(Column::EventKey.eq(event_key))
        .filter(Column::DeletedAt.is_null())
        .filter(agent_is_live())
        .all(&orm(db))
        .await?
        .into_iter()
        .map(serialize)
        .collect())
}

/// `claimDueRoutine(db, routine, asOf)`: atomically advance a due cron
/// routine's `next_run_at` only if it is still due. Overlapping sweeps can
/// both list the same routine, but only one claim succeeds, so each occurrence
/// runs once.
///
/// # Errors
///
/// The tenant database fails.
pub async fn claim_due_routine(db: &PgPool, routine: &Value, as_of_ms: i64) -> Result<bool, DbErr> {
    let next = compute_routine_next_run(
        routine["cronExpr"].as_str(),
        routine["timezone"].as_str(),
        as_of_ms,
    );
    let now = now_tz();
    let claimed = routines::Entity::update_many()
        .col_expr(Column::LastRunAt, Expr::value(now))
        .col_expr(Column::NextRunAt, Expr::value(at_ms(next)))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(routine["id"].as_str().unwrap_or_default()))
        .filter(Column::NextRunAt.lte(at_ms(as_of_ms)))
        .exec(&orm(db))
        .await?;
    Ok(claimed.rows_affected > 0)
}

/// `releaseRoutineClaim(db, routineId, dueAt)`: give back a claimed occurrence
/// that could not be started (retried next sweep).
///
/// # Errors
///
/// The tenant database fails.
pub async fn release_routine_claim(
    db: &PgPool,
    routine_id: &str,
    due_at_ms: i64,
) -> Result<(), DbErr> {
    routines::Entity::update_many()
        .col_expr(Column::NextRunAt, Expr::value(at_ms(due_at_ms)))
        .col_expr(Column::UpdatedAt, Expr::value(now_tz()))
        .filter(Column::Id.eq(routine_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `markRoutineScheduled(db, routine)`: record a routine run; cron routines
/// also advance past it.
///
/// # Errors
///
/// The tenant database fails.
pub async fn mark_routine_scheduled(
    db: &PgPool,
    routine: &Value,
    now_ms: i64,
) -> Result<(), DbErr> {
    let is_cron = routine["scheduleKind"].as_str().unwrap_or("cron") == "cron";
    let now = now_tz();
    let mut update = routines::Entity::update_many()
        .col_expr(Column::LastRunAt, Expr::value(now))
        .col_expr(Column::UpdatedAt, Expr::value(now));
    // `next_run_at = coalesce(next, next_run_at)`: only a cron routine moves on.
    if is_cron {
        let next = compute_routine_next_run(
            routine["cronExpr"].as_str(),
            routine["timezone"].as_str(),
            now_ms,
        );
        update = update.col_expr(Column::NextRunAt, Expr::value(at_ms(next)));
    }
    update
        .filter(Column::Id.eq(routine["id"].as_str().unwrap_or_default()))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `createRoutineRun(db, { routineId, agentId, trigger })`.
///
/// # Errors
///
/// The tenant database fails.
pub async fn create_routine_run(
    db: &PgPool,
    routine_id: &str,
    agent_id: &str,
    trigger: &str,
) -> Result<String, DbErr> {
    let id = generate_id("rrn");
    routine_runs::Entity::insert(routine_runs::ActiveModel {
        id: Set(id.clone()),
        routine_id: Set(routine_id.to_owned()),
        agent_id: Set(agent_id.to_owned()),
        status: Set("queued".to_owned()),
        trigger: Set(trigger.to_owned()),
        started_at: Set(Some(now_tz())),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    Ok(id)
}

/// `completeRoutineRun(db, runId, { status, summary, error, agentRunId })`.
///
/// # Errors
///
/// The tenant database fails.
pub async fn complete_routine_run(
    db: &PgPool,
    run_id: &str,
    status: &str,
    summary: Option<&str>,
    error: Option<&str>,
    agent_run_id: Option<&str>,
) -> Result<(), DbErr> {
    use routine_runs::Column as Run;
    routine_runs::Entity::update_many()
        .col_expr(Run::Status, Expr::value(status))
        .col_expr(Run::Summary, Expr::value(summary))
        .col_expr(Run::Error, Expr::value(error))
        .col_expr(Run::AgentRunId, Expr::value(agent_run_id))
        .col_expr(Run::CompletedAt, Expr::value(now_tz()))
        .filter(Run::Id.eq(run_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `hasRoutineRunForTrigger(db, routineId, trigger)`: the redelivery guard.
///
/// # Errors
///
/// The tenant database fails.
pub async fn has_routine_run_for_trigger(
    db: &PgPool,
    routine_id: &str,
    trigger: &str,
) -> Result<bool, DbErr> {
    use routine_runs::Column as Run;
    let found: Option<String> = routine_runs::Entity::find()
        .select_only()
        .column(Run::Id)
        .filter(Run::RoutineId.eq(routine_id))
        .filter(Run::Trigger.eq(trigger))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

/// The earliest `next_run_at` of a workspace's live cron routines (enabled,
/// not deleted, of an active agent): what the due index is set to. A live
/// routine without one (a legacy row) is due now.
///
/// # Errors
///
/// The tenant database fails.
pub async fn earliest_due(db: &PgPool, now_ms: i64) -> Result<Option<OffsetDateTime>, DbErr> {
    let live: Vec<Option<OffsetDateTime>> = routines::Entity::find()
        .select_only()
        .column(Column::NextRunAt)
        .join(JoinType::InnerJoin, of_agent())
        .filter(Column::Enabled.eq(true))
        .filter(Column::ScheduleKind.eq("cron"))
        .filter(Column::DeletedAt.is_null())
        .filter(agent_is_live())
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(live
        .into_iter()
        .map(|at| at.map_or(now_ms, epoch_ms))
        .min()
        .map(|ms| {
            OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
                .unwrap_or(OffsetDateTime::UNIX_EPOCH)
        }))
}

/// `runWeldAgentRoutineSweepForTenant`: start due cron routines for one
/// workspace. Each routine is claimed first (a concurrent sweep that listed
/// the same one loses), recorded, and run through the seam. A run that could
/// not start fails its row and makes the routine due again, so the next sweep
/// retries instead of silently skipping the occurrence.
///
/// Returns how many routines started.
///
/// # Errors
///
/// The tenant database fails.
pub async fn run_routine_sweep_for_tenant(
    db: &PgPool,
    launcher: &crate::launch::RunLauncher,
    workspace_id: &str,
    actor_user_id: Option<&str>,
    now_ms: i64,
) -> Result<usize, DbErr> {
    let due = list_due_cron_routines(db, now_ms).await?;
    let mut started = 0;
    for routine in due {
        if !claim_due_routine(db, &routine, now_ms).await? {
            continue;
        }
        let routine_id = routine["id"].as_str().unwrap_or_default().to_owned();
        let agent_id = routine["agentId"].as_str().unwrap_or_default().to_owned();
        let run_id = create_routine_run(db, &routine_id, &agent_id, "schedule").await?;
        let actor = actor_user_id
            .map(str::to_owned)
            .or_else(|| routine["createdBy"].as_str().map(str::to_owned))
            .unwrap_or_else(|| "system".to_owned());
        let params = crate::run::RunParams {
            db: db.clone(),
            workspace_id: workspace_id.to_owned(),
            actor_user_id: actor,
            agent_id: agent_id.clone(),
            trigger_type: crate::run::TriggerType::Event,
            trigger_data: Some(json!({ "routineId": routine_id, "schedule": true })),
            user_message: format!(
                "Scheduled routine \"{}\" is due.\n\n{}",
                routine["name"].as_str().unwrap_or_default(),
                routine["instructions"].as_str().unwrap_or_default()
            ),
            extra_system: Some(ROUTINE_RESULT_SYSTEM.to_owned()),
            run_id: None,
            routine_run_id: Some(run_id.clone()),
            skip_approvals: routine["requireApproval"] != json!(true),
            notify: false,
            actor_permissions: None,
            events: None,
            env: crate::run::RunEnv::default(),
        };
        let release = crate::launch::Release {
            routine_id: &routine_id,
            due_at_ms: now_ms,
        };
        match launcher.start(params, Some(release)).await {
            Ok(()) => started += 1,
            Err(message) => {
                complete_routine_run(db, &run_id, "failed", None, Some(&message), None).await?;
                release_routine_claim(db, &routine_id, now_ms).await?;
            }
        }
    }
    Ok(started)
}

/// Make the sweep look at this workspace when its earliest routine is due
/// (`reindexAgentRoutines`, `reindexWorkspaceRoutines`). Best effort: a failure
/// is logged and never fails the user's save. A no-op without a master
/// database (conformance builds).
pub async fn reindex_workspace(master: Option<&PgPool>, db: &PgPool, workspace_id: &str) {
    let Some(master) = master else { return };
    let now = now_ms();
    weldsuite_db::due_index::sync_due(master, DUE_KIND, workspace_id, || earliest_due(db, now))
        .await;
}

fn now_ms() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or_default()
}

/// `weldsuite cron weldagent-routines`: one tick of the routine sweep
/// (`runWeldAgentRoutineSweep`). Opens only the workspaces the due index
/// lists, runs their due routines, and stores when each is next due.
pub async fn run_routine_sweep(
    master: &PgPool,
    tenants: &dyn weldsuite_subscribers::Tenants,
    launcher: &crate::launch::RunLauncher,
    now: OffsetDateTime,
) -> weldsuite_db::due_index::SweepResult {
    weldsuite_db::due_index::run_sweep(
        master,
        DUE_KIND,
        now,
        500,
        Some(time::Duration::minutes(15)),
        |workspace_id, at| async move {
            let tenant = tenants
                .tenant(&workspace_id)
                .await
                .map_err(|error| error.to_string())?;
            let at_ms = i64::try_from(at.unix_timestamp_nanos() / 1_000_000).unwrap_or_default();
            let started = run_routine_sweep_for_tenant(
                &tenant.db,
                launcher,
                &tenant.workspace_id,
                None,
                at_ms,
            )
            .await
            .map_err(|error| error.to_string())?;
            tracing::info!(
                workspace_id,
                started,
                "[WeldAgentRoutineSweep] routines started"
            );
            // The tenant is awake anyway: its next due time, re-derived.
            earliest_due(&tenant.db, at_ms)
                .await
                .map_err(|error| error.to_string())
        },
    )
    .await
}

/// `getRoutine(db, id)`.
///
/// # Errors
///
/// The tenant database fails.
pub async fn get_routine(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    Ok(routines::Entity::find_by_id(id.to_owned())
        .filter(Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(serialize))
}

/// `listRoutines(db, agentId?)`: newest change first.
///
/// # Errors
///
/// The tenant database fails.
pub async fn list_routines(db: &PgPool, agent_id: Option<&str>) -> Result<Vec<Value>, DbErr> {
    let mut query = routines::Entity::find().filter(Column::DeletedAt.is_null());
    if let Some(agent_id) = agent_id {
        query = query.filter(Column::AgentId.eq(agent_id));
    }
    Ok(query
        .order_by_desc(Column::UpdatedAt)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(serialize)
        .collect())
}

/// What `createRoutine` takes.
#[derive(Debug, Default)]
pub struct NewRoutine {
    pub agent_id: String,
    pub name: String,
    pub instructions: String,
    pub skill_id: Option<String>,
    pub schedule_kind: Option<String>,
    pub cron_expr: Option<String>,
    pub timezone: Option<String>,
    pub event_key: Option<String>,
    pub connector_config: Option<Value>,
    pub enabled: Option<bool>,
    pub require_approval: Option<bool>,
    pub created_by: Option<String>,
}

/// `createRoutine(db, input)`: a cron routine gets its first `next_run_at`.
///
/// # Errors
///
/// The tenant database fails.
pub async fn create_routine(db: &PgPool, input: NewRoutine) -> Result<Value, DbErr> {
    let id = generate_id("rtn");
    let kind = input.schedule_kind.unwrap_or_else(|| "cron".to_owned());
    let cron = input
        .cron_expr
        .or_else(|| (kind == "cron").then(|| "0 * * * *".to_owned()));
    let timezone = input.timezone.unwrap_or_else(|| "UTC".to_owned());
    let next = (kind == "cron").then(|| {
        at_ms(compute_routine_next_run(
            cron.as_deref(),
            Some(&timezone),
            now_ms(),
        ))
    });
    routines::Entity::insert(routines::ActiveModel {
        id: Set(id.clone()),
        agent_id: Set(input.agent_id),
        name: Set(input.name.trim().to_owned()),
        instructions: Set(input.instructions.trim().to_owned()),
        skill_id: Set(input.skill_id),
        schedule_kind: Set(kind),
        cron_expr: Set(cron),
        timezone: Set(timezone),
        event_key: Set(input.event_key),
        connector_config: Set(input.connector_config),
        enabled: Set(input.enabled.unwrap_or(true)),
        require_approval: Set(input.require_approval.unwrap_or(false)),
        next_run_at: Set(next),
        created_by: Set(input.created_by),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    Ok(get_routine(db, &id).await?.unwrap_or(Value::Null))
}

/// `updateRoutine(db, id, input)`: `input` has the camelCase keys the route
/// body has, present only when set (a JSON `null` clears a nullable field).
///
/// # Errors
///
/// The tenant database fails.
pub async fn update_routine(
    db: &PgPool,
    id: &str,
    input: &serde_json::Map<String, Value>,
) -> Result<Option<Value>, DbErr> {
    let Some(existing) = get_routine(db, id).await? else {
        return Ok(None);
    };
    let text = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
    let kind = text("scheduleKind").unwrap_or_else(|| {
        existing["scheduleKind"]
            .as_str()
            .unwrap_or("cron")
            .to_owned()
    });
    let schedule_changed = input.get("enabled") == Some(&json!(true))
        || input.contains_key("scheduleKind")
        || input.contains_key("cronExpr")
        || input.contains_key("timezone");
    // `Some(Some(x))` sets, `Some(None)` clears, `None` leaves.
    let next: Option<Option<OffsetDateTime>> = if kind == "cron" && schedule_changed {
        let cron = if input.contains_key("cronExpr") {
            text("cronExpr")
        } else {
            existing["cronExpr"].as_str().map(str::to_owned)
        };
        let zone = text("timezone").or_else(|| existing["timezone"].as_str().map(str::to_owned));
        Some(Some(at_ms(compute_routine_next_run(
            cron.as_deref(),
            zone.as_deref(),
            now_ms(),
        ))))
    } else if kind != "cron" && input.contains_key("scheduleKind") {
        Some(None)
    } else {
        None
    };
    let mut update =
        routines::Entity::update_many().col_expr(Column::UpdatedAt, Expr::value(now_tz()));
    for (key, column) in [
        ("name", Column::Name),
        ("instructions", Column::Instructions),
        ("skillId", Column::SkillId),
        ("scheduleKind", Column::ScheduleKind),
        ("cronExpr", Column::CronExpr),
        ("timezone", Column::Timezone),
        ("eventKey", Column::EventKey),
    ] {
        if let Some(value) = input.get(key) {
            let value = value.as_str().map(|v| {
                if key == "name" || key == "instructions" {
                    v.trim().to_owned()
                } else {
                    v.to_owned()
                }
            });
            update = update.col_expr(column, Expr::value(value));
        }
    }
    if let Some(config) = input.get("connectorConfig") {
        update = update.col_expr(
            Column::ConnectorConfig,
            Expr::value((!config.is_null()).then(|| config.clone())),
        );
    }
    for (key, column) in [
        ("enabled", Column::Enabled),
        ("requireApproval", Column::RequireApproval),
    ] {
        if let Some(flag) = input.get(key).and_then(Value::as_bool) {
            update = update.col_expr(column, Expr::value(flag));
        }
    }
    if let Some(next) = next {
        update = update.col_expr(Column::NextRunAt, Expr::value(next));
    }
    update.filter(Column::Id.eq(id)).exec(&orm(db)).await?;
    get_routine(db, id).await
}

/// `deleteRoutine(db, id)`: soft delete, and off.
///
/// # Errors
///
/// The tenant database fails.
pub async fn delete_routine(db: &PgPool, id: &str) -> Result<bool, DbErr> {
    if get_routine(db, id).await?.is_none() {
        return Ok(false);
    }
    let now = now_tz();
    routines::Entity::update_many()
        .col_expr(Column::DeletedAt, Expr::value(now))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .col_expr(Column::Enabled, Expr::value(false))
        .filter(Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(true)
}

/// `listRoutineRuns(db, routineId, limit)`.
///
/// # Errors
///
/// The tenant database fails.
pub async fn list_routine_runs(
    db: &PgPool,
    routine_id: &str,
    limit: i64,
) -> Result<Vec<Value>, DbErr> {
    Ok(routine_runs::Entity::find()
        .filter(routine_runs::Column::RoutineId.eq(routine_id))
        .order_by_desc(routine_runs::Column::CreatedAt)
        .limit(row_limit(limit)?)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(js)
        .collect())
}

/// `findConnectorRoutines(db, input)`: enabled connector routines that match a
/// Slack or GitHub event.
///
/// # Errors
///
/// The tenant database fails.
pub async fn find_connector_routines(
    db: &PgPool,
    provider: &str,
    channel: Option<&str>,
    repo: Option<&str>,
    event: Option<&str>,
    text: Option<&str>,
) -> Result<Vec<Value>, DbErr> {
    let rows = routines::Entity::find()
        .filter(Column::Enabled.eq(true))
        .filter(Column::ScheduleKind.eq("connector"))
        .filter(Column::DeletedAt.is_null())
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(serialize)
        .filter(|r| {
            let cfg = &r["connectorConfig"];
            if cfg["provider"].as_str() != Some(provider) {
                return false;
            }
            let differs = |key: &str, given: Option<&str>| {
                cfg[key]
                    .as_str()
                    .filter(|c| !c.is_empty())
                    .zip(given.filter(|g| !g.is_empty()))
                    .is_some_and(|(c, g)| c != g)
            };
            if differs("channel", channel) || differs("repo", repo) || differs("event", event) {
                return false;
            }
            if let (Some(pattern), Some(text)) = (
                cfg["match"].as_str().filter(|m| !m.is_empty()),
                text.filter(|t| !t.is_empty()),
            ) {
                if !text.to_lowercase().contains(&pattern.to_lowercase()) {
                    return false;
                }
            }
            true
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hourly_fallback_is_the_next_whole_hour() {
        let at = 1_700_000_123_000;
        let next = compute_next_hourly_run(at);
        assert_eq!(next % 3_600_000, 0);
        assert!(next > at && next - at <= 3_600_000);
    }

    #[test]
    fn schedules_are_checked() {
        let now = 1_700_000_000_000;
        assert_eq!(
            routine_schedule_error(Some("0 7 * * 1-5"), Some("Europe/Amsterdam"), now),
            None
        );
        assert!(
            routine_schedule_error(Some("0 7 * *"), None, now)
                .unwrap_or_default()
                .contains("five fields")
        );
        assert!(
            routine_schedule_error(Some("0 7 * * *"), Some("Nowhere/Land"), now)
                .unwrap_or_default()
                .contains("Unknown timezone")
        );
        assert_eq!(routine_schedule_error(None, None, now), None);
    }

    #[test]
    fn epoch_milliseconds_round_like_postgres() {
        let at = |nanos: i128| OffsetDateTime::from_unix_timestamp_nanos(nanos).unwrap();
        assert_eq!(epoch_ms(at(1_700_000_000_123_000_000)), 1_700_000_000_123);
        assert_eq!(epoch_ms(at(1_700_000_000_123_499_000)), 1_700_000_000_123);
        assert_eq!(epoch_ms(at(1_700_000_000_123_500_000)), 1_700_000_000_124);
        assert_eq!(epoch_ms(at(-1_500_000)), -2);
        assert_eq!(epoch_ms(at_ms(1_700_000_000_000)), 1_700_000_000_000);
    }

    #[test]
    fn a_cron_routine_runs_at_its_hour() {
        // 2023-11-14T22:13:20Z; the next "0 7 * * *" in UTC is the 15th at 07:00.
        let next = compute_routine_next_run(Some("0 7 * * *"), Some("UTC"), 1_700_000_000_000);
        assert_eq!(next, 1_700_031_600_000);
    }
}
