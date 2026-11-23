//! The way back from SeaORM's error to sqlx's: for `AdsError`, which
//! `weldsuite-ads-domain` still declares with `sqlx::Error` (the OAuth
//! callback answers with its text), and for the campaign writes, which
//! answer with a failed statement's text as sqlx showed it. [`sqlx_error`]
//! exists only until that crate is converted to the ORM (ADR DATA-019) and
//! `AdsError` holds `sea_orm::DbErr`; then it goes.

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

/// `error`'s text as sqlx showed it (`error returned from database: …`),
/// without SeaORM's `Query Error: ` / `Execution Error: ` in front.
pub(crate) fn sqlx_message(error: &DbErr) -> String {
    match error {
        DbErr::Conn(RuntimeErr::SqlxError(inner))
        | DbErr::Exec(RuntimeErr::SqlxError(inner))
        | DbErr::Query(RuntimeErr::SqlxError(inner)) => inner.to_string(),
        other => other.to_string(),
    }
}
