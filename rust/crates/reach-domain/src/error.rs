//! `ReachDomainError` (`errors.ts`) and reach-api's `ReachServiceError`: a
//! refusal with its status, code, message and details, which every route
//! answers as `{ error: { code, message, details? } }`. Anything else that
//! goes wrong is [`ReachError::unexpected`]: reach-api's `reachErrorHandler`
//! answers it 500 `INTERNAL_ERROR` "An unexpected error occurred".

use std::fmt;

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct ReachError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

pub type ReachResult<T> = Result<T, ReachError>;

impl ReachError {
    /// A refusal with its own status and code (`new ReachServiceError(...)`).
    pub fn new(status: u16, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.to_owned(),
            message: message.into(),
            details: None,
        }
    }

    #[must_use]
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, "BAD_REQUEST", message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(403, "FORBIDDEN", message)
    }

    /// `reachError.notFound(resource, id)`.
    pub fn not_found(resource: &str, id: Option<&str>) -> Self {
        let message = match id {
            Some(id) if !id.is_empty() => format!("{resource} with ID '{id}' not found"),
            _ => format!("{resource} not found"),
        };
        Self::new(404, "NOT_FOUND", message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, "CONFLICT", message)
    }

    /// `reachError.state(code, message)`: a 409 with its own code.
    pub fn state(code: &str, message: impl Into<String>) -> Self {
        Self::new(409, code, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(500, "INTERNAL_ERROR", message)
    }

    pub fn bad_gateway(message: impl Into<String>) -> Self {
        Self::new(502, "UPSTREAM_ERROR", message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(503, "SERVICE_UNAVAILABLE", message)
    }

    /// An error no route maps: logged, answered 500.
    pub fn unexpected(error: &dyn fmt::Display) -> Self {
        tracing::error!(%error, "[reach] unhandled error");
        Self::new(500, "INTERNAL_ERROR", "An unexpected error occurred")
    }
}

impl fmt::Display for ReachError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}: {}", self.status, self.code, self.message)
    }
}

impl std::error::Error for ReachError {}

impl From<sqlx::Error> for ReachError {
    fn from(error: sqlx::Error) -> Self {
        Self::unexpected(&error)
    }
}
