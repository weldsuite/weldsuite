//! Staff work on the Kubernetes editions (ADR SEC-014). On Global, WeldSuite
//! staff use the admin console (`apps/web/admin`, ADR SEC-009); on EU and
//! self-hosted installs the same work is `weldsuite admin`, run in a server
//! pod through the cluster's API. This crate is that work without the
//! command line: the console's rules, its master-database writes and their
//! side effects, so staff HTTP routes can call the same functions later.
//!
//! - [`staff`]: the install's staff roster (master `admin_users`), who may
//!   act and with which role.
//! - [`access`]: workspaces' access to apps on request only (WeldReach):
//!   approve, reject, suspend, unsuspend, revoke, limits
//!   (`apps/web/admin/actions/app-access.ts`, ADR REACH-003).
//! - [`audit`]: every write's row in master `admin_audit_events`, as the
//!   console writes it.
//!
//! Every write takes the acting [`staff::Actor`] and a reason, runs in one
//! master transaction together with its audit row, and can be planned
//! without writing (`dry_run`).

pub mod access;
pub mod audit;
pub mod staff;

use std::fmt;

/// Why a staff action did not happen.
#[derive(Debug)]
pub enum StaffError {
    /// Refused by the rules, or about something that doesn't exist. The text
    /// is for the person at the terminal, as the console shows it in a toast.
    Refused(String),
    Database(sqlx::Error),
}

impl StaffError {
    pub(crate) fn refused(message: impl Into<String>) -> Self {
        Self::Refused(message.into())
    }
}

impl fmt::Display for StaffError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(message) => f.write_str(message),
            Self::Database(error) => write!(f, "database: {error}"),
        }
    }
}

impl std::error::Error for StaffError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Refused(_) => None,
            Self::Database(error) => Some(error),
        }
    }
}

impl From<sqlx::Error> for StaffError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

pub type StaffResult<T> = Result<T, StaffError>;
