//! The way back from SeaORM's error to sqlx's, for what
//! `weldsuite-books-domain` still declares with `sqlx::Error`: a route's
//! [`Refusal::Database`], [`PostError::Database`] and the `AlsoWrite`
//! callbacks posting runs inside its transaction. It exists only until that
//! crate is converted to the ORM (ADR DATA-019) and holds `sea_orm::DbErr`;
//! then it goes.

use std::sync::Arc;

use sea_orm::{DbErr, RuntimeErr};
use weldsuite_books_domain::http::Refusal;
use weldsuite_books_domain::posting::PostError;

/// The `sqlx::Error` inside `error` when SeaORM ran the statement through
/// sqlx (and nothing else holds it), else a protocol error carrying its text.
pub(crate) fn sqlx_error(error: DbErr) -> sqlx::Error {
    match error {
        DbErr::Conn(RuntimeErr::SqlxError(inner))
        | DbErr::Exec(RuntimeErr::SqlxError(inner))
        | DbErr::Query(RuntimeErr::SqlxError(inner)) => {
            Arc::try_unwrap(inner).unwrap_or_else(|shared| sqlx::Error::Protocol(shared.to_string()))
        }
        other => sqlx::Error::Protocol(other.to_string()),
    }
}

/// A failed statement as a route answers it: its 500.
pub(crate) fn refused(error: DbErr) -> Refusal {
    Refusal::Database(sqlx_error(error))
}

/// A failed statement as posting reports it (`PostError::Database`).
pub(crate) fn post_failed(error: DbErr) -> PostError {
    PostError::Database(sqlx_error(error))
}
