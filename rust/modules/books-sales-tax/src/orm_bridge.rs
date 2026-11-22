//! The way back from SeaORM's error to sqlx's, for `weldsuite-books-domain`'s
//! `Refusal`, which still holds an `sqlx::Error` (`Refusal::Database`, the
//! route's 500). It exists only until that crate is converted to the ORM
//! (ADR DATA-019) and `Refusal` holds `sea_orm::DbErr`; then it goes.

use std::sync::Arc;

use sea_orm::{DbErr, RuntimeErr};
use weldsuite_books_domain::http::Refusal;

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

/// A failed statement as the route's failure (`Refusal::Database`: logged,
/// and answered with the route's 500), as an `sqlx::Error` was.
pub(crate) fn refusal(error: DbErr) -> Refusal {
    Refusal::Database(sqlx_error(error))
}
