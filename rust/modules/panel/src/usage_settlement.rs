//! Usage settlement (`services/usage-settlement.ts`, ADR PANEL-007): what
//! panel-api does with a workspace's counted events and recordings, shared
//! by `GET /api/panel/usage` and the settlement job.
//!
//!  1. Store the month's totals in the master `panel_usage_monthly` row. They
//!     only ever grow (`greatest`), so a late or repeated report changes
//!     nothing.
//!  2. Where the install bills ([`Settlement::bill`], the `billing` feature):
//!     charge every overage block the totals have reached that is not
//!     charged yet to the credit wallet, one consumption per block with the
//!     key `weldpanel:<workspace>:<month>:events|recordings:<n>`, so a retry
//!     or a second replica charges once. Without billing nothing is charged
//!     and the quota stays `ok`.
//!  3. The quota state ([`quota_for`]): a block the wallet could not pay
//!     means `replay_blocked`; when it is an events block and events are past
//!     the allowance plus the 10% grace, `events_blocked`. Settling again
//!     after a top-up retries the unpaid blocks, so the block lifts by
//!     itself.
//!  4. For the current month, the state goes to the cache
//!     (`panel:quota:<workspace>`, deleted for `ok`) for the collector, the
//!     workspace's replay tier into its project records, and the usage
//!     notice that is due is claimed on the row ([`UsageNotice`]).

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use weldsuite_core_domain::credits::{Consumed, LedgerEntry, consume_credits};
use weldsuite_db::PgPool;
use weldsuite_panel_domain::js;
use weldsuite_ports::{Cache, DynCache, PortError};

use crate::domain::{project_key, quota_key};

/// Overage is charged in blocks of this many events / recordings.
pub const EVENT_BLOCK: i64 = 10_000;
pub const RECORDING_BLOCK: i64 = 100;
/// A favourited recording is kept this long, whatever the plan.
pub const FAVORITE_RETENTION_MONTHS: i64 = 13;

/// The price list's row (`weldpanel.pricing`) and its cache key.
const PRICING_KEY: &str = "weldpanel.pricing";
const PRICING_CACHE_KEY: &str = "weldpanel-pricing";
const PRICING_CACHE_TTL: Duration = Duration::from_secs(60);
const MAX_CREDITS_PER_BLOCK: f64 = 100_000.0;

/// What a plan includes of WeldPanel (`PanelPlanLimits`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanLimits {
    pub events: i64,
    pub recordings: i64,
    pub event_retention_months: i64,
    pub recording_retention_days: i64,
    /// `30d` or `90d`.
    pub replay_tier: &'static str,
}

const FREE: PlanLimits = PlanLimits {
    events: 50_000,
    recordings: 500,
    event_retention_months: 12,
    recording_retention_days: 30,
    replay_tier: "30d",
};

/// `panelPlanLimits(slug, features)`: the plan's numbers, the two
/// allowances optionally overridden by its `features`; an unknown slug (or
/// none) is Free.
#[allow(clippy::cast_possible_truncation, reason = "a whole allowance")]
pub fn plan_limits(slug: Option<&str>, features: Option<&Value>) -> PlanLimits {
    let base = match js::trim(slug.unwrap_or_default()).to_lowercase().as_str() {
        "business" => PlanLimits {
            events: 1_000_000,
            recordings: 5_000,
            event_retention_months: 25,
            recording_retention_days: 30,
            replay_tier: "30d",
        },
        "scale" => PlanLimits {
            events: 5_000_000,
            recordings: 25_000,
            event_retention_months: 25,
            recording_retention_days: 90,
            replay_tier: "90d",
        },
        "enterprise" => PlanLimits {
            events: 20_000_000,
            recordings: 100_000,
            event_retention_months: 25,
            recording_retention_days: 90,
            replay_tier: "90d",
        },
        _ => FREE,
    };
    let Some(features) = features.filter(|f| f.is_object()) else {
        return base;
    };
    let allowance = |key: &str, fallback: i64| {
        features
            .get(key)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v >= 0.0)
            .map_or(fallback, |v| v.floor() as i64)
    };
    PlanLimits {
        events: allowance("panelEventsPerMonth", base.events),
        recordings: allowance("panelRecordingsPerMonth", base.recordings),
        ..base
    }
}

