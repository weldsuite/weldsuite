//! Global, the side the move reads: its master database (with read-only
//! credentials), the keys its sealed values open with, and the way to each
//! workspace's Neon database.

use std::str::FromStr as _;
use std::time::Duration;

use sea_orm::ExprTrait as _;
use sea_orm::sea_query::Expr;
use sea_orm::{EntityTrait, FromQueryResult, QueryOrder, QuerySelect};
use sqlx::postgres::PgConnectOptions;
use sqlx::{ConnectOptions as _, PgConnection, PgPool};
use weldsuite_db::{Keyring, decrypt_workspace_database_url, orm, resolve_database_url};
use weldsuite_schema::master::{plans, workspaces};

use crate::ImportError;

/// How long connecting to a Global database may take (a suspended Neon
/// compute wakes in a few seconds).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);

const NEON_API: &str = "https://console.neon.tech/api/v2";

/// Global's master database and keys.
#[derive(Debug, Clone)]
pub struct Global {
    master: PgPool,
    keyring: Keyring,
    neon_api_key: Option<String>,
    http: reqwest::Client,
}

/// Where a Global workspace's database is, as its master row records it.
#[derive(Clone, PartialEq, Eq)]
pub struct SourceDatabase {
    /// `database_url`: sealed (v1, v2, v3) or plain.
    stored_url: Option<String>,
    neon_project_id: Option<String>,
    neon_branch_id: Option<String>,
    neon_role_name: Option<String>,
    neon_database_name: Option<String>,
}

impl std::fmt::Debug for SourceDatabase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourceDatabase")
            .field("stored_url", &self.stored_url.as_ref().map(|_| "<set>"))
            .field("neon_project_id", &self.neon_project_id)
            .field("neon_branch_id", &self.neon_branch_id)
            .field("neon_role_name", &self.neon_role_name)
            .field("neon_database_name", &self.neon_database_name)
            .finish()
    }
}

impl SourceDatabase {
    /// A database reached by a plain connection string, as a Global row may
    /// store it (and as tests point at a scratch database).
    pub fn plain(url: String) -> Self {
        Self {
            stored_url: Some(url),
            neon_project_id: None,
            neon_branch_id: None,
            neon_role_name: None,
            neon_database_name: None,
        }
    }

    pub fn neon_project_id(&self) -> Option<&str> {
        self.neon_project_id.as_deref()
    }

    pub fn neon_branch_id(&self) -> Option<&str> {
        self.neon_branch_id.as_deref()
    }

    pub fn neon_role_name(&self) -> Option<&str> {
        self.neon_role_name.as_deref()
    }

    pub fn neon_database_name(&self) -> Option<&str> {
        self.neon_database_name.as_deref()
    }

    /// Whether `keyring` opens the stored `database_url`; `None` when what is
    /// stored isn't sealed (plain, or nothing).
    pub fn opens_with(&self, workspace_id: &str, keyring: &Keyring) -> Option<bool> {
        let stored = self.stored_url.as_deref()?;
        if stored.starts_with("postgres://") || stored.starts_with("postgresql://") {
            return None;
        }
        Some(decrypt_workspace_database_url(stored, workspace_id, keyring).is_ok())
    }

    /// Enough for Neon's API to name the connection.
    fn neon_meta(&self) -> Option<(&str, &str, &str)> {
        Some((
            self.neon_project_id.as_deref()?,
            self.neon_branch_id.as_deref()?,
            self.neon_role_name.as_deref()?,
        ))
    }
}

/// One workspace in Global's master database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalWorkspace {
    /// `workspaces.id` (`ws_…`), kept on the install.
    pub id: String,
    /// The Clerk organization id, kept too: storage keys and several
    /// registries are keyed by it.
    pub clerk_org_id: Option<String>,
    pub slug: String,
    pub name: String,
    pub plan_id: Option<String>,
    pub partner_id: Option<String>,
    pub is_active: bool,
    pub deleted: bool,
    /// `None`: the row records no database at all.
    pub database: Option<SourceDatabase>,
}

impl GlobalWorkspace {
    /// What rows may name the workspace by: its id and its organization id.
    pub fn references(&self) -> Vec<String> {
        let mut refs = vec![self.id.clone()];
        if let Some(org) = &self.clerk_org_id
            && org != &self.id
        {
            refs.push(org.clone());
        }
        refs
    }

    /// Does `reference` (an id, organization id or slug) name this workspace?
    pub fn is(&self, reference: &str) -> bool {
        self.id == reference
            || self.slug == reference
            || self.clerk_org_id.as_deref() == Some(reference)
    }
}

