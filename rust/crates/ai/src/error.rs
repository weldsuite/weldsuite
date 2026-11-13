//! What an AI call can answer besides a completion, and the HTTP answer each
//! maps to.

use weldsuite_kit::ApiError;

use crate::catalog::ProviderId;

#[derive(Debug)]
pub enum AiError {
    /// The install has no AI provider: 503 `ai_unavailable`, as the
    /// TypeScript workers answer without their model.
    Unavailable,
    /// A model the client sent that the workspace policy doesn't allow: 422
    /// `AI_MODEL_NOT_ALLOWED`.
    ModelNotAllowed { model: String },
    /// The hard gate (`AI_CREDIT_GATE`): 402 `INSUFFICIENT_CREDITS`.
    InsufficientCredits { balance: i64, required: i64 },
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
    /// 402 `INSUFFICIENT_CREDITS`, 502 for a provider failure, 500 otherwise.
    /// Routes whose worker answers differently map the error themselves.
    pub fn into_api_error(self) -> ApiError {
        todo!("AI-012 phase 1: {self}")
    }
}
