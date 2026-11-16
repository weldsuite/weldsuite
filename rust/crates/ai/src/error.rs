//! What an AI call can answer besides a completion, and the HTTP answer each
//! maps to.

use http::StatusCode;
use weldsuite_kit::{ApiError, CreditShortfall};

use crate::catalog::ProviderId;

#[derive(Debug)]
pub enum AiError {
    /// The install has no AI provider: 503 `ai_unavailable`, as the
    /// TypeScript workers answer without their model.
    Unavailable,
    /// A model the client sent that the workspace policy doesn't allow: 422
    /// `AI_MODEL_NOT_ALLOWED`.
    ModelNotAllowed {
        model: String,
    },
    /// The hard gate (`AI_CREDIT_GATE`): 402 `INSUFFICIENT_CREDITS`.
    InsufficientCredits {
        balance: i64,
        required: i64,
    },
    /// The provider (and its fallback) failed. Routes answer as their worker
    /// does when the model call throws.
    Provider {
        provider: ProviderId,
        status: Option<u16>,
        message: String,
    },
    /// The answer didn't match the requested schema, or the request was
    /// malformed.
    Invalid(String),
    Database(sqlx::Error),
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => f.write_str("AI is currently unavailable"),
            Self::ModelNotAllowed { model } => write!(f, "model {model} is not allowed"),
            Self::InsufficientCredits { balance, required } => {
                write!(f, "insufficient credits ({balance} < {required})")
            }
            Self::Provider {
                provider,
                status,
                message,
            } => write!(f, "{} answered {status:?}: {message}", provider.as_str()),
            Self::Invalid(message) => f.write_str(message),
            Self::Database(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for AiError {}

impl From<sqlx::Error> for AiError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl AiError {
    /// The standard answer: 503 `ai_unavailable`, 422 `AI_MODEL_NOT_ALLOWED`,
    /// 402 `INSUFFICIENT_CREDITS`, 502 for a provider failure (and an answer
    /// that doesn't match its schema), 500 for the database. Routes whose
    /// worker answers differently map the error themselves.
    pub fn into_api_error(self) -> ApiError {
        match self {
            Self::Unavailable => ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "ai_unavailable",
                "AI is currently unavailable",
            ),
            Self::ModelNotAllowed { model } => ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "AI_MODEL_NOT_ALLOWED",
                format!("The model {model} is not allowed in this workspace"),
            )
            .with_details(serde_json::json!({ "model": model })),
            Self::InsufficientCredits { balance, required } => {
                #[allow(clippy::cast_precision_loss)]
                let shortfall = CreditShortfall {
                    current_balance: Some(balance as f64),
                    required: Some(required as f64),
                    shortfall: Some((required - balance).max(0) as f64),
                };
                ApiError::insufficient_credits(Some(shortfall))
            }
            Self::Provider {
                provider, status, ..
            } => {
                tracing::warn!(
                    provider = provider.as_str(),
                    status,
                    "[weldsuite-ai] the AI provider failed"
                );
                ApiError::bad_gateway()
            }
            Self::Invalid(message) => {
                tracing::warn!(%message, "[weldsuite-ai] unusable AI answer");
                ApiError::bad_gateway()
            }
            Self::Database(error) => {
                tracing::error!(%error, "[weldsuite-ai] database error");
                ApiError::internal()
            }
        }
    }

    /// The provider's HTTP status, for a provider failure.
    pub fn provider_status(&self) -> Option<u16> {
        match self {
            Self::Provider { status, .. } => *status,
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_map_to_their_answers() {
        let unavailable = AiError::Unavailable.into_api_error();
        assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(unavailable.code(), "ai_unavailable");
        assert_eq!(unavailable.message(), "AI is currently unavailable");

        let refused = AiError::ModelNotAllowed {
            model: "openai/gpt-5".to_owned(),
        }
        .into_api_error();
        assert_eq!(refused.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(refused.code(), "AI_MODEL_NOT_ALLOWED");
        assert_eq!(
            refused.details(),
            Some(&serde_json::json!({ "model": "openai/gpt-5" }))
        );

        let broke = AiError::InsufficientCredits {
            balance: -3,
            required: 1,
        }
        .into_api_error();
        assert_eq!(broke.status(), StatusCode::PAYMENT_REQUIRED);
        assert_eq!(broke.code(), "INSUFFICIENT_CREDITS");
        assert_eq!(
            broke.details(),
            Some(&serde_json::json!({ "currentBalance": -3.0, "required": 1.0, "shortfall": 4.0 }))
        );

        let provider = AiError::Provider {
            provider: ProviderId::Mistral,
            status: Some(500),
            message: "boom".to_owned(),
        };
        assert_eq!(provider.provider_status(), Some(500));
        assert_eq!(provider.into_api_error().status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            AiError::Invalid("not json".to_owned())
                .into_api_error()
                .status(),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            AiError::Database(sqlx::Error::RowNotFound)
                .into_api_error()
                .status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
