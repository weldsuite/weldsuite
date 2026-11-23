//! Temporary, until this crate is on the ORM too (ADR DATA-019): the
//! `sea_orm::DbErr` of a crate that is already converted
//! (`weldsuite-legal-entities`) back as the `sqlx::Error` this crate's
//! functions still answer.

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
