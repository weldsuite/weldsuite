//! Metering: the Rust twin of `@weldsuite/core-domain/ai-billing` (AI-005 to
//! AI-007). Charge the model that served, at the shared rate table:
//! `max(1, ceil(cost × 2.5 × 100))` credits, into the master
//! `workspace_credits` wallet (`weldsuite_core_domain::credits`), with the ops
//! ledger row (`ai_provider_usage`, `gateway = 'direct'`, `key_source`,
//! `feature`) for every call on WeldSuite's account. A charge the wallet can't
//! cover is booked as a negative adjustment (debt). Own-key calls write the
//! ops ledger with `key_source = 'own'`, no cost and no credits. An install
//! with `AI_BILLING=display` meters (the ops ledger, with the credits the call
//! would have cost) and never charges.
//!
//! Fail-open, as the TypeScript twin: without a master database, or when the
//! wallet can't be reached, the call still runs, unmetered.

use serde_json::{Value, json};
use weldsuite_core_domain::credits::{
    self, Consumed, GrantKind, LedgerEntry, check_credits, consume_credits_by, grant_credits,
};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;

use crate::AiCall;
use crate::catalog::{self, KeySource};
use crate::config::{AiConfig, BillingMode};
use crate::error::AiError;
use crate::policy::{Route, Target};
use crate::types::Usage;

/// Smallest balance allowed before the hard gate blocks a call.
pub const MIN_PRECHECK_CREDITS: i64 = 1;

/// The longest `reference_id` the ledgers hold (`varchar(30)`).
const MAX_REFERENCE_ID: usize = 30;
/// The longest `op` the ops ledger holds (`varchar(30)`).
const MAX_OP: usize = 30;

/// Whether the hard gate applies to `route`: `AI_CREDIT_GATE` on, credits
/// billing, and WeldSuite paying the primary target.
pub fn gated(config: &AiConfig, route: &Route) -> bool {
    config.credit_gate
        && config.billing == BillingMode::Credits
        && route.primary.key_source == KeySource::Weldsuite
}

/// `resolveAiMetering`: the wallet's workspace, or `None` (unmetered).
async fn metering(call: &AiCall) -> Option<(&PgPool, String)> {
    let master = call.master.as_ref()?;
    match credits::resolve_internal_workspace_id(master, &call.workspace_id).await {
        Ok(Some(id)) => Some((master, id)),
        Ok(None) => {
            tracing::warn!(workspace = %call.workspace_id, "[weldsuite-ai] no master workspace; unmetered");
            None
        }
        Err(error) => {
            tracing::warn!(%error, "[weldsuite-ai] credit metering unavailable");
            None
        }
    }
}

/// The hard gate: with `AI_CREDIT_GATE` on and WeldSuite paying the primary
/// target, at least one credit in the wallet.
pub async fn assert_credits(
    config: &AiConfig,
    call: &AiCall,
    route: &Route,
) -> Result<(), AiError> {
    if !gated(config, route) {
        return Ok(());
    }
    let Some((master, workspace)) = metering(call).await else {
        return Ok(());
    };
    match check_credits(master, &workspace, MIN_PRECHECK_CREDITS).await {
        Ok(check) if !check.available => Err(AiError::InsufficientCredits {
            balance: check.current_balance,
            required: check.required,
        }),
        Ok(_) => Ok(()),
        Err(error) => {
            tracing::warn!(%error, "[weldsuite-ai] credit check unavailable; letting the call run");
            Ok(())
        }
    }
}

#[allow(clippy::cast_precision_loss)]
fn tokens(count: i64) -> f64 {
    count.max(0) as f64
}

/// USD cost of a call on `model` (per token, per page or per minute):
/// `providerCostUsd`.
pub fn provider_cost_usd(model: &str, usage: Usage, pages: u32, seconds: f64) -> f64 {
    let price = catalog::price(model);
    let mut cost = (tokens(usage.input_tokens) / 1_000_000.0) * price.input_per_m
        + (tokens(usage.output_tokens) / 1_000_000.0) * price.output_per_m;
    if pages > 0
        && let Some(per_page) = price.per_page
    {
        cost += f64::from(pages) * per_page;
    }
    if seconds > 0.0
        && let Some(per_minute) = price.per_minute
    {
        cost += (seconds / 60.0) * per_minute;
    }
    cost
}

