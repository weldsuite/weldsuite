//! What a workflow save keeps in step with its embedded triggers:
//!
//! - `workflow_trigger_index` (`services/workflow-trigger-index.ts`), in the
//!   same transaction as the workflow write;
//! - `workflow_schedules` (`services/workflow-schedule-sync.ts`) and the
//!   schedule sweep's timing: Global keeps it in the schedule-index D1
//!   database, here a schedule's own `next_run_at` (null: compute it again)
//!   and the master `workspace_due_index` row of kind [`SCHEDULE_DUE_KIND`],
//!   which the `workflow-schedules` cron reads;
//! - `workflow_webhooks` and the master `workflow_webhook_registry`
//!   (`services/workflow-webhook-sync.ts`, `workflow-webhook-registry.ts`).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use sqlx::PgConnection;
use time::PrimitiveDateTime;
use weldsuite_db::{OrmConn, PgPool, orm, utc_now, utc_timestamp};
use weldsuite_kit::id::ALPHANUMERIC;
use weldsuite_kit::{generate_id, random_string};
use weldsuite_ports::DynCache;
use weldsuite_schema::master::workflow_webhook_registry as registry;
use weldsuite_schema::tenant::{workflow_schedules, workflow_trigger_index, workflow_webhooks};

use crate::js::{bag, coalesce};
use crate::mvp::{
    one_time_triggers, recurring_triggers, schedule_trigger_ids, webhook_trigger_ids,
    webhook_triggers,
};
use crate::{Caller, ConnectState};

/// The due-index kind of the integration polls (the integration workers'
/// `weldsuite_integrations::workflow_polls::WORKFLOW_POLL_DUE_KIND`).
pub(crate) const WORKFLOW_POLL_DUE_KIND: &str = "workflow_poll";

/// `WORKFLOW_POLL_TRIGGER_EVENTS`.
const POLL_TRIGGER_EVENTS: [(&str, &str); 4] = [
    ("google_sheets", "google_sheets.new_row"),
    ("gmail", "gmail.new_email"),
    ("google_calendar", "google_calendar.new_event"),
    ("airtable", "airtable.new_record"),
];

/// `triggersIncludeWorkflowPoll(triggers)`.
fn includes_workflow_poll(triggers: &[Value]) -> bool {
    triggers.iter().any(|t| {
        if !t.is_object() || t.get("isEnabled") == Some(&Value::Bool(false)) {
            return false;
        }
        let config = t.get("config").filter(|c| c.is_object());
        let pick = |key: &str| {
            t.get(key)
                .filter(|v| !v.is_null())
                .or_else(|| config.and_then(|c| c.get(key)).filter(|v| !v.is_null()))
                .and_then(Value::as_str)
        };
        pick("type") == Some("integration_event")
            && POLL_TRIGGER_EVENTS
                .iter()
                .any(|(p, e)| pick("provider") == Some(*p) && pick("event") == Some(*e))
    })
}

/// The due-index kind of WeldConnect's schedules.
pub(crate) const SCHEDULE_DUE_KIND: &str = "workflow_schedule";

/// Where a save's syncs write, besides the tenant database.
#[derive(Clone)]
pub(crate) struct SyncContext {
    pub(crate) master: Option<PgPool>,
    pub(crate) cache: Option<Arc<dyn DynCache>>,
    /// `workspaces.id`: the due index's key.
    pub(crate) workspace_id: String,
    /// The Clerk org id: the webhook registry's owner.
    pub(crate) clerk_org_id: String,
    /// `publicApiBase(env)`.
    pub(crate) public_api_base: String,
}

impl SyncContext {
    pub(crate) fn for_caller(caller: &Caller, state: &ConnectState) -> Self {
        Self {
            master: caller.overrides.master(state),
            cache: caller.overrides.kv(state),
            workspace_id: caller.workspace_id.clone(),
            clerk_org_id: caller.clerk_org_id.clone(),
            public_api_base: caller.overrides.public_api_base(state),
        }
    }

