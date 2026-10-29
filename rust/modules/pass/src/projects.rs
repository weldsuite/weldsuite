//! Vault projects and their environments (`services/weldpass/vault.ts`).
//! A project of another workspace is not found: an id from elsewhere reads
//! as 404, nothing is confirmed to exist.

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_kit::generate_id;

use crate::envelope::{Key, RootKeyring, create_vault_key, unwrap_vault_key};
use crate::schemas::slugify;
use crate::{PassError, PassResult, dated, now};

macro_rules! project_json {
    () => {
        "jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug, \
         'description', p.description, 'rootKeyVersion', p.root_key_version, \
         'createdBy', p.created_by, 'createdAt', p.created_at, 'updatedAt', p.updated_at)"
    };
}

macro_rules! environment_json {
    () => {
        "jsonb_build_object('id', e.id, 'projectId', e.project_id, 'name', e.name, \
         'slug', e.slug, 'isProduction', e.is_production, 'sortOrder', e.sort_order, \
         'createdAt', e.created_at, 'updatedAt', e.updated_at)"
    };
}

const TIMES: [&str; 2] = ["createdAt", "updatedAt"];

/// A project as the routes return it (`projectColumns`).
#[derive(Debug, Clone)]
pub(crate) struct Project {
    pub(crate) id: String,
    pub(crate) slug: String,
    pub(crate) json: Value,
}

impl Project {
    fn from_row(row: Value) -> Self {
        let row = dated(row, &TIMES);
        Self {
            id: row["id"].as_str().unwrap_or_default().to_owned(),
            slug: row["slug"].as_str().unwrap_or_default().to_owned(),
            json: row,
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
    fn from_row(row: Value) -> Self {
        let row = dated(row, &TIMES);
        Self {
            id: row["id"].as_str().unwrap_or_default().to_owned(),
            slug: row["slug"].as_str().unwrap_or_default().to_owned(),
            json: row,
        }
    }
}

/// `listProjects`: by name.
pub(crate) async fn list_projects(
    db: &PgPool,
    workspace: Option<&str>,
) -> PassResult<Vec<Project>> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        project_json!(),
        " from weldpass_projects p where p.workspace_id = $1 and p.deleted_at is null order by p.name asc"
    ))
    .bind(workspace)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Project::from_row).collect())
}

/// `findProjectBySlug`.
pub(crate) async fn find_project_by_slug(
    db: &PgPool,
    workspace: Option<&str>,
    slug: &str,
) -> PassResult<Option<Project>> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        project_json!(),
        " from weldpass_projects p where p.workspace_id = $1 and p.slug = $2 and p.deleted_at is null limit 1"
    ))
    .bind(workspace)
    .bind(slug)
    .fetch_optional(db)
    .await?;
    Ok(row.map(Project::from_row))
}

