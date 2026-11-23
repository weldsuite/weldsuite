//! `CrmSyncWorkflow` (`workflows/crm-sync.ts`) as the `integrations.crm-sync`
//! job: load the connection (refreshing an expired token), open a sync log,
//! sync each enabled entity type in its own step, then finalise the log and
//! the connection's counters. A failed step marks the log and the
//! connection failed and fails the run, so the connection is never left
//! `syncing`.

use std::time::Duration;

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_ports::{BoxFuture, Job, JobContext, JobError, RealtimeMessage, StepRetry, step};
use weldsuite_schema::tenant::{integration_connections as connections, sync_logs};

use super::adapters::{Adapter, millis_of};
use super::engine::{SyncConnection, SyncEntityStats, now_at, sync_entity_type};
use super::mapper::truthy;
use super::{CRM_SYNC_JOB, CrmDeps, db_message, now_millis};

/// `CrmSyncParams`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrmSyncParams {
    pub workspace_id: String,
    pub connection_id: String,
    pub provider: String,
    #[serde(default)]
    pub sync_type: String,
    #[serde(default)]
    pub entity_types: Option<Vec<String>>,
}

/// `integrations.crm-sync`.
pub struct CrmSyncJob {
    pub deps: CrmDeps,
}

fn retry(limit: u32, seconds: u64) -> StepRetry {
    StepRetry::exponential(limit, Duration::from_secs(seconds))
}

fn failed(error: impl std::fmt::Display) -> JobError {
    JobError::failed(error)
}

/// What `load-connection` hands on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionData {
    sync_settings: Value,
    access_token: String,
}

/// The message a failed run is recorded with (`workflowErr.message`).
fn message_of(error: &JobError) -> String {
    match error {
        JobError::Failed(message) | JobError::StepFailed { message, .. } => message.clone(),
        other => other.to_string(),
    }
}

/// `getEnabledEntityTypes(syncSettings, supportedEntities)`.
pub fn enabled_entity_types(sync_settings: &Value, supported: &[&str]) -> Vec<String> {
    let Some(settings) = sync_settings.as_object() else {
        return supported.iter().map(|s| (*s).to_owned()).collect();
    };
    let not_false = |key: &str| settings.get(key) != Some(&Value::Bool(false));
    let on = |key: &str| truthy(settings.get(key));
    let mut enabled = Vec::new();
    if not_false("syncCompanies") {
        enabled.push("customer");
    }
    if not_false("syncPeople") {
        enabled.push("contact");
    }
    if on("syncLeads") {
        enabled.push("lead");
    }
    if on("syncOpportunities") {
        enabled.push("opportunity");
    }
    if on("syncActivities") {
        enabled.push("activity");
    }
    if not_false("syncCalendarEvents") {
        enabled.push("calendar_event");
    }
    enabled
        .into_iter()
        .filter(|e| supported.contains(e))
        .map(str::to_owned)
        .collect()
}

/// `select * from integration_connections where id = $1 [and deleted_at is null]`.
async fn connection_row(
    db: &PgPool,
    id: &str,
    live: bool,
) -> Result<Option<connections::Model>, String> {
    let mut find = connections::Entity::find_by_id(id.to_owned());
    if live {
        find = find.filter(connections::Column::DeletedAt.is_null());
    }
    find.one(&orm(db)).await.map_err(|e| db_message(&e))
}

/// `db.update(integrationConnections).set({ ... }).where(eq(id))`: the
/// columns given, on the one connection.
async fn update_connection(
    db: &PgPool,
    id: &str,
    set: Vec<(connections::Column, Expr)>,
) -> Result<(), DbErr> {
    let mut update = connections::Entity::update_many();
    for (column, value) in set {
        update = update.col_expr(column, value);
    }
    update
        .filter(connections::Column::Id.eq(id))
        .exec(&orm(db))
        .await
        .map(|_| ())
}

