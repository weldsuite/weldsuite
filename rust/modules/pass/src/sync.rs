//! Sync targets and pushes (`services/weldpass/sync.ts`). A push decrypts an
//! environment, hands the values to the provider and records the run; the
//! run keeps key names and outcomes only.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Unchanged, ColumnTrait, EntityTrait, FromQueryResult, QueryFilter, QueryOrder,
    QuerySelect, Select, Set,
};
use serde::Serialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{weldpass_sync_runs as runs, weldpass_sync_targets as targets};

use crate::credentials::read_credential_token;
use crate::envelope::Key;
use crate::providers;
use crate::secrets::read_environment_values;
use crate::transport::HttpTransport;
use crate::{PassError, PassResult, int4, now, row_json};

use runs::Column as R;
use targets::Column as T;

/// `SyncTargetSummary`'s columns.
#[derive(Debug, Clone, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetRow {
    id: String,
    project_id: String,
    environment_id: String,
    credential_id: String,
    provider: String,
    name: String,
    config: Value,
    auto_sync: bool,
    prune: bool,
    status: String,
    #[serde(with = "weldsuite_schema::js::timestamptz::option")]
    last_synced_at: Option<OffsetDateTime>,
    last_synced_count: i32,
    last_error: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    created_at: OffsetDateTime,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    updated_at: OffsetDateTime,
}

impl TargetRow {
    fn select() -> Select<targets::Entity> {
        targets::Entity::find().select_only().columns([
            T::Id,
            T::ProjectId,
            T::EnvironmentId,
            T::CredentialId,
            T::Provider,
            T::Name,
            T::Config,
            T::AutoSync,
            T::Prune,
            T::Status,
            T::LastSyncedAt,
            T::LastSyncedCount,
            T::LastError,
            T::CreatedAt,
            T::UpdatedAt,
        ])
    }
}

