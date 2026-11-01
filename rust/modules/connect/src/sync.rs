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

use serde_json::{Value, json};
use sqlx::PgConnection;
use weldsuite_db::PgPool;
use weldsuite_kit::id::ALPHANUMERIC;
use weldsuite_kit::{generate_id, random_string};
use weldsuite_ports::DynCache;

use crate::js::{bag, coalesce};
use crate::mvp::{
    one_time_triggers, recurring_triggers, schedule_trigger_ids, webhook_trigger_ids,
    webhook_triggers,
};
use crate::{Caller, ConnectState, now};

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

/// `buildIndexRows` + `buildIndexStatements`, run on `conn` (inside the
/// workflow write's transaction): the workflow's rows replaced by one per
/// enabled trigger when the workflow is active.
pub(crate) async fn write_trigger_index(
    conn: &mut PgConnection,
    workflow_id: &str,
    triggers: Option<&Value>,
    active: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query("delete from workflow_trigger_index where workflow_id = $1")
        .bind(workflow_id)
        .execute(&mut *conn)
        .await?;
    if !active {
        return Ok(());
    }
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
        let pick = |key: &str| coalesce(&[t.get(key), cfg.get(key)]).cloned();
        rows.push(json!({
            "id": generate_id("wti"),
            "trigger_id": id,
            "category": coalesce(&[Some(kind), cfg.get("type")]).cloned().unwrap_or(json!("manual")),
            "entity_type": pick("entityType"),
            "event_type": pick("eventType"),
            "provider": pick("provider"),
            "integration_event": coalesce(&[t.get("event"), cfg.get("event")]).cloned(),
            "integration_id": pick("integrationId"),
            "source_workflow_id": cfg.get("sourceWorkflowId").filter(|v| !v.is_null()).cloned(),
            "filters": coalesce(&[t.get("filters"), cfg.get("filters")]).cloned(),
        }));
    }
    if rows.is_empty() {
        return Ok(());
    }
    let stamp = now();
    sqlx::query(
        "insert into workflow_trigger_index
            (id, created_at, updated_at, workflow_id, trigger_id, category, is_enabled,
             entity_type, event_type, provider, integration_event, integration_id,
             source_workflow_id, filters)
         select r->>'id', $2::timestamp, $2::timestamp, $1, r->>'trigger_id', r->>'category', true,
                r->>'entity_type', r->>'event_type', r->>'provider', r->>'integration_event',
                r->>'integration_id', r->>'source_workflow_id',
                case when jsonb_typeof(r->'filters') in ('null') or r->'filters' is null then null
                     else r->'filters' end
         from jsonb_array_elements($3::jsonb) r",
    )
    .bind(workflow_id)
    .bind(&stamp)
    .bind(Value::Array(rows))
    .execute(&mut *conn)
    .await?;
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
) -> Result<(), sqlx::Error> {
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
    let existing: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from workflow_schedules t
         where t.workflow_id = $1 and t.trigger_id = any($2) and t.deleted_at is null",
    )
    .bind(workflow_id)
    .bind(&managed)
    .fetch_all(db)
    .await?;
    // `new Map(rows.map(...))`: one entry per trigger id, in first-seen
    // order, holding the last row.
    let mut by_trigger: Vec<(String, Value)> = Vec::new();
    for row in existing {
        let trigger_id = row["trigger_id"].as_str().unwrap_or_default().to_owned();
        match by_trigger.iter_mut().find(|(id, _)| *id == trigger_id) {
            Some(entry) => entry.1 = row,
            None => by_trigger.push((trigger_id, row)),
        }
    }
    let mut take = |trigger_id: &str| -> Option<Value> {
        let index = by_trigger.iter().position(|(id, _)| id == trigger_id)?;
        Some(by_trigger.remove(index).1)
    };
    let stamp = now();
    let mut indexed = false;

    for trigger in &recurring {
        let enabled = active && trigger.is_enabled;
        let Some(row) = take(&trigger.trigger_id) else {
            if !enabled {
                continue;
            }
            sqlx::query(
                "insert into workflow_schedules
                    (id, workflow_id, trigger_id, name, schedule_type, cron_expression, timezone,
                     is_enabled, created_at, updated_at)
                 values ($1, $2, $3, $4, 'recurring', $5, $6, $7, $8::timestamp, $8::timestamp)",
            )
            .bind(generate_id("sched"))
            .bind(workflow_id)
            .bind(&trigger.trigger_id)
            .bind(&trigger.name)
            .bind(&trigger.cron_expression)
            .bind(&trigger.timezone)
            .bind(enabled)
            .bind(&stamp)
            .execute(db)
            .await?;
            indexed = true;
            continue;
        };
        let timing_changed = row["cron_expression"].as_str()
            != Some(trigger.cron_expression.as_str())
            || row["timezone"].as_str() != Some(trigger.timezone.as_str())
            || row["is_enabled"].as_bool() != Some(enabled);
        let name_same = row["name"].as_str() == trigger.name.as_deref();
        if !timing_changed && name_same {
            continue;
        }
        sqlx::query(
            "update workflow_schedules set name = $2, schedule_type = 'recurring', cron_expression = $3,
                execute_at = null, timezone = $4, is_enabled = $5, updated_at = $6::timestamp,
                next_run_at = case when $7 then null else next_run_at end
             where id = $1",
        )
        .bind(row["id"].as_str())
        .bind(&trigger.name)
        .bind(&trigger.cron_expression)
        .bind(&trigger.timezone)
        .bind(enabled)
        .bind(&stamp)
        .bind(timing_changed)
        .execute(db)
        .await?;
        indexed |= timing_changed;
    }

    for trigger in &once {
        let row = take(&trigger.trigger_id);
        let fired = row.as_ref().is_some_and(|r| !r["last_run_at"].is_null());
        let enabled = !fired && active && trigger.is_enabled;
        let execute_at = crate::cron::iso(trigger.execute_at).unwrap_or_default();
        let Some(row) = row else {
            if !enabled {
                continue;
            }
            sqlx::query(
                "insert into workflow_schedules
                    (id, workflow_id, trigger_id, name, schedule_type, cron_expression, execute_at,
                     timezone, is_enabled, created_at, updated_at)
                 values ($1, $2, $3, $4, 'one_time', null, $5::timestamp, $6, $7, $8::timestamp, $8::timestamp)",
            )
            .bind(generate_id("sched"))
            .bind(workflow_id)
            .bind(&trigger.trigger_id)
            .bind(&trigger.name)
            .bind(&execute_at)
            .bind(&trigger.timezone)
            .bind(enabled)
            .bind(&stamp)
            .execute(db)
            .await?;
            indexed = true;
            continue;
        };
        let id = row["id"].as_str().unwrap_or_default();
        if fired {
            if row["name"].as_str() != trigger.name.as_deref() {
                sqlx::query("update workflow_schedules set name = $2, updated_at = $3::timestamp where id = $1")
                    .bind(id)
                    .bind(&trigger.name)
                    .bind(&stamp)
                    .execute(db)
                    .await?;
            }
            continue;
        }
        let stored_at = row["execute_at"].as_str().and_then(crate::cron::parse_ms);
        let timing_changed = stored_at != Some(trigger.execute_at)
            || row["timezone"].as_str() != Some(trigger.timezone.as_str())
            || row["is_enabled"].as_bool() != Some(enabled);
        if !timing_changed && row["name"].as_str() == trigger.name.as_deref() {
            continue;
        }
        sqlx::query(
            "update workflow_schedules set name = $2, schedule_type = 'one_time', cron_expression = null,
                execute_at = $3::timestamp, timezone = $4, is_enabled = $5, updated_at = $6::timestamp,
                next_run_at = case when $7 then null else next_run_at end
             where id = $1",
        )
        .bind(id)
        .bind(&trigger.name)
        .bind(&execute_at)
        .bind(&trigger.timezone)
        .bind(enabled)
        .bind(&stamp)
        .bind(timing_changed)
        .execute(db)
        .await?;
        indexed |= timing_changed;
    }

    for (_, row) in by_trigger {
        sqlx::query(
            "update workflow_schedules set deleted_at = $2::timestamp, is_enabled = false,
                updated_at = $2::timestamp where id = $1",
        )
        .bind(row["id"].as_str())
        .bind(&stamp)
        .execute(db)
        .await?;
    }
    if indexed {
        ctx.schedule_due().await;
    }
    Ok(())
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
    Database(sqlx::Error),
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoMaster => f.write_str("No database connection string was provided"),
            Self::Database(error) => error.fmt(f),
        }
    }
}

