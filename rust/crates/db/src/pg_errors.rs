//! Postgres error codes (`worker-kit/src/pg-errors.ts`) and what an API
//! answers for a database error (`createModuleApi`'s `onError` and
//! `classifyMovedDatabaseError` in `workspace-moving.ts`).
//!
//! The predicates walk the error's `source()` chain, five links deep like the
//! TypeScript walk of `cause`, so an `sqlx::Error` wrapped in a caller's own
//! error still matches. A link is matched by its SQLSTATE, and the two "the
//! workspace moved" checks also by Postgres's message text, as in TypeScript
//! (neon-http can leave the code empty). sqlx never puts the query or its
//! parameters in an error, so the message check has no wrapper to skip.
//!
//! The TypeScript side has no generic "constraint violation → status" table:
//! a route that expects a unique or foreign-key violation checks for it and
//! answers its own 409 or 400 with its own message, and anything else is a
//! 500. Routes ported to Rust do the same with these predicates.

use std::borrow::Cow;
use std::error::Error as StdError;

use sqlx::postgres::PgDatabaseError;
use weldsuite_kit::ApiError;

use crate::workspaces::{Tenant, Workspaces};

/// `unique_violation`: a UNIQUE index or constraint rejected the write.
pub const UNIQUE_VIOLATION: &str = "23505";
/// `undefined_table`: the relation does not exist (e.g. migration not yet run).
pub const UNDEFINED_TABLE: &str = "42P01";
/// `foreign_key_violation`.
pub const FOREIGN_KEY_VIOLATION: &str = "23503";
/// `read_only_sql_transaction`: a write reached a database set read-only. A
/// database move does that to the source once it has locked it (TASK-1150).
pub const READ_ONLY_SQL_TRANSACTION: &str = "25006";
/// `invalid_password`: the role's password no longer matches. A database move
/// rotates the source role's password, so a request still holding the old
/// connection URL fails with this (TASK-1150).
pub const INVALID_PASSWORD: &str = "28P01";

/// How deep the `source()` chain is followed, as in TypeScript.
const MAX_DEPTH: usize = 5;

/// `cannot execute INSERT in a read-only transaction` (SQLSTATE 25006).
const READ_ONLY_TRANSACTION_MESSAGE: &str = "in a read-only transaction";
/// `password authentication failed for user '…'` (SQLSTATE 28P01).
const PASSWORD_AUTH_FAILED_MESSAGE: &str = "password authentication failed";

/// `err` and its sources, at most [`MAX_DEPTH`] of them.
fn chain<'a>(
    err: &'a (dyn StdError + 'static),
) -> impl Iterator<Item = &'a (dyn StdError + 'static)> {
    let mut next = Some(err);
    std::iter::from_fn(move || {
        let current = next?;
        next = current.source();
        Some(current)
    })
    .take(MAX_DEPTH)
}