/// `overageBlocks(used, allowance, blockSize)`.
pub fn overage_blocks(used: i64, allowance: i64, block: i64) -> i64 {
    let over = (used - allowance).max(0);
    (over + block - 1) / block
}

/// `eventGraceLimit(allowance)`: the allowance plus 10%.
pub fn event_grace_limit(allowance: i64) -> i64 {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        reason = "an allowance well inside f64's whole numbers"
    )]
    let limit = (allowance as f64 * 1.1).floor() as i64;
    limit
}

/// The workspace and what its plan includes (`WorkspacePlan`).
#[derive(Debug, Clone)]
pub struct WorkspacePlan {
    pub id: String,
    pub name: String,
    pub clerk_org_id: Option<String>,
    pub plan_slug: Option<String>,
    pub limits: PlanLimits,
}

/// A workspace with its plan: id, name, Clerk org id, plan slug, features.
type WorkspaceRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<Value>,
);

/// `loadWorkspacePlan`: `None` when there is no such workspace.
pub async fn load_workspace_plan(
    master: &PgPool,
    workspace_id: &str,
) -> Result<Option<WorkspacePlan>, sqlx::Error> {
    let row: Option<WorkspaceRow> = sqlx::query_as(
        "select w.id, w.name, w.clerk_org_id, p.slug, p.features
             from workspaces w left join plans p on p.id = w.plan_id
             where w.id = $1 limit 1",
    )
    .bind(workspace_id)
    .fetch_optional(master)
    .await?;
    Ok(
        row.map(|(id, name, clerk_org_id, slug, features)| WorkspacePlan {
            limits: plan_limits(slug.as_deref(), features.as_ref()),
            id,
            name,
            clerk_org_id,
            plan_slug: slug,
        }),
    )
}

/// A month's stored row (`PanelUsageMonth`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UsageMonth {
    pub id: String,
    /// `YYYY-MM`.
    pub month: String,
    pub events: i64,
    pub recordings: i64,
    pub event_blocks_charged: i64,
    pub recording_blocks_charged: i64,
    pub event_credits_charged: i64,
    pub recording_credits_charged: i64,
    pub notified: Vec<String>,
}

impl UsageMonth {
    #[allow(clippy::cast_possible_truncation, reason = "whole counts")]
    fn from_row(row: &Value) -> Self {
        let n = |key: &str| row[key].as_f64().map_or(0, |v| v as i64);
        Self {
            id: row["id"].as_str().unwrap_or_default().to_owned(),
            month: row["month"].as_str().unwrap_or_default().to_owned(),
            events: n("events"),
            recordings: n("recordings"),
            event_blocks_charged: n("event_blocks_charged"),
            recording_blocks_charged: n("recording_blocks_charged"),
            event_credits_charged: n("event_credits_charged"),
            recording_credits_charged: n("recording_credits_charged"),
            notified: row["notified"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(|m| m.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
}

/// The row's columns as `to_jsonb` writes them.
const ROW: &str = "to_jsonb(u)";

/// `usageRow`: the stored row of a workspace's month, if any.
pub async fn usage_row(
    master: &PgPool,
    workspace_id: &str,
    month: &str,
) -> Result<Option<UsageMonth>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {ROW} from panel_usage_monthly u where u.workspace_id = $1 and u.month = $2 limit 1"
    )))
    .bind(workspace_id)
    .bind(month)
    .fetch_optional(master)
    .await?;
    Ok(row.as_ref().map(UsageMonth::from_row))
}

