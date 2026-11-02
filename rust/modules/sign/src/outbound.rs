//! The outbound mail guard for WeldSign's signing requests
//! (`@weldsuite/mail-domain/outbound`, `checkOutbound` / `commitOutbound` /
//! `releaseOutbound`, source `sign`, WeldSuite's own address).
//!
//! Global counts in mail-api's `OutboundLedger` Durable Object; here the same
//! windows are counters in Valkey (the cache port's `increment`), with the
//! same limits (`OUTBOUND_DEFAULT_LIMITS` per trust level, the policy row's
//! state and overrides in the master `outbound_mail_policies`) and the same
//! mode flag (`weldmail-outbound-guard`: off / shadow / enforce, default
//! shadow). For a system sender only the workspace windows apply: recipients
//! per 24 hours, per month when the policy sets one, and first-contact
//! recipients per 24 hours, after the state gate (suspended, on hold).
//!
//! Always enforced, as in TypeScript: a recipient who reported the
//! workspace's mail as spam (`mail_suppressions`, reason `complaint`).
//!
//! Not here yet (Mail's full guard comes with Mail, phase P6): template
//! fingerprints and the cold-outreach cap (they need the AI verdicts), the
//! platform budget breaker (Cloudflare's daily limit has no counterpart on a
//! relay), delivery-event risk scoring, and bounce and complaint rates in the
//! trust level (so a workspace is `trusted` only by staff override).
//!
//! Like the TypeScript guard, it fails open: without Valkey, or when a
//! counter can't be read, the mail goes out uncounted.

use std::collections::BTreeSet;
use std::time::Duration;

use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_catalogs::flags::WELDMAIL_OUTBOUND_GUARD;
use weldsuite_ports::{DynCache, FlagContext, FlagSourceExt};

use crate::{SendContext, text};

const HOUR_SECONDS: i64 = 3600;
/// Hourly buckets live a little longer than the 24-hour window they feed.
const HOUR_TTL: Duration = Duration::from_hours(26);
const MONTH_TTL: Duration = Duration::from_hours(33 * 24);

/// What the guard answered.
pub(crate) enum Reserve {
    /// Refused (`OutboundDeniedError`): nothing may go out.
    Refused,
    /// Go ahead. `None` when the guard failed open before reserving.
    Granted(Option<Reservation>),
}

/// What was counted for a send, to commit or hand back.
pub(crate) struct Reservation {
    recipients: Vec<String>,
    first_contact: Vec<String>,
    counted: Option<Counted>,
}

/// The counters a reservation added to.
struct Counted {
    hour: i64,
    month: String,
    recipients: i64,
    first_contact: i64,
}

/// The limits that apply to a system sender (`OutboundLimits`, in part).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Limits {
    pub(crate) workspace_per_day: i64,
    pub(crate) first_contact_per_day: i64,
    pub(crate) monthly_recipients: Option<i64>,
}

/// `OUTBOUND_DEFAULT_LIMITS` (and the `restricted` state's own set).
pub(crate) fn default_limits(level: &str) -> Limits {
    let (workspace_per_day, first_contact_per_day) = match level {
        "standard" => (2_000, 200),
        "trusted" => (10_000, 1_000),
        "restricted" => (200, 0),
        _ => (300, 50),
    };
    Limits {
        workspace_per_day,
        first_contact_per_day,
        monthly_recipients: None,
    }
}