#[derive(Debug, FromQueryResult)]
struct WorkspaceRow {
    id: String,
    clerk_org_id: Option<String>,
    name: String,
    slug: String,
    plan_id: Option<String>,
    partner_id: Option<String>,
    is_active: bool,
    deleted: bool,
    database_url: Option<String>,
    neon_project_id: Option<String>,
    neon_branch_id: Option<String>,
    neon_role_name: Option<String>,
    neon_database_name: Option<String>,
}

impl From<WorkspaceRow> for GlobalWorkspace {
    fn from(row: WorkspaceRow) -> Self {
        let database = SourceDatabase {
            stored_url: row.database_url,
            neon_project_id: row.neon_project_id,
            neon_branch_id: row.neon_branch_id,
            neon_role_name: row.neon_role_name,
            neon_database_name: row.neon_database_name,
        };
        let has_database = database.stored_url.is_some() || database.neon_meta().is_some();
        Self {
            id: row.id,
            clerk_org_id: row.clerk_org_id,
            slug: row.slug,
            name: row.name,
            plan_id: row.plan_id,
            partner_id: row.partner_id,
            is_active: row.is_active,
            deleted: row.deleted,
            database: has_database.then_some(database),
        }
    }
}

/// A plan as both sides name it: id and slug.
#[derive(Debug, Clone, PartialEq, Eq, FromQueryResult)]
pub struct PlanName {
    pub id: String,
    pub slug: String,
}

/// Every plan of a master database, by id and slug.
pub async fn plan_names(master: &PgPool) -> Result<Vec<PlanName>, ImportError> {
    plans::Entity::find()
        .select_only()
        .columns([plans::Column::Id, plans::Column::Slug])
        .order_by_asc(plans::Column::Slug)
        .into_model::<PlanName>()
        .all(&orm(master))
        .await
        .map_err(|error| ImportError::failed("reading the plans", error))
}

impl Global {
    /// `keyring` opens Global's sealed `database_url` values; `neon_api_key`
    /// finds the connection of a row that has no `database_url`.
    pub fn new(master: PgPool, keyring: Keyring, neon_api_key: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Self {
            master,
            keyring,
            neon_api_key,
            http,
        }
    }

    pub fn master(&self) -> &PgPool {
        &self.master
    }

    pub fn keyring(&self) -> &Keyring {
        &self.keyring
    }

    /// Every workspace row, deleted ones included, by slug. Only columns
    /// Global's master has had since before the flip are read: it stays at
    /// master migration 0072 (ADR DATA-019).
    pub async fn workspaces(&self) -> Result<Vec<GlobalWorkspace>, ImportError> {
        use workspaces::Column;
        let rows = workspaces::Entity::find()
            .select_only()
            .columns([
                Column::Id,
                Column::ClerkOrgId,
                Column::Name,
                Column::Slug,
                Column::PlanId,
                Column::PartnerId,
                Column::IsActive,
                Column::DatabaseUrl,
                Column::NeonProjectId,
                Column::NeonBranchId,
                Column::NeonRoleName,
                Column::NeonDatabaseName,
            ])
            .column_as(Expr::col(Column::DeletedAt).is_not_null(), "deleted")
            .order_by_asc(Column::Slug)
            .into_model::<WorkspaceRow>()
            .all(&orm(&self.master))
            .await
            .map_err(|error| ImportError::failed("reading Global's workspaces", error))?;
        Ok(rows.into_iter().map(GlobalWorkspace::from).collect())
    }

