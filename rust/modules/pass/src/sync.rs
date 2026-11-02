//! Sync targets and pushes (`services/weldpass/sync.ts`). A push decrypts an
//! environment, hands the values to the provider and records the run; the
//! run keeps key names and outcomes only.

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_kit::generate_id;

use crate::credentials::read_credential_token;
use crate::envelope::Key;
use crate::providers;
use crate::secrets::read_environment_values;
use crate::transport::HttpTransport;
use crate::{PassError, PassResult, dated, now};

macro_rules! target_json {
    () => {
        "jsonb_build_object('id', t.id, 'projectId', t.project_id, 'environmentId', t.environment_id, \
         'credentialId', t.credential_id, 'provider', t.provider, 'name', t.name, 'config', t.config, \
         'autoSync', t.auto_sync, 'prune', t.prune, 'status', t.status, \
         'lastSyncedAt', t.last_synced_at, 'lastSyncedCount', t.last_synced_count, \
         'lastError', t.last_error, 'createdAt', t.created_at, 'updatedAt', t.updated_at)"
    };
}

macro_rules! run_json {
    () => {
        "jsonb_build_object('id', r.id, 'targetId', r.target_id, 'environmentId', r.environment_id, \
         'status', r.status, 'trigger', r.trigger, 'pushed', r.pushed, 'removed', r.removed, \
         'failed', r.failed, 'error', r.error, 'details', r.details, 'triggeredBy', r.triggered_by, \
         'startedAt', r.started_at, 'finishedAt', r.finished_at)"
    };
}

const TARGET_TIMES: [&str; 3] = ["lastSyncedAt", "createdAt", "updatedAt"];
const RUN_TIMES: [&str; 2] = ["startedAt", "finishedAt"];

/// `SyncTargetSummary`.
#[derive(Debug, Clone)]
pub(crate) struct Target {
    pub(crate) id: String,
    pub(crate) environment_id: String,
    pub(crate) credential_id: String,
    pub(crate) provider: String,
    pub(crate) name: String,
    pub(crate) prune: bool,
    pub(crate) auto_sync: bool,
    pub(crate) json: Value,
}

impl Target {
    fn from_row(row: Value) -> Self {
        let row = dated(row, &TARGET_TIMES);
        let text = |key: &str| row[key].as_str().unwrap_or_default().to_owned();
        Self {
            id: text("id"),
            environment_id: text("environmentId"),
            credential_id: text("credentialId"),
            provider: text("provider"),
            name: text("name"),
            prune: row["prune"].as_bool().unwrap_or(false),
            auto_sync: row["autoSync"].as_bool().unwrap_or(false),
            json: row,
        }
    }

    pub(crate) fn config(&self) -> &Value {
        &self.json["config"]
    }

    /// `{ ...target, redeployNotice: redeployNotice(target.config) }`.
    pub(crate) fn with_notice(&self) -> Value {
        let mut json = self.json.clone();
        json["redeployNotice"] = providers::redeploy_notice(self.config());
        json
    }
}

/// `listSyncTargets`: by name, optionally one environment's.
pub(crate) async fn list_targets(
    db: &PgPool,
    project_id: &str,
    environment_id: Option<&str>,
) -> PassResult<Vec<Target>> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        target_json!(),
        " from weldpass_sync_targets t where t.project_id = $1 \
         and ($2::text is null or t.environment_id = $2) and t.deleted_at is null order by t.name asc"
    ))
    .bind(project_id)
    .bind(environment_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Target::from_row).collect())
}

/// `requireSyncTarget`.
pub(crate) async fn require_target(
    db: &PgPool,
    project_id: &str,
    target_id: &str,
) -> PassResult<Target> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        target_json!(),
        " from weldpass_sync_targets t where t.id = $1 and t.project_id = $2 and t.deleted_at is null limit 1"
    ))
    .bind(target_id)
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    row.map(Target::from_row)
        .ok_or_else(|| PassError::not_found("sync target", target_id))
}

/// What a new target is made of.
pub(crate) struct NewTarget<'a> {
    pub(crate) project_id: &'a str,
    pub(crate) environment_id: &'a str,
    pub(crate) credential_id: &'a str,
    pub(crate) provider: &'a str,
    pub(crate) name: &'a str,
    pub(crate) config: &'a Value,
    pub(crate) auto_sync: Option<bool>,
    pub(crate) prune: Option<bool>,
    pub(crate) actor_id: &'a str,
}