    /// `syncWorkflowPollIndex`: an active workflow with a Google Sheets,
    /// Gmail, Google Calendar or Airtable poll trigger makes the integration
    /// polls (`weldsuite cron workflow-polls`) look at this workspace on the
    /// next tick; they drop it again once it has none. Best effort.
    pub(crate) async fn poll_due(&self, triggers: Option<&Value>, active: bool) {
        let polls = triggers
            .and_then(Value::as_array)
            .is_some_and(|triggers| includes_workflow_poll(triggers));
        if let (true, true, Some(master)) = (active, polls, &self.master) {
            weldsuite_db::due_index::mark_due(
                master,
                WORKFLOW_POLL_DUE_KIND,
                &self.workspace_id,
                time::OffsetDateTime::now_utc(),
            )
            .await;
        }
    }

    /// `syncUpsertScheduleIndex`: look at this workspace's schedules on the
    /// next tick. Best effort.
    pub(crate) async fn schedule_due(&self) {
        if let Some(master) = &self.master {
            weldsuite_db::due_index::mark_due(
                master,
                SCHEDULE_DUE_KIND,
                &self.workspace_id,
                time::OffsetDateTime::now_utc(),
            )
            .await;
        }
    }
}

// ── Trigger index ───────────────────────────────────────────────────────────

/// `r->>'key'` of an index row built as JSON: a string as it is, null as
/// NULL, anything else as its JSON text.
fn json_text(value: Option<Value>) -> Option<String> {
    match value? {
        Value::Null => None,
        Value::String(text) => Some(text),
        other => Some(other.to_string()),
    }
}