/// `resolveOutboundLimits`: the trust level's defaults with the policy's
/// overrides, or `restricted`'s while the workspace is restricted. An
/// override that does not validate is ignored, as `safeParse` fails whole.
pub(crate) fn resolve_limits(level: &str, state: &str, overrides: &Value) -> Limits {
    if state == "restricted" {
        return default_limits("restricted");
    }
    let mut limits = default_limits(level);
    let Some(map) = overrides.as_object() else {
        return limits;
    };
    let bounded = |key: &str, max: i64| -> Result<Option<i64>, ()> {
        match map.get(key) {
            None => Ok(None),
            Some(value) => value
                .as_i64()
                .filter(|n| (0..=max).contains(n))
                .map(Some)
                .ok_or(()),
        }
    };
    let workspace = bounded("workspacePerDay", 10_000_000);
    let first_contact = bounded("firstContactPerDay", 1_000_000);
    let monthly = match map.get("monthlyRecipients") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(value) => value
            .as_i64()
            .filter(|n| (0..=100_000_000).contains(n))
            .map(|n| Some(Some(n)))
            .ok_or(()),
    };
    if let (Ok(workspace), Ok(first_contact), Ok(monthly)) = (workspace, first_contact, monthly) {
        if let Some(n) = workspace {
            limits.workspace_per_day = n;
        }
        if let Some(n) = first_contact {
            limits.first_contact_per_day = n;
        }
        if let Some(n) = monthly {
            limits.monthly_recipients = n;
        }
    }
    limits
}

/// `computeTrustLevel` without delivery rates: `new` until paid for 14 days,
/// then `standard`; `trusted` takes a clean bounce and complaint record,
/// which only the Global ledger tracks so far.
pub(crate) fn trust_level(override_level: Option<&str>, age_days: f64, paid: bool) -> &'static str {
    match override_level {
        Some("new") => return "new",
        Some("standard") => return "standard",
        Some("trusted") => return "trusted",
        _ => {}
    }
    if !paid || age_days < 14.0 {
        "new"
    } else {
        "standard"
    }
}

/// `"Anna" <Anna@Example.com>` → `anna@example.com`, de-duplicated.
fn unique_addresses(list: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for raw in list {
        let trimmed = raw.trim();
        let bare = match (trimmed.rfind('<'), trimmed.ends_with('>')) {
            (Some(open), true) => &trimmed[open + 1..trimmed.len() - 1],
            _ => trimmed,
        };
        let address = bare.trim().to_lowercase();
        if address.contains('@') && seen.insert(address.clone()) {
            out.push(address);
        }
    }
    out
}

/// Refused for a complaint, else the recipients who never wrote in. A
/// tenant without the tables yet counts everyone as known.
async fn first_contacts(ctx: &SendContext, recipients: &[String]) -> Result<Vec<String>, ()> {
    let suppressed: Result<Vec<String>, sqlx::Error> = sqlx::query_scalar(
        "select email from mail_suppressions where email = any($1) and reason = 'complaint'",
    )
    .bind(recipients)
    .fetch_all(&ctx.db)
    .await;
    let known: Result<Vec<String>, sqlx::Error> = match &suppressed {
        Ok(found) if !found.is_empty() => {
            tracing::warn!(
                recipients = ?found,
                "sign: mail refused by the outbound guard (RECIPIENT_SUPPRESSED)"
            );
            return Err(());
        }
        Ok(_) => {
            sqlx::query_scalar(
                "select email from mail_correspondents
                 where email = any($1) and first_inbound_at is not null",
            )
            .bind(recipients)
            .fetch_all(&ctx.db)
            .await
        }
        Err(error) => Err(sqlx::Error::Protocol(error.to_string())),
    };
    match known {
        Ok(known) => Ok(recipients
            .iter()
            .filter(|r| !known.contains(r))
            .cloned()
            .collect()),
        Err(error) => {
            tracing::warn!(%error, "sign: outbound correspondent lookup failed");
            Ok(Vec::new())
        }
    }
}

/// The policy as the guard applies it: state and limits.
struct Policy {
    state: String,
    limits: Limits,
}

async fn load_policy(ctx: &SendContext) -> Result<Policy, sqlx::Error> {
    let row: Option<(String, Option<String>, Value)> = sqlx::query_as(
        "select state, trust_override, limits from outbound_mail_policies
         where workspace_id = $1 limit 1",
    )
    .bind(&ctx.workspace_id)
    .fetch_optional(&ctx.master)
    .await?;
    let (state, trust_override, overrides) =
        row.unwrap_or_else(|| ("active".to_owned(), None, Value::Null));
    let workspace: Option<(f64, bool)> = sqlx::query_as(
        "select extract(epoch from (now() - w.created_at))::float8 / 86400,
                (w.comp_granted_at is not null or w.billing_mode = 'partner'
                 or (coalesce(w.subscription_status, '') in ('active', 'past_due')
                     and coalesce(p.price_monthly::float8, 0) > 0))
         from workspaces w left join plans p on p.id = w.plan_id
         where w.id = $1 limit 1",
    )
    .bind(&ctx.workspace_id)
    .fetch_optional(&ctx.master)
    .await?;
    let level = match workspace {
        Some((age, paid)) => trust_level(trust_override.as_deref(), age, paid),
        None => trust_level(trust_override.as_deref(), 0.0, false),
    };
    Ok(Policy {
        limits: resolve_limits(level, &state, &overrides),
        state,
    })
}

