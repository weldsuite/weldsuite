//! `services/guardrails.ts`: the auto-pause rules that protect sender
//! reputation.
//!
//! - a mailbox with `MAILBOX_HARD_BOUNCES_PER_DAY` hard bounces in the last
//!   24 hours is paused (`pausedReason: 'bounces'`);
//! - a campaign whose bounce rate over its last `CAMPAIGN_BOUNCE_WINDOW`
//!   sends is above `CAMPAIGN_BOUNCE_RATE` is paused
//!   (`pausedReason: 'bounce_rate'`).
//!
//! [`record_hard_bounce`] is the one entry point (the send tick when a
//! recipient is refused, the inbound handler when a bounce notice arrives),
//! called after the enrollment was marked `bounced`.

use std::collections::HashSet;

use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, JoinType, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{REACH_CAMPAIGN_PAUSED, REACH_MAILBOX_UPDATED};
use weldsuite_db::orm;
use weldsuite_schema::tenant::{
    reach_campaigns as campaigns, reach_enrollments as enrollments, reach_mailboxes as mailboxes,
    reach_messages as messages,
};

use crate::schemas::sending;
use crate::{EventSink, ReachEvent, ReachResult, js, stamp, text_or_empty};

/// Fewer sends than this say nothing about a rate.
pub const CAMPAIGN_BOUNCE_MIN_SAMPLE: i64 = 20;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// `GuardrailResult`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GuardrailResult {
    pub mailbox_paused: bool,
    pub campaign_paused: bool,
}

/// `mailboxHardBouncesLastDay(db, mailboxId, now)`.
pub async fn mailbox_hard_bounces_last_day(
    db: &PgPool,
    mailbox_id: &str,
    now: OffsetDateTime,
) -> ReachResult<i64> {
    let since = now - time::Duration::milliseconds(DAY_MS);
    let n = enrollments::Entity::find()
        .filter(enrollments::Column::MailboxId.eq(mailbox_id))
        .filter(enrollments::Column::Status.eq("bounced"))
        .filter(enrollments::Column::UpdatedAt.gte(stamp(since)))
        .count(&orm(db))
        .await?;
    Ok(i64::try_from(n).unwrap_or(i64::MAX))
}

/// `pauseMailboxOnBounces`; the hook publishes `reach_mailbox:updated`
/// with the whole row (`onMailboxPaused`'s data is chosen by the caller).
pub async fn pause_mailbox_on_bounces(
    db: &PgPool,
    mailbox_id: &str,
    now: OffsetDateTime,
) -> ReachResult<Option<Value>> {
    if mailbox_hard_bounces_last_day(db, mailbox_id, now).await?
        < sending::MAILBOX_HARD_BOUNCES_PER_DAY
    {
        return Ok(None);
    }
    let paused = mailboxes::Entity::update_many()
        .col_expr(mailboxes::Column::Status, Expr::value("paused"))
        .col_expr(mailboxes::Column::PausedReason, Expr::value("bounces"))
        .col_expr(mailboxes::Column::UpdatedAt, Expr::value(stamp(now)))
        .filter(mailboxes::Column::Id.eq(mailbox_id))
        .filter(mailboxes::Column::Status.eq("active"))
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next();
    Ok(paused.map(serde_json::to_value).map(js).transpose()?)
}