/// `quotaFor(limits, usage)`, where the install bills; without billing the
/// quota is always `ok`.
pub fn quota_for(limits: &PlanLimits, usage: &UsageMonth, bill: bool) -> &'static str {
    if !bill {
        return "ok";
    }
    let events_unpaid =
        overage_blocks(usage.events, limits.events, EVENT_BLOCK) > usage.event_blocks_charged;
    let recordings_unpaid = overage_blocks(usage.recordings, limits.recordings, RECORDING_BLOCK)
        > usage.recording_blocks_charged;
    if events_unpaid && usage.events > event_grace_limit(limits.events) {
        "events_blocked"
    } else if events_unpaid || recordings_unpaid {
        "replay_blocked"
    } else {
        "ok"
    }
}

/// `parseQuotaState(raw)`.
pub fn parse_quota_state(raw: Option<&str>) -> &'static str {
    crate::domain::parse_quota_state(raw)
}

/// The quota key the collector reads (`quotaKvKey`).
pub fn quota_cache_key(workspace_id: &str) -> String {
    quota_key(workspace_id)
}

/// `monthOf(date)`: the UTC month, `YYYY-MM`.
pub fn month_of(millis: i64) -> String {
    js::iso_string(millis).chars().take(7).collect()
}

/// The prices (`PanelPricing`): credits per 10,000 events and per 100
/// recordings beyond the allowance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pricing {
    pub events_credits_per_10k: i64,
    pub recordings_credits_per_100: i64,
}

/// `DEFAULT_PANEL_PRICING`.
pub const DEFAULT_PRICING: Pricing = Pricing {
    events_credits_per_10k: 10,
    recordings_credits_per_100: 20,
};

/// `parsePanelPricing(value)`: each invalid field falls back to its default.
#[allow(clippy::cast_possible_truncation, reason = "a whole rate")]
fn parse_pricing(value: Option<&Value>) -> Pricing {
    let Some(value) = value.filter(|v| v.is_object()) else {
        return DEFAULT_PRICING;
    };
    let rate = |key: &str, fallback: i64| {
        value
            .get(key)
            .and_then(Value::as_f64)
            .filter(|v| v.fract() == 0.0 && *v > 0.0 && *v <= MAX_CREDITS_PER_BLOCK)
            .map_or(fallback, |v| v as i64)
    };
    Pricing {
        events_credits_per_10k: rate(
            "eventsCreditsPer10k",
            DEFAULT_PRICING.events_credits_per_10k,
        ),
        recordings_credits_per_100: rate(
            "recordingsCreditsPer100",
            DEFAULT_PRICING.recordings_credits_per_100,
        ),
    }
}

/// `getPanelPricing`: the cache (60 s), else the master `system_settings`
/// row; a failed lookup serves the defaults (a block must still be
/// chargeable).
pub async fn pricing(master: &PgPool, cache: Option<&Arc<dyn DynCache>>) -> Pricing {
    if let Some(cache) = cache
        && let Ok(Some(text)) = cache.get(PRICING_CACHE_KEY).await
        && let Ok(cached) = serde_json::from_str::<Value>(&text)
        && !cached.is_null()
    {
        return parse_pricing(Some(&cached));
    }
    let row: Result<Option<Value>, sqlx::Error> =
        sqlx::query_scalar("select value from system_settings where key = $1 limit 1")
            .bind(PRICING_KEY)
            .fetch_optional(master)
            .await;
    match row {
        Ok(value) => {
            let pricing = parse_pricing(value.as_ref());
            if let Some(cache) = cache {
                let text = json!({
                    "eventsCreditsPer10k": pricing.events_credits_per_10k,
                    "recordingsCreditsPer100": pricing.recordings_credits_per_100,
                })
                .to_string();
                if let Err(error) = cache
                    .put(PRICING_CACHE_KEY, &text, Some(PRICING_CACHE_TTL))
                    .await
                {
                    tracing::debug!(%error, "[panel-api] pricing cache write failed");
                }
            }
            pricing
        }
        Err(error) => {
            tracing::warn!(%error, "[panel-api] pricing lookup failed, using defaults");
            DEFAULT_PRICING
        }
    }
}

