//! Which workspaces move ([`select`]), and everything that would stop or
//! spoil the move, read from both sides with nothing written ([`check`]).

use std::collections::{BTreeMap, BTreeSet};

use sea_orm::ExprTrait as _;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ColumnTrait, Condition, EntityTrait, QueryFilter, QuerySelect};
use serde::Serialize;
use sqlx::PgPool;
use weldsuite_db::{Keyring, orm};
use weldsuite_schema::master::enums::NeonSharedProjectStatus;
use weldsuite_schema::master::{neon_shared_projects, users, workspaces};

use crate::global::{Global, GlobalWorkspace};
use crate::master::{self, PlanMap, Rule};
use crate::{ImportError, sql, tenant};

/// A Global workspace that doesn't move, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Staying {
    pub id: String,
    pub slug: String,
    pub reason: String,
}

/// The workspaces a step works on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Selection {
    pub moving: Vec<GlobalWorkspace>,
    pub staying: Vec<Staying>,
}

/// Every live Global workspace with a database moves, or the ones
/// `requested` names (by id, slug or organization id). A deleted workspace
/// stays, and so does one without a database (nothing in it to move: it
/// can be made again on the install). A name that matches nothing is an
/// error.
pub fn select(all: Vec<GlobalWorkspace>, requested: &[String]) -> Result<Selection, ImportError> {
    let unknown: Vec<&String> = requested
        .iter()
        .filter(|reference| !all.iter().any(|ws| ws.is(reference)))
        .collect();
    if !unknown.is_empty() {
        return Err(ImportError::refused(format!(
            "no Global workspace is named {}",
            unknown
                .iter()
                .map(|reference| reference.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    let mut selection = Selection::default();
    for workspace in all {
        if !requested.is_empty() && !requested.iter().any(|reference| workspace.is(reference)) {
            continue;
        }
        let reason = if workspace.deleted {
            Some("deleted on Global")
        } else if workspace.database.is_none() {
            Some("no database on Global")
        } else {
            None
        };
        match reason {
            Some(reason) => selection.staying.push(Staying {
                id: workspace.id,
                slug: workspace.slug,
                reason: reason.to_owned(),
            }),
            None => selection.moving.push(workspace),
        }
    }
    Ok(selection)
}

/// The install's row of a moving workspace, as the check sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnInstall {
    /// `provisioning_status`: `provisioning` once the master rows are in,
    /// `ready` once the database is.
    pub status: String,
}

/// One moving workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCheck {
    pub id: String,
    pub slug: String,
    /// The install's plan it gets.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// Already on the install from an earlier run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_install: Option<OnInstall>,
    /// The newest tenant migration its Global database has.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    /// Older migrations its database skipped, applied after the copy.
    pub gaps: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<i64>,
    /// What stops this workspace's move.
    pub problems: Vec<String>,
    pub warnings: Vec<String>,
}

/// What [`check`] found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckReport {
    pub moving: Vec<WorkspaceCheck>,
    pub staying: Vec<Staying>,
    /// Global master tables that don't move, and why.
    pub skipped_tables: Vec<(String, String)>,
    /// What stops the whole move.
    pub problems: Vec<String>,
    pub warnings: Vec<String>,
}

impl CheckReport {
    /// Nothing stops the move.
    pub fn ok(&self) -> bool {
        self.problems.is_empty() && self.moving.iter().all(|ws| ws.problems.is_empty())
    }
}

/// How [`check`] runs.
#[derive(Debug, Clone, Copy)]
pub struct CheckOptions<'a> {
    pub plans: &'a PlanMap,
    /// The install's own keys: whether they open what Global sealed.
    pub install_keyring: &'a Keyring,
    /// Connect to every moving workspace's Global database (wakes each
    /// Neon compute once) for its migration level and size.
    pub probe_tenants: bool,
}

#[derive(Debug, sea_orm::FromQueryResult)]
struct InstallWorkspace {
    id: String,
    slug: String,
    clerk_org_id: Option<String>,
    provisioning_status: String,
}

/// Read both sides and report (see the module docs). Fails only when a
/// side can't be read at all.
pub async fn check(
    global: &Global,
    install: &PgPool,
    selection: &Selection,
    options: CheckOptions<'_>,
) -> Result<CheckReport, ImportError> {
    let mut report = CheckReport {
        moving: Vec::new(),
        staying: selection.staying.clone(),
        skipped_tables: Vec::new(),
        problems: Vec::new(),
        warnings: Vec::new(),
    };
    tables(global, install, &mut report).await?;

    let existing = install_workspaces(install, &selection.moving).await?;
    let mut install_keys_differ = false;
    for workspace in &selection.moving {
        let mut entry = WorkspaceCheck {
            id: workspace.id.clone(),
            slug: workspace.slug.clone(),
            plan: None,
            on_install: None,
            level: None,
            gaps: 0,
            bytes: None,
            problems: Vec::new(),
            warnings: Vec::new(),
        };
        for row in &existing {
            if row.id == workspace.id {
                entry.on_install = Some(OnInstall {
                    status: row.provisioning_status.clone(),
                });
            } else if row.slug == workspace.slug {
                entry.problems.push(format!(
                    "the slug {} is taken on this install by {}",
                    workspace.slug, row.id
                ));
            } else if row.clerk_org_id.is_some() && row.clerk_org_id == workspace.clerk_org_id {
                entry.problems.push(format!(
                    "the organization id is taken on this install by {}",
                    row.id
                ));
            }
        }
        if let Some(plan) = &workspace.plan_id {
            entry.plan = options.plans.get(plan).map(str::to_owned);
            if entry.plan.is_none() {
                let slug = options.plans.unmapped_slug(plan).unwrap_or(plan);
                entry.problems.push(format!(
                    "Global's plan {slug} has no counterpart here: --plan {slug}=<install plan>"
                ));
            }
        }
        if workspace.partner_id.is_some() {
            entry
                .warnings
                .push("billed through a partner on Global: moves as a direct customer".to_owned());
        }
        if let Some(database) = &workspace.database {
            if database.opens_with(&workspace.id, global.keyring()) == Some(false) {
                entry.problems.push(
                    "Global's keys don't open its database_url: set GLOBAL_DATABASE_ENCRYPTION_KEY(_V2)"
                        .to_owned(),
                );
            }
            if database.opens_with(&workspace.id, options.install_keyring) == Some(false) {
                install_keys_differ = true;
            }
        }
        if options.probe_tenants && entry.problems.is_empty() {
            probe(global, workspace, &mut entry).await;
        }
        report.moving.push(entry);
    }
    if install_keys_differ {
        report.warnings.push(
            "this install's DATABASE_ENCRYPTION_KEY(_V2) differ from Global's: values Global sealed \
             in the moved databases (integration tokens, mailbox passwords) won't open here until \
             the install runs with Global's keys (OPS-025, \"the same encryption keys\")"
                .to_owned(),
        );
    }
    if let Some(warning) = capacity(install, &report).await? {
        report.warnings.push(warning);
    }
    let refs: Vec<String> = selection
        .moving
        .iter()
        .flat_map(GlobalWorkspace::references)
        .collect();
    invitations(global, &refs, &mut report).await?;
    same_email(global, install, &refs, &mut report).await?;
    Ok(report)
}

/// Global master tables with no rule, or that the install lacks.
async fn tables(
    global: &Global,
    install: &PgPool,
    report: &mut CheckReport,
) -> Result<(), ImportError> {
    let mut source = global
        .master()
        .acquire()
        .await
        .map_err(|error| ImportError::failed("connecting to Global's master", error))?;
    let mut target = install
        .acquire()
        .await
        .map_err(|error| ImportError::failed("connecting to this install's master", error))?;
    let global_tables = sql::tables(&mut source)
        .await
        .map_err(|error| ImportError::failed("reading Global's master tables", error))?;
    let install_tables = sql::tables(&mut target)
        .await
        .map_err(|error| ImportError::failed("reading this install's master tables", error))?;
    let unknown = master::unclassified(global_tables.keys());
    if !unknown.is_empty() {
        report.problems.push(format!(
            "Global's master has tables the move has no rule for (add them to master::TABLES): {}",
            unknown.join(", ")
        ));
    }
    for (table, columns) in &global_tables {
        match master::rule(table) {
            Some(Rule::Skip(reason)) => report
                .skipped_tables
                .push((table.clone(), reason.to_owned())),
            Some(Rule::Copy(_)) => match install_tables.get(table) {
                None => report.problems.push(format!(
                    "Global's master table {table} is not on this install"
                )),
                Some(install_columns) => {
                    let dropped: Vec<&String> = columns
                        .iter()
                        .filter(|column| !install_columns.contains(column))
                        .collect();
                    if !dropped.is_empty() {
                        report.warnings.push(format!(
                            "{table}: Global's columns {dropped:?} are not on this install and aren't copied"
                        ));
                    }
                }
            },
            None => {}
        }
    }
    Ok(())
}

/// Install workspaces that share an id, slug or organization id with a
/// moving one.
async fn install_workspaces(
    install: &PgPool,
    moving: &[GlobalWorkspace],
) -> Result<Vec<InstallWorkspace>, ImportError> {
    use workspaces::Column;
    if moving.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<&str> = moving.iter().map(|ws| ws.id.as_str()).collect();
    let slugs: Vec<&str> = moving.iter().map(|ws| ws.slug.as_str()).collect();
    let orgs: Vec<&str> = moving
        .iter()
        .filter_map(|ws| ws.clerk_org_id.as_deref())
        .collect();
    workspaces::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::Slug,
            Column::ClerkOrgId,
            Column::ProvisioningStatus,
        ])
        .filter(
            Condition::any()
                .add(Column::Id.is_in(ids))
                .add(Column::Slug.is_in(slugs))
                .add(Column::ClerkOrgId.is_in(orgs)),
        )
        .into_model::<InstallWorkspace>()
        .all(&orm(install))
        .await
        .map_err(|error| ImportError::failed("reading this install's workspaces", error))
}

