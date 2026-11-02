//! Master-database side of the guard (`outbound/policy-store.ts`): load a
//! subject's sending policy and record automatic and staff changes to it.

use serde_json::{Map, Value, json};
use weldsuite_catalogs::flags::WELDMAIL_OUTBOUND_GUARD;
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_ports::{DynFlagSource, FlagContext, FlagSourceExt};

use super::clock::iso;
use super::ledger_core::{LedgerPolicy, LedgerSubject};
use super::limits::{
    GuardMode, OutboundState, RESTRICTED_LIMITS, TrustInput, TrustLevel, apply_overrides,
    compute_trust_level, personal_limits, resolve_outbound_limits,
};

/// `OUTBOUND_GUARD_FLAG`.
pub const OUTBOUND_GUARD_FLAG: &str = "weldmail-outbound-guard";

/// `DEFAULT_GUARD_MODE`: decide and log, do not block.
pub const DEFAULT_GUARD_MODE: GuardMode = GuardMode::Shadow;

/// `readGuardMode(env, subject)`: the flag's value for the subject, or the
/// default.
pub async fn read_guard_mode(
    flags: Option<&(dyn DynFlagSource + 'static)>,
    subject: &LedgerSubject,
) -> GuardMode {
    let Some(flags) = flags else {
        return DEFAULT_GUARD_MODE;
    };
    let context = match subject {
        LedgerSubject::Workspace {
            workspace_id,
            clerk_org_id,
        } => FlagContext {
            workspace_id: workspace_id.clone(),
            clerk_org_id: clerk_org_id.clone(),
            user_id: String::new(),
        },
        LedgerSubject::Personal {
            personal_account_id,
            ..
        } => FlagContext {
            workspace_id: String::new(),
            clerk_org_id: None,
            user_id: personal_account_id.clone(),
        },
    };
    let value = flags.string_value(WELDMAIL_OUTBOUND_GUARD, &context).await;
    GuardMode::parse(&value).unwrap_or(DEFAULT_GUARD_MODE)
}

/// `DeliveryRates`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct DeliveryRates {
    pub hard_bounce_rate_7d: Option<f64>,
    pub complaint_rate_7d: Option<f64>,
}

/// `LoadedPolicy`: the policy plus the stored risk score.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedPolicy {
    pub policy: LedgerPolicy,
    pub risk_score: i64,
}

/// `fallbackPolicy()`: used when the master database can't be reached and
/// no policy was loaded before: count, never block.
pub fn fallback_policy() -> LoadedPolicy {
    LoadedPolicy {
        policy: LedgerPolicy {
            mode: GuardMode::Shadow,
            trust_level: TrustLevel::Standard,
            state: OutboundState::Active,
            state_reason: None,
            state_set_by: None,
            state_set_at: None,
            allow_replies_when_suspended: false,
            limits: super::limits::STANDARD_LIMITS,
        },
        risk_score: 0,
    }
}

type PolicyRow = (
    Option<String>,
    Option<Value>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<f64>,
    Option<bool>,
    Option<i32>,
);

async fn policy_row(
    db: &PgPool,
    subject: &LedgerSubject,
) -> Result<Option<PolicyRow>, sqlx::Error> {
    let (workspace, personal) = subject_columns(subject);
    sqlx::query_as(
        "select trust_override, limits, state, state_reason, state_set_by,
                (extract(epoch from state_set_at) * 1000)::float8,
                allow_replies_when_suspended, risk_score
         from outbound_mail_policies
         where ($1::text is not null and workspace_id = $1)
            or ($2::text is not null and personal_account_id = $2)
         limit 1",
    )
    .bind(workspace)
    .bind(personal)
    .fetch_optional(db)
    .await
}

/// `(created_at, subscription_status, comp_granted_at, billing_mode,
/// price_monthly)`, times in ms.
type WorkspaceRow = (
    Option<f64>,
    Option<String>,
    Option<f64>,
    Option<String>,
    Option<f64>,
);