/// USD cost of reading `pages` with an OCR model, with document annotations
/// (structured extraction) or without.
pub fn ocr_cost_usd(model: &str, pages: u32, annotated: bool) -> f64 {
    let price = catalog::price(model);
    let per_page = if annotated {
        price.per_page_annotated.or(price.per_page)
    } else {
        price.per_page
    };
    per_page.map_or(0.0, |per_page| f64::from(pages) * per_page)
}

/// Credits for a USD cost, at least 1 (`creditsForCostUsd`).
pub fn credits_for_cost_usd(cost_usd: f64) -> i64 {
    if cost_usd.is_nan() || cost_usd <= 0.0 {
        return 1;
    }
    let credits = (cost_usd * catalog::provider_markup() * catalog::credits_per_usd()).ceil();
    #[allow(clippy::cast_possible_truncation)]
    let credits = credits.min(9.0e15) as i64;
    credits.max(1)
}

/// USD → integer nano-USD (`nanoUsd`): never negative.
pub fn nano_usd(usd: f64) -> i64 {
    if !usd.is_finite() || usd <= 0.0 {
        return 0;
    }
    #[allow(clippy::cast_possible_truncation)]
    let nano = (usd * 1e9).round().min(9.0e18) as i64;
    nano
}

fn clamp_i32(value: i64) -> i64 {
    value.clamp(0, i64::from(i32::MAX))
}

/// What the wallet and the ops ledger record for one call.
struct Charge<'a> {
    workspace: &'a str,
    call: &'a AiCall,
    served: &'a Target,
    usage: Usage,
    cost_usd: f64,
    credits: i64,
}

impl Charge<'_> {
    fn op(&self) -> String {
        self.call.op_name().chars().take(MAX_OP).collect()
    }

    fn reference(&self) -> Option<&str> {
        self.call
            .reference_id
            .as_deref()
            .filter(|r| r.len() <= MAX_REFERENCE_ID)
    }

    fn metadata(&self) -> Value {
        let mut metadata = json!({
            "modelId": self.served.model,
            "op": self.call.op_name(),
            "feature": self.call.feature.as_str(),
            "inputTokens": self.usage.input_tokens,
            "outputTokens": self.usage.output_tokens,
            "gateway": "direct",
            "providerCostNanoUsd": nano_usd(self.cost_usd),
            "keySource": self.served.key_source.as_str(),
        });
        if let (Some(reference), None) = (&self.call.reference_id, self.reference())
            && let Some(fields) = metadata.as_object_mut()
        {
            fields.insert("referenceId".to_owned(), json!(reference));
        }
        metadata
    }

    /// `credit_transactions.reference_type`: `ai`, or the caller's.
    fn reference_type(&self) -> &str {
        self.call
            .ledger
            .as_ref()
            .map_or("ai", |tag| tag.reference_type.as_str())
    }

    /// The caller's idempotency key with `suffix` (`""`, `:debt`, `:usage`).
    fn idempotency_key(&self, suffix: &str) -> Option<String> {
        self.call
            .ledger
            .as_ref()
            .and_then(|tag| tag.idempotency_key.as_deref())
            .map(|key| format!("{key}{suffix}"))
    }

    fn entry(
        &self,
        amount: i64,
        description: String,
        metadata: Value,
        key_suffix: &str,
    ) -> LedgerEntry<'_> {
        LedgerEntry {
            workspace_id: self.workspace,
            amount,
            service_type: Some("ai_tokens"),
            idempotency_key: self.idempotency_key(key_suffix),
            reference_id: self.reference(),
            reference_type: Some(self.reference_type()),
            description: Some(description),
            metadata: Some(metadata),
        }
    }

    /// `consumeCredits`, or the debt when the wallet can't cover it. The
    /// credits charged.
    async fn settle(&self, master: &PgPool) -> i64 {
        let label = self
            .call
            .ledger
            .as_ref()
            .map_or("AI", |tag| tag.label.as_str());
        let description = format!("{label} ({}) [{}]", self.call.op_name(), self.served.model);
        let user = self.call.user_id.as_deref();
        let entry = self.entry(self.credits, description.clone(), self.metadata(), "");
        match consume_credits_by(master, &entry, user).await {
            Ok(Consumed::Ok { .. }) => self.credits,
            Ok(Consumed::Insufficient { .. }) => {
                let mut metadata = self.metadata();
                if let Some(fields) = metadata.as_object_mut() {
                    fields.insert("forcedSettlement".to_owned(), json!(true));
                }
                let debt = self.entry(
                    -self.credits,
                    format!("{description} — settled into negative balance"),
                    metadata,
                    ":debt",
                );
                match grant_credits(master, &debt, GrantKind::Adjustment, user).await {
                    Ok(_) => self.credits,
                    Err(error) => {
                        tracing::error!(%error, "[weldsuite-ai] credit settlement failed (untracked AI usage!)");
                        0
                    }
                }
            }
            Err(error) => {
                tracing::error!(%error, "[weldsuite-ai] credit settlement failed (untracked AI usage!)");
                0
            }
        }
    }

    /// The ops ledger row: what WeldSuite paid to serve the call. Never fails
    /// the call.
    async fn record(&self, master: &PgPool, credits_charged: i64) {
        let own = self.served.key_source == KeySource::Own;
        let cost = if own { 0 } else { nano_usd(self.cost_usd) };
        let result = sqlx::query(
            "insert into ai_provider_usage
                 (id, gateway, model_id, workspace_id, op, input_tokens, output_tokens,
                  provider_cost_nano_usd, covered_by_service_credit, credits_charged,
                  reference_type, reference_id, key_source, feature, idempotency_key)
             values ($1, 'direct', $2, $3, $4, $5::int, $6::int, $7, false, $8::int,
                     $9, $10, $11, $12, $13)
             on conflict (idempotency_key) do nothing",
        )
        .bind(generate_id("apu"))
        .bind(&self.served.model)
        .bind(self.workspace)
        .bind(self.op())
        .bind(clamp_i32(self.usage.input_tokens))
        .bind(clamp_i32(self.usage.output_tokens))
        .bind(cost)
        .bind(clamp_i32(credits_charged))
        .bind(self.reference_type())
        .bind(self.reference())
        .bind(self.served.key_source.as_str())
        .bind(self.call.feature.as_str())
        .bind(self.idempotency_key(":usage"))
        .execute(master)
        .await;
        if let Err(error) = result {
            tracing::error!(%error, "[weldsuite-ai] failed to record provider usage");
        }
    }
}

