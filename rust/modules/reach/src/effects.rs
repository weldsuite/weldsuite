//! `services/reply-effects.ts` and `services/inbox.ts`: what a label does
//! (an opt-out suppresses and stops sequences, interest moves the counter),
//! and a person's change to one inbound message.

use sea_orm::sea_query::extension::postgres as pg;
use sea_orm::sea_query::{Expr, Func, OnConflict, Query};
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_reach_domain::schemas::is_consumer_email;
use weldsuite_reach_domain::{ReachResult, js_slice, now};
use weldsuite_schema::tenant::{
    reach_campaigns, reach_enrollments, reach_messages, reach_prospects, reach_suppressions,
};

use crate::{db_error, row_json};

const STOPPABLE: &[&str] = &["queued", "active", "paused", "completed"];

fn is_positive(label: Option<&str>) -> bool {
    matches!(label, Some("interested" | "meeting_request"))
}

/// `bumpCampaignStat(db, campaignId, key, by)`: never below zero.
pub(crate) async fn bump_campaign_stat(
    db: &PgPool,
    campaign_id: Option<&str>,
    key: &str,
    by: i64,
) -> ReachResult<()> {
    use sea_orm::ExprTrait as _;
    let Some(campaign_id) = campaign_id.filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    if by == 0 {
        return Ok(());
    }
    let stats = || Expr::col(reach_campaigns::Column::Stats);
    // `greatest(0, coalesce(stats->>key, '0')::int + by)`
    let current = Expr::from(Func::coalesce([
        pg::PgExpr::cast_json_field(stats(), key),
        Expr::val("0"),
    ]))
    .cast_as("int");
    let next = Func::greatest([
        Expr::val(0),
        current.add(i32::try_from(by).unwrap_or_default()),
    ]);
    // `jsonb_set(stats, array[key], to_jsonb(next))`
    let set = Func::cust("jsonb_set")
        .arg(stats())
        .arg(Expr::val(format!("{{{key}}}")).cast_as("text[]"))
        .arg(Func::cust("to_jsonb").arg(next));
    reach_campaigns::Entity::update_many()
        .col_expr(reach_campaigns::Column::Stats, Expr::from(set))
        .col_expr(reach_campaigns::Column::UpdatedAt, Expr::value(now()))
        .filter(reach_campaigns::Column::Id.eq(campaign_id))
        .exec(&orm(db))
        .await
        .map_err(db_error)?;
    Ok(())
}

/// `transitionEnrollment(db, id, to, reason, from)`.
pub(crate) async fn transition_enrollment(
    db: &PgPool,
    id: &str,
    to: &str,
    reason: &str,
    from: &[&str],
) -> ReachResult<bool> {
    let done = stopped(to, &js_slice(reason, 100))
        .filter(reach_enrollments::Column::Id.eq(id))
        .filter(reach_enrollments::Column::Status.is_in(from.iter().copied()))
        .exec(&orm(db))
        .await
        .map_err(db_error)?;
    Ok(done.rows_affected > 0)
}

/// `status = to, stopped_reason = reason, next_send_at = null,
/// claimed_at = null, updated_at = now` on `reach_enrollments`.
fn stopped(to: &str, reason: &str) -> sea_orm::UpdateMany<reach_enrollments::Entity> {
    reach_enrollments::Entity::update_many()
        .col_expr(reach_enrollments::Column::Status, Expr::value(to))
        .col_expr(
            reach_enrollments::Column::StoppedReason,
            Expr::value(reason),
        )
        .col_expr(reach_enrollments::Column::NextSendAt, Expr::null())
        .col_expr(reach_enrollments::Column::ClaimedAt, Expr::null())
        .col_expr(reach_enrollments::Column::UpdatedAt, Expr::value(now()))
}

/// `stopOtherEnrollments(db, input)`.
pub(crate) async fn stop_other_enrollments(
    db: &PgPool,
    prospect_id: &str,
    company_domain: Option<&str>,
    scope: &str,
    except: Option<&str>,
    unsubscribed: bool,
) -> ReachResult<i64> {
    let status = if unsubscribed {
        "unsubscribed"
    } else {
        "replied"
    };
    let domain = company_domain.unwrap_or_default().to_lowercase();
    let company_wide =
        scope == "company" && !domain.is_empty() && !is_consumer_email(&format!("x@{domain}"));
    let reason = if company_wide {
        "replied_company"
    } else if unsubscribed {
        "unsubscribed"
    } else {
        "replied_elsewhere"
    };
    let mut update = stopped(status, reason);
    update = if company_wide {
        update.filter(
            reach_enrollments::Column::ProspectId.in_subquery(
                Query::select()
                    .column(reach_prospects::Column::Id)
                    .from(reach_prospects::Entity)
                    .and_where(reach_prospects::Column::CompanyDomain.eq(&domain))
                    .and_where(reach_prospects::Column::DeletedAt.is_null())
                    .to_owned(),
            ),
        )
    } else {
        update.filter(reach_enrollments::Column::ProspectId.eq(prospect_id))
    };
    update = update.filter(reach_enrollments::Column::Status.is_in(["queued", "active", "paused"]));
    if let Some(except) = except {
        update = update.filter(reach_enrollments::Column::Id.ne(except));
    }
    let done = update.exec(&orm(db)).await.map_err(db_error)?;
    Ok(done.rows_affected as i64)
}