/// `loadLedgerPolicy(env, subject, rates)`.
#[allow(clippy::cast_possible_truncation)]
pub async fn load_ledger_policy(
    db: &PgPool,
    flags: Option<&(dyn DynFlagSource + 'static)>,
    subject: &LedgerSubject,
    rates: DeliveryRates,
    now_ms: i64,
) -> Result<LoadedPolicy, sqlx::Error> {
    let mode = read_guard_mode(flags, subject).await;
    let row = policy_row(db, subject).await?;
    let state = row
        .as_ref()
        .and_then(|r| r.2.as_deref())
        .and_then(OutboundState::parse)
        .unwrap_or(OutboundState::Active);
    let trust_override = row
        .as_ref()
        .and_then(|r| r.0.as_deref())
        .and_then(TrustLevel::parse);
    let overrides = row.as_ref().and_then(|r| r.1.clone());
    let (trust_level, limits) = match subject {
        LedgerSubject::Personal { plan, .. } => {
            let trust = trust_override.unwrap_or(if plan == "pro" {
                TrustLevel::Standard
            } else {
                TrustLevel::New
            });
            if state == OutboundState::Restricted {
                (trust, RESTRICTED_LIMITS)
            } else {
                (
                    trust,
                    apply_overrides(personal_limits(plan == "pro"), overrides.as_ref()),
                )
            }
        }
        LedgerSubject::Workspace { workspace_id, .. } => {
            let workspace: Option<WorkspaceRow> = sqlx::query_as(
                "select (extract(epoch from w.created_at) * 1000)::float8,
                            w.subscription_status,
                            (extract(epoch from w.comp_granted_at) * 1000)::float8,
                            w.billing_mode,
                            p.price_monthly::float8
                     from workspaces w
                     left join plans p on p.id = w.plan_id
                     where w.id = $1
                     limit 1",
            )
            .bind(workspace_id)
            .fetch_optional(db)
            .await?;
            let trust = match workspace {
                Some((created, status, comp, billing, price)) => compute_trust_level(&TrustInput {
                    created_at_ms: created.unwrap_or_default() as i64,
                    subscription_status: status,
                    plan_price_monthly: price,
                    comp_granted: comp.is_some() || billing.as_deref() == Some("partner"),
                    trust_override,
                    hard_bounce_rate_7d: rates.hard_bounce_rate_7d,
                    complaint_rate_7d: rates.complaint_rate_7d,
                    now_ms,
                }),
                None => trust_override.unwrap_or(TrustLevel::New),
            };
            (
                trust,
                resolve_outbound_limits(trust, state, overrides.as_ref()),
            )
        }
    };
    Ok(LoadedPolicy {
        policy: LedgerPolicy {
            mode,
            trust_level,
            state,
            state_reason: row.as_ref().and_then(|r| r.3.clone()),
            state_set_by: row.as_ref().and_then(|r| r.4.clone()),
            state_set_at: row.as_ref().and_then(|r| r.5).map(|ms| ms as i64),
            allow_replies_when_suspended: row.as_ref().and_then(|r| r.6).unwrap_or(false),
            limits,
        },
        risk_score: row.as_ref().and_then(|r| r.7).map_or(0, i64::from),
    })
}

/// `subjectColumns(subject)`: `(workspace_id, personal_account_id)`.
pub fn subject_columns(subject: &LedgerSubject) -> (Option<&str>, Option<&str>) {
    match subject {
        LedgerSubject::Workspace { workspace_id, .. } => (Some(workspace_id.as_str()), None),
        LedgerSubject::Personal {
            personal_account_id,
            ..
        } => (None, Some(personal_account_id.as_str())),
    }
}

async fn policy_id(db: &PgPool, subject: &LedgerSubject) -> Result<Option<String>, sqlx::Error> {
    let (workspace, personal) = subject_columns(subject);
    sqlx::query_scalar(
        "select id from outbound_mail_policies
         where ($1::text is not null and workspace_id = $1)
            or ($2::text is not null and personal_account_id = $2)
         limit 1",
    )
    .bind(workspace)
    .bind(personal)
    .fetch_optional(db)
    .await
}

/// `ensurePolicyRow(db, subject)`: create the row if missing; its id.
pub async fn ensure_policy_row(
    db: &PgPool,
    subject: &LedgerSubject,
) -> Result<String, sqlx::Error> {
    if let Some(id) = policy_id(db, subject).await? {
        return Ok(id);
    }
    let id = generate_id("obpol");
    let (workspace, personal) = subject_columns(subject);
    sqlx::query(
        "insert into outbound_mail_policies (id, workspace_id, personal_account_id)
         values ($1, $2, $3) on conflict do nothing",
    )
    .bind(&id)
    .bind(workspace)
    .bind(personal)
    .execute(db)
    .await?;
    Ok(policy_id(db, subject).await?.unwrap_or(id))
}

/// `saveRiskScore(env, subject, score)`.
pub async fn save_risk_score(
    db: &PgPool,
    subject: &LedgerSubject,
    score: i64,
    now_ms: i64,
) -> Result<(), sqlx::Error> {
    let (workspace, personal) = subject_columns(subject);
    let now = iso(now_ms);
    let update = "update outbound_mail_policies
                  set risk_score = $3, risk_updated_at = $4::timestamp, updated_at = $4::timestamp
                  where ($1::text is not null and workspace_id = $1)
                     or ($2::text is not null and personal_account_id = $2)";
    let updated = sqlx::query(update)
        .bind(workspace)
        .bind(personal)
        .bind(i32::try_from(score).unwrap_or(i32::MAX))
        .bind(&now)
        .execute(db)
        .await?
        .rows_affected();
    if updated == 0 && score > 0 {
        ensure_policy_row(db, subject).await?;
        sqlx::query(update)
            .bind(workspace)
            .bind(personal)
            .bind(i32::try_from(score).unwrap_or(i32::MAX))
            .bind(&now)
            .execute(db)
            .await?;
    }
    Ok(())
}

/// An automatic state change (`applyAutomaticState`).
#[derive(Debug, Clone)]
pub struct StateChange {
    pub from: OutboundState,
    pub to: OutboundState,
    pub customer_reason: String,
    pub reason: String,
    pub details: Value,
}

/// `applyAutomaticState(env, subject, change)`.
pub async fn apply_automatic_state(
    db: &PgPool,
    subject: &LedgerSubject,
    change: &StateChange,
    now_ms: i64,
) -> Result<(), sqlx::Error> {
    ensure_policy_row(db, subject).await?;
    let (workspace, personal) = subject_columns(subject);
    sqlx::query(
        "update outbound_mail_policies
         set state = $3, state_reason = $4, state_set_by = 'system',
             state_set_at = $5::timestamp, updated_at = $5::timestamp
         where (($1::text is not null and workspace_id = $1)
            or ($2::text is not null and personal_account_id = $2))
           and state = $6",
    )
    .bind(workspace)
    .bind(personal)
    .bind(change.to.as_str())
    .bind(&change.customer_reason)
    .bind(iso(now_ms))
    .bind(change.from.as_str())
    .execute(db)
    .await?;
    record_outbound_event(
        db,
        Some(subject),
        &OutboundEvent {
            kind: "state_changed",
            from_value: Some(change.from.as_str().to_owned()),
            to_value: Some(change.to.as_str().to_owned()),
            reason: Some(change.reason.clone()),
            actor: "system".to_owned(),
            details: Some(change.details.clone()),
        },
    )
    .await;
    Ok(())
}

/// One `outbound_mail_events` row.
#[derive(Debug, Clone)]
pub struct OutboundEvent {
    /// `OUTBOUND_EVENT_KINDS`.
    pub kind: &'static str,
    pub from_value: Option<String>,
    pub to_value: Option<String>,
    pub reason: Option<String>,
    pub actor: String,
    pub details: Option<Value>,
}

/// `recordOutboundEvent(db, subject, event)`; `None` for the platform.
/// Never fails: a failed insert is logged.
pub async fn record_outbound_event(
    db: &PgPool,
    subject: Option<&LedgerSubject>,
    event: &OutboundEvent,
) {
    let (workspace, personal) = subject.map_or((None, None), subject_columns);
    let result = sqlx::query(
        "insert into outbound_mail_events
           (id, workspace_id, personal_account_id, kind, from_value, to_value, reason, actor, details)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(generate_id("obevt"))
    .bind(workspace)
    .bind(personal)
    .bind(event.kind)
    .bind(&event.from_value)
    .bind(&event.to_value)
    .bind(&event.reason)
    .bind(&event.actor)
    .bind(&event.details)
    .execute(db)
    .await;
    if let Err(error) = result {
        tracing::error!(%error, "[outbound] Failed to record event");
    }
}

/// `{ key: value, … }` from ordered pairs.
pub fn ordered_object(entries: &[(String, Value)]) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.clone(), value.clone());
    }
    Value::Object(map)
}

/// The customer-facing reason while a system restriction is on
/// (`CUSTOMER_REASONS`).
pub fn customer_reason(state: OutboundState) -> &'static str {
    match state {
        OutboundState::Hold => {
            "New conversations are paused while WeldSuite reviews this workspace. Replies still go out."
        }
        _ => "Sending is limited while WeldSuite reviews unusual activity from this workspace.",
    }
}

/// `{ recipients, quota }` for the platform breaker's trail.
pub fn platform_details(recipients: i64, quota: Option<i64>) -> Value {
    json!({ "recipients": recipients, "quota": quota })
}