impl CrmSyncJob {
    /// Step 1, `load-connection`.
    async fn load_connection(&self, p: &CrmSyncParams) -> Result<ConnectionData, String> {
        let id = &p.connection_id;
        let db = self.deps.db(&p.workspace_id).await?;
        let connection = connection_row(&db, id, true)
            .await?
            .ok_or_else(|| format!("Connection {id} not found"))?;
        let tokens = connection.oauth_tokens.clone().unwrap_or(Value::Null);
        let access = tokens.get("accessToken");
        if !truthy(access) {
            return Err(format!("No access token for connection {id}"));
        }
        let access = weldsuite_core_domain::js::js_string(
            &weldsuite_core_domain::js::Js::from_jsonb(access.expect("truthy")),
        );
        let sync_settings = connection.sync_settings.clone().unwrap_or(Value::Null);
        let expiry = tokens.get("expiresAt").filter(|v| truthy(Some(v)));
        let expired = expiry
            .and_then(Value::as_str)
            .and_then(millis_of)
            .is_some_and(|at| at < now_millis());
        if !expired {
            return Ok(ConnectionData {
                sync_settings,
                access_token: access,
            });
        }
        let refresh = tokens.get("refreshToken").filter(|v| truthy(Some(v)));
        let Some(refresh) = refresh else {
            return Err(format!(
                "Token expired and no refresh token available for {id}"
            ));
        };
        let refresh = weldsuite_core_domain::js::js_string(
            &weldsuite_core_domain::js::Js::from_jsonb(refresh),
        );
        let adapter = Adapter::for_provider(&p.provider)?;
        let upper = p.provider.to_uppercase();
        let client_id = self
            .deps
            .env(&format!("{upper}_CLIENT_ID"))
            .or_else(|| self.deps.env("ATTIO_CLIENT_ID"));
        let client_secret = self
            .deps
            .env(&format!("{upper}_CLIENT_SECRET"))
            .or_else(|| self.deps.env("ATTIO_CLIENT_SECRET"));
        let (Some(client_id), Some(client_secret)) = (client_id, client_secret) else {
            return Err(format!(
                "Missing OAuth client credentials for provider {}",
                p.provider
            ));
        };
        let tokens = adapter
            .refresh_access_token(
                self.deps.http.as_ref(),
                &client_id,
                &client_secret,
                &refresh,
            )
            .await?;
        update_connection(
            &db,
            id,
            vec![
                (
                    connections::Column::OauthTokens,
                    Expr::value(tokens.to_json()),
                ),
                (connections::Column::UpdatedAt, Expr::value(now_at())),
            ],
        )
        .await
        .map_err(|e| db_message(&e))?;
        Ok(ConnectionData {
            sync_settings,
            access_token: tokens.access_text(),
        })
    }

    /// Step 2, `create-sync-log`.
    async fn create_log(&self, p: &CrmSyncParams) -> Result<String, String> {
        let db = self.deps.db(&p.workspace_id).await?;
        let id = generate_id("slog");
        let triggered_by = if p.sync_type == "full" {
            "manual"
        } else {
            "scheduled"
        };
        sync_logs::Entity::insert(sync_logs::ActiveModel {
            id: Set(id.clone()),
            platform: Set(p.provider.clone()),
            connection_id: Set(p.connection_id.clone()),
            sync_type: Set("all".to_owned()),
            status: Set("running".to_owned()),
            triggered_by: Set(triggered_by.to_owned()),
            started_at: Set(Some(now_at())),
            ..Default::default()
        })
        .exec_without_returning(&orm(&db))
        .await
        .map_err(|e| db_message(&e))?;
        update_connection(
            &db,
            &p.connection_id,
            vec![
                (connections::Column::Status, Expr::value("syncing")),
                (connections::Column::UpdatedAt, Expr::value(now_at())),
            ],
        )
        .await
        .map_err(|e| db_message(&e))?;
        Ok(id)
    }

    /// Step 3, `sync-<entityType>`.
    async fn sync_type(
        &self,
        p: &CrmSyncParams,
        adapter: Adapter,
        entity_type: &str,
        access_token: &str,
    ) -> Result<SyncEntityStats, String> {
        let db = self.deps.db(&p.workspace_id).await?;
        let connection = connection_row(&db, &p.connection_id, false)
            .await?
            .ok_or_else(|| format!("Connection {} not found during sync", p.connection_id))?;
        let sync = SyncConnection {
            id: p.connection_id.clone(),
            sync_cursor: connection.sync_cursor.clone().filter(|v| !v.is_null()),
            conflict_strategy: Some(connection.conflict_strategy.clone()),
            entity_config: connection.entity_config.clone().filter(|v| !v.is_null()),
        };
        let defaults: Vec<(&str, Option<Value>)> = if entity_type == "calendar_event" {
            vec![
                (
                    "calendarId",
                    connection
                        .settings
                        .as_ref()
                        .and_then(|s| s.get("googleCalendarId"))
                        .cloned(),
                ),
                (
                    "organizerId",
                    Some(
                        connection
                            .connected_by
                            .clone()
                            .map_or(Value::Null, Value::String),
                    ),
                ),
                ("type", Some(json!("event"))),
            ]
        } else {
            Vec::new()
        };
        sync_entity_type(
            &db,
            self.deps.http.as_ref(),
            adapter,
            &sync,
            entity_type,
            access_token,
            &defaults,
        )
        .await
    }