/// What a settlement reads and writes.
pub struct Settlement<'a> {
    pub master: &'a PgPool,
    /// The cache the collector reads (`WORKSPACE_CACHE`); `None` writes
    /// nothing there.
    pub cache: Option<&'a Arc<dyn DynCache>>,
    /// Epoch milliseconds of "now".
    pub now: i64,
    /// The install bills plans (the `billing` feature): overage is charged.
    pub bill: bool,
}

/// What to settle (`SettlementInput`).
#[derive(Debug, Clone)]
pub struct SettlementInput {
    /// `workspaces.id`.
    pub workspace_id: String,
    /// `YYYY-MM`, UTC.
    pub month: String,
    pub events: i64,
    pub recordings: i64,
}

/// A usage email due to the owners (`UsageNotice`), claimed on the row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageNotice {
    pub workspace_id: String,
    pub workspace_name: String,
    pub clerk_org_id: Option<String>,
    /// `near`, `full`, `replay_blocked` or `events_blocked`.
    pub kind: &'static str,
    pub month: String,
    pub events: (i64, i64),
    pub recordings: (i64, i64),
}

/// A settlement's outcome (`SettlementResult`).
#[derive(Debug, Clone)]
pub struct Settled {
    pub month: String,
    pub workspace: WorkspacePlan,
    pub usage: UsageMonth,
    pub quota: &'static str,
    pub pricing: Pricing,
    /// The notice claimed now, for the caller to send (best effort).
    pub notice: Option<UsageNotice>,
}

/// What a settlement can fail with.
#[derive(Debug)]
pub enum SettlementError {
    Database(sqlx::Error),
    Cache(PortError),
    Credits(String),
}

impl std::fmt::Display for SettlementError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => error.fmt(f),
            Self::Cache(error) => error.fmt(f),
            Self::Credits(error) => f.write_str(error),
        }
    }
}

impl std::error::Error for SettlementError {}

impl From<sqlx::Error> for SettlementError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<PortError> for SettlementError {
    fn from(error: PortError) -> Self {
        Self::Cache(error)
    }
}

/// `chargeBlocks`: blocks `already + 1 ..= needed` of one meter, stopping at
/// the first the wallet can't pay. The blocks now charged and the credits
/// this call accounts for.
async fn charge_blocks(
    master: &PgPool,
    input: &SettlementInput,
    meter: &str,
    needed: i64,
    already: i64,
    credits_per_block: i64,
) -> Result<(i64, i64), SettlementError> {
    let mut charged = already;
    let mut credits = 0;
    let reference = format!("{}:{}", input.workspace_id, input.month);
    while charged < needed {
        let block = charged + 1;
        let entry = LedgerEntry {
            workspace_id: &input.workspace_id,
            amount: credits_per_block,
            service_type: Some(if meter == "events" {
                "panel_events"
            } else {
                "panel_recordings"
            }),
            idempotency_key: Some(format!(
                "weldpanel:{}:{}:{meter}:{block}",
                input.workspace_id, input.month
            )),
            reference_id: Some(&reference),
            reference_type: Some("panel_usage"),
            description: Some(format!(
                "WeldPanel {meter} beyond the plan allowance ({}, block {block})",
                input.month
            )),
            metadata: Some(json!({ "month": input.month, "meter": meter, "block": block })),
        };
        match consume_credits(master, &entry).await {
            Ok(Consumed::Ok { .. }) => {
                charged = block;
                credits += credits_per_block;
            }
            Ok(Consumed::Insufficient { .. }) => break,
            Err(error) => return Err(SettlementError::Credits(error.to_string())),
        }
    }
    Ok((charged, credits))
}

/// `NOTICE_MARKERS`, in rising severity.
const NOTICE_MARKERS: [&str; 4] = ["80", "100", "replay_blocked", "events_blocked"];