/// The workspace's Global database: its migration level and size.
async fn probe(global: &Global, workspace: &GlobalWorkspace, entry: &mut WorkspaceCheck) {
    let mut conn = match global.connect(workspace).await {
        Ok(conn) => conn,
        Err(error) => {
            entry.problems.push(error.to_string());
            return;
        }
    };
    match tenant::level(&mut conn).await {
        Ok(level) => {
            entry.level = level.latest().map(str::to_owned);
            entry.gaps = level.gaps.len();
            entry.bytes = Some(level.bytes);
            if level.unknown > 0 {
                entry.problems.push(format!(
                    "its database has {} migration row(s) this build's journal doesn't know",
                    level.unknown
                ));
            }
            if level.applied.is_empty() {
                entry
                    .problems
                    .push("its database has no tenant migrations recorded".to_owned());
            }
        }
        Err(error) => entry.problems.push(error.to_string()),
    }
    let _ = sqlx::Connection::close(conn).await;
}

/// Room on the install's shards for the databases still to make.
async fn capacity(install: &PgPool, report: &CheckReport) -> Result<Option<String>, ImportError> {
    use neon_shared_projects::Column;
    let needed = report
        .moving
        .iter()
        .filter(|ws| {
            ws.on_install
                .as_ref()
                .is_none_or(|row| row.status != "ready")
        })
        .count();
    let room: Option<i64> = neon_shared_projects::Entity::find()
        .select_only()
        .column_as(
            Expr::from(Func::sum(
                Expr::col(Column::MaxDatabases).sub(Expr::col(Column::DatabaseCount)),
            )),
            "room",
        )
        .filter(Column::NeonProjectId.starts_with("cnpg:"))
        .filter(Column::Status.eq(NeonSharedProjectStatus::Active))
        .into_tuple()
        .one(&orm(install))
        .await
        .map_err(|error| ImportError::failed("reading the shards", error))?
        .flatten();
    Ok(match room {
        None => Some(
            "no shard is registered on this install yet: TENANT_SHARDS registers on the first database"
                .to_owned(),
        ),
        Some(room) if usize::try_from(room).unwrap_or(0) < needed => Some(format!(
            "the shards have room for {room} more database(s); {needed} are needed"
        )),
        Some(_) => None,
    })
}

