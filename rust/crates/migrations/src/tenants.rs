//! Every tenant database, as `apps/tools/migrate-databases` finds and
//! migrates them (`getWorkspaces`, `runMigrations`).

use std::fmt;
use std::sync::{Arc, LazyLock};

use regex::Regex;
use sqlx::PgConnection;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use weldsuite_db::{Keyring, resolve_database_url};

use crate::apply::{DatabaseOptions, DatabaseOutcome, migrate_database};
use crate::journal::Journal;

/// Database move statuses during which the old database is locked on
/// purpose (`ACTIVE_DATABASE_MOVE_STATUSES`): such a workspace is skipped,
/// not failed, and migrated by the next run wherever it lives by then.
pub const ACTIVE_DATABASE_MOVE_STATUSES: [&str; 8] = [
    "queued",
    "preparing",
    "soft_locked",
    "locked",
    "copying",
    "verifying",
    "switching",
    "cancelling",
];

/// A workspace, by id and name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRef {
    pub id: String,
    pub name: String,
}

/// A tenant database to migrate. The URL holds the role's password, so
/// `Debug` leaves it out.
#[derive(Clone)]
pub struct TenantDatabase {
    pub workspace: WorkspaceRef,
    database_url: String,
}

impl fmt::Debug for TenantDatabase {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TenantDatabase")
            .field("workspace", &self.workspace)
            .finish_non_exhaustive()
    }
}

impl TenantDatabase {
    pub fn new(workspace: WorkspaceRef, database_url: String) -> Self {
        Self {
            workspace,
            database_url,
        }
    }

    pub fn database_url(&self) -> &str {
        &self.database_url
    }

    /// The URL with its password replaced by `****` (`maskDatabaseUrl`).
    pub fn masked_url(&self) -> String {
        mask_database_url(&self.database_url)
    }
}

/// The workspaces a run covers.
#[derive(Debug, Default)]
pub struct TenantList {
    /// Their databases, in the master's order.
    pub databases: Vec<TenantDatabase>,
    /// Left out because a database move owns their database right now.
    pub moving: Vec<WorkspaceRef>,
    /// Placed (a project or shard is recorded) but without a stored URL:
    /// a database still being provisioned, which migrates itself. The
    /// TypeScript runner resolves these through the Neon API instead; the
    /// Kubernetes editions have no such fallback.
    pub without_url: Vec<WorkspaceRef>,
    /// A stored URL that would not open (wrong key, sealed for another row):
    /// each counts as a failed workspace.
    pub unresolvable: Vec<(WorkspaceRef, String)>,
}

#[derive(sqlx::FromRow)]
struct WorkspaceRow {
    id: String,
    name: String,
    database_url: Option<String>,
}

/// The active, placed workspaces (`is_active` and a `neon_project_id`, the
/// recorded placement on either edition), or only `only` (a `workspaces.id`),
/// with their URLs opened.
pub async fn list_tenants(
    master: &mut PgConnection,
    keyring: &Keyring,
    only: Option<&str>,
) -> Result<TenantList, sqlx::Error> {
    let rows: Vec<WorkspaceRow> = sqlx::query_as(
        "select id, name, database_url from workspaces
         where is_active = true and neon_project_id is not null
           and ($1::text is null or id = $1)",
    )
    .bind(only)
    .fetch_all(&mut *master)
    .await?;

    let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
    let moving: Vec<String> = if ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar(
            "select workspace_id from workspace_database_moves
             where workspace_id = any($1) and status = any($2)",
        )
        .bind(&ids)
        .bind(&ACTIVE_DATABASE_MOVE_STATUSES[..])
        .fetch_all(&mut *master)
        .await?
    };

    let mut list = TenantList::default();
    for row in rows {
        let workspace = WorkspaceRef {
            id: row.id,
            name: row.name,
        };
        if moving.contains(&workspace.id) {
            list.moving.push(workspace);
            continue;
        }
        let Some(stored) = row.database_url.filter(|url| !url.is_empty()) else {
            list.without_url.push(workspace);
            continue;
        };
        match resolve_database_url(&stored, &workspace.id, keyring) {
            Ok(url) => list.databases.push(TenantDatabase::new(workspace, url)),
            Err(error) => list.unresolvable.push((
                workspace,
                format!("cannot open the stored database URL: {error}"),
            )),
        }
    }
    Ok(list)
}

/// One workspace after [`migrate_tenants`].
#[derive(Debug, Clone)]
pub struct TenantResult {
    pub workspace: WorkspaceRef,
    /// What was applied, or why it failed (the database is as it was).
    pub outcome: Result<DatabaseOutcome, String>,
}

