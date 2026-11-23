//! The ops ledger row of a model call WeldSuite pays for and never charges:
//! `recordProviderUsage(masterDb, { …, creditsCharged: 0 })`
//! (`@weldsuite/credits/gateway-costs`), which Global writes for
//! mail-inbound-worker's auto-labels and for the outbound abuse review
//! (`outbound/review.ts`). Neither is a customer feature, so the workspace
//! wallet is left alone; the master `ai_provider_usage` still shows what the
//! provider was paid. The callers compute the cost with `weldsuite-ai`'s
//! rate table; the AI layer's own metering is off for these calls.

use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::Set, EntityTrait};
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::master::ai_provider_usage;

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

fn clamp_i32(value: i64) -> i32 {
    i32::try_from(value.clamp(0, i64::from(i32::MAX))).unwrap_or(i32::MAX)
}

/// Writes the row; a second write under the same idempotency key does
/// nothing (`on conflict (idempotency_key) do nothing`). Never fails the
/// caller: an error is logged.
pub async fn record_ops_usage(master: &PgPool, usage: &OpsUsage<'_>) {
    let row = ai_provider_usage::ActiveModel {
        id: Set(weldsuite_kit::generate_id("apu")),
        gateway: Set("direct".to_owned()),
        model_id: Set(usage.model_id.to_owned()),
        workspace_id: Set(usage.workspace_id.map(str::to_owned)),
        op: Set(usage.op.to_owned()),
        input_tokens: Set(clamp_i32(usage.input_tokens)),
        output_tokens: Set(clamp_i32(usage.output_tokens)),
        provider_cost_nano_usd: Set(usage.provider_cost_nano_usd.max(0)),
        covered_by_service_credit: Set(false),
        credits_charged: Set(0),
        reference_type: Set(Some(usage.reference_type.to_owned())),
        reference_id: Set(usage.reference_id.map(str::to_owned)),
        idempotency_key: Set(Some(usage.idempotency_key.to_owned())),
        key_source: Set(usage.key_source.to_owned()),
        feature: Set(Some(usage.feature.to_owned())),
        ..Default::default()
    };
    let result = ai_provider_usage::Entity::insert(row)
        .on_conflict(
            OnConflict::column(ai_provider_usage::Column::IdempotencyKey)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(&orm(master))
        .await;
    if let Err(error) = result {
        tracing::error!(%error, op = usage.op, "[ai-usage] failed to record provider usage");
    }
}