/// `suppressAddress(db, email, reason, source)`.
pub(crate) async fn suppress_address(
    db: &PgPool,
    email: &str,
    reason: &str,
    source: Option<&str>,
) -> ReachResult<()> {
    let value = weldsuite_reach_domain::text::js_trim(email).to_lowercase();
    if !value.contains('@') {
        return Ok(());
    }
    reach_suppressions::Entity::insert(reach_suppressions::ActiveModel {
        id: Set(generate_id("rsup")),
        value: Set(value),
        type_: Set("email".to_owned()),
        reason: Set(reason.to_owned()),
        source: Set(source.map(|s| js_slice(s, 255))),
        created_by: Set(None),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::column(reach_suppressions::Column::Value)
            .do_nothing()
            .to_owned(),
    )
    .exec_without_returning(&orm(db))
    .await
    .map_err(db_error)?;
    Ok(())
}

/// `flagProspectsSuppressed(db, emails)`.
pub(crate) async fn flag_prospects_suppressed(db: &PgPool, emails: &[String]) -> ReachResult<()> {
    let unique: Vec<String> = weldsuite_reach_domain::unique(
        &emails
            .iter()
            .map(|e| weldsuite_reach_domain::text::js_trim(e).to_lowercase())
            .filter(|e| e.contains('@'))
            .collect::<Vec<_>>(),
    );
    if unique.is_empty() {
        return Ok(());
    }
    reach_prospects::Entity::update_many()
        .col_expr(
            reach_prospects::Column::Validation,
            Expr::value("suppressed"),
        )
        .col_expr(reach_prospects::Column::UpdatedAt, Expr::value(now()))
        .filter(reach_prospects::Column::Email.is_in(unique))
        .filter(reach_prospects::Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await
        .map_err(db_error)?;
    Ok(())
}

/// The message an opt-out came with and whom it concerns (`LabelEffectTarget`).
pub(crate) struct Target {
    pub(crate) message_id: String,
    pub(crate) sender_email: String,
    /// `(id, email, companyDomain)`.
    pub(crate) prospect: Option<(String, String, Option<String>)>,
    pub(crate) enrollment_id: Option<String>,
    pub(crate) campaign_id: Option<String>,
    pub(crate) previous_label: Option<String>,
}

/// A prospect as a [`Target`] names it: `(id, email, companyDomain)`.
pub(crate) async fn load_target_prospect(
    db: &PgPool,
    id: &str,
) -> Result<Option<(String, String, Option<String>)>, DbErr> {
    reach_prospects::Entity::find_by_id(id.to_owned())
        .select_only()
        .columns([
            reach_prospects::Column::Id,
            reach_prospects::Column::Email,
            reach_prospects::Column::CompanyDomain,
        ])
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `applyUnsubscribe(db, target)`.
pub(crate) async fn apply_unsubscribe(db: &PgPool, target: &Target) -> ReachResult<()> {
    let mut emails = vec![target.sender_email.clone()];
    if let Some((_, email, _)) = &target.prospect
        && *email != target.sender_email
    {
        emails.push(email.clone());
    }
    for email in &emails {
        suppress_address(db, email, "unsubscribed", Some(&target.message_id)).await?;
    }
    flag_prospects_suppressed(db, &emails).await?;
    if let Some(enrollment) = &target.enrollment_id {
        let mut from = STOPPABLE.to_vec();
        from.push("replied");
        if transition_enrollment(db, enrollment, "unsubscribed", "unsubscribed", &from).await? {
            bump_campaign_stat(db, target.campaign_id.as_deref(), "unsubscribed", 1).await?;
        }
    }
    if let Some((id, _, domain)) = &target.prospect {
        stop_other_enrollments(
            db,
            id,
            domain.as_deref(),
            "prospect",
            target.enrollment_id.as_deref(),
            true,
        )
        .await?;
    }
    Ok(())
}

/// `applyLabelEffects(db, target, label)`.
pub(crate) async fn apply_label_effects(
    db: &PgPool,
    target: &Target,
    label: &str,
) -> ReachResult<()> {
    if label == "unsubscribe" {
        apply_unsubscribe(db, target).await?;
    }
    let was = is_positive(target.previous_label.as_deref());
    let is = is_positive(Some(label));
    if is && !was {
        bump_campaign_stat(db, target.campaign_id.as_deref(), "interested", 1).await?;
    }
    if !is && was {
        bump_campaign_stat(db, target.campaign_id.as_deref(), "interested", -1).await?;
    }
    Ok(())
}

/// The validated `updateReachMessageSchema` body.
#[derive(Debug, Default)]
pub(crate) struct MessageInput {
    pub(crate) label: Option<String>,
    pub(crate) read: Option<bool>,
    pub(crate) handled: Option<bool>,
}

/// `at` as its ISO text reads back (`toISOString()`): to the millisecond.
pub(crate) fn to_ms(at: OffsetDateTime) -> OffsetDateTime {
    at.replace_nanosecond(at.nanosecond() / 1_000_000 * 1_000_000)
        .unwrap_or(at)
}

/// `updateMessage(db, id, input, userId)`: the updated row and the label
/// change (previous, next), or `None` for an unknown inbound message.
pub(crate) async fn update_message(
    db: &PgPool,
    id: &str,
    input: &MessageInput,
    user_id: &str,
) -> ReachResult<Option<(Value, Option<(Option<String>, String)>)>> {
    use reach_messages::Column;
    let existing = reach_messages::Entity::find_by_id(id.to_owned())
        .filter(Column::Direction.eq("in"))
        .one(&orm(db))
        .await
        .map_err(db_error)?;
    let Some(existing) = existing else {
        return Ok(None);
    };
    let at = now();
    let read_at = existing.read_at.map(to_ms);
    let handled_at = existing.handled_at.map(to_ms);
    let mut update = reach_messages::Entity::update_many();
    let mut read: Option<Option<OffsetDateTime>> = None;
    match input.handled {
        Some(true) => {
            update = update
                .col_expr(Column::HandledAt, Expr::value(handled_at.unwrap_or(at)))
                .col_expr(
                    Column::HandledBy,
                    Expr::value(if handled_at.is_some() {
                        existing.handled_by.clone()
                    } else {
                        Some(user_id.to_owned())
                    }),
                );
            read = Some(Some(read_at.unwrap_or(at)));
        }
        Some(false) => {
            update = update
                .col_expr(Column::HandledAt, Expr::null())
                .col_expr(Column::HandledBy, Expr::null());
        }
        None => {}
    }
    match input.read {
        Some(true) => read = Some(Some(read_at.unwrap_or(at))),
        Some(false) if input.handled != Some(true) => read = Some(None),
        _ => {}
    }
    if let Some(read) = read {
        update = update.col_expr(Column::ReadAt, Expr::value(read));
    }
    let previous_label = existing.label.clone();
    let change = input
        .label
        .clone()
        .filter(|label| Some(label.as_str()) != previous_label.as_deref())
        .map(|next| (previous_label.clone(), next));
    if let Some((_, next)) = &change {
        update = update
            .col_expr(Column::Label, Expr::value(next))
            .col_expr(Column::LabelSource, Expr::value("user"))
            .col_expr(Column::ClassifiedAt, Expr::value(at));
    }
    let updated = update
        .col_expr(Column::UpdatedAt, Expr::value(at))
        .filter(Column::Id.eq(id))
        .exec_with_returning(&orm(db))
        .await
        .map_err(db_error)?
        .into_iter()
        .next();
    let Some(updated) = updated else {
        return Ok(None);
    };
    if input.read == Some(true)
        && let (Some(thread_key), Some(received_at)) = (&existing.thread_key, existing.received_at)
    {
        reach_messages::Entity::update_many()
            .col_expr(Column::ReadAt, Expr::value(at))
            .col_expr(Column::UpdatedAt, Expr::value(at))
            .filter(Column::ThreadKey.eq(thread_key))
            .filter(Column::Direction.eq("in"))
            .filter(Column::ReadAt.is_null())
            .filter(Column::ReceivedAt.lt(to_ms(received_at)))
            .exec(&orm(db))
            .await
            .map_err(db_error)?;
    }
    if let Some((previous, next)) = &change {
        let prospect = match &updated.prospect_id {
            Some(prospect_id) => load_target_prospect(db, prospect_id)
                .await
                .map_err(db_error)?,
            None => None,
        };
        let target = Target {
            message_id: updated.id.clone(),
            sender_email: updated.from_email.clone(),
            prospect,
            enrollment_id: updated.enrollment_id.clone(),
            campaign_id: updated.campaign_id.clone(),
            previous_label: previous.clone(),
        };
        apply_label_effects(db, &target, next).await?;
    }
    let updated = row_json(updated)?;
    Ok(Some((updated, change)))
}

/// `replyEventData(message, extra)`.
pub(crate) fn reply_event_data(message: &Value, label: &str, label_source: &str) -> Value {
    json!({
        "id": message.get("id"),
        "threadKey": message.get("threadKey"),
        "kind": message.get("kind"),
        "mailboxId": message.get("mailboxId"),
        "campaignId": message.get("campaignId"),
        "enrollmentId": message.get("enrollmentId"),
        "prospectId": message.get("prospectId"),
        "fromEmail": message.get("fromEmail"),
        "subject": message.get("subject"),
        "receivedAt": message.get("receivedAt"),
        "label": label,
        "labelSource": label_source,
    })
}