/// Invitations still open on Global: they don't move.
async fn invitations(
    global: &Global,
    refs: &[String],
    report: &mut CheckReport,
) -> Result<(), ImportError> {
    let mut conn = global
        .master()
        .acquire()
        .await
        .map_err(|error| ImportError::failed("connecting to Global's master", error))?;
    let present = sql::tables(&mut conn)
        .await
        .map_err(|error| ImportError::failed("reading Global's master tables", error))?;
    if !present.contains_key("workspace_invitations") || refs.is_empty() {
        return Ok(());
    }
    let open = sql::count_matching(
        &mut conn,
        "workspace_invitations",
        "workspace_id = any($1) and status = 'pending'",
        refs,
    )
    .await
    .map_err(|error| ImportError::failed("counting Global's invitations", error))?;
    if open > 0 {
        report.warnings.push(format!(
            "{open} invitation(s) are open on Global; they don't move: admins invite those people again"
        ));
    }
    Ok(())
}

/// People who already have an account on the install under another id:
/// after the move they would have two.
async fn same_email(
    global: &Global,
    install: &PgPool,
    refs: &[String],
    report: &mut CheckReport,
) -> Result<(), ImportError> {
    if refs.is_empty() {
        return Ok(());
    }
    let mut conn = global
        .master()
        .acquire()
        .await
        .map_err(|error| ImportError::failed("connecting to Global's master", error))?;
    let members = sql::distinct_values(
        &mut conn,
        "user_workspaces",
        "user_id",
        "workspace_id = any($1)",
        refs,
    )
    .await
    .map_err(|error| ImportError::failed("reading Global's memberships", error))?;
    if members.is_empty() {
        return Ok(());
    }
    let global_users: Vec<(String, String)> = users::Entity::find()
        .select_only()
        .columns([users::Column::Id, users::Column::Email])
        .filter(users::Column::Id.is_in(members.clone()))
        .into_tuple()
        .all(&orm(global.master()))
        .await
        .map_err(|error| ImportError::failed("reading Global's users", error))?;
    let emails: BTreeMap<String, String> = global_users
        .into_iter()
        .map(|(id, email)| (email.to_lowercase(), id))
        .collect();
    let install_users: Vec<(String, String)> = users::Entity::find()
        .select_only()
        .columns([users::Column::Id, users::Column::Email])
        .filter(
            Expr::expr(Func::lower(Expr::col(users::Column::Email)))
                .is_in(emails.keys().cloned().collect::<Vec<_>>()),
        )
        .into_tuple()
        .all(&orm(install))
        .await
        .map_err(|error| ImportError::failed("reading this install's users", error))?;
    let twice: BTreeSet<String> = install_users
        .into_iter()
        .filter(|(id, email)| emails.get(&email.to_lowercase()) != Some(id))
        .map(|(_, email)| email.to_lowercase())
        .collect();
    if !twice.is_empty() {
        report.warnings.push(format!(
            "{} person(s) already have an account on this install under another id (same email): \
             after the move they have two; their Global account is the one with the workspaces",
            twice.len()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(id: &str, slug: &str, deleted: bool, database: bool) -> GlobalWorkspace {
        GlobalWorkspace {
            id: id.to_owned(),
            clerk_org_id: None,
            slug: slug.to_owned(),
            name: slug.to_owned(),
            plan_id: None,
            partner_id: None,
            is_active: true,
            deleted,
            database: database.then(|| crate::SourceDatabase::plain("postgres://u@h/d".to_owned())),
        }
    }

    #[test]
    fn deleted_and_databaseless_workspaces_stay() {
        let all = vec![
            workspace("ws_1", "live", false, true),
            workspace("ws_2", "gone", true, true),
            workspace("ws_3", "empty", false, false),
        ];
        let selection = select(all.clone(), &[]).expect("select");
        assert_eq!(
            selection
                .moving
                .iter()
                .map(|ws| ws.id.as_str())
                .collect::<Vec<_>>(),
            ["ws_1"]
        );
        let reasons: Vec<(&str, &str)> = selection
            .staying
            .iter()
            .map(|ws| (ws.id.as_str(), ws.reason.as_str()))
            .collect();
        assert_eq!(
            reasons,
            [
                ("ws_2", "deleted on Global"),
                ("ws_3", "no database on Global")
            ]
        );

        let one = select(all.clone(), &["live".to_owned()]).expect("select");
        assert_eq!(one.moving.len(), 1);
        assert_eq!(one.staying, Vec::<Staying>::new());
        assert!(select(all, &["nobody".to_owned()]).is_err());
    }
}