#[allow(clippy::cast_precision_loss, reason = "counts well inside f64")]
fn percent_of(used: i64, allowance: i64) -> f64 {
    if allowance > 0 {
        (used as f64 * 100.0) / allowance as f64
    } else if used > 0 {
        f64::INFINITY
    } else {
        0.0
    }
}

/// `reachedMarkers`: every marker the month's usage and quota have reached.
pub fn reached_markers(limits: &PlanLimits, usage: &UsageMonth, quota: &str) -> Vec<&'static str> {
    let top = percent_of(usage.events, limits.events)
        .max(percent_of(usage.recordings, limits.recordings));
    let mut reached = Vec::new();
    if top >= 80.0 {
        reached.push("80");
    }
    if top >= 100.0 {
        reached.push("100");
    }
    if quota == "replay_blocked" || quota == "events_blocked" {
        reached.push("replay_blocked");
    }
    if quota == "events_blocked" {
        reached.push("events_blocked");
    }
    reached
}

/// `planUsageNotice`: claims every marker reached (compare-and-set on the
/// row, so two settlements racing send one mail) and answers the mail for
/// the highest one not sent before.
async fn plan_usage_notice(
    master: &PgPool,
    workspace: &WorkspacePlan,
    usage: &UsageMonth,
    quota: &str,
    now: i64,
) -> Result<Option<UsageNotice>, sqlx::Error> {
    let reached = reached_markers(&workspace.limits, usage, quota);
    let mut notified = usage.notified.clone();
    for _ in 0..3 {
        let unsent: Vec<&str> = reached
            .iter()
            .copied()
            .filter(|m| !notified.iter().any(|n| n == m))
            .collect();
        if unsent.is_empty() {
            return Ok(None);
        }
        let next = js::distinct(
            notified
                .iter()
                .cloned()
                .chain(reached.iter().map(|m| (*m).to_owned())),
        );
        let claimed: Option<String> = sqlx::query_scalar(
            "update panel_usage_monthly set notified = $2, updated_at = $4::timestamptz
             where id = $1 and notified = $3::jsonb returning id",
        )
        .bind(&usage.id)
        .bind(json!(next))
        .bind(json!(notified))
        .bind(js::iso_string(now))
        .fetch_optional(master)
        .await?;
        if claimed.is_none() {
            // Another settlement moved the markers first: look again.
            let fresh: Option<Value> = sqlx::query_scalar(
                "select notified from panel_usage_monthly where id = $1 limit 1",
            )
            .bind(&usage.id)
            .fetch_optional(master)
            .await?;
            notified = fresh
                .as_ref()
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|m| m.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            continue;
        }
        let rank = |m: &str| NOTICE_MARKERS.iter().position(|n| *n == m).unwrap_or(0);
        let highest = unsent
            .iter()
            .copied()
            .reduce(|a, b| if rank(b) > rank(a) { b } else { a })
            .unwrap_or("80");
        let kind = match highest {
            "80" => "near",
            "100" => "full",
            "replay_blocked" => "replay_blocked",
            _ => "events_blocked",
        };
        return Ok(Some(UsageNotice {
            workspace_id: workspace.id.clone(),
            workspace_name: workspace.name.clone(),
            clerk_org_id: workspace.clerk_org_id.clone(),
            kind,
            month: usage.month.clone(),
            events: (usage.events, workspace.limits.events),
            recordings: (usage.recordings, workspace.limits.recordings),
        }));
    }
    Ok(None)
}

/// `panel:tier:<workspaceId>`: the replay tier last written into the
/// workspace's project records.
fn tier_key(workspace_id: &str) -> String {
    format!("panel:tier:{workspace_id}")
}

