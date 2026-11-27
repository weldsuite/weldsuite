//! The move from Global (ADR OPS-025, plan `retire-global-edition.md`,
//! phase 4): Global's workspaces, their members, their tenant databases and
//! their files, copied into a Kubernetes install, so the install serves them
//! from then on. `weldsuite admin import-global` drives it, one step at a
//! time, each safe to run again:
//!
//! 1. **[`check`]** reads both sides and changes nothing: which workspaces
//!    move and which stay behind (deleted, no database), names taken on the
//!    install, plans with no counterpart, Global master tables the move has
//!    no rule for, and each tenant database's migration level.
//! 2. **[`master::copy`]** copies the master rows of the moving workspaces
//!    in one transaction ([`master::TABLES`] says, table by table, what moves
//!    and why the rest doesn't): the workspace rows with their placement
//!    cleared and their plan mapped, the members, credits, API keys and the
//!    registries that route public traffic to a workspace.
//! 3. **[`tenant::move_tenant`]**, per workspace: a database on one of the
//!    install's shards, migrated to exactly the level Global's database has,
//!    every row streamed into it in one transaction (`COPY`), then the
//!    migrations since, the materialized views, the services outside the EU
//!    the workspace had connected (ADR OPS-026), the due index, and the
//!    workspace marked ready. A `workspace_database_moves` row (kind
//!    `import_global`) records it and keeps `weldsuite migrate` off the
//!    database meanwhile.
//! 4. **[`files::copy_bucket`]** copies a bucket's objects with their keys
//!    unchanged, skipping what is already there with the same size.
//! 5. **[`verify`]** counts again on both sides.
//!
//! What it does not do: drain mailboxes kept in Durable Objects, flush the
//! collaborative documents or recreate sleeping Cloudflare Workflows (all on
//! Global's side, before the copy), import the people into `WeldID`
//! (`weldid admin user import`), reindex search with the install's
//! embeddings (`POST /api/search/reindex` per workspace), or file the
//! verified mail domains for DMARC reports (`weldsuite mail
//! backfill-domain-registry`, once, after the tenants step).

pub mod check;
#[cfg(test)]
mod copy_tests;
pub mod files;
pub mod global;
pub mod master;
mod sql;
pub mod tenant;
pub mod verify;

use std::fmt;

pub use check::{CheckOptions, CheckReport, Selection, Staying, check, select};
pub use global::{Global, GlobalWorkspace, PlanName, SourceDatabase, plan_names};
pub use master::{MasterOptions, MasterReport, PlanMap};
pub use tenant::{LevelProvisioner, TenantOptions, TenantReport, move_tenant};
pub use verify::{Verification, verify};

/// The kind of the `workspace_database_moves` rows the move writes.
pub const MOVE_KIND: &str = "import_global";

/// Why a step stopped. Never holds a connection string.
#[derive(Debug)]
pub enum ImportError {
    /// The move can't go on as asked: a name taken, a plan with no
    /// counterpart, a table with no rule, a step run out of order.
    Refused(String),
    /// A database, a store or an API failed.
    Failed(String),
}

impl ImportError {
    pub(crate) fn failed(context: &str, error: impl fmt::Display) -> Self {
        Self::Failed(format!("{context}: {}", redact_urls(&error.to_string())))
    }

    pub(crate) fn refused(message: impl Into<String>) -> Self {
        Self::Refused(message.into())
    }
}

impl fmt::Display for ImportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(message) | Self::Failed(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for ImportError {}

/// `message` with every `postgres://…` connection string replaced, so a
/// driver's error can be printed: the rest (workspace ids, table names) is
/// what the person running the move needs to see.
pub fn redact_urls(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut rest = message;
    loop {
        let found = ["postgresql://", "postgres://"]
            .iter()
            .filter_map(|scheme| rest.find(scheme))
            .min();
        let Some(start) = found else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..start]);
        out.push_str("<connection string>");
        let tail = &rest[start..];
        let end = tail
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
            .unwrap_or(tail.len());
        rest = &tail[end..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_connection_strings_only() {
        assert_eq!(
            redact_urls(
                "error connecting to postgres://u:p@ep-1.neon.tech/db?sslmode=require for ws_1"
            ),
            "error connecting to <connection string> for ws_1"
        );
        assert_eq!(
            redact_urls("a 'postgresql://x:y@h/d' and postgres://z"),
            "a '<connection string>' and <connection string>"
        );
        assert_eq!(redact_urls("nothing here"), "nothing here");
    }
}