    /// The connection string of a workspace's Global database: its
    /// `database_url` opened with Global's keys, else asked of Neon's API
    /// (the direct endpoint, not the pooler: the copy holds one long
    /// transaction).
    pub async fn database_url(&self, workspace: &GlobalWorkspace) -> Result<String, ImportError> {
        let Some(database) = &workspace.database else {
            return Err(ImportError::refused(format!(
                "{} has no database on Global",
                workspace.id
            )));
        };
        if let Some(stored) = &database.stored_url {
            return resolve_database_url(stored, &workspace.id, &self.keyring).map_err(|error| {
                ImportError::refused(format!(
                    "{}: Global's database_url does not open ({error}); set GLOBAL_DATABASE_ENCRYPTION_KEY \
                     and GLOBAL_DATABASE_ENCRYPTION_KEY_V2 to Global's keys",
                    workspace.id
                ))
            });
        }
        let Some((project, branch, role)) = database.neon_meta() else {
            return Err(ImportError::refused(format!(
                "{} has no database_url and no Neon placement on Global",
                workspace.id
            )));
        };
        let Some(key) = &self.neon_api_key else {
            return Err(ImportError::refused(format!(
                "{} has no database_url on Global: set GLOBAL_NEON_API_KEY so Neon's API can name its connection",
                workspace.id
            )));
        };
        let url = reqwest::Url::parse_with_params(
            &format!("{NEON_API}/projects/{project}/connection_uri"),
            &[
                ("branch_id", branch),
                ("role_name", role),
                (
                    "database_name",
                    database.neon_database_name().unwrap_or("neondb"),
                ),
                ("pooled", "false"),
            ],
        )
        .map_err(|error| ImportError::failed("Neon's API address", error))?;
        let response = self
            .http
            .get(url)
            .bearer_auth(key)
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|error| ImportError::failed("Neon's API", error))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| ImportError::failed("Neon's API", error))?;
        if !status.is_success() {
            return Err(ImportError::Failed(format!(
                "{}: Neon's API answered {status}",
                workspace.id
            )));
        }
        serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| value.get("uri")?.as_str().map(str::to_owned))
            .ok_or_else(|| {
                ImportError::Failed(format!(
                    "{}: Neon's API answered without a uri",
                    workspace.id
                ))
            })
    }

    /// One connection to a workspace's Global database.
    pub async fn connect(&self, workspace: &GlobalWorkspace) -> Result<PgConnection, ImportError> {
        let url = self.database_url(workspace).await?;
        connect(&url, &format!("{}'s Global database", workspace.id)).await
    }
}

/// A small pool on Global's master (`GLOBAL_DATABASE_URL_MASTER`): no
/// statement cache (Neon's pooler may sit in front), and time for a
/// suspended compute to wake.
pub fn master_pool(url: &str) -> Result<PgPool, ImportError> {
    let options = PgConnectOptions::from_str(url)
        .map_err(|error| ImportError::failed("GLOBAL_DATABASE_URL_MASTER", error))?
        .statement_cache_capacity(0)
        .application_name("weldsuite admin import-global");
    Ok(sqlx::postgres::PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(CONNECT_TIMEOUT)
        .connect_lazy_with(options))
}

/// One connection to `url`, with no statement cache (a transaction-mode
/// pooler may sit in front) and a bounded wait.
pub(crate) async fn connect(url: &str, what: &str) -> Result<PgConnection, ImportError> {
    let options = PgConnectOptions::from_str(url)
        .map_err(|error| ImportError::failed(&format!("{what}: the address"), error))?
        .statement_cache_capacity(0)
        .application_name("weldsuite admin import-global");
    tokio::time::timeout(CONNECT_TIMEOUT, options.connect())
        .await
        .map_err(|_| ImportError::Failed(format!("{what}: no answer within 60 seconds")))?
        .map_err(|error| ImportError::failed(&format!("connecting to {what}"), error))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(id: &str, org: Option<&str>) -> GlobalWorkspace {
        GlobalWorkspace {
            id: id.to_owned(),
            clerk_org_id: org.map(str::to_owned),
            slug: "acme".to_owned(),
            name: "Acme".to_owned(),
            plan_id: None,
            partner_id: None,
            is_active: true,
            deleted: false,
            database: None,
        }
    }

    #[test]
    fn a_workspace_is_named_by_its_id_organization_or_slug() {
        let acme = workspace("ws_1", Some("org_1"));
        assert_eq!(acme.references(), ["ws_1", "org_1"]);
        assert!(acme.is("ws_1") && acme.is("org_1") && acme.is("acme"));
        assert!(!acme.is("ws_2"));
        assert_eq!(workspace("ws_1", None).references(), ["ws_1"]);
        assert_eq!(workspace("ws_1", Some("ws_1")).references(), ["ws_1"]);
    }

    #[test]
    fn a_row_without_url_or_neon_placement_has_no_database() {
        let row = |url: Option<&str>, project: Option<&str>| WorkspaceRow {
            id: "ws_1".to_owned(),
            clerk_org_id: None,
            name: "A".to_owned(),
            slug: "a".to_owned(),
            plan_id: None,
            partner_id: None,
            is_active: true,
            deleted: false,
            database_url: url.map(str::to_owned),
            neon_project_id: project.map(str::to_owned),
            neon_branch_id: project.map(|_| "br".to_owned()),
            neon_role_name: project.map(|_| "role".to_owned()),
            neon_database_name: None,
        };
        assert!(GlobalWorkspace::from(row(None, None)).database.is_none());
        assert!(
            GlobalWorkspace::from(row(Some("v2:aa:bb"), None))
                .database
                .is_some()
        );
        assert!(
            GlobalWorkspace::from(row(None, Some("p")))
                .database
                .is_some()
        );
    }
}