/// `applyReplayTier`: the workspace's replay tier into its live projects'
/// collector records (`90d` written, `30d` the default and left out).
async fn apply_replay_tier(
    master: &PgPool,
    cache: &Arc<dyn DynCache>,
    workspace_id: &str,
    tier: &str,
) -> Result<(), SettlementError> {
    if cache.get(&tier_key(workspace_id)).await?.as_deref() == Some(tier) {
        return Ok(());
    }
    let tokens: Vec<String> = sqlx::query_scalar(
        "select token from panel_project_registry where workspace_id = $1 and deleted_at is null",
    )
    .bind(workspace_id)
    .fetch_all(master)
    .await?;
    for token in tokens {
        let key = project_key(&token);
        let Some(raw) = cache.get(&key).await? else {
            continue;
        };
        let Ok(Value::Object(mut record)) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let valid = record.get("v").and_then(Value::as_f64) == Some(1.0)
            && record.get("projectId").is_some_and(Value::is_string)
            && record.get("workspaceId").is_some_and(Value::is_string);
        if !valid {
            continue;
        }
        let current = record.get("replayTier").and_then(Value::as_str);
        let wanted = (tier == "90d").then_some(tier);
        if current == wanted {
            continue;
        }
        if tier == "90d" {
            record.insert("replayTier".to_owned(), json!(tier));
        } else {
            record.remove("replayTier");
        }
        cache
            .put(&key, &Value::Object(record).to_string(), None)
            .await?;
    }
    cache.put(&tier_key(workspace_id), tier, None).await?;
    Ok(())
}