/// `buildIndexRows` + `buildIndexStatements`, run on `conn` (inside the
/// workflow write's transaction): the workflow's rows replaced by one per
/// enabled trigger when the workflow is active.
pub(crate) async fn write_trigger_index(
    conn: &mut PgConnection,
    workflow_id: &str,
    triggers: Option<&Value>,
    active: bool,
) -> Result<(), DbErr> {
    use workflow_trigger_index::{ActiveModel, Column, Entity};
    let db = OrmConn::new(conn);
    Entity::delete_many()
        .filter(Column::WorkflowId.eq(workflow_id))
        .exec(&db)
        .await?;
    if !active {
        return Ok(());
    }
    let stamp = utc_now();
    let mut rows = Vec::new();
    for raw in crate::js::array(triggers) {
        let t = bag(Some(raw));
        let (Some(id), Some(kind)) = (
            t.get("id").filter(|v| truthy(v)),
            t.get("type").filter(|v| truthy(v)),
        ) else {
            continue;
        };
        if matches!(t.get("isEnabled"), Some(Value::Bool(false))) {
            continue;
        }
        let cfg = bag(t.get("config"));
        let pick = |key: &str| json_text(coalesce(&[t.get(key), cfg.get(key)]).cloned());
        let category = coalesce(&[Some(kind), cfg.get("type")])
            .cloned()
            .unwrap_or(json!("manual"));
        rows.push(ActiveModel {
            id: Set(generate_id("wti")),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            workflow_id: Set(workflow_id.to_owned()),
            trigger_id: Set(json_text(Some(id.clone())).unwrap_or_default()),
            category: Set(json_text(Some(category)).unwrap_or_default()),
            is_enabled: Set(true),
            entity_type: Set(pick("entityType")),
            event_type: Set(pick("eventType")),
            provider: Set(pick("provider")),
            integration_event: Set(json_text(
                coalesce(&[t.get("event"), cfg.get("event")]).cloned(),
            )),
            integration_id: Set(pick("integrationId")),
            source_workflow_id: Set(json_text(cfg.get("sourceWorkflowId").cloned())),
            filters: Set(coalesce(&[t.get("filters"), cfg.get("filters")]).cloned()),
        });
    }
    if rows.is_empty() {
        return Ok(());
    }
    Entity::insert_many(rows).exec_without_returning(&db).await?;
    Ok(())
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

// ── Schedules ───────────────────────────────────────────────────────────────

/// `syncWorkflowSchedules(db, sync, { workflowId, previousTriggers,
/// nextTriggers, workflowActive })`.
pub(crate) async fn sync_schedules(
    db: &PgPool,
    ctx: &SyncContext,
    workflow_id: &str,
    previous: Option<&Value>,
    next: Option<&Value>,
    active: bool,
) -> Result<(), DbErr> {
    ctx.poll_due(next, active).await;
    let recurring = recurring_triggers(next);
    let once = one_time_triggers(next);
    let mut managed: Vec<String> = schedule_trigger_ids(previous);
    for id in schedule_trigger_ids(next) {
        if !managed.contains(&id) {
            managed.push(id);
        }
    }
    if managed.is_empty() {
        return Ok(());
    }
    use workflow_schedules::{ActiveModel, Column, Entity, Model};
    let db = orm(db);
    let existing: Vec<Model> = Entity::find()
        .filter(Column::WorkflowId.eq(workflow_id))
        .filter(Column::TriggerId.is_in(&managed))
        .filter(Column::DeletedAt.is_null())
        .all(&db)
        .await?;
    // `new Map(rows.map(...))`: one entry per trigger id, in first-seen
    // order, holding the last row.
    let mut by_trigger: Vec<(String, Model)> = Vec::new();
    for row in existing {
        let trigger_id = row.trigger_id.clone().unwrap_or_default();
        match by_trigger.iter_mut().find(|(id, _)| *id == trigger_id) {
            Some(entry) => entry.1 = row,
            None => by_trigger.push((trigger_id, row)),
        }
    }
    let mut take = |trigger_id: &str| -> Option<Model> {
        let index = by_trigger.iter().position(|(id, _)| id == trigger_id)?;
        Some(by_trigger.remove(index).1)
    };
    let stamp = utc_now();
    let mut indexed = false;
    // `next_run_at = case when timing_changed then null else next_run_at end`.
    let cleared = Option::<PrimitiveDateTime>::None;

    for trigger in &recurring {
        let enabled = active && trigger.is_enabled;
        let Some(row) = take(&trigger.trigger_id) else {
            if !enabled {
                continue;
            }
            Entity::insert(ActiveModel {
                id: Set(generate_id("sched")),
                workflow_id: Set(workflow_id.to_owned()),
                trigger_id: Set(Some(trigger.trigger_id.clone())),
                name: Set(trigger.name.clone()),
                schedule_type: Set("recurring".to_owned()),
                cron_expression: Set(Some(trigger.cron_expression.clone())),
                timezone: Set(trigger.timezone.clone()),
                is_enabled: Set(enabled),
                created_at: Set(stamp),
                updated_at: Set(stamp),
                ..Default::default()
            })
            .exec_without_returning(&db)
            .await?;
            indexed = true;
            continue;
        };
        let timing_changed = row.cron_expression.as_deref()
            != Some(trigger.cron_expression.as_str())
            || row.timezone != trigger.timezone
            || row.is_enabled != enabled;
        let name_same = row.name.as_deref() == trigger.name.as_deref();
        if !timing_changed && name_same {
            continue;
        }
        let mut update = Entity::update_many()
            .col_expr(Column::Name, Expr::value(trigger.name.clone()))
            .col_expr(Column::ScheduleType, Expr::value("recurring"))
            .col_expr(
                Column::CronExpression,
                Expr::value(trigger.cron_expression.clone()),
            )
            .col_expr(Column::ExecuteAt, Expr::value(cleared))
            .col_expr(Column::Timezone, Expr::value(trigger.timezone.clone()))
            .col_expr(Column::IsEnabled, Expr::value(enabled))
            .col_expr(Column::UpdatedAt, Expr::value(stamp));
        if timing_changed {
            update = update.col_expr(Column::NextRunAt, Expr::value(cleared));
        }
        update.filter(Column::Id.eq(&row.id)).exec(&db).await?;
        indexed |= timing_changed;
    }

    for trigger in &once {
        let row = take(&trigger.trigger_id);
        let fired = row.as_ref().is_some_and(|r| r.last_run_at.is_some());
        let enabled = !fired && active && trigger.is_enabled;
        let execute_at = || execute_at(trigger.execute_at);
        let Some(row) = row else {
            if !enabled {
                continue;
            }
            Entity::insert(ActiveModel {
                id: Set(generate_id("sched")),
                workflow_id: Set(workflow_id.to_owned()),
                trigger_id: Set(Some(trigger.trigger_id.clone())),
                name: Set(trigger.name.clone()),
                schedule_type: Set("one_time".to_owned()),
                cron_expression: Set(None),
                execute_at: Set(Some(execute_at()?)),
                timezone: Set(trigger.timezone.clone()),
                is_enabled: Set(enabled),
                created_at: Set(stamp),
                updated_at: Set(stamp),
                ..Default::default()
            })
            .exec_without_returning(&db)
            .await?;
            indexed = true;
            continue;
        };
        if fired {
            if row.name.as_deref() != trigger.name.as_deref() {
                Entity::update_many()
                    .col_expr(Column::Name, Expr::value(trigger.name.clone()))
                    .col_expr(Column::UpdatedAt, Expr::value(stamp))
                    .filter(Column::Id.eq(&row.id))
                    .exec(&db)
                    .await?;
            }
            continue;
        }
        let stored_at = row.execute_at.and_then(epoch_ms);
        let timing_changed = stored_at != Some(trigger.execute_at)
            || row.timezone != trigger.timezone
            || row.is_enabled != enabled;
        if !timing_changed && row.name.as_deref() == trigger.name.as_deref() {
            continue;
        }
        let mut update = Entity::update_many()
            .col_expr(Column::Name, Expr::value(trigger.name.clone()))
            .col_expr(Column::ScheduleType, Expr::value("one_time"))
            .col_expr(Column::CronExpression, Expr::value(Option::<String>::None))
            .col_expr(Column::ExecuteAt, Expr::value(execute_at()?))
            .col_expr(Column::Timezone, Expr::value(trigger.timezone.clone()))
            .col_expr(Column::IsEnabled, Expr::value(enabled))
            .col_expr(Column::UpdatedAt, Expr::value(stamp));
        if timing_changed {
            update = update.col_expr(Column::NextRunAt, Expr::value(cleared));
        }
        update.filter(Column::Id.eq(&row.id)).exec(&db).await?;
        indexed |= timing_changed;
    }

    for (_, row) in by_trigger {
        Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(stamp))
            .col_expr(Column::IsEnabled, Expr::value(false))
            .col_expr(Column::UpdatedAt, Expr::value(stamp))
            .filter(Column::Id.eq(&row.id))
            .exec(&db)
            .await?;
    }
    if indexed {
        ctx.schedule_due().await;
    }
    Ok(())
}

