//! The ops ledger row of a model call WeldSuite pays for and never charges:
//! `recordProviderUsage(masterDb, { …, creditsCharged: 0 })`
//! (`@weldsuite/credits/gateway-costs`), which Global writes for
//! mail-inbound-worker's auto-labels and for the outbound abuse review
//! (`outbound/review.ts`). Neither is a customer feature, so the workspace
//! wallet is left alone; the master `ai_provider_usage` still shows what the
//! provider was paid. The callers compute the cost with `weldsuite-ai`'s
//! rate table; the AI layer's own metering is off for these calls.

use weldsuite_db::PgPool;

/// One call, as the ops ledger keeps it (`gateway = 'direct'`: the Rust
/// backend calls the provider without a gateway).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpsUsage<'a> {
    /// The canonical model id that served (`mistral/…`).
    pub model_id: &'a str,
    /// `weldsuite` or `own` (an own key costs WeldSuite nothing: 0).
    pub key_source: &'a str,
    /// The AI feature (`mail`, `mail-review`).
    pub feature: &'a str,
    /// `mail_auto_label`, `mail_outbound_review`.
    pub op: &'a str,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub provider_cost_nano_usd: i64,
    pub workspace_id: Option<&'a str>,
    pub reference_type: &'a str,
    pub reference_id: Option<&'a str>,
    /// A retried call books once.
    pub idempotency_key: &'a str,
}

fn clamp_i32(value: i64) -> i64 {
    value.clamp(0, i64::from(i32::MAX))
}

/// Writes the row; a second write under the same idempotency key does
/// nothing. Never fails the caller: an error is logged.
pub async fn record_ops_usage(master: &PgPool, usage: &OpsUsage<'_>) {
    let result = sqlx::query(
        "insert into ai_provider_usage
             (id, gateway, model_id, workspace_id, op, input_tokens, output_tokens,
              provider_cost_nano_usd, covered_by_service_credit, credits_charged,
              reference_type, reference_id, idempotency_key, key_source, feature)
         values ($1, 'direct', $2, $3, $4, $5::int, $6::int, $7, false, 0,
                 $8, $9, $10, $11, $12)
         on conflict (idempotency_key) do nothing",
    )
    .bind(weldsuite_kit::generate_id("apu"))
    .bind(usage.model_id)
    .bind(usage.workspace_id)
    .bind(usage.op)
    .bind(clamp_i32(usage.input_tokens))
    .bind(clamp_i32(usage.output_tokens))
    .bind(usage.provider_cost_nano_usd.max(0))
    .bind(usage.reference_type)
    .bind(usage.reference_id)
    .bind(usage.idempotency_key)
    .bind(usage.key_source)
    .bind(usage.feature)
    .execute(master)
    .await;
    if let Err(error) = result {
        tracing::error!(%error, op = usage.op, "[ai-usage] failed to record provider usage");
    }
}
