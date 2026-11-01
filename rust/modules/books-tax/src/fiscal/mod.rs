//! Brazilian fiscal documents through Focus NFe (books-api's `br-fiscal/*`):
//! issuing, refreshing, cancelling and correcting the NF-e / NFS-e of an
//! invoice (`/api/fiscal-documents`), the NF-e received from suppliers
//! (`/api/received-fiscal-documents`), and Focus' webhook
//! (`/public/fiscal-webhooks/:token`).

pub(crate) mod documents;
pub(crate) mod focus;
pub(crate) mod nfe_xml;
pub(crate) mod payload;
pub(crate) mod received;
pub(crate) mod settings;
pub(crate) mod webhooks;

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::http::Refusal;
use weldsuite_books_domain::tables::ENTITIES;
use weldsuite_kit::ApiError;

use crate::vat_returns::has_feature;
use focus::ProviderError;
use payload::PayloadError;

/// What the fiscal services throw (`FiscalDocumentError`, `BrPayloadError`,
/// `FiscalProviderError`) and their failures.
#[derive(Debug)]
pub(crate) enum FiscalError {
    /// `FiscalDocumentError`: 400, 404 or 409.
    Document {
        message: String,
        status: u16,
        details: Option<Value>,
    },
    Payload(PayloadError),
    Provider(ProviderError),
    /// Answered as it is (a refusal of another kind, a 500).
    Refusal(Refusal),
}

impl From<sqlx::Error> for FiscalError {
    fn from(error: sqlx::Error) -> Self {
        Self::Refusal(Refusal::Database(error))
    }
}

impl From<Refusal> for FiscalError {
    fn from(refusal: Refusal) -> Self {
        Self::Refusal(refusal)
    }
}

impl From<ProviderError> for FiscalError {
    fn from(error: ProviderError) -> Self {
        Self::Provider(error)
    }
}

impl From<PayloadError> for FiscalError {
    fn from(error: PayloadError) -> Self {
        Self::Payload(error)
    }
}

impl FiscalError {
    pub(crate) fn bad(message: impl Into<String>) -> Self {
        Self::Document {
            message: message.into(),
            status: 400,
            details: None,
        }
    }

    pub(crate) fn status(message: impl Into<String>, status: u16, details: Option<Value>) -> Self {
        Self::Document {
            message: message.into(),
            status,
            details,
        }
    }

    /// `fiscalErrorResponse(c, err)`.
    pub(crate) fn refusal(self) -> Refusal {
        match self {
            Self::Document {
                message,
                status: 404,
                ..
            } => ApiError::not_found(&message, None).into(),
            Self::Document {
                message,
                status: 409,
                details,
            } => match details {
                Some(details) => Refusal::conflict_with(message, details),
                None => Refusal::conflict(message),
            },
            Self::Document {
                message, details, ..
            } => match details {
                Some(details) => Refusal::bad_request_with(message, details),
                None => Refusal::bad_request(message),
            },
            Self::Payload(error) => {
                Refusal::bad_request_with(error.message, json!({ "missing": error.missing }))
            }
            Self::Provider(error) => {
                if error.is_rejection() || error.is_auth_failure() {
                    let mut details = serde_json::Map::new();
                    details.insert("provider".into(), json!("focus_nfe"));
                    if let Some(codigo) = &error.codigo {
                        details.insert("codigo".into(), json!(codigo));
                    }
                    details.insert("erros".into(), error.erros_json());
                    Refusal::bad_request_with(error.detail(), Value::Object(details))
                } else {
                    ApiError::bad_gateway().with_message(error.detail()).into()
                }
            }
            Self::Refusal(refusal) => refusal,
        }
    }
}

/// `requireFiscalEntity(db, entityId)`: a live entity of a jurisdiction
/// with fiscal documents (Brazil).
pub(crate) async fn require_fiscal_entity(db: &PgPool, entity_id: &str) -> Result<Value, FiscalError> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(entities),
        " from entities t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    let Some(entity) = row.map(|row| ENTITIES.js(row)) else {
        return Err(FiscalError::status(
            format!("Accounting entity {entity_id} not found"),
            404,
            None,
        ));
    };
    if !has_feature(entity["jurisdictionCode"].as_str(), "fiscalDocuments") {
        return Err(FiscalError::bad(
            "Fiscal documents (NF-e / NFS-e) are only available for Brazilian accounting entities",
        ));
    }
    Ok(entity)
}

/// The request's entity (`requireEntity(c, db)`).
pub(crate) async fn require_entity(
    caller: &weldsuite_books_domain::http::Caller,
) -> Result<Value, FiscalError> {
    let Some(entity_id) = weldsuite_books_domain::entity_context::resolve_entity_id(caller).await?
    else {
        return Err(FiscalError::bad(
            "No accounting entity resolved. Set X-Accounting-Entity-Id or configure a default entity.",
        ));
    };
    require_fiscal_entity(&caller.db, &entity_id).await
}

/// `str(value)`: a non-empty string, or a number as text.
pub(crate) fn str_of(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        Some(Value::Number(n)) => Some(weldsuite_books_domain::js::number_text(
            n.as_f64().unwrap_or(f64::NAN),
        )),
        _ => None,
    }
}

/// `page` / `pageSize` of a list (`Math.max(parseInt(q.page || '1') || 1, 1)`, …).
pub(crate) fn page_of(q: &weldsuite_books_domain::http::Query) -> (i64, i64) {
    let int = |key: &str, fallback: i64| {
        let raw = q.present(key).unwrap_or_default();
        let raw = if raw.is_empty() {
            fallback.to_string()
        } else {
            raw.to_owned()
        };
        weldsuite_books_domain::js::parse_int(&raw)
            .filter(|v| *v != 0)
            .unwrap_or(fallback)
    };
    let page = int("page", 1).max(1);
    let size = int("pageSize", 25).clamp(1, 100);
    (page, size)
}