/// `createSyncTarget`.
pub(crate) async fn create_target(db: &PgPool, input: NewTarget<'_>) -> PassResult<Target> {
    let row: Value = sqlx::query_scalar(concat!(
        "with t as (insert into weldpass_sync_targets \
         (id, project_id, environment_id, credential_id, provider, name, config, auto_sync, prune, created_by) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *) select ",
        target_json!(),
        " from t"
    ))
    .bind(generate_id("wpt"))
    .bind(input.project_id)
    .bind(input.environment_id)
    .bind(input.credential_id)
    .bind(input.provider)
    .bind(input.name)
    .bind(input.config)
    .bind(input.auto_sync.unwrap_or(false))
    .bind(input.prune.unwrap_or(false))
    .bind(input.actor_id)
    .fetch_one(db)
    .await?;
    Ok(Target::from_row(row))
}

/// The fields a target update may set.
#[derive(Default)]
pub(crate) struct TargetPatch<'a> {
    pub(crate) name: Option<&'a str>,
    pub(crate) credential_id: Option<&'a str>,
    pub(crate) config: Option<&'a Value>,
    pub(crate) auto_sync: Option<bool>,
    pub(crate) prune: Option<bool>,
}

/// `updateSyncTarget`.
pub(crate) async fn update_target(
    db: &PgPool,
    project_id: &str,
    target_id: &str,
    patch: TargetPatch<'_>,
) -> PassResult<Target> {
    require_target(db, project_id, target_id).await?;
    let row: Value = sqlx::query_scalar(concat!(
        "with t as (update weldpass_sync_targets set name = coalesce($2, name), \
         credential_id = coalesce($3, credential_id), config = coalesce($4, config), \
         auto_sync = coalesce($5, auto_sync), prune = coalesce($6, prune), \
         updated_at = $7::timestamptz where id = $1 returning *) select ",
        target_json!(),
        " from t"
    ))
    .bind(target_id)
    .bind(patch.name)
    .bind(patch.credential_id)
    .bind(patch.config)
    .bind(patch.auto_sync)
    .bind(patch.prune)
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(Target::from_row(row))
}

/// `deleteSyncTarget`: soft.
pub(crate) async fn delete_target(
    db: &PgPool,
    project_id: &str,
    target_id: &str,
) -> PassResult<()> {
    require_target(db, project_id, target_id).await?;
    let now = now();
    sqlx::query(
        "update weldpass_sync_targets set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
         where id = $1",
    )
    .bind(target_id)
    .bind(&now)
    .execute(db)
    .await?;
    Ok(())
}

/// `PushOutcome`: the run and the target after it.
pub(crate) struct PushOutcome {
    pub(crate) run: Value,
    pub(crate) target: Target,
}

impl PushOutcome {
    /// `runAutoSync`'s line for this push.
    pub(crate) fn summary(&self) -> Value {
        json!({
            "targetId": self.target.id,
            "name": self.target.name,
            "status": self.run["status"],
            "pushed": self.run["pushed"],
            "error": self.run["error"],
        })
    }
}

/// `pushToTarget`: the run row first, so a push that dies still leaves a
/// `running` record; a provider failure is a failed run, not an error.
pub(crate) async fn push_to_target(
    db: &PgPool,
    kek: &Key,
    http: &dyn HttpTransport,
    project_id: &str,
    target_id: &str,
    trigger: &str,
    actor_id: &str,
) -> PassResult<PushOutcome> {
    let target = require_target(db, project_id, target_id).await?;
    let run_id = generate_id("wpr");
    sqlx::query(
        "insert into weldpass_sync_runs \
         (id, target_id, project_id, environment_id, status, trigger, triggered_by, started_at) \
         values ($1, $2, $3, $4, 'running', $5, $6, $7::timestamptz)",
    )
    .bind(&run_id)
    .bind(&target.id)
    .bind(project_id)
    .bind(&target.environment_id)
    .bind(trigger)
    .bind(actor_id)
    .bind(now())
    .execute(db)
    .await?;
    sqlx::query(
        "update weldpass_sync_targets set status = 'running', updated_at = $2::timestamptz where id = $1",
    )
    .bind(&target.id)
    .bind(now())
    .execute(db)
    .await?;

    let attempt = async {
        let token = read_credential_token(db, kek, project_id, &target.credential_id).await?;
        let secrets = read_environment_values(db, kek, &target.environment_id).await?;
        providers::push(
            http,
            &target.provider,
            &token,
            target.config(),
            &secrets,
            target.prune,
        )
        .await
        .map_err(|error| PassError::Provider(error.0))
    }
    .await;

    match attempt {
        Ok(result) => {
            let status = if result.failed > 0 {
                "partial"
            } else {
                "success"
            };
            let error = (result.failed > 0).then(|| {
                format!(
                    "{} of {} values were rejected",
                    result.failed,
                    result.pushed + result.failed
                )
            });
            let details: Vec<Value> = result
                .details
                .iter()
                .map(providers::PushDetail::to_json)
                .collect();
            let run = finish_run(
                db,
                &run_id,
                status,
                (result.pushed, result.removed, result.failed),
                error.as_deref(),
                &Value::Array(details),
            )
            .await?;
            let target = mark_target(
                db,
                &target.id,
                status,
                Some((now(), result.pushed)),
                run["error"].as_str(),
            )
            .await?;
            Ok(PushOutcome { run, target })
        }
        Err(error) => {
            let message = failure_message(error);
            let run =
                finish_run(db, &run_id, "failed", (0, 0, 0), Some(&message), &json!([])).await?;
            let target = mark_target(db, &target.id, "failed", None, Some(&message)).await?;
            Ok(PushOutcome { run, target })
        }
    }
}

