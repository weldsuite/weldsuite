//! The core legal entity service (`service.ts`): the companies of a
//! workspace, their registrations and bank accounts, and who may see them.
//! Pure functions over the tenant database; app-api's `/api/legal-entities`
//! routes, books-api and hr-api call them.
//!
//! Release 1 mirrors: registrations are mirrored into the deprecated
//! `entities.tax_identifiers` and into the WeldHR employer that runs payroll
//! under them; a bank account is mirrored into the deprecated
//! `hr_payroll_employers.bank_encrypted` of the employers that pay from it;
//! the default entity is mirrored into `settings.default_entity_id` when
//! WeldBooks is enabled for it.
//!
//! Errors carry TypeScript's codes and messages ([`LegalEntityError`]); the
//! rows and shapes serialize to the JSON the TypeScript service returns.

mod bank_accounts;
mod entities;
mod members;
mod registrations;
mod types;

use std::fmt;

use serde::de::DeserializeOwned;
use serde_json::Value;
use sqlx::postgres::PgArguments;
use sqlx::query::QueryScalar;
use sqlx::{AssertSqlSafe, PgPool, Postgres};
use time::OffsetDateTime;
use weldsuite_kit::ApiError;

pub use bank_accounts::{
    create_bank_account, delete_bank_account, list_bank_accounts, reveal_bank_account_number,
    update_bank_account,
};
pub use entities::{
    create_legal_entity, delete_legal_entity, get_default_legal_entity,
    get_default_legal_entity_row, get_legal_entity, legal_entity_usage, list_legal_entities,
    set_default_legal_entity, set_legal_entity_archived, update_legal_entity,
};
pub use members::{
    get_entity_access_list, my_effective_access, remove_entity_member, set_entity_member,
    set_entity_restricted,
};
pub use registrations::{
    create_registration, delete_registration, get_registration, list_registrations,
    update_registration,
};
pub use types::{
    BankAccountRow, CreateBankAccountInput, CreateLegalEntityInput, CreateRegistrationInput,
    EntityMemberRow, EntityRow, LegalEntity, LegalEntityAccess, LegalEntityAccessMember,
    LegalEntityBankAccount, LegalEntityEffectiveAccess, LegalEntityMyAccess,
    LegalEntityRegistration, LegalEntityUsage, ListLegalEntitiesOptions, RegistrationRow,
    RevealBankAccount, RevealedAccountNumber, SetEntityMember, SetEntityMemberResult,
    UpdateBankAccountInput, UpdateLegalEntityInput, UpdateRegistrationInput,
};

/// `LegalEntityErrorCode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegalEntityErrorCode {
    NotFound,
    Conflict,
    BadRequest,
    NoEncryptionKey,
}

impl LegalEntityErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotFound => "NOT_FOUND",
            Self::Conflict => "CONFLICT",
            Self::BadRequest => "BAD_REQUEST",
            Self::NoEncryptionKey => "NO_ENCRYPTION_KEY",
        }
    }
}

/// A service failure: a `LegalEntityError` with its code and message, or
/// what TypeScript throws as a plain error (a failed query, a value that
/// does not decrypt), which the routes answer as a 500.
#[derive(Debug)]
pub enum LegalEntityError {
    Coded {
        code: LegalEntityErrorCode,
        message: String,
    },
    Database(sqlx::Error),
    /// Not a `LegalEntityError` in TypeScript: a thrown `Error`.
    Internal(String),
}