fn counter_key(workspace_id: &str, metric: &str, bucket: &str) -> String {
    format!("outbound:ws:{workspace_id}:{metric}:{bucket}")
}

/// The sum of an hourly metric over the last 24 buckets, the current one
/// included.
async fn day_total(
    cache: &dyn DynCache,
    workspace_id: &str,
    metric: &str,
    hour: i64,
) -> Result<i64, weldsuite_ports::PortError> {
    let mut total = 0;
    for h in hour - 23..=hour {
        if let Some(value) = cache
            .get_boxed(&counter_key(workspace_id, metric, &h.to_string()))
            .await?
        {
            total += value.parse::<i64>().unwrap_or(0);
        }
    }
    Ok(total)
}

/// Add `by` to every counter of `counted` (negative to hand them back).
async fn add(
    cache: &dyn DynCache,
    workspace_id: &str,
    counted: &Counted,
    recipients: i64,
    first_contact: i64,
) -> Result<(), weldsuite_ports::PortError> {
    let hour = counted.hour.to_string();
    if recipients != 0 {
        cache
            .increment_boxed(
                &counter_key(workspace_id, "r", &hour),
                recipients,
                Some(HOUR_TTL),
            )
            .await?;
        cache
            .increment_boxed(
                &counter_key(workspace_id, "m", &counted.month),
                recipients,
                Some(MONTH_TTL),
            )
            .await?;
    }
    if first_contact != 0 {
        cache
            .increment_boxed(
                &counter_key(workspace_id, "fc", &hour),
                first_contact,
                Some(HOUR_TTL),
            )
            .await?;
    }
    Ok(())
}

/// Why a send is refused, for the log (`OutboundDenialDetails`).
struct Denial {
    code: &'static str,
    limit: Option<i64>,
    used: Option<i64>,
}

/// Count the send, then decide against the windows with it counted: the
/// increment is the reservation, so two sends at once can't both slip under
/// a limit.
async fn count_and_decide(
    ctx: &SendContext,
    cache: &dyn DynCache,
    policy: &Policy,
    recipients: i64,
    first_contact: i64,
) -> Result<(Counted, Option<Denial>), weldsuite_ports::PortError> {
    let now = OffsetDateTime::now_utc();
    let counted = Counted {
        hour: now.unix_timestamp().div_euclid(HOUR_SECONDS),
        month: format!("{:04}-{:02}", now.year(), u8::from(now.month())),
        recipients,
        first_contact,
    };
    add(
        cache,
        &ctx.workspace_id,
        &counted,
        recipients,
        first_contact,
    )
    .await?;
    let ws = &ctx.workspace_id;
    let day = day_total(cache, ws, "r", counted.hour).await?;
    if day > policy.limits.workspace_per_day {
        let denial = Denial {
            code: "SENDING_LIMITED",
            limit: Some(policy.limits.workspace_per_day),
            used: Some(day - recipients),
        };
        return Ok((counted, Some(denial)));
    }
    if let Some(monthly) = policy.limits.monthly_recipients {
        let month = cache
            .get_boxed(&counter_key(ws, "m", &counted.month))
            .await?
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        if month > monthly {
            let denial = Denial {
                code: "SENDING_LIMITED",
                limit: Some(monthly),
                used: Some(month - recipients),
            };
            return Ok((counted, Some(denial)));
        }
    }
    if first_contact > 0 {
        let fc = day_total(cache, ws, "fc", counted.hour).await?;
        if fc > policy.limits.first_contact_per_day {
            let denial = Denial {
                code: "FIRST_CONTACT_LIMITED",
                limit: Some(policy.limits.first_contact_per_day),
                used: Some(fc - first_contact),
            };
            return Ok((counted, Some(denial)));
        }
    }
    Ok((counted, None))
}