/// A one-time trigger's `executeAt` (epoch ms) as the `timestamp` column
/// stores it (`new Date(ms)`; Postgres refuses a time out of range).
fn execute_at(ms: i64) -> Result<PrimitiveDateTime, DbErr> {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .map(utc_timestamp)
        .map_err(|error| DbErr::Custom(format!("invalid executeAt {ms}: {error}")))
}

/// A stored `timestamp` as `new Date(row.executeAt).getTime()`: epoch
/// milliseconds, the microseconds cut.
fn epoch_ms(at: PrimitiveDateTime) -> Option<i64> {
    let at = utc_timestamp(at.assume_utc()).assume_utc();
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok()
}

// ── Webhook registry ────────────────────────────────────────────────────────

const REGISTRY_CACHE_TTL: Duration = Duration::from_secs(300);
const NOT_FOUND_SENTINEL: &str = "__not_found__";

fn registry_key(webhook_id: &str) -> String {
    format!("webhook:{webhook_id}")
}

/// `getMasterDb(env)` failing without a master database.
#[derive(Debug)]
pub(crate) enum RegistryError {
    NoMaster,
    Database(DbErr),
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoMaster => f.write_str("No database connection string was provided"),
            Self::Database(error) => error.fmt(f),
        }
    }
}

impl From<DbErr> for RegistryError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