/// The SQLSTATE of one link, when it is a database error.
fn code_of<'a>(link: &'a (dyn StdError + 'static)) -> Option<Cow<'a, str>> {
    if let Some(sqlx::Error::Database(database)) = link.downcast_ref::<sqlx::Error>() {
        return database.code();
    }
    link.downcast_ref::<PgDatabaseError>()
        .map(|database| Cow::Borrowed(database.code()))
}

/// The first SQLSTATE in `err`'s chain.
pub fn pg_error_code(err: &(dyn StdError + 'static)) -> Option<String> {
    chain(err).find_map(|link| code_of(link).map(Cow::into_owned))
}

/// `hasPgErrorCode`: does `err`, or anything in its source chain, carry this
/// Postgres error code?
pub fn has_pg_error_code(err: &(dyn StdError + 'static), code: &str) -> bool {
    chain(err).any(|link| code_of(link).is_some_and(|found| found == code))
}

/// `isUniqueViolation` (23505).
pub fn is_unique_violation(err: &(dyn StdError + 'static)) -> bool {
    has_pg_error_code(err, UNIQUE_VIOLATION)
}

/// `isMissingTable` (42P01).
pub fn is_missing_table(err: &(dyn StdError + 'static)) -> bool {
    has_pg_error_code(err, UNDEFINED_TABLE)
}

/// `isForeignKeyViolation` (23503).
pub fn is_foreign_key_violation(err: &(dyn StdError + 'static)) -> bool {
    has_pg_error_code(err, FOREIGN_KEY_VIOLATION)
}

/// Does the message of a link contain `pattern`, ignoring ASCII case (a
/// JavaScript `/…/i` regex without the `u` flag never folds non-ASCII
/// characters onto ASCII ones)?
fn message_in_chain_matches(err: &(dyn StdError + 'static), pattern: &str) -> bool {
    chain(err).any(|link| link.to_string().to_ascii_lowercase().contains(pattern))
}

/// `isReadOnlyTransaction`: a write was refused because the database is
/// read-only (25006, or its message).
pub fn is_read_only_transaction(err: &(dyn StdError + 'static)) -> bool {
    has_pg_error_code(err, READ_ONLY_SQL_TRANSACTION)
        || message_in_chain_matches(err, READ_ONLY_TRANSACTION_MESSAGE)
}

/// `isPasswordAuthFailure`: the role's password was rejected (28P01, or its
/// message).
pub fn is_password_auth_failure(err: &(dyn StdError + 'static)) -> bool {
    has_pg_error_code(err, INVALID_PASSWORD)
        || message_in_chain_matches(err, PASSWORD_AUTH_FAILED_MESSAGE)
}

/// How a tenant database refused a request because the workspace moved
/// (`MovedDatabaseFailure`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MovedDatabaseFailure {
    /// The source was set read-only (25006).
    ReadOnly,
    /// The source role's password was rotated (28P01), so the URL this
    /// request holds is dead and any cached copy of it must go.
    PasswordRotated,
}

impl MovedDatabaseFailure {
    /// The TypeScript value: `read_only` or `password_rotated`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::PasswordRotated => "password_rotated",
        }
    }
}

/// `classifyMovedDatabaseError`: is `err` the database saying the workspace
/// moved? `None` for any other error. A rotated password wins over read-only.
pub fn classify_moved_database_error(
    err: &(dyn StdError + 'static),
) -> Option<MovedDatabaseFailure> {
    if is_password_auth_failure(err) {
        Some(MovedDatabaseFailure::PasswordRotated)
    } else if is_read_only_transaction(err) {
        Some(MovedDatabaseFailure::ReadOnly)
    } else {
        None
    }
}

/// The message of `onError`'s 500, which differs from `error.internal`'s.
const UNEXPECTED_ERROR_MESSAGE: &str = "An unexpected error occurred";

/// What `createModuleApi`'s `onError` answers for an error a handler did not
/// handle: 503 `WORKSPACE_MOVING` (with `Retry-After`) when the tenant
/// database says the workspace moved under the request, else 500
/// `INTERNAL_ERROR` "An unexpected error occurred". Only the classification
/// of a moved database is logged, never the error: its message can carry the
/// role name.
///
/// [`Workspaces::database_error`] also drops the cached workspace on a
/// rotated password; use that one where the tenant is known.
pub fn database_error(err: &(dyn StdError + 'static)) -> ApiError {
    if let Some(moved) = classify_moved_database_error(err) {
        tracing::warn!(
            failure = moved.as_str(),
            "workspace database moved under the request"
        );
        return ApiError::workspace_moving();
    }
    tracing::error!(error = %err, "unhandled database error");
    ApiError::internal().with_message(UNEXPECTED_ERROR_MESSAGE)
}

impl Workspaces {
    /// [`database_error`] for a request on `tenant`. A rotated password means
    /// the URL in the cached entry is dead, so the entry is dropped and the
    /// next request resolves the workspace from master again instead of
    /// failing the same way until the TTL runs out (`forgetWorkspaceContext`).
    pub fn database_error(&self, tenant: &Tenant, err: &(dyn StdError + 'static)) -> ApiError {
        let moved = classify_moved_database_error(err);
        if moved == Some(MovedDatabaseFailure::PasswordRotated) {
            let mut references = vec![tenant.workspace_id.as_str()];
            references.extend(tenant.clerk_org_id.as_deref());
            self.forget(&references);
        }
        if let Some(moved) = moved {
            tracing::warn!(
                failure = moved.as_str(),
                workspace_id = %tenant.workspace_id,
                "workspace database moved under the request"
            );
            return ApiError::workspace_moving();
        }
        database_error(err)
    }
}

#[cfg(test)]
mod tests {
    use std::fmt;

    use http::StatusCode;
    use sqlx::error::{DatabaseError, ErrorKind};

    use super::*;

    /// A driver error as sqlx hands it over: a database error with an
    /// optional SQLSTATE.
    #[derive(Debug)]
    struct FakeDbError {
        message: String,
        code: Option<&'static str>,
    }

    impl fmt::Display for FakeDbError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(&self.message)
        }
    }

    impl StdError for FakeDbError {}

    impl DatabaseError for FakeDbError {
        fn message(&self) -> &str {
            &self.message
        }

        fn code(&self) -> Option<Cow<'_, str>> {
            self.code.map(Cow::Borrowed)
        }

        fn as_error(&self) -> &(dyn StdError + Send + Sync + 'static) {
            self
        }

        fn as_error_mut(&mut self) -> &mut (dyn StdError + Send + Sync + 'static) {
            self
        }

        fn into_error(self: Box<Self>) -> Box<dyn StdError + Send + Sync + 'static> {
            self
        }

        fn kind(&self) -> ErrorKind {
            ErrorKind::Other
        }
    }

    fn db_error(message: &str, code: Option<&'static str>) -> sqlx::Error {
        sqlx::Error::Database(Box::new(FakeDbError {
            message: message.to_owned(),
            code,
        }))
    }

    /// A caller's own error wrapping a database error, like drizzle's
    /// `DrizzleQueryError` wraps the driver's. Its message carries request
    /// data that must not be read as Postgres's.
    #[derive(Debug)]
    struct Wrapped {
        source: sqlx::Error,
    }

    impl fmt::Display for Wrapped {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("saving the note failed")
        }
    }

    impl StdError for Wrapped {
        fn source(&self) -> Option<&(dyn StdError + 'static)> {
            Some(&self.source)
        }
    }

    fn wrapped(source: sqlx::Error) -> Wrapped {
        Wrapped { source }
    }

    /// A plain error with a message, like `new Error(message)`.
    #[derive(Debug)]
    struct Plain(&'static str);

    impl fmt::Display for Plain {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(self.0)
        }
    }

    impl StdError for Plain {}

    // pg-errors.test.ts: hasPgErrorCode
    #[test]
    fn finds_the_code_on_the_error_itself_and_anywhere_in_the_source_chain() {
        assert!(has_pg_error_code(&db_error("dup", Some("23505")), "23505"));
        assert!(has_pg_error_code(
            &wrapped(db_error("dup", Some("23505"))),
            "23505"
        ));
        assert!(!has_pg_error_code(
            &wrapped(db_error("dup", Some("23505"))),
            "23503"
        ));
        assert_eq!(
            pg_error_code(&wrapped(db_error("dup", Some("23505")))).as_deref(),
            Some("23505")
        );
    }

    #[test]
    fn keeps_the_older_predicates_on_the_same_walk() {
        assert!(is_unique_violation(&wrapped(db_error("x", Some("23505")))));
        assert!(is_missing_table(&wrapped(db_error("x", Some("42P01")))));
        assert!(is_foreign_key_violation(&wrapped(db_error(
            "x",
            Some("23503")
        ))));
    }

    #[test]
    fn is_false_for_errors_without_a_code() {
        assert!(!has_pg_error_code(&sqlx::Error::RowNotFound, "23505"));
        assert!(!has_pg_error_code(&Plain("23505"), "23505"));
        assert_eq!(pg_error_code(&sqlx::Error::PoolTimedOut), None);
    }

    // pg-errors.test.ts: isReadOnlyTransaction
    #[test]
    fn read_only_matches_sqlstate_25006_on_the_error_or_its_source() {
        assert_eq!(READ_ONLY_SQL_TRANSACTION, "25006");
        assert!(is_read_only_transaction(&db_error("boom", Some("25006"))));
        assert!(is_read_only_transaction(&wrapped(db_error(
            "boom",
            Some("25006")
        ))));
    }

    #[test]
    fn read_only_matches_the_message_when_the_code_is_missing() {
        assert!(is_read_only_transaction(&wrapped(db_error(
            "cannot execute INSERT in a read-only transaction",
            None
        ))));
        assert!(is_read_only_transaction(&db_error(
            "cannot execute UPDATE in a READ-ONLY transaction",
            Some("")
        )));
    }

    #[test]
    fn read_only_is_false_for_other_database_errors() {
        assert!(!is_read_only_transaction(&wrapped(db_error(
            "duplicate key value",
            Some("23505")
        ))));
        assert!(!is_read_only_transaction(&Plain("boom")));
        assert!(!is_read_only_transaction(&sqlx::Error::PoolTimedOut));
    }

    // pg-errors.test.ts: isPasswordAuthFailure
    #[test]
    fn password_matches_sqlstate_28p01_on_the_error_or_its_source() {
        assert_eq!(INVALID_PASSWORD, "28P01");
        assert!(is_password_auth_failure(&db_error("boom", Some("28P01"))));
        assert!(is_password_auth_failure(&wrapped(db_error(
            "boom",
            Some("28P01")
        ))));
    }

    #[test]
    fn password_matches_the_message_when_the_code_is_missing() {
        let message = "password authentication failed for user 'tenant_role'";
        assert!(is_password_auth_failure(&wrapped(db_error(message, None))));
        assert!(is_password_auth_failure(&db_error(message, Some(""))));
        assert!(is_password_auth_failure(&Plain(
            "password authentication failed for user 'tenant_role'"
        )));
    }

    #[test]
    fn password_is_false_for_other_errors_and_other_auth_looking_text() {
        assert!(!is_password_auth_failure(&wrapped(db_error(
            "duplicate key value",
            Some("23505")
        ))));
        assert!(!is_password_auth_failure(&Plain("Unauthorized")));
        // Only ASCII letters fold, as in a JavaScript /i regex.
        assert!(!is_password_auth_failure(&Plain(
            "PASSWORD AUTHENT\u{130}CAT\u{130}ON FAILED"
        )));
    }

    /// A chain that never ends, like the cyclic `cause` of the TypeScript
    /// test: the walk stops after five links.
    #[derive(Debug)]
    struct Endless(u32);

    impl fmt::Display for Endless {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(f, "link {}", self.0)
        }
    }

    static ENDLESS: Endless = Endless(0);

    impl StdError for Endless {
        fn source(&self) -> Option<&(dyn StdError + 'static)> {
            Some(&ENDLESS)
        }
    }

    #[test]
    fn is_not_fooled_by_an_endless_source_chain() {
        assert_eq!(chain(&Endless(1)).count(), MAX_DEPTH);
        assert!(!is_password_auth_failure(&Endless(1)));
        assert!(!is_read_only_transaction(&Endless(1)));
    }

    // workspace-moving.test.ts: classifyMovedDatabaseError
    #[test]
    fn tells_a_read_only_source_from_a_rotated_password_and_ignores_everything_else() {
        let classify = |err: &(dyn StdError + 'static)| classify_moved_database_error(err);
        assert_eq!(
            classify(&db_error("x", Some("25006"))),
            Some(MovedDatabaseFailure::ReadOnly)
        );
        assert_eq!(
            classify(&db_error("x", Some("28P01"))),
            Some(MovedDatabaseFailure::PasswordRotated)
        );
        assert_eq!(
            classify(&Plain("password authentication failed for user 'r'")),
            Some(MovedDatabaseFailure::PasswordRotated)
        );
        assert_eq!(
            classify(&Plain("cannot execute DELETE in a read-only transaction")),
            Some(MovedDatabaseFailure::ReadOnly)
        );
        assert_eq!(classify(&Plain("boom")), None);
        assert_eq!(classify(&db_error("x", Some("23505"))), None);
        assert_eq!(MovedDatabaseFailure::ReadOnly.as_str(), "read_only");
        assert_eq!(
            MovedDatabaseFailure::PasswordRotated.as_str(),
            "password_rotated"
        );
    }

    // app.test.ts: onError
    #[test]
    fn a_moved_database_is_a_503_and_anything_else_a_500() {
        let moving = database_error(&db_error("x", Some("25006")));
        assert_eq!(moving, ApiError::workspace_moving());
        assert_eq!(moving.retry_after(), Some(30));

        let other = database_error(&db_error("duplicate key value", Some("23505")));
        assert_eq!(other.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(other.code(), "INTERNAL_ERROR");
        assert_eq!(other.message(), "An unexpected error occurred");
        assert_eq!(other.retry_after(), None);
    }
}