/// `checkOutbound` for a batch of signing requests to `to`.
pub(crate) async fn reserve(
    ctx: &SendContext,
    envelope: &Value,
    to: &[String],
    _names: &[String],
) -> Reserve {
    let recipients = unique_addresses(to);
    let Ok(first_contact) = first_contacts(ctx, &recipients).await else {
        return Reserve::Refused;
    };
    let base = Reservation {
        recipients,
        first_contact,
        counted: None,
    };
    let Some(cache) = ctx.services.cache.as_deref() else {
        return Reserve::Granted(Some(base));
    };
    let flag_context = FlagContext {
        workspace_id: ctx.workspace_id.clone(),
        clerk_org_id: Some(ctx.clerk_org_id.clone()),
        user_id: String::new(),
    };
    let mode = ctx
        .services
        .flags
        .string_value(WELDMAIL_OUTBOUND_GUARD, &flag_context)
        .await;
    let mode = match mode.as_str() {
        "off" | "shadow" | "enforce" => mode,
        _ => "shadow".to_owned(),
    };
    if mode == "off" {
        return Reserve::Granted(Some(base));
    }
    let policy = match load_policy(ctx).await {
        Ok(policy) => policy,
        Err(error) => {
            tracing::error!(%error, "sign: outbound policy unavailable, failing open");
            return Reserve::Granted(Some(base));
        }
    };
    let envelope_id = text(envelope, "id");
    // The state gate: a signing request starts a conversation.
    let gate = match policy.state.as_str() {
        "suspended" => Some("SENDING_SUSPENDED"),
        "hold" => Some("SENDING_ON_HOLD"),
        _ => None,
    };
    if let Some(code) = gate {
        if mode == "enforce" {
            tracing::warn!(
                envelope_id,
                code,
                "sign: mail refused by the outbound guard"
            );
            return Reserve::Refused;
        }
        tracing::info!(
            envelope_id,
            code,
            "sign: outbound guard (shadow) would refuse"
        );
    }
    let n = i64::try_from(base.recipients.len()).unwrap_or(i64::MAX);
    let fc = i64::try_from(base.first_contact.len()).unwrap_or(i64::MAX);
    match count_and_decide(ctx, cache, &policy, n, fc).await {
        Ok((counted, Some(denial))) if mode == "enforce" => {
            tracing::warn!(
                envelope_id,
                code = denial.code,
                limit = denial.limit,
                used = denial.used,
                "sign: mail refused by the outbound guard"
            );
            if let Err(error) = add(cache, &ctx.workspace_id, &counted, -n, -fc).await {
                tracing::warn!(%error, "sign: outbound counters not handed back");
            }
            Reserve::Refused
        }
        Ok((counted, denial)) => {
            if let Some(denial) = denial {
                tracing::info!(
                    envelope_id,
                    code = denial.code,
                    limit = denial.limit,
                    used = denial.used,
                    "sign: outbound guard (shadow) would refuse"
                );
            }
            Reserve::Granted(Some(Reservation {
                counted: Some(counted),
                ..base
            }))
        }
        Err(error) => {
            tracing::error!(%error, "sign: outbound counters unavailable, failing open");
            Reserve::Granted(Some(base))
        }
    }
}

/// `releaseOutbound`: hand back what a send that never went out counted.
pub(crate) async fn release(ctx: &SendContext, reservation: Option<Reservation>) {
    let (Some(reservation), Some(cache)) = (reservation, ctx.services.cache.as_deref()) else {
        return;
    };
    if let Some(counted) = &reservation.counted
        && let Err(error) = add(
            cache,
            &ctx.workspace_id,
            counted,
            -counted.recipients,
            -counted.first_contact,
        )
        .await
    {
        tracing::warn!(%error, "sign: outbound release failed");
    }
}

