//! `@weldsuite/crm-domain` (`packages/domains/crm`): the CRM services that
//! crm-api's routes run on and that other modules writing CRM records share
//! (WeldConnect's workflow actions, WeldData, WeldBooks, app-api).
//!
//! Pure business logic over a tenant database: no request, no response.
//! Inputs are the parsed bodies the routes validated (Zod's output: the keys
//! the caller set, defaults filled in), as JSON objects keyed like the
//! TypeScript types.

pub mod activities;
pub mod companies;
pub mod company_attributes;
pub mod events;
pub use weldsuite_core_domain::js;
pub mod leads;
pub mod opportunities;
pub mod people;
pub mod sequence_run;
pub mod tables;
#[allow(clippy::too_many_lines)]
mod tables_gen;
pub mod validation;

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, Value};
use time::OffsetDateTime;
use weldsuite_events::{EntityEventPublisher, iso_timestamp};
use weldsuite_kit::ApiError;
use weldsuite_ports::{DynCache, DynJobs, DynRealtimePublisher, FileStores};

pub use tables::Table;

/// What the CRM code reaches outside the tenant database: the workers'
/// `env`, as ports.
#[derive(Clone)]
pub struct CrmServices {
    pub events: EntityEventPublisher,
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    pub files: Option<FileStores>,
    pub cache: Option<Arc<dyn DynCache>>,
    pub jobs: Option<Arc<dyn DynJobs>>,
    /// The worker's plain settings (`R2_PUBLIC_URL`, `ENVIRONMENT`, …).
    pub env: Arc<HashMap<String, String>>,
}

impl CrmServices {
    /// A setting of `env`.
    pub fn env(&self, name: &str) -> Option<&str> {
        self.env.get(name).map(String::as_str)
    }
}

/// What the services refuse with, and failures.
#[derive(Debug)]
pub enum DomainError {
    /// A member id field names nobody in the workspace (`InvalidMemberIdError`).
    InvalidMemberId {
        message: String,
        field: String,
    },
    /// A status the workspace doesn't define (`InvalidStatusError`).
    InvalidStatus {
        message: String,
        field: String,
    },
    /// `ifVersion` no longer matches (`*VersionConflictError`).
    VersionConflict(String),
    /// An active person already has this email (`PersonDuplicateEmailError`).
    DuplicateEmail {
        message: String,
        existing_person_id: String,
    },
    /// A 400 with the message.
    BadRequest(String),
    Database(sqlx::Error),
    /// Anything else (`throw new Error(message)`).
    Other(String),
}

impl DomainError {
    /// The refusal a route answers for this error as the CRM routes map
    /// them; `Err(message)` for a failure the route answers with its 500.
    pub fn into_api_error(self) -> Result<ApiError, String> {
        match self {
            Self::InvalidMemberId { message, field } | Self::InvalidStatus { message, field } => {
                Ok(ApiError::bad_request(message)
                    .with_details(serde_json::json!({ "field": field })))
            }
            Self::VersionConflict(message) => Ok(ApiError::conflict(message)),
            Self::DuplicateEmail {
                message,
                existing_person_id,
            } => Ok(ApiError::conflict(message)
                .with_details(serde_json::json!({ "existingPersonId": existing_person_id }))),
            Self::BadRequest(message) => Ok(ApiError::bad_request(message)),
            Self::Database(error) => Err(error.to_string()),
            Self::Other(message) => Err(message),
        }
    }

    /// The message, as `err.message` reads it.
    pub fn message(&self) -> String {
        match self {
            Self::InvalidMemberId { message, .. }
            | Self::InvalidStatus { message, .. }
            | Self::VersionConflict(message)
            | Self::DuplicateEmail { message, .. }
            | Self::BadRequest(message)
            | Self::Other(message) => message.clone(),
            Self::Database(error) => error.to_string(),
        }
    }
}

impl From<sqlx::Error> for DomainError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

pub type DomainResult<T> = Result<T, DomainError>;

/// `new Date()` as Drizzle writes it: UTC with milliseconds.
pub fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `new Date(text).toISOString()`; an invalid date is the `RangeError`
/// Drizzle throws when it writes one.
pub fn to_iso(text: &str) -> DomainResult<String> {
    js::js_date(text).ok_or_else(|| DomainError::Other("Invalid time value".to_owned()))
}

/// `value ? new Date(value) : null` for a string field of a parsed body.
pub fn date_or_null(value: Option<&Value>) -> DomainResult<Value> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Ok(Value::String(to_iso(text)?)),
        _ => Ok(Value::Null),
    }
}

/// A row read with `to_jsonb(t)`, as Drizzle returns it.
pub fn drizzle_row(row: Value) -> Value {
    weldsuite_db::js_row(row)
}

/// `obj[key]` of a JSON object, `None` when absent.
pub fn field<'a>(row: &'a Value, key: &str) -> Option<&'a Value> {
    row.get(key)
}

/// A string field of a row, `None` when absent or null.
pub fn str_field<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `{ ...a, ...b }` of two objects.
pub fn spread(a: &Map<String, Value>, b: &Map<String, Value>) -> Map<String, Value> {
    let mut out = a.clone();
    for (key, value) in b {
        out.insert(key.clone(), value.clone());
    }
    out
}