/// `settleUsage`: `None` when the workspace does not exist (nothing is
/// stored or charged).
#[allow(
    clippy::too_many_lines,
    reason = "the TypeScript's one function, step by step"
)]
pub async fn settle_usage(
    deps: &Settlement<'_>,
    input: &SettlementInput,
) -> Result<Option<Settled>, SettlementError> {
    let Some(workspace) = load_workspace_plan(deps.master, &input.workspace_id).await? else {
        return Ok(None);
    };
    let pricing = pricing(deps.master, deps.cache).await;
    let now = js::iso_string(deps.now);

    let stored: Value = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "insert into panel_usage_monthly as u (id, workspace_id, month, events, recordings)
         values ($1, $2, $3, $4, $5)
         on conflict (workspace_id, month) do update set
           events = greatest(u.events, $4),
           recordings = greatest(u.recordings, $5),
           updated_at = $6::timestamptz
         returning {ROW}"
    )))
    .bind(weldsuite_kit::id::generate_id("pnu"))
    .bind(&input.workspace_id)
    .bind(&input.month)
    .bind(input.events)
    .bind(i32::try_from(input.recordings).unwrap_or(i32::MAX))
    .bind(&now)
    .fetch_one(deps.master)
    .await?;
    let stored = UsageMonth::from_row(&stored);

    let events_needed = overage_blocks(stored.events, workspace.limits.events, EVENT_BLOCK);
    let recordings_needed = overage_blocks(
        stored.recordings,
        workspace.limits.recordings,
        RECORDING_BLOCK,
    );
    let mut usage = stored.clone();
    if deps.bill
        && (events_needed > stored.event_blocks_charged
            || recordings_needed > stored.recording_blocks_charged)
    {
        let (event_blocks, event_credits) = charge_blocks(
            deps.master,
            input,
            "events",
            events_needed,
            stored.event_blocks_charged,
            pricing.events_credits_per_10k,
        )
        .await?;
        let (recording_blocks, recording_credits) = charge_blocks(
            deps.master,
            input,
            "recordings",
            recordings_needed,
            stored.recording_blocks_charged,
            pricing.recordings_credits_per_100,
        )
        .await?;
        // `greatest` keeps two settlements running at once from undoing each other.
        let updated: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "update panel_usage_monthly as u set
               event_blocks_charged = greatest(u.event_blocks_charged, $2),
               recording_blocks_charged = greatest(u.recording_blocks_charged, $3),
               event_credits_charged = greatest(u.event_credits_charged, $4),
               recording_credits_charged = greatest(u.recording_credits_charged, $5),
               updated_at = $6::timestamptz
             where u.id = $1 returning {ROW}"
        )))
        .bind(&stored.id)
        .bind(i32::try_from(event_blocks).unwrap_or(i32::MAX))
        .bind(i32::try_from(recording_blocks).unwrap_or(i32::MAX))
        .bind(i32::try_from(stored.event_credits_charged + event_credits).unwrap_or(i32::MAX))
        .bind(
            i32::try_from(stored.recording_credits_charged + recording_credits).unwrap_or(i32::MAX),
        )
        .bind(&now)
        .fetch_optional(deps.master)
        .await?;
        if let Some(updated) = updated {
            usage = UsageMonth::from_row(&updated);
        }
    }

    let quota = quota_for(&workspace.limits, &usage, deps.bill);
    let mut notice = None;
    // Only the current month decides what the collector does.
    if input.month == month_of(deps.now) {
        if let Some(cache) = deps.cache {
            if quota == "ok" {
                cache.delete(&quota_key(&input.workspace_id)).await?;
            } else {
                cache
                    .put(&quota_key(&input.workspace_id), quota, None)
                    .await?;
            }
            if let Err(error) = apply_replay_tier(
                deps.master,
                cache,
                &input.workspace_id,
                workspace.limits.replay_tier,
            )
            .await
            {
                tracing::error!(%error, workspace = %input.workspace_id, "[panel-api] replay tier refresh failed");
            }
        }
        match plan_usage_notice(deps.master, &workspace, &usage, quota, deps.now).await {
            Ok(planned) => notice = planned,
            Err(error) => {
                tracing::error!(%error, workspace = %input.workspace_id, "[panel-api] usage notice failed");
            }
        }
    }

    Ok(Some(Settled {
        month: input.month.clone(),
        workspace,
        usage,
        quota,
        pricing,
        notice,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_and_their_overrides() {
        assert_eq!(plan_limits(None, None), FREE);
        assert_eq!(
            plan_limits(Some(" Scale "), None).recording_retention_days,
            90
        );
        let custom = plan_limits(
            Some("business"),
            Some(&json!({ "panelEventsPerMonth": 2_000_000.7, "panelRecordingsPerMonth": -1 })),
        );
        assert_eq!(custom.events, 2_000_000);
        assert_eq!(custom.recordings, 5_000);
    }

    #[test]
    fn blocks_grace_and_quota() {
        assert_eq!(overage_blocks(50_000, 50_000, EVENT_BLOCK), 0);
        assert_eq!(overage_blocks(50_001, 50_000, EVENT_BLOCK), 1);
        assert_eq!(overage_blocks(70_001, 50_000, EVENT_BLOCK), 3);
        assert_eq!(event_grace_limit(50_000), 55_000);
        let usage = |events, charged| UsageMonth {
            events,
            event_blocks_charged: charged,
            ..UsageMonth::default()
        };
        assert_eq!(quota_for(&FREE, &usage(70_001, 0), true), "events_blocked");
        assert_eq!(quota_for(&FREE, &usage(52_000, 0), true), "replay_blocked");
        assert_eq!(quota_for(&FREE, &usage(70_001, 3), true), "ok");
        assert_eq!(quota_for(&FREE, &usage(70_001, 0), false), "ok");
    }

    #[test]
    fn markers_rise_with_usage_and_blocks() {
        let usage = UsageMonth {
            events: 70_001,
            ..UsageMonth::default()
        };
        assert_eq!(
            reached_markers(&FREE, &usage, "events_blocked"),
            ["80", "100", "replay_blocked", "events_blocked"]
        );
        let near = UsageMonth {
            events: 40_000,
            ..UsageMonth::default()
        };
        assert_eq!(reached_markers(&FREE, &near, "ok"), ["80"]);
    }

    #[test]
    fn pricing_falls_back_per_field() {
        assert_eq!(parse_pricing(None), DEFAULT_PRICING);
        assert_eq!(
            parse_pricing(Some(
                &json!({ "eventsCreditsPer10k": 12, "recordingsCreditsPer100": 1.5 })
            )),
            Pricing {
                events_credits_per_10k: 12,
                recordings_credits_per_100: 20
            }
        );
        assert_eq!(month_of(0), "1970-01");
    }
}