/// `settle` in mail.ts: release when nothing went out, else commit what did
/// (handing back the recipients that were not reached) and record them as
/// correspondents (`recordOutboundCorrespondents`).
pub(crate) async fn settle(
    ctx: &SendContext,
    reservation: Option<Reservation>,
    sent: &[String],
    _total: usize,
) {
    let Some(reservation) = reservation else {
        return;
    };
    if sent.is_empty() {
        release(ctx, Some(reservation)).await;
        return;
    }
    let sent = unique_addresses(sent);
    if let (Some(counted), Some(cache)) = (&reservation.counted, ctx.services.cache.as_deref()) {
        let missed = reservation
            .recipients
            .iter()
            .filter(|r| !sent.contains(r))
            .count();
        let missed_fc = reservation
            .first_contact
            .iter()
            .filter(|r| !sent.contains(r))
            .count();
        let missed = i64::try_from(missed).unwrap_or(0);
        let missed_fc = i64::try_from(missed_fc).unwrap_or(0);
        if (missed > 0 || missed_fc > 0)
            && let Err(error) = add(cache, &ctx.workspace_id, counted, -missed, -missed_fc).await
        {
            tracing::warn!(%error, "sign: outbound commit failed");
        }
    }
    let now = crate::now();
    let recorded = sqlx::query(
        "insert into mail_correspondents
             (email, first_outbound_at, last_outbound_at, outbound_count, updated_at)
         select email, $2::timestamp, $2::timestamp, 1, $2::timestamp from unnest($1::text[]) as email
         on conflict (email) do update set
             first_outbound_at = coalesce(mail_correspondents.first_outbound_at, excluded.first_outbound_at),
             last_outbound_at = excluded.last_outbound_at,
             outbound_count = mail_correspondents.outbound_count + 1,
             updated_at = excluded.updated_at",
    )
    .bind(&sent)
    .bind(&now)
    .execute(&ctx.db)
    .await;
    if let Err(error) = recorded {
        tracing::warn!(%error, "sign: outbound correspondent record failed");
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn limits_follow_the_trust_level_state_and_overrides() {
        assert_eq!(default_limits("new").workspace_per_day, 300);
        assert_eq!(
            resolve_limits("standard", "restricted", &json!({ "workspacePerDay": 9 })),
            default_limits("restricted")
        );
        let overridden = resolve_limits(
            "new",
            "active",
            &json!({ "workspacePerDay": 10, "monthlyRecipients": 100 }),
        );
        assert_eq!(overridden.workspace_per_day, 10);
        assert_eq!(overridden.monthly_recipients, Some(100));
        // One bad value and safeParse rejects the whole override.
        assert_eq!(
            resolve_limits(
                "new",
                "active",
                &json!({ "workspacePerDay": 10, "firstContactPerDay": -1 })
            ),
            default_limits("new")
        );
    }

    #[test]
    fn trust_and_addresses() {
        assert_eq!(trust_level(None, 30.0, true), "standard");
        assert_eq!(trust_level(None, 3.0, true), "new");
        assert_eq!(trust_level(None, 300.0, false), "new");
        assert_eq!(trust_level(Some("trusted"), 0.0, false), "trusted");
        assert_eq!(
            unique_addresses(&[
                "\"Anna\" <Anna@Example.com>".to_owned(),
                "anna@example.com".to_owned(),
                "nobody".to_owned()
            ]),
            vec!["anna@example.com".to_owned()]
        );
    }

    #[tokio::test]
    async fn counters_reserve_and_hand_back() {
        let cache = weldsuite_ports::MemoryCache::new();
        let counted = Counted {
            hour: 100,
            month: "2026-11".to_owned(),
            recipients: 3,
            first_contact: 1,
        };
        add(&cache, "ws_1", &counted, 3, 1).await.expect("add");
        assert_eq!(day_total(&cache, "ws_1", "r", 110).await.expect("sum"), 3);
        assert_eq!(day_total(&cache, "ws_1", "r", 124).await.expect("sum"), 0);
        add(&cache, "ws_1", &counted, -3, -1).await.expect("add");
        assert_eq!(day_total(&cache, "ws_1", "fc", 100).await.expect("sum"), 0);
    }
}
