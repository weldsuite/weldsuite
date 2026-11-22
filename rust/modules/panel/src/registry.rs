//! `services/project-registry.ts`: keeps what the collector reads in step with
//! a project, the master `panel_project_registry` row and the cache record
//! `panel:project:<token>`. Both writes are idempotent, so a request that
//! fails halfway is repaired by repeating it.

use std::sync::Arc;

use sea_orm::sea_query::{Expr, Func, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect,
};
use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_panel_domain::js;
use weldsuite_ports::{Cache, DynCache, PortError};
use weldsuite_schema::master::panel_project_registry::{self as registry, Column};
use weldsuite_schema::master::{plans, workspaces};

use crate::domain::{
    names_replay_tier, plan_replay_tier, project_key, project_record, stored_project_record,
    tier_key, with_replay_tier, with_setting_defaults,
};
use crate::saved::{instant, js_row};

/// What a registry write can fail with: the master database or the cache.
#[derive(Debug)]
pub(crate) enum RegistryError {
    Database(sea_orm::DbErr),
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

impl From<sea_orm::DbErr> for RegistryError {
    fn from(error: sea_orm::DbErr) -> Self {
        Self::Database(error)
    }
}

impl From<sqlx::Error> for RegistryError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(weldsuite_db::orm_error(error))
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

/// An ISO moment of a project row (`updatedAt`) as the `timestamptz` it
/// was read from.
fn moment(iso: &str) -> Result<OffsetDateTime, DbErr> {
    js::parse_iso(iso)
        .map(instant)
        .ok_or_else(|| DbErr::Type(format!("not a timestamp: {iso:?}")))
}

impl Registry {
    async fn row(&self, project_id: &str) -> Result<Option<Value>, DbErr> {
        registry::Entity::find_by_id(project_id)
            .one(&orm(&self.master))
            .await?
            .map(js_row)
            .transpose()
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
        let version = moment(updated_at)?;
        let written = registry::Entity::insert(registry::ActiveModel {
            project_id: Set(project_id.to_owned()),
            token: Set(token.to_owned()),
            workspace_id: Set(self.workspace_id.clone()),
            status: Set(view.text("status").to_owned()),
            allowed_domains: Set(view.get("allowedDomains")),
            settings: Set(settings.clone()),
            updated_at: Set(version),
            deleted_at: Set(None),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(Column::ProjectId)
                .update_columns([
                    Column::Token,
                    Column::WorkspaceId,
                    Column::Status,
                    Column::AllowedDomains,
                    Column::Settings,
                    Column::UpdatedAt,
                    Column::DeletedAt,
                ])
                .action_and_where(sea_orm::ExprTrait::lte(
                    Expr::col((registry::Entity, Column::UpdatedAt)),
                    version,
                ))
                .to_owned(),
        )
        .exec_without_returning(&orm(&self.master))
        .await?;
        // A newer version was synced meanwhile, and publishes itself.
        if written == 0 {
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
        let version = moment(view.text("updatedAt"))?;
        registry::Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(instant(js::now_millis())))
            .col_expr(
                Column::UpdatedAt,
                Func::greatest([Expr::col(Column::UpdatedAt), Expr::value(version)]).into(),
            )
            .filter(Column::ProjectId.eq(project_id))
            .exec(&orm(&self.master))
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

/// `loadPlanSlug`: the slug of the workspace's plan, `None` for a
/// workspace without a plan, or none.
pub(crate) async fn plan_slug(
    master: &PgPool,
    workspace_id: &str,
) -> Result<Option<String>, DbErr> {
    let slug: Option<Option<String>> = workspaces::Entity::find()
        .select_only()
        .column(plans::Column::Slug)
        .join(JoinType::LeftJoin, workspace_plan())
        .filter(workspaces::Column::Id.eq(workspace_id))
        .into_tuple()
        .one(&orm(master))
        .await?;
    Ok(slug.flatten())
}

/// `plans p on p.id = w.plan_id`.
pub(crate) fn workspace_plan() -> sea_orm::RelationDef {
    workspaces::Entity::belongs_to(plans::Entity)
        .from(workspaces::Column::PlanId)
        .to(plans::Column::Id)
        .into()
}

/// `replayTierOf(registry)`: the tier the workspace's plan writes new
/// recording chunks to; `30d` for a workspace without a plan, or none.
pub(crate) async fn replay_tier_of(
    master: &PgPool,
    workspace_id: &str,
) -> Result<&'static str, DbErr> {
    Ok(plan_replay_tier(
        plan_slug(master, workspace_id).await?.as_deref(),
    ))
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
    let tokens: Vec<String> = registry::Entity::find()
        .select_only()
        .column(Column::Token)
        .filter(Column::WorkspaceId.eq(workspace_id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(master))
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

/// An ISO timestamp field of a `js_row` (`toISOString()` form, which orders
/// as text).
fn iso<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}
