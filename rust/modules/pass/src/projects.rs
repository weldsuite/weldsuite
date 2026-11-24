//! Vault projects and their environments (`services/weldpass/vault.ts`).
//! A project of another workspace is not found: an id from elsewhere reads
//! as 404, nothing is confirmed to exist.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Unchanged, ColumnTrait, EntityTrait, FromQueryResult, QueryFilter, QueryOrder,
    QuerySelect, Select, Set,
};
use serde::Serialize;
use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    weldpass_environments as environments, weldpass_projects as projects, weldpass_secrets,
    weldpass_sync_targets,
};

use crate::envelope::{Key, RootKeyring, create_vault_key, unwrap_vault_key};
use crate::schemas::slugify;
use crate::{PassError, PassResult, int4, now, row_json};

use environments::Column as E;
use projects::Column as P;

/// `projectColumns`: never the wrapped key.
#[derive(Debug, Clone, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRow {
    id: String,
    name: String,
    slug: String,
    description: Option<String>,
    root_key_version: String,
    created_by: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    created_at: OffsetDateTime,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    updated_at: OffsetDateTime,
}

impl ProjectRow {
    fn select() -> Select<projects::Entity> {
        projects::Entity::find().select_only().columns([
            P::Id,
            P::Name,
            P::Slug,
            P::Description,
            P::RootKeyVersion,
            P::CreatedBy,
            P::CreatedAt,
            P::UpdatedAt,
        ])
    }
}

