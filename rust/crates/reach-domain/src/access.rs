//! `access.ts`: what a workspace may do in WeldReach right now (the access
//! summary with live usage, and whether sending may run).

use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_schema::tenant::{reach_domains, reach_mailboxes, reach_messages};

use crate::inbox::AccessState;
use crate::schemas::resolve_limits;
use crate::{ReachResult, epoch_ms, parse_iso, stamp};

/// `BILLING_GRACE_DAYS`.
pub const BILLING_GRACE_DAYS: i64 = 7;

/// `maySend(access, now)`: `Err(reason)` when sending may not run.
pub fn may_send(access: &AccessState, now: OffsetDateTime) -> Result<(), String> {
    if access.status != "approved" {
        return Err(format!("access_{}", access.status));
    }
    if access.billing_status == "canceled" {
        return Err("billing_canceled".to_owned());
    }
    if access.billing_status == "past_due" {
        let since = access
            .billing_status_at
            .as_deref()
            .and_then(parse_iso)
            .map_or_else(|| epoch_ms(now), epoch_ms);
        if epoch_ms(now) - since > BILLING_GRACE_DAYS * 86_400_000 {
            return Err("billing_past_due".to_owned());
        }
    }
    Ok(())
}

/// `utcDayStart(now)`.
pub fn utc_day_start(now: OffsetDateTime) -> OffsetDateTime {
    now.replace_time(time::Time::MIDNIGHT)
}

/// `utcTomorrow(now)`.
pub fn utc_tomorrow(now: OffsetDateTime) -> OffsetDateTime {
    utc_day_start(now) + time::Duration::days(1)
}

/// `getReachUsage(db, now)`.
pub async fn usage(db: &PgPool, now: OffsetDateTime) -> ReachResult<Value> {
    let db = orm(db);
    let domains = reach_domains::Entity::find().count(&db).await?;
    let mailboxes = reach_mailboxes::Entity::find()
        .filter(reach_mailboxes::Column::Status.ne("deleted"))
        .filter(reach_mailboxes::Column::DeletedAt.is_null())
        .count(&db)
        .await?;
    let sends = reach_messages::Entity::find()
        .filter(reach_messages::Column::Direction.eq("out"))
        .filter(reach_messages::Column::Status.eq("sent"))
        .filter(reach_messages::Column::SentAt.gte(stamp(utc_day_start(now))))
        .count(&db)
        .await?;
    Ok(json!({ "domains": domains, "mailboxes": mailboxes, "sendsToday": sends }))
}

/// `buildAccessSummary(input)`.
pub async fn summary(
    db: &PgPool,
    status: &str,
    limits: Option<&Value>,
    sending_enabled: bool,
) -> ReachResult<Value> {
    let usage = usage(db, crate::now()).await?;
    Ok(json!({
        "status": if status == "none" { "requested" } else { status },
        "limits": resolve_limits(limits).to_json(),
        "usage": usage,
        "sendingEnabled": sending_enabled,
    }))
}