async fn cache_put(cache: Option<&Arc<dyn DynCache>>, key: &str, value: &str) {
    if let Some(cache) = cache
        && let Err(error) = cache.put_boxed(key, value, Some(REGISTRY_CACHE_TTL)).await
    {
        tracing::warn!(%error, key, "webhook registry: cache write failed");
    }
}

/// `registerWebhookOwner(deps, webhookId, workspaceId)`.
pub(crate) async fn register_owner(
    ctx: &SyncContext,
    webhook_id: &str,
) -> Result<(), RegistryError> {
    let master = ctx.master.as_ref().ok_or(RegistryError::NoMaster)?;
    registry::Entity::insert(registry::ActiveModel {
        id: Set(webhook_id.to_owned()),
        workspace_id: Set(ctx.clerk_org_id.clone()),
        created_at: Set(utc_now()),
        deleted_at: Set(None),
    })
    .on_conflict(
        OnConflict::column(registry::Column::Id)
            .update_column(registry::Column::WorkspaceId)
            .value(
                registry::Column::DeletedAt,
                Expr::value(Option::<PrimitiveDateTime>::None),
            )
            .to_owned(),
    )
    .exec_without_returning(&orm(master))
    .await?;
    cache_put(
        ctx.cache.as_ref(),
        &registry_key(webhook_id),
        &ctx.clerk_org_id,
    )
    .await;
    Ok(())
}

/// `deregisterWebhookOwner(deps, webhookId)`.
pub(crate) async fn deregister_owner(
    ctx: &SyncContext,
    webhook_id: &str,
) -> Result<(), RegistryError> {
    let master = ctx.master.as_ref().ok_or(RegistryError::NoMaster)?;
    registry::Entity::update_many()
        .col_expr(registry::Column::DeletedAt, Expr::value(utc_now()))
        .filter(registry::Column::Id.eq(webhook_id))
        .exec(&orm(master))
        .await?;
    cache_put(
        ctx.cache.as_ref(),
        &registry_key(webhook_id),
        NOT_FOUND_SENTINEL,
    )
    .await;
    Ok(())
}

/// `resolveWebhookWorkspace(deps, webhookId)`: the owning Clerk org id.
pub(crate) async fn resolve_owner(
    master: Option<&PgPool>,
    cache: Option<&Arc<dyn DynCache>>,
    webhook_id: &str,
) -> Result<Option<String>, RegistryError> {
    let key = registry_key(webhook_id);
    if let Some(cache) = cache
        && let Ok(Some(cached)) = cache.get_boxed(&key).await
    {
        if cached == NOT_FOUND_SENTINEL {
            return Ok(None);
        }
        if !cached.is_empty() {
            return Ok(Some(cached));
        }
    }
    let master = master.ok_or(RegistryError::NoMaster)?;
    let row: Option<(String, Option<PrimitiveDateTime>)> = registry::Entity::find()
        .select_only()
        .columns([registry::Column::WorkspaceId, registry::Column::DeletedAt])
        .filter(registry::Column::Id.eq(webhook_id))
        .limit(1)
        .into_tuple()
        .one(&orm(master))
        .await?;
    if let Some((workspace, None)) = row {
        cache_put(cache, &key, &workspace).await;
        Ok(Some(workspace))
    } else {
        cache_put(cache, &key, NOT_FOUND_SENTINEL).await;
        Ok(None)
    }
}