    /// Step 4, `finalize`.
    async fn finalize(
        &self,
        p: &CrmSyncParams,
        log_id: &str,
        all: &[(String, SyncEntityStats)],
        started: i64,
    ) -> Result<(), String> {
        let db = self.deps.db(&p.workspace_id).await?;
        let duration = now_millis() - started;
        let total = |f: fn(&SyncEntityStats) -> i64| all.iter().map(|(_, s)| f(s)).sum::<i64>();
        let processed = total(|s| s.processed);
        let metadata: Map<String, Value> = all
            .iter()
            .map(|(k, s)| (k.clone(), serde_json::to_value(s).unwrap_or(Value::Null)))
            .collect();
        let count = |n: i64| i32::try_from(n).unwrap_or(i32::MAX);
        sync_logs::Entity::update_many()
            .col_expr(sync_logs::Column::Status, Expr::value("completed"))
            .col_expr(
                sync_logs::Column::ItemsProcessed,
                Expr::value(count(processed)),
            )
            .col_expr(sync_logs::Column::TotalItems, Expr::value(count(processed)))
            .col_expr(
                sync_logs::Column::ItemsCreated,
                Expr::value(count(total(|s| s.created))),
            )
            .col_expr(
                sync_logs::Column::ItemsUpdated,
                Expr::value(count(total(|s| s.updated))),
            )
            .col_expr(
                sync_logs::Column::ItemsFailed,
                Expr::value(count(total(|s| s.failed))),
            )
            .col_expr(
                sync_logs::Column::ItemsSkipped,
                Expr::value(count(total(|s| s.skipped))),
            )
            .col_expr(sync_logs::Column::FinishedAt, Expr::value(now_at()))
            .col_expr(sync_logs::Column::DurationMs, Expr::value(count(duration)))
            .col_expr(
                sync_logs::Column::Metadata,
                Expr::value(Value::Object(metadata)),
            )
            .filter(sync_logs::Column::Id.eq(log_id))
            .exec(&orm(&db))
            .await
            .map_err(|e| db_message(&e))?;

        let of = |key: &str| {
            all.iter()
                .find(|(k, _)| k == key)
                .map(|(_, s)| i32::try_from(s.processed).unwrap_or(i32::MAX))
        };
        // `calendar_event` overwrites `activitiesSynced` after `activity`.
        let activities = of("calendar_event").or_else(|| of("activity"));
        let at = now_at();
        let mut set = vec![
            (connections::Column::Status, Expr::value("active")),
            (connections::Column::LastSyncAt, Expr::value(at)),
            (
                connections::Column::LastSyncStatus,
                Expr::value("completed"),
            ),
            (connections::Column::LastError, Expr::value(None::<String>)),
            (
                connections::Column::LastErrorAt,
                Expr::value(None::<time::PrimitiveDateTime>),
            ),
            (connections::Column::UpdatedAt, Expr::value(at)),
        ];
        // `coalesce($n, <counter>)`: a counter the run synced nothing of keeps its value.
        for (column, synced) in [
            (connections::Column::CompaniesSynced, of("customer")),
            (connections::Column::PeopleSynced, of("contact")),
            (connections::Column::LeadsSynced, of("lead")),
            (connections::Column::OpportunitiesSynced, of("opportunity")),
            (connections::Column::ActivitiesSynced, activities),
        ] {
            if let Some(synced) = synced {
                set.push((column, Expr::value(synced)));
            }
        }
        update_connection(&db, &p.connection_id, set)
            .await
            .map_err(|e| db_message(&e))?;
        tracing::info!(
            "[CrmSync] Completed: {processed} processed, {} created, {} updated, {} failed ({duration}ms)",
            total(|s| s.created),
            total(|s| s.updated),
            total(|s| s.failed)
        );

        // Frontends refresh their calendar views.
        if let Some((_, calendar)) = all.iter().find(|(k, _)| k == "calendar_event")
            && (calendar.created > 0 || calendar.updated > 0)
            && let Some(realtime) = &self.deps.realtime
        {
            let message = RealtimeMessage::workspace(
                &p.workspace_id,
                "calendar_event",
                "updated",
                json!({ "id": "bulk_sync", "syncStats": calendar }),
                "system",
            );
            if let Err(error) = realtime.publish_boxed(&message).await {
                tracing::error!(%error, "[CrmSync] Failed to publish realtime calendar event");
            }
        }
        Ok(())
    }

