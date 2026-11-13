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

use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::js_row;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;

/// The `workspace_due_index` kind of the routine sweep.
pub const DUE_KIND: &str = "weldagent_routine";

/// A routine's final reply is posted in its owner's chat thread
/// (`ROUTINE_RESULT_SYSTEM`).
pub const ROUTINE_RESULT_SYSTEM: &str = "Your final reply is posted in the user's chat with you as this routine's result, and they are notified. \
Write it as the message they should read (for a digest: the digest itself), not a report about running the routine.";

fn iso_of_ms(ms: i64) -> String {
    let nanos = i128::from(ms) * 1_000_000;
    iso_timestamp(
        OffsetDateTime::from_unix_timestamp_nanos(nanos).unwrap_or(OffsetDateTime::UNIX_EPOCH),
    )
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
fn serialize(row: Value) -> Value {
    let row = js_row(row);
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

/// `listDueCronRoutines(db, asOf)`: enabled cron routines whose `next_run_at`
/// has passed. Routines of paused, draft or deleted agents are skipped:
/// pausing an agent pauses its schedule.
///
/// # Errors
///
/// The tenant database fails.
pub async fn list_due_cron_routines(db: &PgPool, as_of_ms: i64) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from weldagent_routines r join weldagent_agents a on a.id = r.agent_id
         where r.enabled = true and r.schedule_kind = 'cron' and r.deleted_at is null
           and r.next_run_at <= $1::timestamptz and a.status = 'active' and a.deleted_at is null
         limit 50",
    )
    .bind(iso_of_ms(as_of_ms))
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(serialize).collect())
}

/// `findEventRoutines(db, eventKey)`: enabled event routines (of active
/// agents) listening for `eventKey`.
///
/// # Errors
///
/// The tenant database fails.
pub async fn find_event_routines(db: &PgPool, event_key: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from weldagent_routines r join weldagent_agents a on a.id = r.agent_id
         where r.enabled = true and r.schedule_kind = 'event' and r.event_key = $1 and r.deleted_at is null
           and a.status = 'active' and a.deleted_at is null",
    )
    .bind(event_key)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(serialize).collect())
}

/// `claimDueRoutine(db, routine, asOf)`: atomically advance a due cron
/// routine's `next_run_at` only if it is still due. Overlapping sweeps can
/// both list the same routine, but only one claim succeeds, so each occurrence
/// runs once.
///
/// # Errors
///
/// The tenant database fails.
pub async fn claim_due_routine(
    db: &PgPool,
    routine: &Value,
    as_of_ms: i64,
) -> Result<bool, sqlx::Error> {
    let next = compute_routine_next_run(
        routine["cronExpr"].as_str(),
        routine["timezone"].as_str(),
        as_of_ms,
    );
    let claimed = sqlx::query(
        "update weldagent_routines
         set last_run_at = $3::timestamptz, next_run_at = $4::timestamptz, updated_at = $3::timestamptz
         where id = $1 and next_run_at <= $2::timestamptz",
    )
    .bind(routine["id"].as_str())
    .bind(iso_of_ms(as_of_ms))
    .bind(crate::now())
    .bind(iso_of_ms(next))
    .execute(db)
    .await?;
    Ok(claimed.rows_affected() > 0)
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
) -> Result<(), sqlx::Error> {
    sqlx::query("update weldagent_routines set next_run_at = $2::timestamptz, updated_at = $3::timestamptz where id = $1")
        .bind(routine_id)
        .bind(iso_of_ms(due_at_ms))
        .bind(crate::now())
        .execute(db)
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
) -> Result<(), sqlx::Error> {
    let is_cron = routine["scheduleKind"].as_str().unwrap_or("cron") == "cron";
    let next = is_cron.then(|| {
        iso_of_ms(compute_routine_next_run(
            routine["cronExpr"].as_str(),
            routine["timezone"].as_str(),
            now_ms,
        ))
    });
    sqlx::query(
        "update weldagent_routines
         set last_run_at = $2::timestamptz, next_run_at = coalesce($3::timestamptz, next_run_at), updated_at = $2::timestamptz
         where id = $1",
    )
    .bind(routine["id"].as_str())
    .bind(crate::now())
    .bind(next)
    .execute(db)
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
) -> Result<String, sqlx::Error> {
    let id = generate_id("rrn");
    sqlx::query(
        "insert into weldagent_routine_runs (id, routine_id, agent_id, status, trigger, started_at)
         values ($1, $2, $3, 'queued', $4, $5::timestamptz)",
    )
    .bind(&id)
    .bind(routine_id)
    .bind(agent_id)
    .bind(trigger)
    .bind(crate::now())
    .execute(db)
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
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update weldagent_routine_runs
         set status = $2, summary = $3, error = $4, agent_run_id = $5, completed_at = $6::timestamptz
         where id = $1",
    )
    .bind(run_id)
    .bind(status)
    .bind(summary)
    .bind(error)
    .bind(agent_run_id)
    .bind(crate::now())
    .execute(db)
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
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "select exists (select 1 from weldagent_routine_runs where routine_id = $1 and trigger = $2)",
    )
    .bind(routine_id)
    .bind(trigger)
    .fetch_one(db)
    .await
}