/// Migrate `databases`, `concurrency` at a time (the TypeScript runner does
/// one at a time, which is `1`). `on_result` sees each result as it
/// completes, with the database's position in `databases`; the returned
/// results are in that order. One failure never stops the others.
pub async fn migrate_tenants(
    databases: Vec<TenantDatabase>,
    journal: &'static Journal,
    options: DatabaseOptions,
    concurrency: usize,
    mut on_result: impl FnMut(usize, &TenantResult),
) -> Vec<TenantResult> {
    let permits = Arc::new(Semaphore::new(concurrency.max(1)));
    let mut tasks = JoinSet::new();
    let mut slots: Vec<Option<TenantResult>> = vec![None; databases.len()];
    let workspaces: Vec<WorkspaceRef> = databases.iter().map(|db| db.workspace.clone()).collect();

    for (index, database) in databases.into_iter().enumerate() {
        let permits = Arc::clone(&permits);
        tasks.spawn(async move {
            let _permit = permits.acquire_owned().await;
            let outcome = migrate_database(database.database_url(), journal, options)
                .await
                .map_err(|error| error.to_string());
            (index, outcome)
        });
    }

    while let Some(joined) = tasks.join_next().await {
        // A task only ends without a result when it panicked; the slot left
        // empty is reported below.
        let Ok((index, outcome)) = joined else {
            continue;
        };
        let result = TenantResult {
            workspace: workspaces[index].clone(),
            outcome,
        };
        on_result(index, &result);
        slots[index] = Some(result);
    }

    slots
        .into_iter()
        .zip(workspaces)
        .enumerate()
        .map(|(index, (slot, workspace))| {
            slot.unwrap_or_else(|| {
                let result = TenantResult {
                    workspace,
                    outcome: Err("the migration task stopped unexpectedly".to_owned()),
                };
                on_result(index, &result);
                result
            })
        })
        .collect()
}

/// A URL with its password replaced by `****` (`maskDatabaseUrl`).
pub fn mask_database_url(url: &str) -> String {
    static PASSWORD: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r":([^:@/]+)@").expect("valid pattern"));
    PASSWORD.replace(url, ":****@").into_owned()
}

/// A driver or Postgres message with anything that identifies a tenant
/// replaced (`sanitizeMessage`): connection strings, Neon hosts, Clerk
/// organization ids, and on top of the TypeScript patterns the `ws_…`
/// workspace ids and database names the Kubernetes editions use.
pub fn redact(message: &str) -> String {
    static PATTERNS: LazyLock<[(Regex, &str); 4]> = LazyLock::new(|| {
        [
            // Spelled out in ASCII: the regex build has no Unicode tables
            // for `(?i)`, `\w`, `\s` or a Unicode `\b`.
            (
                r"[Pp][Oo][Ss][Tt][Gg][Rr][Ee][Ss](?:[Qq][Ll])?://[^ \t\r\n]+",
                "<redacted-connection-string>",
            ),
            (
                r"(?-u:\b)[A-Za-z0-9_.-]+\.[Nn][Ee][Oo][Nn]\.[Tt][Ee][Cc][Hh](?-u:\b)",
                "<redacted-host>",
            ),
            (r"(?-u:\b)org_[A-Za-z0-9]+", "<redacted-workspace-id>"),
            (
                r"(?-u:\b)(?:role_)?ws_[A-Za-z0-9_]+",
                "<redacted-workspace-id>",
            ),
        ]
        .map(|(pattern, replacement)| (Regex::new(pattern).expect("valid pattern"), replacement))
    });
    PATTERNS
        .iter()
        .fold(message.to_owned(), |text, (pattern, replacement)| {
            pattern.replace_all(&text, *replacement).into_owned()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_the_password_only() {
        assert_eq!(
            mask_database_url(
                "postgres://role_ws_1:s3cret@tenants-1-pooler.postgres.svc:5432/ws_ws_1"
            ),
            "postgres://role_ws_1:****@tenants-1-pooler.postgres.svc:5432/ws_ws_1"
        );
    }

    #[test]
    fn redacts_what_identifies_a_tenant() {
        assert_eq!(
            redact(
                "connect postgres://u:p@ep-1.neon.tech/db failed for org_2abc on ep-2.eu.neon.tech: \
                 database \"ws_ws_9x\" (role_ws_9x) does not exist"
            ),
            "connect <redacted-connection-string> failed for <redacted-workspace-id> on <redacted-host>: \
             database \"<redacted-workspace-id>\" (<redacted-workspace-id>) does not exist"
        );
    }
}
