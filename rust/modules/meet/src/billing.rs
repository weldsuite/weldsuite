//! WeldMeet AI billing (`@weldsuite/meet-domain/billing`): the price list
//! per meeting minute (master `system_settings` `weldmeet.ai_pricing`,
//! cached 60 s in the workspace cache), the wallet the work is gated on and
//! its balance. Charging happens in the AI workflow, which the Kubernetes
//! editions don't run.
//!
//! The worker also keeps the price list for 60 s per isolate; Rust reads the
//! cache instead, which holds it for the same 60 s.

use std::sync::Arc;

use serde_json::{Value, json};
use time::{Month, OffsetDateTime};
use weldsuite_db::PgPool;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_ports::DynCache;

/// `WELDMEET_AI_PRICING_KEY`.
const PRICING_KEY: &str = "weldmeet.ai_pricing";
/// `WELDMEET_AI_PRICING_KV_KEY`.
const PRICING_CACHE_KEY: &str = "weldmeet-ai-pricing";
/// `PRICING_CACHE_TTL_SECONDS`.
const PRICING_CACHE_TTL_SECONDS: u64 = 60;
/// `SERVICE_CREDIT_RATES.meetingTranscriptionPerMinute` / `meetingSummaryPerMinute`.
const DEFAULT_TRANSCRIPTION: f64 = 2.0;
const DEFAULT_SUMMARY: f64 = 1.0;

/// `MeetingAiPricing`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Pricing {
    pub(crate) transcription: f64,
    pub(crate) summary: f64,
}

impl Pricing {
    pub(crate) fn json(self) -> serde_json::Map<String, Value> {
        let mut map = serde_json::Map::new();
        map.insert(
            "transcriptionCreditsPerMinute".into(),
            js_number(self.transcription),
        );
        map.insert("summaryCreditsPerMinute".into(), js_number(self.summary));
        map
    }
}

/// A number as `JSON.stringify` writes it (`2`, not `2.0`).
pub(crate) fn js_number(value: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        return json!(value as i64);
    }
    json!(value)
}

fn defaults() -> Pricing {
    Pricing {
        transcription: DEFAULT_TRANSCRIPTION,
        summary: DEFAULT_SUMMARY,
    }
}

/// `validRate`: positive, at most 1000, at most two decimals.
fn valid_rate(value: &Value) -> Option<f64> {
    let rate = value.as_f64()?;
    if !rate.is_finite() || rate <= 0.0 || rate > 1000.0 {
        return None;
    }
    ((rate * 100.0 - (rate * 100.0).round()).abs() < 1e-6).then_some(rate)
}

/// `parseMeetingAiPricing`: each invalid or missing field falls back.
fn parse(value: &Value) -> Pricing {
    let defaults = defaults();
    if !value.is_object() {
        return defaults;
    }
    Pricing {
        transcription: valid_rate(&value["transcriptionCreditsPerMinute"])
            .unwrap_or(defaults.transcription),
        summary: valid_rate(&value["summaryCreditsPerMinute"]).unwrap_or(defaults.summary),
    }
}

/// `getMeetingAiPricing(env)`: cache → master database → defaults. A lookup
/// failure serves the defaults.
pub(crate) async fn pricing(cache: Option<&Arc<dyn DynCache>>, master: Option<&PgPool>) -> Pricing {
    if let Some(cache) = cache
        && let Ok(Some(raw)) = cache.get_boxed(PRICING_CACHE_KEY).await
        && let Ok(cached) = serde_json::from_str::<Value>(&raw)
        && !cached.is_null()
    {
        return parse(&cached);
    }
    let Some(master) = master else {
        tracing::warn!("[meet-billing] pricing lookup failed, using defaults: no master database");
        return defaults();
    };
    let row: Result<Option<Option<Value>>, sqlx::Error> =
        sqlx::query_scalar("select value from system_settings where key = $1 limit 1")
            .bind(PRICING_KEY)
            .fetch_optional(master)
            .await;
    match row {
        Ok(row) => {
            let pricing = parse(&row.flatten().unwrap_or(Value::Null));
            if let Some(cache) = cache {
                let text = Value::Object(pricing.json()).to_string();
                let _ = cache
                    .put_boxed(
                        PRICING_CACHE_KEY,
                        &text,
                        Some(std::time::Duration::from_secs(PRICING_CACHE_TTL_SECONDS)),
                    )
                    .await;
            }
            pricing
        }
        Err(error) => {
            tracing::warn!(%error, "[meet-billing] pricing lookup failed, using defaults");
            defaults()
        }
    }
}

/// Why the wallet could not be used.
#[derive(Debug)]
pub(crate) enum BillingError {
    /// `MeetingBillingUnavailableError`: no billing workspace (503).
    Unavailable,
    /// `InsufficientMeetingCreditsError` (402).
    Insufficient {
        current: i64,
        required: i64,
        shortfall: i64,
    },
    /// Anything else (no master database, a failed statement): the route's 500.
    Failed(String),
}

