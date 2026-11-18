//! `services/project-registry.ts`: keeps what the collector reads in step with
//! a project, the master `panel_project_registry` row and the cache record
//! `panel:project:<token>`. Both writes are idempotent, so a request that
//! fails halfway is repaired by repeating it.

use std::sync::Arc;

use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_events::iso_timestamp;
use weldsuite_ports::{Cache, DynCache, PortError};

use crate::domain::{
    names_replay_tier, plan_replay_tier, project_key, project_record, stored_project_record,
    tier_key, with_replay_tier, with_setting_defaults,
};

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
    async fn delete_tokens(
        &self,
        tokens: &[Option<&str>],
        keep: Option<&str>,
    ) -> Result<(), PortError> {
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

        // No expiry: deleting is explicit (rotation, project deletion).
        let tier = replay_tier_of(&self.master, &self.workspace_id).await?;
        let record = with_replay_tier(
            project_record(
                project_id,
                &self.workspace_id,
                &view.get("status"),
                &view.get("allowedDomains"),
                &settings,
            ),
            tier,
        );
        self.cache
            .put(&project_key(token), &record.to_string(), None)
            .await?;

        // A newer change (or the deletion) that synced while this one ran
        // wins: leave the cache as the registry says.
        if let Some(after) = self.row(project_id).await?
            && iso(&after, "updatedAt") > updated_at
        {
            let after_token = after
                .get("token")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let deleted = !after.get("deletedAt").is_none_or(Value::is_null);
            if deleted || after_token != token {
                self.cache.delete(&project_key(token)).await?;
            }
            if !deleted {
                let workspace = after
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let latest = with_replay_tier(
                    project_record(
                        project_id,
                        workspace,
                        &after.get("status").cloned().unwrap_or(Value::Null),
                        &after.get("allowedDomains").cloned().unwrap_or(Value::Null),
                        &after.get("settings").cloned().unwrap_or(Value::Null),
                    ),
                    tier,
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

/// `replayTierOf(registry)`: the tier the workspace's plan writes new
/// recording chunks to; `30d` for a workspace without a plan, or none.
pub(crate) async fn replay_tier_of(
    master: &PgPool,
    workspace_id: &str,
) -> Result<&'static str, sqlx::Error> {
    let slug: Option<Option<String>> = sqlx::query_scalar(
        "select p.slug from workspaces w left join plans p on p.id = w.plan_id
         where w.id = $1 limit 1",
    )
    .bind(workspace_id)
    .fetch_optional(master)
    .await?;
    Ok(plan_replay_tier(slug.flatten().as_deref()))
}

/// `applyReplayTier(deps, workspaceId, tier)`: brings the cache records of
/// a workspace's projects in step with its plan's replay tier, so a plan
/// change takes effect without anyone touching a project. Checked against
/// `panel:tier:<workspace>` first, so the usual call is one cache read; a
/// failed run leaves the marker alone and is repeated by the next one.
/// Answers whether the marker was behind (the records were looked at).
///
/// # Errors
///
/// The master database or the cache failing.
pub async fn apply_replay_tier(
    master: &PgPool,
    cache: &dyn DynCache,
    workspace_id: &str,
    tier: &str,
) -> Result<bool, PortError> {
    if cache.get_boxed(&tier_key(workspace_id)).await?.as_deref() == Some(tier) {
        return Ok(false);
    }
    let tokens: Vec<String> = sqlx::query_scalar(
        "select token from panel_project_registry
         where workspace_id = $1 and deleted_at is null",
    )
    .bind(workspace_id)
    .fetch_all(master)
    .await
    .map_err(PortError::backend)?;
    for token in tokens {
        let raw = cache.get_boxed(&project_key(&token)).await?;
        let Some(record) = stored_project_record(raw.as_deref()) else {
            continue;
        };
        if names_replay_tier(&record, tier) {
            continue;
        }
        cache
            .put_boxed(
                &project_key(&token),
                &with_replay_tier(record, tier).to_string(),
                None,
            )
            .await?;
    }
    cache.put_boxed(&tier_key(workspace_id), tier, None).await?;
    Ok(true)
}

/// Every workspace with a live project, and the tier its plan writes to
/// (`30d` without billing, as on Global without a plan).
///
/// # Errors
///
/// The master database failing.
pub async fn replay_tiers(master: &PgPool) -> Result<Vec<(String, &'static str)>, sqlx::Error> {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "select r.workspace_id, p.slug
         from (select distinct workspace_id from panel_project_registry where deleted_at is null) r
         left join workspaces w on w.id = r.workspace_id
         left join plans p on p.id = w.plan_id
         order by r.workspace_id",
    )
    .fetch_all(master)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(workspace_id, slug)| (workspace_id, plan_replay_tier(slug.as_deref())))
        .collect())
}

/// An ISO timestamp field of a `js_row` (`toISOString()` form, which orders
/// as text).
fn iso<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}