/// `generateWebhookSecret()`.
pub(crate) fn webhook_secret() -> String {
    random_string(32, ALPHANUMERIC)
}

/// Why a webhook sync failed: the tenant write, or the registry.
#[derive(Debug)]
pub(crate) enum SyncError {
    Database(DbErr),
    Registry(RegistryError),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => error.fmt(f),
            Self::Registry(error) => error.fmt(f),
        }
    }
}

impl From<DbErr> for SyncError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

impl From<RegistryError> for SyncError {
    fn from(error: RegistryError) -> Self {
        Self::Registry(error)
    }
}

/// `syncWorkflowWebhooks(db, ctx, { workflowId, previousTriggers, nextTriggers })`.
pub(crate) async fn sync_webhooks(
    db: &PgPool,
    ctx: &SyncContext,
    workflow_id: &str,
    previous: Option<&Value>,
    next: Option<&Value>,
) -> Result<(), SyncError> {
    let desired = webhook_triggers(next);
    let mut managed = webhook_trigger_ids(previous);
    for id in webhook_trigger_ids(next) {
        if !managed.contains(&id) {
            managed.push(id);
        }
    }
    if managed.is_empty() {
        return Ok(());
    }
    if ctx.master.is_none() {
        return Err(RegistryError::NoMaster.into());
    }
    use workflow_webhooks::{ActiveModel, Column, Entity};
    let db = orm(db);
    let existing: Vec<(String, String, Option<bool>)> = Entity::find()
        .select_only()
        .columns([Column::Id, Column::TriggerId, Column::IsEnabled])
        .filter(Column::WorkflowId.eq(workflow_id))
        .filter(Column::TriggerId.is_in(&managed))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(&db)
        .await?;
    let mut by_trigger: HashMap<String, (String, Option<bool>)> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for (id, trigger_id, enabled) in existing {
        if !order.contains(&trigger_id) {
            order.push(trigger_id.clone());
        }
        by_trigger.insert(trigger_id, (id, enabled));
    }
    let stamp = utc_now();
    for trigger in &desired {
        if let Some((id, enabled)) = by_trigger.remove(&trigger.trigger_id) {
            if enabled != Some(trigger.is_enabled) {
                Entity::update_many()
                    .col_expr(Column::IsEnabled, Expr::value(trigger.is_enabled))
                    .col_expr(Column::UpdatedAt, Expr::value(stamp))
                    .filter(Column::Id.eq(&id))
                    .exec(&db)
                    .await?;
            }
            register_owner(ctx, &id).await?;
            continue;
        }
        if !trigger.is_enabled {
            continue;
        }
        let id = generate_id("wh");
        let url = format!("/api/workflows/webhook/{id}");
        Entity::insert(ActiveModel {
            id: Set(id.clone()),
            workflow_id: Set(workflow_id.to_owned()),
            trigger_id: Set(Some(trigger.trigger_id.clone())),
            name: Set(trigger.name.as_deref().unwrap_or("Webhook").to_owned()),
            external_url: Set(Some(format!("{}{url}", ctx.public_api_base))),
            url: Set(Some(url)),
            secret: Set(Some(webhook_secret())),
            validate_signature: Set(Some(false)),
            signature_header: Set(Some("x-webhook-signature".to_owned())),
            allowed_methods: Set(Some(json!(["POST"]))),
            is_enabled: Set(true),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            ..Default::default()
        })
        .exec_without_returning(&db)
        .await?;
        register_owner(ctx, &id).await?;
    }
    for trigger_id in order {
        let Some((id, _)) = by_trigger.remove(&trigger_id) else {
            continue;
        };
        Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(stamp))
            .col_expr(Column::IsEnabled, Expr::value(false))
            .col_expr(Column::UpdatedAt, Expr::value(stamp))
            .filter(Column::Id.eq(&id))
            .exec(&db)
            .await?;
        deregister_owner(ctx, &id).await?;
    }
    Ok(())
}