    /// Step `handle-failure`.
    async fn handle_failure(
        &self,
        p: &CrmSyncParams,
        log_id: Option<&str>,
        message: &str,
    ) -> Result<(), String> {
        let db = self.deps.db(&p.workspace_id).await?;
        if let Some(log_id) = log_id {
            sync_logs::Entity::update_many()
                .col_expr(sync_logs::Column::Status, Expr::value("failed"))
                .col_expr(sync_logs::Column::ErrorMessage, Expr::value(message))
                .col_expr(sync_logs::Column::FinishedAt, Expr::value(now_at()))
                .filter(sync_logs::Column::Id.eq(log_id))
                .exec(&orm(&db))
                .await
                .map_err(|e| db_message(&e))?;
        }
        let at = now_at();
        update_connection(
            &db,
            &p.connection_id,
            vec![
                (connections::Column::Status, Expr::value("error")),
                (connections::Column::LastSyncStatus, Expr::value("failed")),
                (connections::Column::LastError, Expr::value(message)),
                (connections::Column::LastErrorAt, Expr::value(at)),
                (connections::Column::UpdatedAt, Expr::value(at)),
            ],
        )
        .await
        .map_err(|e| db_message(&e))?;
        Ok(())
    }

    async fn run_steps(
        &self,
        ctx: &dyn JobContext,
        p: &CrmSyncParams,
        log: &mut Option<String>,
    ) -> Result<(), JobError> {
        let data: ConnectionData = step(ctx, "load-connection", retry(2, 5), || async move {
            self.load_connection(p).await.map_err(failed)
        })
        .await?;
        let log_id: String = step(
            ctx,
            "create-sync-log",
            StepRetry::default(),
            || async move { self.create_log(p).await.map_err(failed) },
        )
        .await?;
        *log = Some(log_id.clone());

        let adapter = Adapter::for_provider(&p.provider).map_err(failed)?;
        let entity_types = match &p.entity_types {
            Some(types) => types.clone(),
            None => enabled_entity_types(&data.sync_settings, adapter.supported_entities()),
        };
        let mut all: Vec<(String, SyncEntityStats)> = Vec::new();
        let started = now_millis();
        let token = data.access_token.as_str();
        for entity_type in &entity_types {
            let name = format!("sync-{entity_type}");
            let stats: SyncEntityStats = step(ctx, &name, retry(3, 10), || async move {
                self.sync_type(p, adapter, entity_type, token)
                    .await
                    .map_err(failed)
            })
            .await?;
            match all.iter_mut().find(|(k, _)| k == entity_type) {
                Some((_, slot)) => *slot = stats,
                None => all.push((entity_type.clone(), stats)),
            }
        }
        let all = &all;
        let log_id = log_id.as_str();
        let _: Value = step(ctx, "finalize", StepRetry::default(), || async move {
            self.finalize(p, log_id, all, started)
                .await
                .map(|()| Value::Null)
                .map_err(failed)
        })
        .await?;
        Ok(())
    }

    async fn run_sync(&self, ctx: &dyn JobContext, p: CrmSyncParams) -> Result<(), JobError> {
        let mut log: Option<String> = None;
        let Err(error) = self.run_steps(ctx, &p, &mut log).await else {
            return Ok(());
        };
        let message = message_of(&error);
        tracing::error!(
            "[CrmSync] Sync failed for connection {}: {message}",
            p.connection_id
        );
        let (p, log, message) = (&p, log.as_deref(), message.as_str());
        let _: Value = step(ctx, "handle-failure", StepRetry::default(), || async move {
            self.handle_failure(p, log, message)
                .await
                .map(|()| Value::Null)
                .map_err(failed)
        })
        .await?;
        Err(error)
    }
}

impl Job for CrmSyncJob {
    fn name(&self) -> &'static str {
        CRM_SYNC_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let params: CrmSyncParams = serde_json::from_value(payload)?;
            self.run_sync(ctx, params).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entity_types_follow_the_sync_settings() {
        let all = ["customer", "contact", "opportunity"];
        assert_eq!(enabled_entity_types(&Value::Null, &all), all);
        assert_eq!(
            enabled_entity_types(
                &json!({ "syncCompanies": false, "syncOpportunities": true, "syncPeople": 0 }),
                &all
            ),
            ["contact", "opportunity"]
        );
    }
}
