//! Master-database side of the guard (`outbound/policy-store.ts`): load a
//! subject's sending policy and record automatic and staff changes to it.

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect,
    RelationDef,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::flags::WELDMAIL_OUTBOUND_GUARD;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_ports::{DynFlagSource, FlagContext, FlagSourceExt};
use weldsuite_schema::master::{outbound_mail_events, outbound_mail_policies, plans, workspaces};

use super::clock::timestamp;
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

/// `(extract(epoch from at) * 1000)::float8` as an integer: the moment's
/// milliseconds (a `timestamp` column is UTC).
fn epoch_ms(at: PrimitiveDateTime) -> i64 {
    i64::try_from(at.assume_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or_default()
}

/// The subject's row: `($1 is not null and workspace_id = $1) or ($2 is not
/// null and personal_account_id = $2)`, one of the two set.
fn subject_condition(subject: &LedgerSubject) -> Expr {
    match subject {
        LedgerSubject::Workspace { workspace_id, .. } => {
            outbound_mail_policies::Column::WorkspaceId.eq(workspace_id.as_str())
        }
        LedgerSubject::Personal {
            personal_account_id,
            ..
        } => outbound_mail_policies::Column::PersonalAccountId.eq(personal_account_id.as_str()),
    }
}

async fn policy_row(
    db: &PgPool,
    subject: &LedgerSubject,
) -> Result<Option<outbound_mail_policies::Model>, DbErr> {
    outbound_mail_policies::Entity::find()
        .filter(subject_condition(subject))
        .one(&orm(db))
        .await
}

/// `(created_at, subscription_status, comp_granted_at, billing_mode,
/// price_monthly::float8)`.
type WorkspaceRow = (
    PrimitiveDateTime,
    Option<String>,
    Option<PrimitiveDateTime>,
    String,
    Option<f64>,
);

/// `leftJoin(plans, eq(plans.id, workspaces.planId))`.
fn workspace_plan() -> RelationDef {
    workspaces::Entity::belongs_to(plans::Entity)
        .from(workspaces::Column::PlanId)
        .to(plans::Column::Id)
        .into()
}

async fn workspace_row(db: &PgPool, workspace_id: &str) -> Result<Option<WorkspaceRow>, DbErr> {
    workspaces::Entity::find()
        .select_only()
        .columns([
            workspaces::Column::CreatedAt,
            workspaces::Column::SubscriptionStatus,
            workspaces::Column::CompGrantedAt,
            workspaces::Column::BillingMode,
        ])
        .column_as(
            sea_orm::ExprTrait::cast_as(
                Expr::col((plans::Entity, plans::Column::PriceMonthly)),
                "float8",
            ),
            "price_monthly",
        )
        .join(JoinType::LeftJoin, workspace_plan())
        .filter(workspaces::Column::Id.eq(workspace_id))
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `loadLedgerPolicy(env, subject, rates)`.
pub async fn load_ledger_policy(
    db: &PgPool,
    flags: Option<&(dyn DynFlagSource + 'static)>,
    subject: &LedgerSubject,
    rates: DeliveryRates,
    now_ms: i64,
) -> Result<LoadedPolicy, DbErr> {
    let mode = read_guard_mode(flags, subject).await;
    let row = policy_row(db, subject).await?;
    let state = row
        .as_ref()
        .and_then(|r| OutboundState::parse(&r.state))
        .unwrap_or(OutboundState::Active);
    let trust_override = row
        .as_ref()
        .and_then(|r| r.trust_override.as_deref())
        .and_then(TrustLevel::parse);
    let overrides = row.as_ref().map(|r| r.limits.clone());
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
            let workspace = workspace_row(db, workspace_id).await?;
            let trust = match workspace {
                Some((created, status, comp, billing, price)) => compute_trust_level(&TrustInput {
                    created_at_ms: epoch_ms(created),
                    subscription_status: status,
                    plan_price_monthly: price,
                    comp_granted: comp.is_some() || billing == "partner",
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
            state_reason: row.as_ref().and_then(|r| r.state_reason.clone()),
            state_set_by: row.as_ref().and_then(|r| r.state_set_by.clone()),
            state_set_at: row.as_ref().and_then(|r| r.state_set_at).map(epoch_ms),
            allow_replies_when_suspended: row
                .as_ref()
                .is_some_and(|r| r.allow_replies_when_suspended),
            limits,
        },
        risk_score: row.as_ref().map_or(0, |r| i64::from(r.risk_score)),
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

async fn policy_id(db: &PgPool, subject: &LedgerSubject) -> Result<Option<String>, DbErr> {
    outbound_mail_policies::Entity::find()
        .select_only()
        .column(outbound_mail_policies::Column::Id)
        .filter(subject_condition(subject))
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `ensurePolicyRow(db, subject)`: create the row if missing; its id.
pub async fn ensure_policy_row(db: &PgPool, subject: &LedgerSubject) -> Result<String, DbErr> {
    if let Some(id) = policy_id(db, subject).await? {
        return Ok(id);
    }
    let id = generate_id("obpol");
    let (workspace, personal) = subject_columns(subject);
    let row = outbound_mail_policies::ActiveModel {
        id: Set(id.clone()),
        workspace_id: Set(workspace.map(str::to_owned)),
        personal_account_id: Set(personal.map(str::to_owned)),
        ..Default::default()
    };
    outbound_mail_policies::Entity::insert(row)
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .exec_without_returning(&orm(db))
        .await?;
    Ok(policy_id(db, subject).await?.unwrap_or(id))
}

/// `update outbound_mail_policies set risk_score, risk_updated_at,
/// updated_at` on the subject's row: the rows it changed.
async fn update_risk_score(
    db: &PgPool,
    subject: &LedgerSubject,
    score: i32,
    now: PrimitiveDateTime,
) -> Result<u64, DbErr> {
    use outbound_mail_policies::Column;
    let done = outbound_mail_policies::Entity::update_many()
        .col_expr(Column::RiskScore, Expr::value(score))
        .col_expr(Column::RiskUpdatedAt, Expr::value(now))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(subject_condition(subject))
        .exec(&orm(db))
        .await?;
    Ok(done.rows_affected)
}

/// `saveRiskScore(env, subject, score)`.
pub async fn save_risk_score(
    db: &PgPool,
    subject: &LedgerSubject,
    score: i64,
    now_ms: i64,
) -> Result<(), DbErr> {
    let now = timestamp(now_ms);
    let stored = i32::try_from(score).unwrap_or(i32::MAX);
    let updated = update_risk_score(db, subject, stored, now).await?;
    if updated == 0 && score > 0 {
        ensure_policy_row(db, subject).await?;
        update_risk_score(db, subject, stored, now).await?;
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
) -> Result<(), DbErr> {
    use outbound_mail_policies::Column;
    ensure_policy_row(db, subject).await?;
    let now = timestamp(now_ms);
    // Only from the state the change was decided on.
    outbound_mail_policies::Entity::update_many()
        .col_expr(Column::State, Expr::value(change.to.as_str()))
        .col_expr(Column::StateReason, Expr::value(&change.customer_reason))
        .col_expr(Column::StateSetBy, Expr::value("system"))
        .col_expr(Column::StateSetAt, Expr::value(now))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(subject_condition(subject))
        .filter(Column::State.eq(change.from.as_str()))
        .exec(&orm(db))
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
    let row = outbound_mail_events::ActiveModel {
        id: Set(generate_id("obevt")),
        workspace_id: Set(workspace.map(str::to_owned)),
        personal_account_id: Set(personal.map(str::to_owned)),
        kind: Set(event.kind.to_owned()),
        from_value: Set(event.from_value.clone()),
        to_value: Set(event.to_value.clone()),
        reason: Set(event.reason.clone()),
        actor: Set(event.actor.clone()),
        details: Set(event.details.clone()),
        ..Default::default()
    };
    let result = outbound_mail_events::Entity::insert(row)
        .exec_without_returning(&orm(db))
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