/// `campaignBounceRate(db, campaignId)`: (sample, bounced, rate).
pub async fn campaign_bounce_rate(db: &PgPool, campaign_id: &str) -> ReachResult<(i64, i64, f64)> {
    let rows: Vec<(Option<String>, Option<String>)> = messages::Entity::find()
        .select_only()
        .column(messages::Column::EnrollmentId)
        .column(enrollments::Column::Status)
        .join(
            JoinType::LeftJoin,
            messages::Entity::belongs_to(enrollments::Entity)
                .from(messages::Column::EnrollmentId)
                .to(enrollments::Column::Id)
                .into(),
        )
        .filter(messages::Column::CampaignId.eq(campaign_id))
        .filter(messages::Column::Direction.eq("out"))
        .filter(
            Condition::any()
                .add(messages::Column::Status.eq("sent"))
                .add(
                    Condition::all()
                        .add(messages::Column::Status.eq("failed"))
                        .add(enrollments::Column::Status.eq("bounced")),
                ),
        )
        .order_by_desc(messages::Column::CreatedAt)
        .order_by_desc(messages::Column::Id)
        .limit(u64::try_from(sending::CAMPAIGN_BOUNCE_WINDOW).unwrap_or_default())
        .into_tuple()
        .all(&orm(db))
        .await?;
    let bounced: HashSet<Option<String>> = rows
        .iter()
        .filter(|(_, status)| status.as_deref() == Some("bounced"))
        .map(|(enrollment, _)| enrollment.clone())
        .collect();
    let sample = rows.len() as i64;
    let bounced = bounced.len() as i64;
    let rate = if sample == 0 {
        0.0
    } else {
        bounced as f64 / sample as f64
    };
    Ok((sample, bounced, rate))
}

/// `pauseCampaignOnBounceRate`.
pub async fn pause_campaign_on_bounce_rate(
    db: &PgPool,
    campaign_id: &str,
    now: OffsetDateTime,
) -> ReachResult<Option<Value>> {
    let (sample, _, rate) = campaign_bounce_rate(db, campaign_id).await?;
    if sample < CAMPAIGN_BOUNCE_MIN_SAMPLE || rate <= sending::CAMPAIGN_BOUNCE_RATE {
        return Ok(None);
    }
    let paused = campaigns::Entity::update_many()
        .col_expr(campaigns::Column::Status, Expr::value("paused"))
        .col_expr(campaigns::Column::PausedReason, Expr::value("bounce_rate"))
        .col_expr(campaigns::Column::UpdatedAt, Expr::value(stamp(now)))
        .filter(campaigns::Column::Id.eq(campaign_id))
        .filter(campaigns::Column::Status.eq("active"))
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next();
    Ok(paused.map(serde_json::to_value).map(js).transpose()?)
}

/// `recordHardBounce(db, target, hooks, now)` with the send tick's hooks:
/// a paused mailbox publishes `reach_mailbox:updated` with
/// `{ id, email, status, pausedReason }`, a paused campaign
/// `reach_campaign:paused` with the row.
pub async fn record_hard_bounce(
    db: &PgPool,
    mailbox_id: Option<&str>,
    campaign_id: Option<&str>,
    emit: &dyn EventSink,
    now: OffsetDateTime,
) -> ReachResult<GuardrailResult> {
    let mut result = GuardrailResult::default();
    if let Some(mailbox_id) = mailbox_id
        && let Some(m) = pause_mailbox_on_bounces(db, mailbox_id, now).await?
    {
        result.mailbox_paused = true;
        emit.emit(ReachEvent::new(
            REACH_MAILBOX_UPDATED,
            text_or_empty(&m, "id"),
            mailbox_event(&m),
        ));
    }
    if let Some(campaign_id) = campaign_id
        && let Some(c) = pause_campaign_on_bounce_rate(db, campaign_id, now).await?
    {
        result.campaign_paused = true;
        emit.emit(ReachEvent::new(
            REACH_CAMPAIGN_PAUSED,
            text_or_empty(&c, "id"),
            c.clone(),
        ));
    }
    Ok(result)
}

/// The data of the send tick's `reach_mailbox:updated` events.
pub fn mailbox_event(m: &Value) -> Value {
    json!({
        "id": m.get("id").cloned().unwrap_or(Value::Null),
        "email": m.get("email").cloned().unwrap_or(Value::Null),
        "status": m.get("status").cloned().unwrap_or(Value::Null),
        "pausedReason": m.get("pausedReason").cloned().unwrap_or(Value::Null),
    })
}
