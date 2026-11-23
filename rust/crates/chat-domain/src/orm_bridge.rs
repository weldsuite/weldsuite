//! The way back from SeaORM's error to sqlx's, for the calls into
//! `weldsuite-core-domain` (now on the ORM) from functions here that still
//! return `sqlx::Error`. It exists only until this crate is converted to the
//! ORM (ADR DATA-019); then it goes.

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
