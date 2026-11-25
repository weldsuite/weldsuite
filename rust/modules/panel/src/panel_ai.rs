//! What WeldPanel's AI calls share (`services/ai-summaries.ts`,
//! `services/explain.ts`, `http.ts`'s `aiFailure`).
//!
//! panel-api calls `@weldsuite/ai` with an explicit model (Claude Haiku for
//! one session and for a root-cause narrative, `recommended.summarize.quality`
//! for a set's themes) through the Cloudflare AI Gateway, and meters each call
//! with `@weldsuite/core-domain/ai-billing`. Here the install's AI
//! (`weldsuite_ai`, ADR AI-012) picks the model: the catalog has no WeldPanel
//! feature, so the calls run as [`FEATURE`] at the task and tier of the
//! model panel-api names (Mistral on EU). The crate meters as panel-api does:
//! the wallet is checked before every call ([`Ai::assert_credits`], 402 when
//! it holds less than a credit and the credit gate is on), and the model that
//! served is charged after it, under the same ledger `op` and reference
//! (`AI (<op>) [<model>]`).
//!
//! Without AI on the install every call answers as panel-api without its
//! gateway configured.

use axum::response::{IntoResponse, Response};
use http::StatusCode;
use serde_json::{Value, json};
use weldsuite_ai::{Ai, AiCall, AiError, ChatRequest, ChatResponse, Feature, Task, Tier};
use weldsuite_kit::ApiError;

use crate::recordings::Failure;
use crate::{Caller, PanelState};

/// The feature WeldPanel's calls run as: the workspace's general AI (the
/// catalog, `packages/core/ai/src/catalog.ts`, has no WeldPanel entry).
pub(crate) const FEATURE: Feature = Feature::Assistant;

/// What `assertGatewayConfigured` throws without the gateway's account:
/// the message panel-api answers a 503 `AI_NOT_CONFIGURED` with.
pub(crate) const NOT_CONFIGURED: &str = "AI gateway is not configured (missing CF_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID) for provider \"cloudflare\"";

/// What an AI route can fail with besides its own refusals.
#[derive(Debug)]
pub(crate) enum AiFailure {
    /// The install has no AI (`PanelAiError('AI_NOT_CONFIGURED', …, 503)`).
    NotConfigured,
    /// The wallet can't pay (`InsufficientAiCreditsError`): 402.
    Credits { balance: i64, required: i64 },
    /// The model call failed (`AI_REQUEST_FAILED`, 502).
    RequestFailed(String),
    /// The model answered, but not what its schema asks (`AI_BAD_ANSWER`,
    /// 502); charged all the same.
    BadAnswer,
    /// The project switched AI off (`AiDisabledError`): 403 `AI_DISABLED`.
    Disabled,
    /// A filter that matches no session (`NoSessionsError`): 404.
    NoSessions,
    /// Not the AI: the query layer's answer (`queryFailure`).
    Query(Failure),
}

impl From<Failure> for AiFailure {
    fn from(failure: Failure) -> Self {
        Self::Query(failure)
    }
}

impl From<sea_orm::DbErr> for AiFailure {
    fn from(error: sea_orm::DbErr) -> Self {
        Self::Query(Failure::from(error))
    }
}

impl From<sqlx::Error> for AiFailure {
    fn from(error: sqlx::Error) -> Self {
        Self::Query(Failure::from(error))
    }
}

impl From<AiError> for AiFailure {
    fn from(error: AiError) -> Self {
        match error {
            AiError::Unavailable => Self::NotConfigured,
            AiError::InsufficientCredits { balance, required } => {
                Self::Credits { balance, required }
            }
            AiError::Database(error) => Self::Query(Failure::from(error)),
            other => Self::RequestFailed(other.to_string()),
        }
    }
}

fn coded(status: StatusCode, code: &'static str, message: &str) -> Response {
    ApiError::new(status, code, message).into_response()
}

