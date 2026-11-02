//! `services/project-registry.ts`: keeps what the collector reads in step with
//! a project, the master `panel_project_registry` row and the cache record
//! `panel:project:<token>`. Both writes are idempotent, so a request that
//! fails halfway is repaired by repeating it.

use std::sync::Arc;

use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_events::iso_timestamp;
use weldsuite_ports::{Cache, DynCache, PortError};

use crate::domain::{project_key, project_record, with_setting_defaults};

/// What a registry write can fail with: the master database or the cache.
#[derive(Debug)]
pub(crate) enum RegistryError {
    Database(sqlx::Error),
    Cache(PortError),
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => write!(f, "{error}"),
            Self::Cache(error) => write!(f, "{error}"),
        }
    }
}

impl From<sqlx::Error> for RegistryError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<PortError> for RegistryError {
    fn from(error: PortError) -> Self {
        Self::Cache(error)
    }
}

/// `ProjectRegistry`: the master database, the cache and `workspaces.id`.
pub(crate) struct Registry {
    pub(crate) master: PgPool,
    pub(crate) cache: Arc<dyn DynCache>,
    pub(crate) workspace_id: String,
}

/// A project row as the routes read it (`js_row` of `panel_projects`).
pub(crate) struct ProjectView<'a>(pub(crate) &'a Value);

impl ProjectView<'_> {
    pub(crate) fn text(&self, key: &str) -> &str {
        self.0.get(key).and_then(Value::as_str).unwrap_or_default()
    }

    pub(crate) fn get(&self, key: &str) -> Value {
        self.0.get(key).cloned().unwrap_or(Value::Null)
    }
}

impl Registry {
    async fn row(&self, project_id: &str) -> Result<Option<Value>, sqlx::Error> {
        let row: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(r) from panel_project_registry r where r.project_id = $1 limit 1",
        )
        .bind(project_id)
        .fetch_optional(&self.master)
        .await?;
        Ok(row.map(weldsuite_db::js_row))
    }

    /// Deletes the cache records of `tokens`, each once, except `keep`'s.
    async fn delete_tokens(&self, tokens: &[Option<&str>], keep: Option<&str>) -> Result<(), PortError> {
        let mut retired: Vec<&str> = Vec::new();
        for token in tokens.iter().flatten() {
            if token.is_empty() || Some(*token) == keep || retired.contains(token) {
                continue;
            }
            retired.push(token);
        }
        for token in retired {
            self.cache.delete(&project_key(token)).await?;
        }
        Ok(())
    }

    /// `syncProjectRegistry(registry, project, previousToken)`.
    pub(crate) async fn sync(
        &self,
        project: &Value,
        previous_token: Option<&str>,
    ) -> Result<(), RegistryError> {
        let view = ProjectView(project);
        let project_id = view.text("id");
        let token = view.text("token");
        let updated_at = view.text("updatedAt");
        let before = self.row(project_id).await?;
        if let Some(before) = &before
            && iso(before, "updatedAt") > updated_at
        {
            return Ok(());
        }
        let before_token = before
            .as_ref()
            .and_then(|row| row.get("token"))
            .and_then(Value::as_str);
        self.delete_tokens(&[previous_token, before_token], Some(token))
            .await?;

        let settings = with_setting_defaults(project.get("settings"));
        let written: Option<String> = sqlx::query_scalar(
            "insert into panel_project_registry
               (project_id, token, workspace_id, status, allowed_domains, settings, updated_at, deleted_at)
             values ($1, $2, $3, $4, $5, $6, $7::timestamptz, null)
             on conflict (project_id) do update set
               token = excluded.token,
               workspace_id = excluded.workspace_id,
               status = excluded.status,
               allowed_domains = excluded.allowed_domains,
               settings = excluded.settings,
               updated_at = excluded.updated_at,
               deleted_at = null
             where panel_project_registry.updated_at <= $7::timestamptz
             returning project_id",
        )
        .bind(project_id)
        .bind(token)
        .bind(&self.workspace_id)
        .bind(view.text("status"))
        .bind(view.get("allowedDomains"))
        .bind(&settings)
        .bind(updated_at)
        .fetch_optional(&self.master)
        .await?;
        // A newer version was synced meanwhile, and publishes itself.
        if written.is_none() {
            return Ok(());
        }

        let record = project_record(
            project_id,
            &self.workspace_id,
            &view.get("status"),
            &view.get("allowedDomains"),
            &settings,
        );
        self.cache
            .put(&project_key(token), &record.to_string(), None)
            .await?;

        // A newer change (or the deletion) that synced while this one ran
        // wins: leave the cache as the registry says.
        if let Some(after) = self.row(project_id).await?
            && iso(&after, "updatedAt") > updated_at
        {
            let after_token = after.get("token").and_then(Value::as_str).unwrap_or_default();
            let deleted = !after.get("deletedAt").is_none_or(Value::is_null);
            if deleted || after_token != token {
                self.cache.delete(&project_key(token)).await?;
            }
            if !deleted {
                let workspace = after
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let latest = project_record(
                    project_id,
                    workspace,
                    &after.get("status").cloned().unwrap_or(Value::Null),
                    &after.get("allowedDomains").cloned().unwrap_or(Value::Null),
                    &after.get("settings").cloned().unwrap_or(Value::Null),
                );
                self.cache
                    .put(&project_key(after_token), &latest.to_string(), None)
                    .await?;
            }
        }
        Ok(())
    }

    /// `removeProjectFromRegistry(registry, project)`: marks the row
    /// deleted, then drops the cache records of the project's token and of
    /// the one the registry names. Safe to repeat.
    pub(crate) async fn remove(&self, project: &Value) -> Result<(), RegistryError> {
        let view = ProjectView(project);
        let project_id = view.text("id");
        let before = self.row(project_id).await?;
        sqlx::query(
            "update panel_project_registry
             set deleted_at = $2::timestamptz,
                 updated_at = greatest(updated_at, $3::timestamptz)
             where project_id = $1",
        )
        .bind(project_id)
        .bind(iso_timestamp(time::OffsetDateTime::now_utc()))
        .bind(view.text("updatedAt"))
        .execute(&self.master)
        .await?;
        let before_token = before
            .as_ref()
            .and_then(|row| row.get("token"))
            .and_then(Value::as_str);
        self.delete_tokens(&[Some(view.text("token")), before_token], None)
            .await?;
        Ok(())
    }
}

/// An ISO timestamp field of a `js_row` (`toISOString()` form, which orders
/// as text).
fn iso<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}
