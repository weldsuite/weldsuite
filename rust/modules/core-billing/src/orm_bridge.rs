//! The way back from SeaORM's error to sqlx's, for
//! [`crate::addons::resume_inboxes`], which `weldsuite admin billing comp`
//! (`bins/weldsuite/src/admin_billing.rs`, whose `StaffError` still holds
//! `sqlx::Error`) calls inside its own sqlx transaction. It exists only until
//! the staff commands are converted to the ORM (ADR DATA-019); then it goes.

use std::sync::Arc;

use sea_orm::{DbErr, RuntimeErr};

/// The `sqlx::Error` inside `error` when SeaORM ran the statement through
/// sqlx (and nothing else holds it), else a protocol error carrying its text.
pub(crate) fn sqlx_error(error: DbErr) -> sqlx::Error {
    match error {
        DbErr::Conn(RuntimeErr::SqlxError(inner))
        | DbErr::Exec(RuntimeErr::SqlxError(inner))
        | DbErr::Query(RuntimeErr::SqlxError(inner)) => Arc::try_unwrap(inner)
            .unwrap_or_else(|shared| sqlx::Error::Protocol(shared.to_string())),
        other => sqlx::Error::Protocol(other.to_string()),
    }
}