impl AiFailure {
    /// `aiFailure(c, err)`.
    pub(crate) fn into_response(self) -> Response {
        match self {
            Self::Credits { balance, required } => ApiError::payment_required(
                "INSUFFICIENT_CREDITS",
                "Insufficient credits. Top up your workspace balance to continue.",
            )
            .with_details(json!({ "requiredCredits": required, "availableCredits": balance }))
            .into_response(),
            Self::Disabled => coded(
                StatusCode::FORBIDDEN,
                "AI_DISABLED",
                "AI summaries are switched off for this project",
            ),
            Self::NoSessions => coded(
                StatusCode::NOT_FOUND,
                "NO_SESSIONS",
                "No sessions match this filter",
            ),
            Self::NotConfigured => coded(
                StatusCode::SERVICE_UNAVAILABLE,
                "AI_NOT_CONFIGURED",
                NOT_CONFIGURED,
            ),
            Self::RequestFailed(error) => {
                tracing::error!(%error, "[panel-api] AI model call failed");
                coded(
                    StatusCode::BAD_GATEWAY,
                    "AI_REQUEST_FAILED",
                    "The AI request failed",
                )
            }
            Self::BadAnswer => coded(
                StatusCode::BAD_GATEWAY,
                "AI_BAD_ANSWER",
                "The AI did not return a usable summary",
            ),
            Self::Query(failure) => failure.into_response(),
        }
    }
}

/// The AI and the caller's context for its calls (`SummaryDeps`).
#[derive(Clone)]
pub(crate) struct AiDeps {
    pub(crate) ai: Option<Ai>,
    workspace_id: String,
    user_id: String,
    tenant: weldsuite_db::PgPool,
    master: Option<weldsuite_db::PgPool>,
}

impl AiDeps {
    pub(crate) fn new(caller: &Caller, state: &PanelState) -> Self {
        Self {
            ai: caller.ai(state),
            workspace_id: caller.workspace_id.clone(),
            user_id: caller.user_id.clone(),
            tenant: caller.db.clone(),
            master: caller.master(state),
        }
    }

    /// `gateway(deps)`: the AI, or the 503 of panel-api without its gateway.
    pub(crate) fn ai(&self) -> Result<&Ai, AiFailure> {
        self.ai.as_ref().ok_or(AiFailure::NotConfigured)
    }

    /// A call's context: WeldPanel's feature at `tier`, summarising, metered
    /// on the workspace's wallet under `op` with `reference` as the ledger's
    /// reference (the summary's id).
    pub(crate) fn call(&self, tier: Tier, op: &str, reference: &str) -> AiCall {
        AiCall::new(&self.workspace_id, FEATURE, Task::Summarize, tier)
            .user(&self.user_id)
            .tenant(self.tenant.clone())
            .master(self.master.clone())
            .op(op)
            .reference(reference)
    }
}

/// `assertAiCredits` then `generateObject`: one structured answer, charged
/// for the model that served. The object is the model's JSON as parsed;
/// its shape is the caller's to check (`AI_BAD_ANSWER`).
pub(crate) async fn generate_object(
    ai: &Ai,
    call: &AiCall,
    system: &str,
    prompt: String,
    schema: Value,
) -> Result<(Value, ChatResponse), AiFailure> {
    ai.assert_credits(call).await?;
    let answer = ai
        .chat(
            call,
            ChatRequest::system_user(system, prompt).schema("response", schema),
        )
        .await?;
    let object = answer.object.clone().unwrap_or(Value::Null);
    Ok((object, answer))
}

/// A string of `min..=max` UTF-16 units (`z.string().min().max()`).
pub(crate) fn text_within(value: Option<&Value>, min: usize, max: usize) -> Option<String> {
    let text = value?.as_str()?;
    let units = text.encode_utf16().count();
    (min..=max).contains(&units).then(|| text.to_owned())
}