impl From<sqlx::Error> for RegistryError {
    fn from(error: sqlx::Error) -> Self {
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
    sqlx::query(
        "insert into workflow_webhook_registry (id, workspace_id, created_at, deleted_at)
         values ($1, $2, $3::timestamp, null)
         on conflict (id) do update set workspace_id = excluded.workspace_id, deleted_at = null",
    )
    .bind(webhook_id)
    .bind(&ctx.clerk_org_id)
    .bind(now())
    .execute(master)
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
    sqlx::query("update workflow_webhook_registry set deleted_at = $2::timestamp where id = $1")
        .bind(webhook_id)
        .bind(now())
        .execute(master)
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
    let row: Option<(String, bool)> = sqlx::query_as(
        "select workspace_id, deleted_at is not null from workflow_webhook_registry where id = $1 limit 1",
    )
    .bind(webhook_id)
    .fetch_optional(master)
    .await?;
    match row {
        Some((workspace, false)) => {
            cache_put(cache, &key, &workspace).await;
            Ok(Some(workspace))
        }
        _ => {
            cache_put(cache, &key, NOT_FOUND_SENTINEL).await;
            Ok(None)
        }
    }
}

/// `generateWebhookSecret()`.
pub(crate) fn webhook_secret() -> String {
    random_string(32, ALPHANUMERIC)
}

/// Why a webhook sync failed: the tenant write, or the registry.
#[derive(Debug)]
pub(crate) enum SyncError {
    Database(sqlx::Error),
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

impl From<sqlx::Error> for SyncError {
    fn from(error: sqlx::Error) -> Self {
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
    let existing: Vec<(String, String, Option<bool>)> = sqlx::query_as(
        "select id, trigger_id, is_enabled from workflow_webhooks
         where workflow_id = $1 and trigger_id = any($2) and deleted_at is null",
    )
    .bind(workflow_id)
    .bind(&managed)
    .fetch_all(db)
    .await?;
    let mut by_trigger: HashMap<String, (String, Option<bool>)> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for (id, trigger_id, enabled) in existing {
        if !order.contains(&trigger_id) {
            order.push(trigger_id.clone());
        }
        by_trigger.insert(trigger_id, (id, enabled));
    }
    let stamp = now();
    for trigger in &desired {
        if let Some((id, enabled)) = by_trigger.remove(&trigger.trigger_id) {
            if enabled != Some(trigger.is_enabled) {
                sqlx::query("update workflow_webhooks set is_enabled = $2, updated_at = $3::timestamp where id = $1")
                    .bind(&id)
                    .bind(trigger.is_enabled)
                    .bind(&stamp)
                    .execute(db)
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
        sqlx::query(
            "insert into workflow_webhooks
                (id, workflow_id, trigger_id, name, url, external_url, secret, validate_signature,
                 signature_header, allowed_methods, is_enabled, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, false, 'x-webhook-signature', '[\"POST\"]'::jsonb, true,
                     $8::timestamp, $8::timestamp)",
        )
        .bind(&id)
        .bind(workflow_id)
        .bind(&trigger.trigger_id)
        .bind(trigger.name.as_deref().unwrap_or("Webhook"))
        .bind(&url)
        .bind(format!("{}{url}", ctx.public_api_base))
        .bind(webhook_secret())
        .bind(&stamp)
        .execute(db)
        .await?;
        register_owner(ctx, &id).await?;
    }
    for trigger_id in order {
        let Some((id, _)) = by_trigger.remove(&trigger_id) else {
            continue;
        };
        sqlx::query(
            "update workflow_webhooks set deleted_at = $2::timestamp, is_enabled = false,
                updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&stamp)
        .execute(db)
        .await?;
        deregister_owner(ctx, &id).await?;
    }
    Ok(())
}
