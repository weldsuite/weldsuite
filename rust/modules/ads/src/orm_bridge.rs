//! A failed statement's text as sqlx showed it: the campaign writes answer
//! with it.

use sea_orm::{DbErr, RuntimeErr};

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