impl LegalEntityError {
    fn coded(code: LegalEntityErrorCode, message: impl Into<String>) -> Self {
        Self::Coded {
            code,
            message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::coded(LegalEntityErrorCode::NotFound, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::coded(LegalEntityErrorCode::Conflict, message)
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::coded(LegalEntityErrorCode::BadRequest, message)
    }

    pub fn no_encryption_key(message: impl Into<String>) -> Self {
        Self::coded(LegalEntityErrorCode::NoEncryptionKey, message)
    }

    /// `err.code` of a `LegalEntityError`; `None` for anything else.
    pub fn code(&self) -> Option<LegalEntityErrorCode> {
        match self {
            Self::Coded { code, .. } => Some(*code),
            _ => None,
        }
    }

    /// `err.message`.
    pub fn message(&self) -> String {
        match self {
            Self::Coded { message, .. } | Self::Internal(message) => message.clone(),
            Self::Database(error) => error.to_string(),
        }
    }

    /// app-api's `failure(c, err)`: `NOT_FOUND` → 404 "Legal entity not found"
    /// (whatever the message), `CONFLICT` → 409 and `BAD_REQUEST` → 400 with the
    /// message, `NO_ENCRYPTION_KEY` → 500 "Encryption is not configured", and
    /// anything else the global handler's 500. Other modules map the codes
    /// their own way.
    pub fn to_api_error(&self) -> ApiError {
        match self {
            Self::Coded { code, message } => match code {
                LegalEntityErrorCode::NotFound => ApiError::not_found("Legal entity", None),
                LegalEntityErrorCode::Conflict => ApiError::conflict(message.clone()),
                LegalEntityErrorCode::BadRequest => ApiError::bad_request(message.clone()),
                LegalEntityErrorCode::NoEncryptionKey => {
                    ApiError::internal().with_message("Encryption is not configured")
                }
            },
            Self::Database(error) => {
                tracing::error!(%error, "legal entities: a query failed");
                ApiError::internal()
            }
            Self::Internal(message) => {
                tracing::error!(%message, "legal entities: the service failed");
                ApiError::internal()
            }
        }
    }
}

impl fmt::Display for LegalEntityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Coded { code, message } => write!(f, "{}: {message}", code.as_str()),
            Self::Database(error) => write!(f, "database: {error}"),
            Self::Internal(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for LegalEntityError {}

impl From<sqlx::Error> for LegalEntityError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// `new Date()` as Drizzle writes it: UTC with milliseconds, bound as text
/// and cast (`::timestamp`).
pub(crate) fn now_iso() -> String {
    let format = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    OffsetDateTime::now_utc()
        .format(&format)
        .unwrap_or_default()
}

/// `text.slice(0, end)` in UTF-16 code units, as JavaScript cuts strings.
pub(crate) fn js_slice_start(text: &str, end: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(end).collect();
    String::from_utf16_lossy(&units)
}

/// `text.slice(-count)` in UTF-16 code units.
pub(crate) fn js_slice_end(text: &str, count: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let from = units.len().saturating_sub(count);
    String::from_utf16_lossy(units.get(from..).unwrap_or_default())
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A `to_jsonb(t)` row as Drizzle returns it, read into `T`.
pub(crate) fn read_row<T: DeserializeOwned>(row: Value) -> Result<(T, Value), LegalEntityError> {
    let json = weldsuite_db::js_row(row);
    let typed = serde_json::from_value(json.clone()).map_err(|error| {
        LegalEntityError::Internal(format!("legal entities: unreadable row: {error}"))
    })?;
    Ok((typed, json))
}

/// A bound value of a statement built at run time.
#[derive(Debug, Clone)]
pub(crate) enum Param {
    Text(Option<String>),
    Json(Option<Value>),
    Int(Option<i32>),
    Bool(Option<bool>),
    /// An ISO timestamp, cast to `timestamp`.
    Timestamp(Option<String>),
    /// `YYYY-MM-DD`, cast to `date`.
    Date(Option<String>),
}

impl Param {
    fn placeholder(&self, at: usize) -> String {
        match self {
            Self::Json(_) => format!("${at}::jsonb"),
            Self::Timestamp(_) => format!("${at}::timestamp"),
            Self::Date(_) => format!("${at}::date"),
            Self::Text(_) | Self::Int(_) | Self::Bool(_) => format!("${at}"),
        }
    }
}

/// The columns a Drizzle `.set(patch)` or `.values(row)` writes: only those
/// present, so the others keep their value (or take their default).
#[derive(Debug, Clone, Default)]
pub(crate) struct Columns(Vec<(&'static str, Param)>);

impl Columns {
    /// Set `column`, replacing an earlier value in its place.
    pub(crate) fn set(&mut self, column: &'static str, param: Param) {
        if let Some(slot) = self.0.iter_mut().find(|(name, _)| *name == column) {
            slot.1 = param;
        } else {
            self.0.push((column, param));
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub(crate) fn get(&self, column: &str) -> Option<&Param> {
        self.0
            .iter()
            .find(|(name, _)| *name == column)
            .map(|(_, param)| param)
    }
}

fn bind_all(
    mut query: QueryScalar<'static, Postgres, Value, PgArguments>,
    params: impl IntoIterator<Item = Param>,
) -> QueryScalar<'static, Postgres, Value, PgArguments> {
    for param in params {
        query = match param {
            Param::Text(value) | Param::Timestamp(value) | Param::Date(value) => query.bind(value),
            Param::Json(value) => query.bind(value),
            Param::Int(value) => query.bind(value),
            Param::Bool(value) => query.bind(value),
        };
    }
    query
}

/// `insert into <table> (...) values (...) returning *`, the row as `to_jsonb`.
pub(crate) async fn insert_returning(
    db: &PgPool,
    table: &'static str,
    columns: Columns,
) -> Result<Value, sqlx::Error> {
    let names: Vec<&str> = columns.0.iter().map(|(name, _)| *name).collect();
    let placeholders: Vec<String> = columns
        .0
        .iter()
        .enumerate()
        .map(|(at, (_, param))| param.placeholder(at + 1))
        .collect();
    let sql = format!(
        "insert into {table} as t ({}) values ({}) returning to_jsonb(t)",
        names.join(", "),
        placeholders.join(", ")
    );
    let query = sqlx::query_scalar(AssertSqlSafe(sql));
    bind_all(query, columns.0.into_iter().map(|(_, param)| param))
        .fetch_one(db)
        .await
}

/// `update <table> set ... where id = $id returning *`, the row as
/// `to_jsonb`; `None` when no row has the id.
pub(crate) async fn update_returning(
    db: &PgPool,
    table: &'static str,
    columns: Columns,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let assignments: Vec<String> = columns
        .0
        .iter()
        .enumerate()
        .map(|(at, (name, param))| format!("{name} = {}", param.placeholder(at + 1)))
        .collect();
    let sql = format!(
        "update {table} as t set {} where t.id = ${} returning to_jsonb(t)",
        assignments.join(", "),
        columns.0.len() + 1
    );
    let query = sqlx::query_scalar(AssertSqlSafe(sql));
    bind_all(query, columns.0.into_iter().map(|(_, param)| param))
        .bind(id.to_owned())
        .fetch_optional(db)
        .await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn strings_are_cut_like_javascript() {
        assert_eq!(js_slice_end("123456789", 4), "6789");
        assert_eq!(js_slice_end("12", 4), "12");
        assert_eq!(js_slice_start("NL", 2), "NL");
        assert_eq!(js_slice_start("NLD", 2), "NL");
        assert_eq!(js_slice_start("N", 2), "N");
    }

    #[test]
    fn truthiness() {
        assert!(!js_truthy(&json!("")));
        assert!(js_truthy(&json!("x")));
        assert!(!js_truthy(&json!(0)));
        assert!(!js_truthy(&Value::Null));
        assert!(js_truthy(&json!({})));
    }

    #[test]
    fn errors_map_like_app_api() {
        let missing = LegalEntityError::not_found("Registration not found").to_api_error();
        assert_eq!(missing.message(), "Legal entity not found");
        let conflict = LegalEntityError::conflict("nope").to_api_error();
        assert_eq!((conflict.code(), conflict.message()), ("CONFLICT", "nope"));
        let key = LegalEntityError::no_encryption_key("x").to_api_error();
        assert_eq!(key.message(), "Encryption is not configured");
        assert_eq!(key.code(), "INTERNAL_ERROR");
    }

    #[test]
    fn now_is_an_iso_timestamp_with_milliseconds() {
        let now = now_iso();
        assert_eq!(now.len(), 24);
        assert!(now.ends_with('Z'));
    }
}
