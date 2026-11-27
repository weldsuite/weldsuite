//! Count again on both sides ([`verify`]): the master rows the move copies
//! and every table of the tenant database, Global against the install.
//!
//! Run it before the install opens: afterwards the install's numbers move
//! on, and a difference means work done there, not a row lost.

use serde::Serialize;
use sqlx::PgPool;
use weldsuite_db::Workspaces;

use crate::global::{Global, GlobalWorkspace};
use crate::master::{self, Filter, Rule};
use crate::{ImportError, sql};

/// A table whose counts differ.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Difference {
    pub table: String,
    pub global: i64,
    pub install: i64,
}

/// One workspace, counted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub id: String,
    /// Master tables compared.
    pub master_tables: usize,
    pub master: Vec<Difference>,
    /// Tenant tables compared (`None`: the database isn't on the install).
    pub tenant_tables: Option<usize>,
    pub tenant: Vec<Difference>,
    /// Tables only one side has.
    pub only_on_one_side: Vec<String>,
}

impl Verification {
    /// Every count matched.
    pub fn ok(&self) -> bool {
        self.master.is_empty()
            && self.tenant.is_empty()
            && self.only_on_one_side.is_empty()
            && self.tenant_tables.is_some()
    }
}

/// Count `workspace`'s rows on Global and on the install. `tenants` opens
/// the install's tenant databases.
pub async fn verify(
    global: &Global,
    install: &PgPool,
    tenants: &Workspaces,
    workspace: &GlobalWorkspace,
) -> Result<Verification, ImportError> {
    let mut report = Verification {
        id: workspace.id.clone(),
        master_tables: 0,
        master: Vec::new(),
        tenant_tables: None,
        tenant: Vec::new(),
        only_on_one_side: Vec::new(),
    };
    master_counts(global, install, workspace, &mut report).await?;
    let Ok(tenant) = tenants.tenant(&workspace.id).await else {
        return Ok(report);
    };
    let mut source = global.connect(workspace).await?;
    let mut target = tenant
        .db
        .acquire()
        .await
        .map_err(|error| ImportError::failed("connecting to the install's database", error))?;
    let source_tables = sql::tables(&mut source)
        .await
        .map_err(|error| ImportError::failed("reading Global's tables", error))?;
    let target_tables = sql::tables(&mut target)
        .await
        .map_err(|error| ImportError::failed("reading the install's tables", error))?;
    let mut compared = 0;
    for table in source_tables.keys() {
        if table == "__drizzle_migrations" {
            continue;
        }
        if !target_tables.contains_key(table) {
            report
                .only_on_one_side
                .push(format!("{table} (Global only)"));
            continue;
        }
        let on_global = sql::count_rows(&mut source, table)
            .await
            .map_err(|error| ImportError::failed(&format!("counting Global's {table}"), error))?;
        let here = sql::count_rows(&mut target, table).await.map_err(|error| {
            ImportError::failed(&format!("counting the install's {table}"), error)
        })?;
        compared += 1;
        if on_global != here {
            report.tenant.push(Difference {
                table: table.clone(),
                global: on_global,
                install: here,
            });
        }
    }
    report.tenant_tables = Some(compared);
    let _ = sqlx::Connection::close(source).await;
    Ok(report)
}

async fn master_counts(
    global: &Global,
    install: &PgPool,
    workspace: &GlobalWorkspace,
    report: &mut Verification,
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
    let refs = workspace.references();
    let members = sql::distinct_values(
        &mut source,
        "user_workspaces",
        "user_id",
        "workspace_id = any($1)",
        &refs,
    )
    .await
    .map_err(|error| ImportError::failed("reading Global's memberships", error))?;
    for entry in master::TABLES {
        let Rule::Copy(filter) = entry.rule else {
            continue;
        };
        if !global_tables.contains_key(entry.name) {
            continue;
        }
        let values = match filter {
            Filter::User(_) => &members,
            _ => &refs,
        };
        let condition = filter.sql();
        let on_global = sql::count_matching(&mut source, entry.name, &condition, values)
            .await
            .map_err(|error| {
                ImportError::failed(&format!("counting Global's {}", entry.name), error)
            })?;
        let here = sql::count_matching(&mut target, entry.name, &condition, values)
            .await
            .map_err(|error| {
                ImportError::failed(&format!("counting the install's {}", entry.name), error)
            })?;
        report.master_tables += 1;
        if on_global != here {
            report.master.push(Difference {
                table: entry.name.to_owned(),
                global: on_global,
                install: here,
            });
        }
    }
    Ok(())
}