impl From<targets::Model> for TargetRow {
    fn from(row: targets::Model) -> Self {
        Self {
            id: row.id,
            project_id: row.project_id,
            environment_id: row.environment_id,
            credential_id: row.credential_id,
            provider: row.provider,
            name: row.name,
            config: row.config,
            auto_sync: row.auto_sync,
            prune: row.prune,
            status: row.status,
            last_synced_at: row.last_synced_at,
            last_synced_count: row.last_synced_count,
            last_error: row.last_error,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// A run as the routes list it: everything but its project.
#[derive(Debug, Clone, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunRow {
    id: String,
    target_id: String,
    environment_id: String,
    status: String,
    trigger: String,
    pushed: i32,
    removed: i32,
    failed: i32,
    error: Option<String>,
    details: Value,
    triggered_by: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    started_at: OffsetDateTime,
    #[serde(with = "weldsuite_schema::js::timestamptz::option")]
    finished_at: Option<OffsetDateTime>,
}

impl From<runs::Model> for RunRow {
    fn from(row: runs::Model) -> Self {
        Self {
            id: row.id,
            target_id: row.target_id,
            environment_id: row.environment_id,
            status: row.status,
            trigger: row.trigger,
            pushed: row.pushed,
            removed: row.removed,
            failed: row.failed,
            error: row.error,
            details: row.details,
            triggered_by: row.triggered_by,
            started_at: row.started_at,
            finished_at: row.finished_at,
        }
    }
}

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
    fn from_row(row: TargetRow) -> Self {
        Self {
            json: row_json(&row),
            id: row.id,
            environment_id: row.environment_id,
            credential_id: row.credential_id,
            provider: row.provider,
            name: row.name,
            prune: row.prune,
            auto_sync: row.auto_sync,
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
    let mut select = TargetRow::select().filter(T::ProjectId.eq(project_id));
    if let Some(environment_id) = environment_id {
        select = select.filter(T::EnvironmentId.eq(environment_id));
    }
    let rows = select
        .filter(T::DeletedAt.is_null())
        .order_by_asc(T::Name)
        .into_model::<TargetRow>()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().map(Target::from_row).collect())
}

/// `requireSyncTarget`.
pub(crate) async fn require_target(
    db: &PgPool,
    project_id: &str,
    target_id: &str,
) -> PassResult<Target> {
    let row = TargetRow::select()
        .filter(T::Id.eq(target_id))
        .filter(T::ProjectId.eq(project_id))
        .filter(T::DeletedAt.is_null())
        .into_model::<TargetRow>()
        .one(&orm(db))
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
    let row = targets::Entity::insert(targets::ActiveModel {
        id: Set(generate_id("wpt")),
        project_id: Set(input.project_id.to_owned()),
        environment_id: Set(input.environment_id.to_owned()),
        credential_id: Set(input.credential_id.to_owned()),
        provider: Set(input.provider.to_owned()),
        name: Set(input.name.to_owned()),
        config: Set(input.config.clone()),
        auto_sync: Set(input.auto_sync.unwrap_or(false)),
        prune: Set(input.prune.unwrap_or(false)),
        created_by: Set(Some(input.actor_id.to_owned())),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    Ok(Target::from_row(row.into()))
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
    let mut update = targets::ActiveModel {
        id: Unchanged(target_id.to_owned()),
        ..Default::default()
    };
    if let Some(name) = patch.name {
        update.name = Set(name.to_owned());
    }
    if let Some(credential_id) = patch.credential_id {
        update.credential_id = Set(credential_id.to_owned());
    }
    if let Some(config) = patch.config {
        update.config = Set(config.clone());
    }
    if let Some(auto_sync) = patch.auto_sync {
        update.auto_sync = Set(auto_sync);
    }
    if let Some(prune) = patch.prune {
        update.prune = Set(prune);
    }
    update.updated_at = Set(now());
    let row = targets::Entity::update(update).exec(&orm(db)).await?;
    Ok(Target::from_row(row.into()))
}

/// `deleteSyncTarget`: soft.
pub(crate) async fn delete_target(
    db: &PgPool,
    project_id: &str,
    target_id: &str,
) -> PassResult<()> {
    require_target(db, project_id, target_id).await?;
    let now = now();
    targets::Entity::update_many()
        .col_expr(T::DeletedAt, Expr::value(now))
        .col_expr(T::UpdatedAt, Expr::value(now))
        .filter(T::Id.eq(target_id))
        .exec(&orm(db))
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
    let conn = orm(db);
    runs::Entity::insert(runs::ActiveModel {
        id: Set(run_id.clone()),
        target_id: Set(target.id.clone()),
        project_id: Set(project_id.to_owned()),
        environment_id: Set(target.environment_id.clone()),
        status: Set("running".to_owned()),
        trigger: Set(trigger.to_owned()),
        triggered_by: Set(Some(actor_id.to_owned())),
        started_at: Set(now()),
        ..Default::default()
    })
    .exec_without_returning(&conn)
    .await?;
    targets::Entity::update_many()
        .col_expr(T::Status, Expr::value("running"))
        .col_expr(T::UpdatedAt, Expr::value(now()))
        .filter(T::Id.eq(target.id.as_str()))
        .exec(&conn)
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
    let ids: Vec<String> = targets::Entity::find()
        .select_only()
        .column(T::Id)
        .filter(T::ProjectId.eq(project_id))
        .filter(T::EnvironmentId.eq(environment_id))
        .filter(T::AutoSync.eq(true))
        .filter(T::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
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
    let mut select = runs::Entity::find()
        .select_only()
        .columns([
            R::Id,
            R::TargetId,
            R::EnvironmentId,
            R::Status,
            R::Trigger,
            R::Pushed,
            R::Removed,
            R::Failed,
            R::Error,
            R::Details,
            R::TriggeredBy,
            R::StartedAt,
            R::FinishedAt,
        ])
        .filter(R::ProjectId.eq(project_id));
    if let Some(target_id) = target_id {
        select = select.filter(R::TargetId.eq(target_id));
    }
    let rows = select
        .order_by_desc(R::StartedAt)
        .limit(u64::try_from(limit).unwrap_or_default())
        .into_model::<RunRow>()
        .all(&orm(db))
        .await?;
    Ok(rows.iter().map(row_json).collect())
}

async fn finish_run(
    db: &PgPool,
    run_id: &str,
    status: &str,
    (pushed, removed, failed): (i64, i64, i64),
    error: Option<&str>,
    details: &Value,
) -> PassResult<Value> {
    let row = runs::Entity::update(runs::ActiveModel {
        id: Unchanged(run_id.to_owned()),
        status: Set(status.to_owned()),
        pushed: Set(int4(pushed)?),
        removed: Set(int4(removed)?),
        failed: Set(int4(failed)?),
        error: Set(error.map(str::to_owned)),
        details: Set(details.clone()),
        finished_at: Set(Some(now())),
        ..Default::default()
    })
    .exec(&orm(db))
    .await?;
    Ok(row_json(&RunRow::from(row)))
}

/// `markTarget`: the status, and on success when and how many.
async fn mark_target(
    db: &PgPool,
    target_id: &str,
    status: &str,
    synced: Option<(OffsetDateTime, i64)>,
    last_error: Option<&str>,
) -> PassResult<Target> {
    let mut update = targets::ActiveModel {
        id: Unchanged(target_id.to_owned()),
        status: Set(status.to_owned()),
        ..Default::default()
    };
    if let Some((at, count)) = synced {
        update.last_synced_at = Set(Some(at));
        update.last_synced_count = Set(int4(count)?);
    }
    update.last_error = Set(last_error.map(str::to_owned));
    update.updated_at = Set(now());
    let row = targets::Entity::update(update).exec(&orm(db)).await?;
    Ok(Target::from_row(row.into()))
}
