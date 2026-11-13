//! Metering: the Rust twin of `@weldsuite/core-domain/ai-billing` (AI-005 to
//! AI-007). Charge the model that served, at the shared rate table:
//! `max(1, ceil(cost × 2.5 × 100))` credits, into the master
//! `workspace_credits` wallet (`weldsuite_core_domain::credits`), with the ops
//! ledger row (`ai_provider_usage`, `gateway = 'direct'`, `key_source`,
//! `feature`) for every call on WeldSuite's account. A charge the wallet can't
//! cover is booked as a negative adjustment (debt). Own-key calls write the
//! ops ledger with `key_source = 'own'` and no credits.

use crate::catalog::ProviderId;
use crate::config::AiConfig;
use crate::error::AiError;
use crate::policy::{Route, Target};
use crate::types::Usage;
use crate::AiCall;

/// The hard gate: with `AI_CREDIT_GATE` on and WeldSuite paying the primary
/// target, at least one credit in the wallet.
pub async fn assert_credits(config: &AiConfig, call: &AiCall, route: &Route) -> Result<(), AiError> {
    let _ = (config, call, route);
    todo!("AI-012 phase 1")
}

/// USD cost of a call on `model` (per token, per page or per minute).
pub fn provider_cost_usd(model: &str, usage: Usage, pages: u32, seconds: f64) -> f64 {
    let _ = (model, usage, pages, seconds);
    todo!("AI-012 phase 1")
}

/// Credits for a USD cost, at least 1.
pub fn credits_for_cost_usd(cost_usd: f64) -> i64 {
    let _ = cost_usd;
    todo!("AI-012 phase 1")
}

/// Charge one completed call on `served` and write the ops ledger. Never
/// fails the call: an error is logged and 0 returned.
pub async fn charge(config: &AiConfig, call: &AiCall, served: &Target, cost_usd: f64, usage: Usage) -> i64 {
    let _ = (config, call, served, cost_usd, usage, ProviderId::Mistral);
    todo!("AI-012 phase 1")
}
