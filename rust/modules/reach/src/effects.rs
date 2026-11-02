//! `services/reply-effects.ts` and `services/inbox.ts`: what a label does
//! (an opt-out suppresses and stops sequences, interest moves the counter),
//! and a person's change to one inbound message.

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_reach_domain::schemas::is_consumer_email;
use weldsuite_reach_domain::{ReachResult, iso, js_slice, now, text};

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
    let Some(campaign_id) = campaign_id.filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    if by == 0 {
        return Ok(());
    }
    sqlx::query(
        "update reach_campaigns set
             stats = jsonb_set(stats, array[$2::text], to_jsonb(greatest(0, (coalesce(stats->>$2, '0'))::int + $3::int))),
             updated_at = $4::timestamptz
         where id = $1",
    )
    .bind(campaign_id)
    .bind(key)
    .bind(i32::try_from(by).unwrap_or_default())
    .bind(iso(now()))
    .execute(db)
    .await?;
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
    let from: Vec<String> = from.iter().map(|s| (*s).to_owned()).collect();
    let rows: Vec<String> = sqlx::query_scalar(
        "update reach_enrollments set status = $2, stopped_reason = $3, next_send_at = null, claimed_at = null,
             updated_at = $4::timestamptz
         where id = $1 and status = any($5) returning id",
    )
    .bind(id)
    .bind(to)
    .bind(js_slice(reason, 100))
    .bind(iso(now()))
    .bind(&from)
    .fetch_all(db)
    .await?;
    Ok(!rows.is_empty())
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
    let rows: Vec<String> = sqlx::query_scalar(
        "update reach_enrollments set status = $1, stopped_reason = $2, next_send_at = null, claimed_at = null,
             updated_at = $3::timestamptz
         where (case when $4 then prospect_id in (select id from reach_prospects where company_domain = $5 and deleted_at is null)
                     else prospect_id = $6 end)
           and status in ('queued', 'active', 'paused')
           and ($7::text is null or id <> $7)
         returning id",
    )
    .bind(status)
    .bind(reason)
    .bind(iso(now()))
    .bind(company_wide)
    .bind(&domain)
    .bind(prospect_id)
    .bind(except)
    .fetch_all(db)
    .await?;
    Ok(rows.len() as i64)
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
    sqlx::query(
        "insert into reach_suppressions (id, value, type, reason, source, created_by)
         values ($1, $2, 'email', $3, $4, null) on conflict (value) do nothing",
    )
    .bind(generate_id("rsup"))
    .bind(&value)
    .bind(reason)
    .bind(source.map(|s| js_slice(s, 255)))
    .execute(db)
    .await?;
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
    sqlx::query(
        "update reach_prospects set validation = 'suppressed', updated_at = $2::timestamptz
         where email = any($1) and deleted_at is null",
    )
    .bind(&unique)
    .bind(iso(now()))
    .execute(db)
    .await?;
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

/// `updateMessage(db, id, input, userId)`: the updated row and the label
/// change (previous, next), or `None` for an unknown inbound message.
pub(crate) async fn update_message(
    db: &PgPool,
    id: &str,
    input: &MessageInput,
    user_id: &str,
) -> ReachResult<Option<(Value, Option<(Option<String>, String)>)>> {
    let existing: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from reach_messages t where t.id = $1 and t.direction = 'in' limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(existing) = existing.map(weldsuite_db::js_row) else {
        return Ok(None);
    };
    let at = iso(now());
    let mut patch = serde_json::Map::new();
    let read_at = text(&existing, "readAt").map(str::to_owned);
    let handled_at = text(&existing, "handledAt").map(str::to_owned);
    match input.handled {
        Some(true) => {
            patch.insert(
                "handled_at".to_owned(),
                json!(handled_at.clone().unwrap_or_else(|| at.clone())),
            );
            patch.insert(
                "handled_by".to_owned(),
                if handled_at.is_some() {
                    json!(text(&existing, "handledBy"))
                } else {
                    json!(user_id)
                },
            );
            patch.insert(
                "read_at".to_owned(),
                json!(read_at.clone().unwrap_or_else(|| at.clone())),
            );
        }
        Some(false) => {
            patch.insert("handled_at".to_owned(), Value::Null);
            patch.insert("handled_by".to_owned(), Value::Null);
        }
        None => {}
    }
    match input.read {
        Some(true) => {
            patch.insert(
                "read_at".to_owned(),
                json!(read_at.clone().unwrap_or_else(|| at.clone())),
            );
        }
        Some(false) if input.handled != Some(true) => {
            patch.insert("read_at".to_owned(), Value::Null);
        }
        _ => {}
    }
    let previous_label = text(&existing, "label").map(str::to_owned);
    let change = input
        .label
        .clone()
        .filter(|label| Some(label.as_str()) != previous_label.as_deref())
        .map(|next| (previous_label.clone(), next));
    if let Some((_, next)) = &change {
        patch.insert("label".to_owned(), json!(next));
        patch.insert("label_source".to_owned(), json!("user"));
        patch.insert("classified_at".to_owned(), json!(at));
    }
    let updated: Option<Value> = sqlx::query_scalar(
        "update reach_messages m set
             handled_at = case when $2::jsonb ? 'handled_at' then ($2::jsonb->>'handled_at')::timestamptz else m.handled_at end,
             handled_by = case when $2::jsonb ? 'handled_by' then $2::jsonb->>'handled_by' else m.handled_by end,
             read_at = case when $2::jsonb ? 'read_at' then ($2::jsonb->>'read_at')::timestamptz else m.read_at end,
             label = case when $2::jsonb ? 'label' then $2::jsonb->>'label' else m.label end,
             label_source = case when $2::jsonb ? 'label_source' then $2::jsonb->>'label_source' else m.label_source end,
             classified_at = case when $2::jsonb ? 'classified_at' then ($2::jsonb->>'classified_at')::timestamptz else m.classified_at end,
             updated_at = $3::timestamptz
         where m.id = $1 returning to_jsonb(m)",
    )
    .bind(id)
    .bind(Value::Object(patch))
    .bind(&at)
    .fetch_optional(db)
    .await?;
    let Some(updated) = updated.map(weldsuite_db::js_row) else {
        return Ok(None);
    };
    if input.read == Some(true)
        && let (Some(thread_key), Some(received_at)) =
            (text(&existing, "threadKey"), text(&existing, "receivedAt"))
    {
        sqlx::query(
            "update reach_messages set read_at = $3::timestamptz, updated_at = $3::timestamptz
             where thread_key = $1 and direction = 'in' and read_at is null and received_at < $2::timestamptz",
        )
        .bind(thread_key)
        .bind(received_at)
        .bind(&at)
        .execute(db)
        .await?;
    }
    if let Some((previous, next)) = &change {
        let prospect: Option<(String, String, Option<String>)> =
            match text(&updated, "prospectId") {
                Some(prospect_id) => sqlx::query_as(
                    "select id, email, company_domain from reach_prospects where id = $1 limit 1",
                )
                .bind(prospect_id)
                .fetch_optional(db)
                .await?,
                None => None,
            };
        let target = Target {
            message_id: text(&updated, "id").unwrap_or_default().to_owned(),
            sender_email: text(&updated, "fromEmail").unwrap_or_default().to_owned(),
            prospect,
            enrollment_id: text(&updated, "enrollmentId").map(str::to_owned),
            campaign_id: text(&updated, "campaignId").map(str::to_owned),
            previous_label: previous.clone(),
        };
        apply_label_effects(db, &target, next).await?;
    }
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