/// `err.message` of what a push threw.
fn failure_message(error: PassError) -> String {
    match error {
        PassError::NotFound { resource, id } => format!("{resource} {id} not found"),
        PassError::Provider(message)
        | PassError::BadRequest(message)
        | PassError::Forbidden(message)
        | PassError::Conflict(message)
        | PassError::Internal(message) => message,
        PassError::Envelope(error) => error.0,
        PassError::Response(_) => "An unexpected error occurred".to_owned(),
    }
}

/// `pushAutoTargets`: every auto-sync target of an environment, one run each.
pub(crate) async fn push_auto_targets(
    db: &PgPool,
    kek: &Key,
    http: &dyn HttpTransport,
    project_id: &str,
    environment_id: &str,
    actor_id: &str,
) -> PassResult<Vec<PushOutcome>> {
    let ids: Vec<String> = sqlx::query_scalar(
        "select id from weldpass_sync_targets where project_id = $1 and environment_id = $2 \
         and auto_sync = true and deleted_at is null",
    )
    .bind(project_id)
    .bind(environment_id)
    .fetch_all(db)
    .await?;
    let mut outcomes = Vec::with_capacity(ids.len());
    for id in ids {
        outcomes.push(push_to_target(db, kek, http, project_id, &id, "auto", actor_id).await?);
    }
    Ok(outcomes)
}

/// `listSyncRuns`: newest first.
pub(crate) async fn list_runs(
    db: &PgPool,
    project_id: &str,
    target_id: Option<&str>,
    limit: i64,
) -> PassResult<Vec<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        run_json!(),
        " from weldpass_sync_runs r where r.project_id = $1 and ($2::text is null or r.target_id = $2) \
         order by r.started_at desc limit $3"
    ))
    .bind(project_id)
    .bind(target_id)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|row| dated(row, &RUN_TIMES)).collect())
}

async fn finish_run(
    db: &PgPool,
    run_id: &str,
    status: &str,
    (pushed, removed, failed): (i64, i64, i64),
    error: Option<&str>,
    details: &Value,
) -> PassResult<Value> {
    let row: Value = sqlx::query_scalar(concat!(
        "with r as (update weldpass_sync_runs set status = $2, pushed = $3::integer, removed = $4::integer, \
         failed = $5::integer, error = $6, details = $7, finished_at = $8::timestamptz \
         where id = $1 returning *) select ",
        run_json!(),
        " from r"
    ))
    .bind(run_id)
    .bind(status)
    .bind(pushed)
    .bind(removed)
    .bind(failed)
    .bind(error)
    .bind(details)
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(dated(row, &RUN_TIMES))
}

/// `markTarget`: the status, and on success when and how many.
async fn mark_target(
    db: &PgPool,
    target_id: &str,
    status: &str,
    synced: Option<(String, i64)>,
    last_error: Option<&str>,
) -> PassResult<Target> {
    let (synced_at, count) = synced.map_or((None, None), |(at, count)| (Some(at), Some(count)));
    let row: Value = sqlx::query_scalar(concat!(
        "with t as (update weldpass_sync_targets set status = $2, \
         last_synced_at = case when $3::text is null then last_synced_at else $3::timestamptz end, \
         last_synced_count = coalesce($4::integer, last_synced_count), last_error = $5, \
         updated_at = $6::timestamptz where id = $1 returning *) select ",
        target_json!(),
        " from t"
    ))
    .bind(target_id)
    .bind(status)
    .bind(synced_at)
    .bind(count)
    .bind(last_error)
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(Target::from_row(row))
}