/// The earliest `next_run_at` of a workspace's live cron routines (enabled,
/// not deleted, of an active agent): what the due index is set to. A live
/// routine without one (a legacy row) is due now.
///
/// # Errors
///
/// The tenant database fails.
pub async fn earliest_due(db: &PgPool, now_ms: i64) -> Result<Option<OffsetDateTime>, sqlx::Error> {
    let live: Vec<Option<i64>> = sqlx::query_scalar(
        "select (extract(epoch from r.next_run_at) * 1000)::bigint from weldagent_routines r join weldagent_agents a on a.id = r.agent_id
         where r.enabled = true and r.schedule_kind = 'cron' and r.deleted_at is null
           and a.status = 'active' and a.deleted_at is null",
    )
    .fetch_all(db)
    .await?;
    Ok(live
        .into_iter()
        .map(|at| at.unwrap_or(now_ms))
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
    ai: Option<&weldsuite_ai::Ai>,
    env: &crate::run::RunEnv,
    workspace_id: &str,
    actor_user_id: Option<&str>,
    now_ms: i64,
) -> Result<usize, sqlx::Error> {
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
        let outcome = crate::run::run_agent(
            ai,
            crate::run::RunParams {
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
                env: env.clone(),
            },
        )
        .await;
        match outcome {
            Ok(_) => started += 1,
            Err(error) => {
                let message = format!("{error:?}");
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
    ai: Option<&weldsuite_ai::Ai>,
    now: OffsetDateTime,
) -> weldsuite_db::due_index::SweepResult {
    let env = &crate::run::RunEnv {
        master: Some(master.clone()),
        ..crate::run::RunEnv::default()
    };
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
                ai,
                env,
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
pub async fn get_routine(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from weldagent_routines r where r.id = $1 and r.deleted_at is null",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(serialize))
}

/// `listRoutines(db, agentId?)`: newest change first.
///
/// # Errors
///
/// The tenant database fails.
pub async fn list_routines(db: &PgPool, agent_id: Option<&str>) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from weldagent_routines r
         where r.deleted_at is null and ($1::text is null or r.agent_id = $1) order by r.updated_at desc",
    )
    .bind(agent_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(serialize).collect())
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
pub async fn create_routine(db: &PgPool, input: NewRoutine) -> Result<Value, sqlx::Error> {
    let id = generate_id("rtn");
    let kind = input.schedule_kind.unwrap_or_else(|| "cron".to_owned());
    let cron = input
        .cron_expr
        .or_else(|| (kind == "cron").then(|| "0 * * * *".to_owned()));
    let timezone = input.timezone.unwrap_or_else(|| "UTC".to_owned());
    let next = (kind == "cron").then(|| {
        iso_of_ms(compute_routine_next_run(
            cron.as_deref(),
            Some(&timezone),
            now_ms(),
        ))
    });
    sqlx::query(
        "insert into weldagent_routines
             (id, agent_id, name, instructions, skill_id, schedule_kind, cron_expr, timezone, event_key,
              connector_config, enabled, require_approval, next_run_at, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::timestamptz, $14)",
    )
    .bind(&id)
    .bind(&input.agent_id)
    .bind(input.name.trim())
    .bind(input.instructions.trim())
    .bind(&input.skill_id)
    .bind(&kind)
    .bind(&cron)
    .bind(&timezone)
    .bind(&input.event_key)
    .bind(&input.connector_config)
    .bind(input.enabled.unwrap_or(true))
    .bind(input.require_approval.unwrap_or(false))
    .bind(next)
    .bind(&input.created_by)
    .execute(db)
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
) -> Result<Option<Value>, sqlx::Error> {
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
    let next: Option<Option<String>> = if kind == "cron" && schedule_changed {
        let cron = if input.contains_key("cronExpr") {
            text("cronExpr")
        } else {
            existing["cronExpr"].as_str().map(str::to_owned)
        };
        let zone = text("timezone").or_else(|| existing["timezone"].as_str().map(str::to_owned));
        Some(Some(iso_of_ms(compute_routine_next_run(
            cron.as_deref(),
            zone.as_deref(),
            now_ms(),
        ))))
    } else if kind != "cron" && input.contains_key("scheduleKind") {
        Some(None)
    } else {
        None
    };
    let mut query: sqlx::QueryBuilder<sqlx::Postgres> =
        sqlx::QueryBuilder::new("update weldagent_routines set updated_at = ");
    query.push_bind(crate::now()).push("::timestamptz");
    for (key, column) in [
        ("name", "name"),
        ("instructions", "instructions"),
        ("skillId", "skill_id"),
        ("scheduleKind", "schedule_kind"),
        ("cronExpr", "cron_expr"),
        ("timezone", "timezone"),
        ("eventKey", "event_key"),
    ] {
        if let Some(value) = input.get(key) {
            let value = value.as_str().map(|v| {
                if key == "name" || key == "instructions" {
                    v.trim().to_owned()
                } else {
                    v.to_owned()
                }
            });
            query.push(format!(", {column} = ")).push_bind(value);
        }
    }
    if let Some(config) = input.get("connectorConfig") {
        query
            .push(", connector_config = ")
            .push_bind((!config.is_null()).then(|| config.clone()))
            .push("::jsonb");
    }
    for (key, column) in [
        ("enabled", "enabled"),
        ("requireApproval", "require_approval"),
    ] {
        if let Some(flag) = input.get(key).and_then(Value::as_bool) {
            query.push(format!(", {column} = ")).push_bind(flag);
        }
    }
    if let Some(next) = next {
        query
            .push(", next_run_at = ")
            .push_bind(next)
            .push("::timestamptz");
    }
    query.push(" where id = ").push_bind(id.to_owned());
    query.build().execute(db).await?;
    get_routine(db, id).await
}

/// `deleteRoutine(db, id)`: soft delete, and off.
///
/// # Errors
///
/// The tenant database fails.
pub async fn delete_routine(db: &PgPool, id: &str) -> Result<bool, sqlx::Error> {
    if get_routine(db, id).await?.is_none() {
        return Ok(false);
    }
    sqlx::query(
        "update weldagent_routines set deleted_at = $2::timestamptz, updated_at = $2::timestamptz, enabled = false where id = $1",
    )
    .bind(id)
    .bind(crate::now())
    .execute(db)
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
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from weldagent_routine_runs r where r.routine_id = $1 order by r.created_at desc limit $2",
    )
    .bind(routine_id)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
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
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from weldagent_routines r
         where r.enabled = true and r.schedule_kind = 'connector' and r.deleted_at is null",
    )
    .fetch_all(db)
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
    fn a_cron_routine_runs_at_its_hour() {
        // 2023-11-14T22:13:20Z; the next "0 7 * * *" in UTC is the 15th at 07:00.
        let next = compute_routine_next_run(Some("0 7 * * *"), Some("UTC"), 1_700_000_000_000);
        assert_eq!(next, 1_700_031_600_000);
    }
}
