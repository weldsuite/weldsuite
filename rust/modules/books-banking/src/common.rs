//! What the banking groups share: their error mappings and row lookups.

use serde_json::{Map, Value};
use sqlx::PgPool;
use weldsuite_books_domain::bank_accounts::{BankAccountError, NO_KEY_MESSAGE};
use weldsuite_books_domain::http::Refusal;
use weldsuite_books_domain::posting::PostError;
use weldsuite_kit::ApiError;

/// `ClosedPeriodError | LockedPeriodError | PostingError` (and the route's
/// own user errors): 400 with the message; a database failure is the
/// route's 500.
pub(crate) fn posting_refusal(error: PostError) -> Refusal {
    match error.user_message() {
        Some(message) => Refusal::bad_request(message),
        None => match error {
            PostError::Database(error) => Refusal::Database(error),
            other => Refusal::Internal(other.to_string()),
        },
    }
}

/// A bank-account failure as the bank-account routes answer it:
/// `PostingError` 400, `AccountNumberKeyError` 500 with its message.
pub(crate) fn bank_account_refusal(error: BankAccountError) -> Refusal {
    match error {
        BankAccountError::Posting(message) => Refusal::bad_request(message),
        BankAccountError::NoKey => ApiError::internal().with_message(NO_KEY_MESSAGE).into(),
        BankAccountError::Unreadable(message) => Refusal::Internal(message),
        BankAccountError::Database(error) => Refusal::Database(error),
    }
}

/// `{ field: { old, new } }` for the audit trail, in insertion order.
pub(crate) fn changes(entries: Vec<(&str, Value, Value)>) -> Map<String, Value> {
    entries
        .into_iter()
        .map(|(key, old, new)| {
            (
                key.to_owned(),
                weldsuite_books_domain::guards::change(old, new),
            )
        })
        .collect()
}

/// `row.key` as text, `None` for null or absent.
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `row.key` as a value (`Value::Null` when absent).
pub(crate) fn field(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// The live bank transaction `id` (`deleted_at is null`), as Drizzle
/// returns it.
pub(crate) async fn find_transaction(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    weldsuite_books_domain::tables::BANK_TRANSACTIONS
        .find_live(db, id)
        .await
}