/// `requireProject`: in the caller's workspace, or a 404.
pub(crate) async fn require_project(
    db: &PgPool,
    workspace: Option<&str>,
    project_id: &str,
) -> PassResult<Project> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        project_json!(),
        " from weldpass_projects p where p.id = $1 and p.workspace_id = $2 and p.deleted_at is null limit 1"
    ))
    .bind(project_id)
    .bind(workspace)
    .fetch_optional(db)
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
    let project: Value = sqlx::query_scalar(concat!(
        "with p as (insert into weldpass_projects \
         (id, workspace_id, name, slug, description, kek_wrapped, root_key_version, created_by) \
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *) select ",
        project_json!(),
        " from p"
    ))
    .bind(&id)
    .bind(workspace)
    .bind(name)
    .bind(&slug)
    .bind(description)
    .bind(&key.kek_wrapped)
    .bind(key.root_key_version)
    .bind(created_by)
    .fetch_one(db)
    .await?;

    let ids: Vec<String> = DEFAULT_ENVIRONMENTS
        .iter()
        .map(|_| generate_id("wpe"))
        .collect();
    let names: Vec<&str> = DEFAULT_ENVIRONMENTS.iter().map(|e| e.0).collect();
    let slugs: Vec<&str> = DEFAULT_ENVIRONMENTS.iter().map(|e| e.1).collect();
    let production: Vec<bool> = DEFAULT_ENVIRONMENTS.iter().map(|e| e.2).collect();
    let order: Vec<i32> = DEFAULT_ENVIRONMENTS.iter().map(|e| e.3).collect();
    let environments: Vec<Value> = sqlx::query_scalar(concat!(
        "with e as (insert into weldpass_environments (id, project_id, name, slug, is_production, sort_order) \
         select u.id, $2, u.name, u.slug, u.is_production, u.sort_order \
         from unnest($1::varchar[], $3::varchar[], $4::varchar[], $5::boolean[], $6::integer[]) with ordinality \
         as u(id, name, slug, is_production, sort_order, n) order by u.n returning *) select ",
        environment_json!(),
        " from e"
    ))
    .bind(&ids)
    .bind(&id)
    .bind(&names)
    .bind(&slugs)
    .bind(&production)
    .bind(&order)
    .fetch_all(db)
    .await?;
    Ok((
        Project::from_row(project),
        environments
            .into_iter()
            .map(Environment::from_row)
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
    let row: Value = sqlx::query_scalar(concat!(
        "with p as (update weldpass_projects set \
         name = coalesce($3, name), \
         description = case when $4 then $5 else description end, \
         updated_at = $6::timestamptz \
         where id = $1 and workspace_id = $2 returning *) select ",
        project_json!(),
        " from p"
    ))
    .bind(project_id)
    .bind(workspace)
    .bind(name)
    .bind(description.is_some())
    .bind(description.flatten())
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(Project::from_row(row))
}

/// `deleteProject`: soft.
pub(crate) async fn delete_project(
    db: &PgPool,
    workspace: Option<&str>,
    project_id: &str,
) -> PassResult<()> {
    require_project(db, workspace, project_id).await?;
    let now = now();
    sqlx::query(
        "update weldpass_projects set deleted_at = $3::timestamptz, updated_at = $3::timestamptz \
         where id = $1 and workspace_id = $2",
    )
    .bind(project_id)
    .bind(workspace)
    .bind(&now)
    .execute(db)
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
    let wrapped: Option<String> =
        sqlx::query_scalar("select kek_wrapped from weldpass_projects where id = $1 limit 1")
            .bind(project_id)
            .fetch_optional(db)
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
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        environment_json!(),
        " from weldpass_environments e where e.project_id = $1 and e.deleted_at is null \
         order by e.sort_order asc, e.name asc"
    ))
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Environment::from_row).collect())
}

/// `requireEnvironment`: within a project the caller already resolved.
pub(crate) async fn require_environment(
    db: &PgPool,
    project_id: &str,
    environment_id: &str,
) -> PassResult<Environment> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        environment_json!(),
        " from weldpass_environments e where e.id = $1 and e.project_id = $2 and e.deleted_at is null limit 1"
    ))
    .bind(environment_id)
    .bind(project_id)
    .fetch_optional(db)
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
    let row: Value = sqlx::query_scalar(concat!(
        "with e as (insert into weldpass_environments (id, project_id, name, slug, is_production, sort_order) \
         values ($1, $2, $3, $4, $5, $6) returning *) select ",
        environment_json!(),
        " from e"
    ))
    .bind(generate_id("wpe"))
    .bind(project_id)
    .bind(name)
    .bind(slugify(slug.unwrap_or(name)))
    .bind(is_production.unwrap_or(false))
    .bind(i32::try_from(existing.len()).unwrap_or(i32::MAX))
    .fetch_one(db)
    .await?;
    Ok(Environment::from_row(row))
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
    let row: Value = sqlx::query_scalar(concat!(
        "with e as (update weldpass_environments set \
         name = coalesce($3, name), is_production = coalesce($4, is_production), \
         sort_order = coalesce($5::integer, sort_order), updated_at = $6::timestamptz \
         where id = $1 and project_id = $2 returning *) select ",
        environment_json!(),
        " from e"
    ))
    .bind(environment_id)
    .bind(project_id)
    .bind(name)
    .bind(is_production)
    .bind(sort_order)
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(Environment::from_row(row))
}

/// `deleteEnvironment`: soft-deletes its secrets, its sync targets, then it.
pub(crate) async fn delete_environment(
    db: &PgPool,
    project_id: &str,
    environment_id: &str,
) -> PassResult<()> {
    require_environment(db, project_id, environment_id).await?;
    let now = now();
    sqlx::query(
        "update weldpass_secrets set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
         where environment_id = $1 and deleted_at is null",
    )
    .bind(environment_id)
    .bind(&now)
    .execute(db)
    .await?;
    sqlx::query(
        "update weldpass_sync_targets set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
         where environment_id = $1 and deleted_at is null",
    )
    .bind(environment_id)
    .bind(&now)
    .execute(db)
    .await?;
    sqlx::query(
        "update weldpass_environments set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
         where id = $1",
    )
    .bind(environment_id)
    .bind(&now)
    .execute(db)
    .await?;
    Ok(())
}