impl From<projects::Model> for ProjectRow {
    fn from(row: projects::Model) -> Self {
        Self {
            id: row.id,
            name: row.name,
            slug: row.slug,
            description: row.description,
            root_key_version: row.root_key_version,
            created_by: row.created_by,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// `environmentColumns`.
#[derive(Debug, Clone, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentRow {
    id: String,
    project_id: String,
    name: String,
    slug: String,
    is_production: bool,
    sort_order: i32,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    created_at: OffsetDateTime,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    updated_at: OffsetDateTime,
}

impl EnvironmentRow {
    fn select() -> Select<environments::Entity> {
        environments::Entity::find().select_only().columns([
            E::Id,
            E::ProjectId,
            E::Name,
            E::Slug,
            E::IsProduction,
            E::SortOrder,
            E::CreatedAt,
            E::UpdatedAt,
        ])
    }
}

impl From<environments::Model> for EnvironmentRow {
    fn from(row: environments::Model) -> Self {
        Self {
            id: row.id,
            project_id: row.project_id,
            name: row.name,
            slug: row.slug,
            is_production: row.is_production,
            sort_order: row.sort_order,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// A project as the routes return it (`projectColumns`).
#[derive(Debug, Clone)]
pub(crate) struct Project {
    pub(crate) id: String,
    pub(crate) slug: String,
    pub(crate) json: Value,
}

impl Project {
    fn from_row(row: ProjectRow) -> Self {
        Self {
            json: row_json(&row),
            id: row.id,
            slug: row.slug,
        }
    }
}

/// An environment (`environmentColumns`).
#[derive(Debug, Clone)]
pub(crate) struct Environment {
    pub(crate) id: String,
    pub(crate) slug: String,
    pub(crate) json: Value,
}

impl Environment {
    fn from_row(row: EnvironmentRow) -> Self {
        Self {
            json: row_json(&row),
            id: row.id,
            slug: row.slug,
        }
    }
}

/// `workspace_id` of a new row. Without a workspace the worker's insert
/// fails on the column's NOT NULL (a 500), as it does here before writing.
pub(crate) fn workspace_of(workspace: Option<&str>, table: &str) -> PassResult<String> {
    workspace.map(str::to_owned).ok_or_else(|| {
        PassError::Internal(format!(
            "null value in column \"workspace_id\" of relation \"{table}\" violates not-null constraint"
        ))
    })
}

/// `listProjects`: by name.
pub(crate) async fn list_projects(
    db: &PgPool,
    workspace: Option<&str>,
) -> PassResult<Vec<Project>> {
    let rows = ProjectRow::select()
        .filter(P::WorkspaceId.eq(workspace))
        .filter(P::DeletedAt.is_null())
        .order_by_asc(P::Name)
        .into_model::<ProjectRow>()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().map(Project::from_row).collect())
}

/// `findProjectBySlug`.
pub(crate) async fn find_project_by_slug(
    db: &PgPool,
    workspace: Option<&str>,
    slug: &str,
) -> PassResult<Option<Project>> {
    let row = ProjectRow::select()
        .filter(P::WorkspaceId.eq(workspace))
        .filter(P::Slug.eq(slug))
        .filter(P::DeletedAt.is_null())
        .into_model::<ProjectRow>()
        .one(&orm(db))
        .await?;
    Ok(row.map(Project::from_row))
}

/// `requireProject`: in the caller's workspace, or a 404.
pub(crate) async fn require_project(
    db: &PgPool,
    workspace: Option<&str>,
    project_id: &str,
) -> PassResult<Project> {
    let row = ProjectRow::select()
        .filter(P::Id.eq(project_id))
        .filter(P::WorkspaceId.eq(workspace))
        .filter(P::DeletedAt.is_null())
        .into_model::<ProjectRow>()
        .one(&orm(db))
        .await?;
    row.map(Project::from_row)
        .ok_or_else(|| PassError::not_found("project", project_id))
}

/// The environments every project starts with.
const DEFAULT_ENVIRONMENTS: [(&str, &str, bool, i32); 3] = [
    ("Development", "development", false, 0),
    ("Preview", "preview", false, 1),
    ("Production", "production", true, 2),
];

/// `createProject`: the project, its KEK and its default environments.
/// Ordered so an interruption leaves a usable project, never one whose key
/// is missing.
pub(crate) async fn create_project(
    db: &PgPool,
    workspace: Option<&str>,
    keyring: &RootKeyring,
    name: &str,
    slug: Option<&str>,
    description: Option<&str>,
    created_by: &str,
) -> PassResult<(Project, Vec<Environment>)> {
    let id = generate_id("wpp");
    let slug = slugify(slug.unwrap_or(name));
    if slug.is_empty() {
        return Err(PassError::Internal(
            "Project name must contain at least one letter or digit".to_owned(),
        ));
    }
    let key = create_vault_key(keyring, &id)?;
    let workspace = workspace_of(workspace, "weldpass_projects")?;
    let db = orm(db);
    let project = projects::Entity::insert(projects::ActiveModel {
        id: Set(id.clone()),
        workspace_id: Set(workspace),
        name: Set(name.to_owned()),
        slug: Set(slug),
        description: Set(description.map(str::to_owned)),
        kek_wrapped: Set(key.kek_wrapped),
        root_key_version: Set(key.root_key_version.to_owned()),
        created_by: Set(Some(created_by.to_owned())),
        ..Default::default()
    })
    .exec_with_returning(&db)
    .await?;

    let environments = environments::Entity::insert_many(DEFAULT_ENVIRONMENTS.iter().map(
        |&(name, slug, is_production, sort_order)| environments::ActiveModel {
            id: Set(generate_id("wpe")),
            project_id: Set(id.clone()),
            name: Set(name.to_owned()),
            slug: Set(slug.to_owned()),
            is_production: Set(is_production),
            sort_order: Set(sort_order),
            ..Default::default()
        },
    ))
    .exec_with_returning(&db)
    .await?;
    Ok((
        Project::from_row(project.into()),
        environments
            .into_iter()
            .map(|row| Environment::from_row(row.into()))
            .collect(),
    ))
}

/// `updateProject`: the fields given (`description: null` clears it).
#[allow(clippy::option_option)] // `description`: left out, null, or a text
pub(crate) async fn update_project(
    db: &PgPool,
    workspace: Option<&str>,
    project_id: &str,
    name: Option<&str>,
    description: Option<Option<&str>>,
) -> PassResult<Project> {
    require_project(db, workspace, project_id).await?;
    let mut patch = projects::ActiveModel {
        id: Unchanged(project_id.to_owned()),
        updated_at: Set(now()),
        ..Default::default()
    };
    if let Some(name) = name {
        patch.name = Set(name.to_owned());
    }
    if let Some(description) = description {
        patch.description = Set(description.map(str::to_owned));
    }
    let row = projects::Entity::update(patch)
        .validate()?
        .filter(P::WorkspaceId.eq(workspace))
        .exec(&orm(db))
        .await?;
    Ok(Project::from_row(row.into()))
}

/// `deleteProject`: soft.
pub(crate) async fn delete_project(
    db: &PgPool,
    workspace: Option<&str>,
    project_id: &str,
) -> PassResult<()> {
    require_project(db, workspace, project_id).await?;
    let now = now();
    projects::Entity::update_many()
        .col_expr(P::DeletedAt, Expr::value(now))
        .col_expr(P::UpdatedAt, Expr::value(now))
        .filter(P::Id.eq(project_id))
        .filter(P::WorkspaceId.eq(workspace))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `openVault`: the project and its KEK, for one request.
pub(crate) async fn open_vault(
    db: &PgPool,
    workspace: Option<&str>,
    keyring: &RootKeyring,
    project_id: &str,
) -> PassResult<(Project, Key)> {
    let project = require_project(db, workspace, project_id).await?;
    let wrapped: Option<String> = projects::Entity::find()
        .select_only()
        .column(P::KekWrapped)
        .filter(P::Id.eq(project_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    let wrapped = wrapped.ok_or_else(|| PassError::not_found("project", project_id))?;
    let kek = unwrap_vault_key(keyring, &project.id, &wrapped)?;
    Ok((project, kek))
}

/// `listEnvironments`: by sort order, then name.
pub(crate) async fn list_environments(
    db: &PgPool,
    project_id: &str,
) -> PassResult<Vec<Environment>> {
    let rows = EnvironmentRow::select()
        .filter(E::ProjectId.eq(project_id))
        .filter(E::DeletedAt.is_null())
        .order_by_asc(E::SortOrder)
        .order_by_asc(E::Name)
        .into_model::<EnvironmentRow>()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().map(Environment::from_row).collect())
}

/// `requireEnvironment`: within a project the caller already resolved.
pub(crate) async fn require_environment(
    db: &PgPool,
    project_id: &str,
    environment_id: &str,
) -> PassResult<Environment> {
    let row = EnvironmentRow::select()
        .filter(E::Id.eq(environment_id))
        .filter(E::ProjectId.eq(project_id))
        .filter(E::DeletedAt.is_null())
        .into_model::<EnvironmentRow>()
        .one(&orm(db))
        .await?;
    row.map(Environment::from_row)
        .ok_or_else(|| PassError::not_found("environment", environment_id))
}

/// `createEnvironment`: placed after the existing ones.
pub(crate) async fn create_environment(
    db: &PgPool,
    project_id: &str,
    name: &str,
    slug: Option<&str>,
    is_production: Option<bool>,
) -> PassResult<Environment> {
    let existing = list_environments(db, project_id).await?;
    let row = environments::Entity::insert(environments::ActiveModel {
        id: Set(generate_id("wpe")),
        project_id: Set(project_id.to_owned()),
        name: Set(name.to_owned()),
        slug: Set(slugify(slug.unwrap_or(name))),
        is_production: Set(is_production.unwrap_or(false)),
        sort_order: Set(i32::try_from(existing.len()).unwrap_or(i32::MAX)),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    Ok(Environment::from_row(row.into()))
}

/// `updateEnvironment`: the fields given.
pub(crate) async fn update_environment(
    db: &PgPool,
    project_id: &str,
    environment_id: &str,
    name: Option<&str>,
    is_production: Option<bool>,
    sort_order: Option<i64>,
) -> PassResult<Environment> {
    require_environment(db, project_id, environment_id).await?;
    let mut patch = environments::ActiveModel {
        id: Unchanged(environment_id.to_owned()),
        ..Default::default()
    };
    if let Some(name) = name {
        patch.name = Set(name.to_owned());
    }
    if let Some(is_production) = is_production {
        patch.is_production = Set(is_production);
    }
    if let Some(sort_order) = sort_order {
        patch.sort_order = Set(int4(sort_order)?);
    }
    patch.updated_at = Set(now());
    let row = environments::Entity::update(patch)
        .validate()?
        .filter(E::ProjectId.eq(project_id))
        .exec(&orm(db))
        .await?;
    Ok(Environment::from_row(row.into()))
}

/// `deleteEnvironment`: soft-deletes its secrets, its sync targets, then it.
pub(crate) async fn delete_environment(
    db: &PgPool,
    project_id: &str,
    environment_id: &str,
) -> PassResult<()> {
    require_environment(db, project_id, environment_id).await?;
    let now = now();
    let db = orm(db);
    weldpass_secrets::Entity::update_many()
        .col_expr(weldpass_secrets::Column::DeletedAt, Expr::value(now))
        .col_expr(weldpass_secrets::Column::UpdatedAt, Expr::value(now))
        .filter(weldpass_secrets::Column::EnvironmentId.eq(environment_id))
        .filter(weldpass_secrets::Column::DeletedAt.is_null())
        .exec(&db)
        .await?;
    weldpass_sync_targets::Entity::update_many()
        .col_expr(weldpass_sync_targets::Column::DeletedAt, Expr::value(now))
        .col_expr(weldpass_sync_targets::Column::UpdatedAt, Expr::value(now))
        .filter(weldpass_sync_targets::Column::EnvironmentId.eq(environment_id))
        .filter(weldpass_sync_targets::Column::DeletedAt.is_null())
        .exec(&db)
        .await?;
    environments::Entity::update_many()
        .col_expr(E::DeletedAt, Expr::value(now))
        .col_expr(E::UpdatedAt, Expr::value(now))
        .filter(E::Id.eq(environment_id))
        .exec(&db)
        .await?;
    Ok(())
}
