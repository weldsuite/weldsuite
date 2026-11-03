//! The errors of the US sales tax flow: the engine's
//! (`SalesTaxEngineError`, `@weldsuite/books-domain/sales-tax`) and the
//! document flow's (`services/sales-tax/errors.ts`: `SalesTaxDocumentError`,
//! `SalesTaxSetupError`), and how a route answers them
//! (`salesTaxErrorResponse`).

use axum::Json;
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use serde_json::{Map, Value, json};

/// `SalesTaxEngineError`: the engine could not calculate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineError {
    pub message: String,
    /// `unreachable` | `auth` | `invalid_request` | `not_configured` | `rate_limited`.
    pub code: &'static str,
    pub retryable: bool,
}

/// `SalesTaxDocumentError`: a document the flow refuses, with the API code
/// the UI acts on.
#[derive(Debug, Clone, PartialEq)]
pub struct DocumentError {
    /// `ADDRESS_REQUIRED` | `TAX_ENGINE_UNAVAILABLE` | `TAX_RATES_NOT_CONFIGURED` |
    /// `USE_TAX_ENGINE_UNSUPPORTED` | `CREDIT_LINE_NOT_ON_ORIGINAL` |
    /// `TAX_NOT_CALCULATED` | `TAX_COMMIT_NOT_APPLICABLE`.
    pub code: &'static str,
    pub message: String,
    /// 400, 409 or 503.
    pub status: u16,
    pub details: Option<Map<String, Value>>,
}

impl DocumentError {
    /// `new SalesTaxDocumentError(code, message)` (status 400).
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            status: 400,
            details: None,
        }
    }
}

/// `SalesTaxSetupError`: a setup object the request can't create or change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupError {
    pub message: String,
    /// 400, 404 or 409.
    pub status: u16,
}

/// Any sales tax refusal a route answers itself.
#[derive(Debug, Clone, PartialEq)]
pub enum SalesTaxError {
    Engine(EngineError),
    Document(DocumentError),
    Setup(SetupError),
}

impl From<EngineError> for SalesTaxError {
    fn from(error: EngineError) -> Self {
        Self::Engine(error)
    }
}

impl From<DocumentError> for SalesTaxError {
    fn from(error: DocumentError) -> Self {
        Self::Document(error)
    }
}

impl From<SetupError> for SalesTaxError {
    fn from(error: SetupError) -> Self {
        Self::Setup(error)
    }
}

/// `addressRequired()`.
pub fn address_required() -> DocumentError {
    DocumentError::new(
        "ADDRESS_REQUIRED",
        "A ship-to (or bill-to) address with a state and ZIP code is required to calculate sales tax. Add it to the invoice before finalizing.",
    )
}

/// `engineUnavailable(err)`: the engine's failure as the document flow
/// reports it (503 when retrying may help).
pub fn engine_unavailable(error: &EngineError) -> DocumentError {
    let retryable = error.code == "unreachable" || error.code == "rate_limited";
    let mut details = Map::new();
    details.insert("engineCode".into(), Value::String(error.code.into()));
    details.insert("retryable".into(), Value::Bool(retryable));
    DocumentError {
        code: "TAX_ENGINE_UNAVAILABLE",
        message: format!(
            "The sales tax engine could not calculate tax: {}. The invoice was not posted.{}",
            error.message,
            if retryable {
                " Try again in a moment."
            } else {
                ""
            }
        ),
        status: if retryable { 503 } else { 400 },
        details: Some(details),
    }
}

fn status_of(status: u16) -> StatusCode {
    StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST)
}

impl SalesTaxError {
    /// `salesTaxErrorResponse(c, err)`.
    pub fn response(&self) -> Response {
        match self {
            Self::Setup(error) => {
                let code = match error.status {
                    404 => "NOT_FOUND",
                    409 => "CONFLICT",
                    _ => "BAD_REQUEST",
                };
                (
                    status_of(error.status),
                    Json(json!({ "error": { "code": code, "message": error.message } })),
                )
                    .into_response()
            }
            Self::Document(error) => document_response(error),
            Self::Engine(error) => document_response(&engine_unavailable(error)),
        }
    }
}

fn document_response(error: &DocumentError) -> Response {
    let mut body = Map::new();
    body.insert("code".into(), Value::String(error.code.into()));
    body.insert("message".into(), Value::String(error.message.clone()));
    // `details: undefined` is left out of the JSON.
    if let Some(details) = &error.details {
        body.insert("details".into(), Value::Object(details.clone()));
    }
    (
        status_of(error.status),
        Json(json!({ "error": Value::Object(body) })),
    )
        .into_response()
}