impl From<sqlx::Error> for BillingError {
    fn from(error: sqlx::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

/// `resolveMeetingMetering(env, orgId, userId)`: the wallet's workspace id.
pub(crate) async fn metering(
    master: Option<&PgPool>,
    org_id: &str,
) -> Result<String, BillingError> {
    let Some(master) = master else {
        return Err(BillingError::Failed("no master database".into()));
    };
    let id: Option<String> =
        sqlx::query_scalar("select id from workspaces where id = $1 or clerk_org_id = $1 limit 1")
            .bind(org_id)
            .fetch_optional(master)
            .await?;
    id.ok_or(BillingError::Unavailable)
}

/// The first day of this month and of the next, at midnight UTC.
fn period(now: OffsetDateTime) -> (String, String) {
    let start = time::Date::from_calendar_date(now.year(), now.month(), 1)
        .unwrap_or(now.date())
        .midnight()
        .assume_utc();
    let (year, month) = if now.month() == Month::December {
        (now.year() + 1, Month::January)
    } else {
        (now.year(), now.month().next())
    };
    let end = time::Date::from_calendar_date(year, month, 1)
        .unwrap_or(now.date())
        .midnight()
        .assume_utc();
    (iso_timestamp(start), iso_timestamp(end))
}

/// `getOrCreateWorkspaceCredits(db, workspaceId).currentBalance`.
pub(crate) async fn balance(master: &PgPool, workspace_id: &str) -> Result<i64, sqlx::Error> {
    let existing: Option<i32> = sqlx::query_scalar(
        "select current_balance from workspace_credits where workspace_id = $1 limit 1",
    )
    .bind(workspace_id)
    .fetch_optional(master)
    .await?;
    if let Some(balance) = existing {
        return Ok(i64::from(balance));
    }
    let (start, end) = period(OffsetDateTime::now_utc());
    sqlx::query(
        "insert into workspace_credits
             (id, workspace_id, current_balance, plan_credits, subscribed_credits,
              monthly_allocation, rolled_over_credits, rollover_cap, period_start, period_end,
              last_reset_at)
         values ($1, $2, 0, 0, 0, 0, 0, null, $3::timestamptz, $4::timestamptz, null)
         on conflict do nothing",
    )
    .bind(generate_id("wcr"))
    .bind(workspace_id)
    .bind(&start)
    .bind(&end)
    .execute(master)
    .await?;
    let balance: Option<i32> = sqlx::query_scalar(
        "select current_balance from workspace_credits where workspace_id = $1 limit 1",
    )
    .bind(workspace_id)
    .fetch_optional(master)
    .await?;
    Ok(i64::from(balance.unwrap_or(0)))
}

/// `creditsForMinutes(minutes, rate)`.
#[allow(clippy::neg_cmp_op_on_partial_ord)] // NaN is not positive, as in `!(minutes > 0)`
fn credits_for_minutes(minutes: f64, rate: f64) -> f64 {
    if !(minutes > 0.0) || !(rate > 0.0) {
        return 0.0;
    }
    (minutes * rate - 1e-9).ceil()
}

/// `minimumBalanceFor(pricing, selected)`: one minute of the selected items.
fn minimum_balance(pricing: Pricing, transcription: bool, summary: bool) -> i64 {
    let per_minute = (if transcription {
        pricing.transcription
    } else {
        0.0
    }) + (if summary { pricing.summary } else { 0.0 });
    #[allow(clippy::cast_possible_truncation)]
    let credits = credits_for_minutes(1.0, per_minute) as i64;
    credits.max(1)
}

/// `gateCredits(c, selected)`'s wallet part: the price list, the wallet,
/// and `assertMeetingAiCredits`.
pub(crate) async fn gate(
    cache: Option<&Arc<dyn DynCache>>,
    master: Option<&PgPool>,
    org_id: &str,
    transcription: bool,
    summary: bool,
) -> Result<(), BillingError> {
    let pricing = pricing(cache, master).await;
    let workspace = metering(master, org_id).await?;
    let required = minimum_balance(pricing, transcription, summary);
    let master = master.ok_or_else(|| BillingError::Failed("no master database".into()))?;
    let current = balance(master, &workspace).await?;
    if current >= required {
        return Ok(());
    }
    Err(BillingError::Insufficient {
        current,
        required,
        shortfall: required - current,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_parse_like_the_worker() {
        assert_eq!(parse(&Value::Null), defaults());
        assert_eq!(
            parse(&json!({ "transcriptionCreditsPerMinute": 3.5, "summaryCreditsPerMinute": 0 })),
            Pricing {
                transcription: 3.5,
                summary: 1.0
            }
        );
        assert_eq!(
            parse(&json!({ "transcriptionCreditsPerMinute": 1.234 })).transcription,
            2.0
        );
        assert_eq!(minimum_balance(defaults(), true, true), 3);
        assert_eq!(minimum_balance(defaults(), false, false), 1);
        assert_eq!(
            minimum_balance(
                Pricing {
                    transcription: 0.25,
                    summary: 1.0
                },
                true,
                false
            ),
            1
        );
        assert_eq!(js_number(2.0), json!(2));
        assert_eq!(js_number(2.5), json!(2.5));
    }
}