/// The credits a call on `served` is charged: none on an own key or a
/// display-only install, else [`credits_for_cost_usd`].
pub fn credits_for(config: &AiConfig, served: &Target, cost_usd: f64) -> i64 {
    if served.key_source == KeySource::Own || config.billing == BillingMode::Display {
        0
    } else {
        credits_for_cost_usd(cost_usd)
    }
}

/// Charge one completed call on `served` and write the ops ledger. Never
/// fails the call: an error is logged and 0 returned.
pub async fn charge(
    config: &AiConfig,
    call: &AiCall,
    served: &Target,
    cost_usd: f64,
    usage: Usage,
) -> i64 {
    let Some((master, workspace)) = metering(call).await else {
        return 0;
    };
    let credits = if served.key_source == KeySource::Own {
        0
    } else {
        credits_for_cost_usd(cost_usd)
    };
    let charge = Charge {
        workspace: &workspace,
        call,
        served,
        usage,
        cost_usd,
        credits,
    };
    let charged = if credits > 0 && config.billing == BillingMode::Credits {
        charge.settle(master).await
    } else {
        0
    };
    // A display-only install records what the call would have cost.
    let recorded = if config.billing == BillingMode::Display {
        credits
    } else {
        charged
    };
    charge.record(master, recorded).await;
    charged
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{ProviderId, Region};

    fn target(provider: ProviderId, model: &str, key_source: KeySource) -> Target {
        Target {
            provider,
            model: model.to_owned(),
            region: Region::Eu,
            key_source,
        }
    }

    fn usage(input: i64, output: i64) -> Usage {
        Usage {
            input_tokens: input,
            output_tokens: output,
        }
    }

    #[test]
    fn costs_follow_the_rate_table() {
        // Mistral Small 4: $0.15 / $0.60 per million.
        let cost = provider_cost_usd(
            "mistral/mistral-small-2603",
            usage(1_000_000, 1_000_000),
            0,
            0.0,
        );
        assert!((cost - 0.75).abs() < 1e-12);
        // Exactly the TypeScript arithmetic for Sonnet 5.5.
        let sonnet = provider_cost_usd("anthropic/claude-sonnet-5-5", usage(1000, 500), 0, 0.0);
        assert_eq!(
            sonnet.to_bits(),
            ((1000.0 / 1_000_000.0) * 2.0 + (500.0 / 1_000_000.0) * 10.0_f64).to_bits()
        );
        // Pages and minutes only count for models priced by them.
        assert_eq!(
            provider_cost_usd("anthropic/claude-sonnet-5-5", usage(1000, 500), 3, 60.0).to_bits(),
            sonnet.to_bits()
        );
        assert!(
            (provider_cost_usd("mistral/mistral-ocr-4-1", Usage::default(), 10, 0.0) - 0.04).abs()
                < 1e-12
        );
        assert!((ocr_cost_usd("mistral/mistral-ocr-4-1", 10, true) - 0.05).abs() < 1e-12);
        assert!((ocr_cost_usd("mistral/mistral-ocr-4-1", 10, false) - 0.04).abs() < 1e-12);
        assert!(ocr_cost_usd("anthropic/claude-sonnet-5-5", 10, true).abs() < f64::EPSILON);
        let voxtral = provider_cost_usd(
            "mistral/voxtral-mini-transcribe-3-0",
            Usage::default(),
            0,
            600.0,
        );
        assert!((voxtral - 0.035).abs() < 1e-12);
    }

    #[test]
    fn credits_are_cost_times_markup_rounded_up_at_least_one() {
        assert_eq!(credits_for_cost_usd(0.0), 1);
        assert_eq!(credits_for_cost_usd(-3.0), 1);
        assert_eq!(credits_for_cost_usd(f64::NAN), 1);
        assert_eq!(credits_for_cost_usd(0.000_01), 1);
        // $0.75 × 2.5 × 100 = 187.5 → 188.
        assert_eq!(credits_for_cost_usd(0.75), 188);
        // $0.04 of OCR → 10 credits.
        assert_eq!(credits_for_cost_usd(0.04), 10);
        assert_eq!(credits_for_cost_usd(1.0), 250);
    }

    #[test]
    fn nano_usd_is_never_negative() {
        assert_eq!(nano_usd(0.75), 750_000_000);
        assert_eq!(nano_usd(-1.0), 0);
        assert_eq!(nano_usd(f64::INFINITY), 0);
        assert_eq!(nano_usd(f64::NAN), 0);
    }

    #[test]
    fn own_keys_and_display_installs_are_not_charged() {
        let config = AiConfig::default();
        let weldsuite = target(
            ProviderId::Mistral,
            "mistral/mistral-small-2603",
            KeySource::Weldsuite,
        );
        let own = target(
            ProviderId::Anthropic,
            "anthropic/claude-sonnet-5-5",
            KeySource::Own,
        );
        assert_eq!(credits_for(&config, &weldsuite, 0.75), 188);
        assert_eq!(credits_for(&config, &own, 0.75), 0);
        let display = AiConfig {
            billing: BillingMode::Display,
            ..AiConfig::default()
        };
        assert_eq!(credits_for(&display, &weldsuite, 0.75), 0);
    }

    #[test]
    fn the_gate_needs_the_switch_credits_billing_and_weldsuite_paying() {
        let route = |key_source| Route {
            primary: target(
                ProviderId::Anthropic,
                "anthropic/claude-sonnet-5-5",
                key_source,
            ),
            fallbacks: Vec::new(),
        };
        let mut config = AiConfig::default();
        assert!(!gated(&config, &route(KeySource::Weldsuite)));
        config.credit_gate = true;
        assert!(gated(&config, &route(KeySource::Weldsuite)));
        assert!(!gated(&config, &route(KeySource::Own)));
        config.billing = BillingMode::Display;
        assert!(!gated(&config, &route(KeySource::Weldsuite)));
    }

    #[tokio::test]
    async fn without_a_master_database_calls_are_unmetered() {
        let config = AiConfig {
            credit_gate: true,
            ..AiConfig::default()
        };
        let call = AiCall::new(
            "ws_1",
            crate::Feature::Mail,
            crate::Task::Draft,
            crate::Tier::Free,
        );
        let served = target(
            ProviderId::Mistral,
            "mistral/mistral-small-2603",
            KeySource::Weldsuite,
        );
        assert_eq!(
            charge(&config, &call, &served, 0.75, usage(10, 10)).await,
            0
        );
        let route = Route {
            primary: served,
            fallbacks: Vec::new(),
        };
        assert!(assert_credits(&config, &call, &route).await.is_ok());
    }
}
