//! `enrollments.ts`: a prospect's place in a campaign.

use std::collections::HashSet;

use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_kit::generate_id;

use crate::schemas::is_consumer_email;
use crate::suppressions::load_index;
use crate::{ReachResult, field, iso, js_rows, text};

const CHUNK: usize = 500;

/// `bulkSetNextSendAt(db, items, { status, now })`.
pub async fn bulk_set_next_send_at(
    db: &PgPool,
    items: &[(String, OffsetDateTime)],
    activate: bool,
    now: OffsetDateTime,
) -> ReachResult<()> {
    for chunk in items.chunks(CHUNK) {
        let ids: Vec<String> = chunk.iter().map(|(id, _)| id.clone()).collect();
        let ats: Vec<String> = chunk.iter().map(|(_, at)| iso(*at)).collect();
        sqlx::query(
            "update reach_enrollments set next_send_at = v.at,
                 status = case when $3 then 'active' else reach_enrollments.status end,
                 claimed_at = null, updated_at = $4::timestamptz
             from (select * from unnest($1::varchar[], $2::text[]::timestamptz[])) as v(id, at)
             where reach_enrollments.id = v.id",
        )
        .bind(&ids)
        .bind(&ats)
        .bind(activate)
        .bind(iso(now))
        .execute(db)
        .await?;
    }
    Ok(())
}

/// `enrollmentSkipReason(prospect, facts)`.
pub fn skip_reason(
    prospect: &Value,
    already_enrolled: bool,
    enrolled_elsewhere: bool,
    suppressed: bool,
    allow_consumer: bool,
) -> Option<&'static str> {
    if already_enrolled {
        return Some("already_enrolled");
    }
    if suppressed {
        return Some("suppressed");
    }
    let email = text(prospect, "email").unwrap_or_default();
    if !allow_consumer && is_consumer_email(email) {
        return Some("consumer");
    }
    if matches!(
        text(prospect, "validation"),
        Some("invalid" | "role" | "no_mx")
    ) {
        return Some("invalid");
    }
    if enrolled_elsewhere {
        return Some("enrolled_elsewhere");
    }
    None
}

async fn load_candidates(
    db: &PgPool,
    prospect_ids: &[String],
    list_id: Option<&str>,
) -> ReachResult<Vec<Value>> {
    let mut by_id: Vec<Value> = Vec::new();
    let mut put = |row: Value| {
        let id = text(&row, "id").map(str::to_owned);
        match by_id
            .iter_mut()
            .find(|r| text(r, "id").map(str::to_owned) == id)
        {
            Some(slot) => *slot = row,
            None => by_id.push(row),
        }
    };
    let ids = crate::unique(prospect_ids);
    for chunk in ids.chunks(CHUNK) {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from reach_prospects t where t.id = any($1) and t.deleted_at is null",
        )
        .bind(chunk)
        .fetch_all(db)
        .await?;
        for row in js_rows(rows) {
            put(row);
        }
    }
    if let Some(list_id) = list_id {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(p) from reach_prospect_list_members m
             join reach_prospects p on p.id = m.prospect_id
             where m.list_id = $1 and p.deleted_at is null",
        )
        .bind(list_id)
        .fetch_all(db)
        .await?;
        for row in js_rows(rows) {
            put(row);
        }
    }
    Ok(by_id)
}

/// `addProspectsToCampaign(db, campaignId, input, { allowConsumer })`:
/// the report and the new enrollment ids.
pub async fn add_prospects_to_campaign(
    db: &PgPool,
    campaign_id: &str,
    prospect_ids: &[String],
    list_id: Option<&str>,
    allow_consumer: bool,
) -> ReachResult<(Value, Vec<String>)> {
    let candidates = load_candidates(db, prospect_ids, list_id).await?;
    let mut skipped: Vec<(&'static str, i64)> = Vec::new();
    let mut bump =
        |reason: &'static str, by: i64| match skipped.iter_mut().find(|(r, _)| *r == reason) {
            Some(entry) => entry.1 += by,
            None => skipped.push((reason, by)),
        };
    if candidates.is_empty() {
        return Ok((json!({ "added": 0, "skipped": [] }), Vec::new()));
    }
    let ids: Vec<String> = candidates
        .iter()
        .filter_map(|c| text(c, "id").map(str::to_owned))
        .collect();
    let mut here: HashSet<String> = HashSet::new();
    let mut elsewhere: HashSet<String> = HashSet::new();
    for chunk in ids.chunks(CHUNK) {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "select prospect_id, campaign_id from reach_enrollments
             where prospect_id = any($1) and (campaign_id = $2 or status in ('queued', 'active'))",
        )
        .bind(chunk)
        .bind(campaign_id)
        .fetch_all(db)
        .await?;
        for (prospect, campaign) in rows {
            if campaign == campaign_id {
                here.insert(prospect);
            } else {
                elsewhere.insert(prospect);
            }
        }
    }
    let emails: Vec<String> = candidates
        .iter()
        .map(|c| crate::text_or_empty(c, "email").to_owned())
        .collect();
    let suppressed = load_index(db, &emails).await?;
    let mut eligible: Vec<String> = Vec::new();
    for prospect in &candidates {
        let id = crate::text_or_empty(prospect, "id");
        let email = crate::text_or_empty(prospect, "email");
        match skip_reason(
            prospect,
            here.contains(id),
            elsewhere.contains(id),
            suppressed.check(email).is_some(),
            allow_consumer,
        ) {
            Some(reason) => bump(reason, 1),
            None => eligible.push(id.to_owned()),
        }
    }
    let mut added_ids: Vec<String> = Vec::new();
    for chunk in eligible.chunks(CHUNK) {
        let new_ids: Vec<String> = chunk.iter().map(|_| generate_id("renr")).collect();
        let inserted: Vec<String> = sqlx::query_scalar(
            "insert into reach_enrollments (id, campaign_id, prospect_id, status)
             select id, $2, prospect_id, 'queued' from unnest($1::varchar[], $3::varchar[]) as v(id, prospect_id)
             on conflict do nothing returning id",
        )
        .bind(&new_ids)
        .bind(campaign_id)
        .bind(chunk)
        .fetch_all(db)
        .await?;
        added_ids.extend(inserted);
    }
    let lost = i64::try_from(eligible.len() - added_ids.len()).unwrap_or_default();
    if lost > 0 {
        bump("already_enrolled", lost);
    }
    let skipped: Vec<Value> = skipped
        .into_iter()
        .map(|(reason, count)| json!({ "reason": reason, "count": count }))
        .collect();
    Ok((
        json!({ "added": added_ids.len(), "skipped": skipped }),
        added_ids,
    ))
}

/// `toEnrollment(row, prospect, mailboxEmail)`.
pub fn to_enrollment(row: &Value, prospect: &Value, mailbox_email: Option<&str>) -> Value {
    json!({
        "id": field(row, "id"),
        "campaignId": field(row, "campaignId"),
        "prospect": {
            "id": field(prospect, "id"),
            "email": field(prospect, "email"),
            "firstName": field(prospect, "firstName"),
            "lastName": field(prospect, "lastName"),
            "companyName": field(prospect, "companyName"),
        },
        "mailboxId": field(row, "mailboxId"),
        "mailboxEmail": mailbox_email,
        "status": field(row, "status"),
        "currentStep": field(row, "currentStep"),
        "nextSendAt": field(row, "nextSendAt"),
        "stoppedReason": field(row, "stoppedReason"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// `listCampaignEnrollments(db, campaignId, options)`: (enrollment, prospect,
/// mailbox email), newest first, `limit + 1` of them.
pub async fn list_campaign_enrollments(
    db: &PgPool,
    campaign_id: &str,
    status: Option<&str>,
    cursor: Option<&(String, String)>,
    limit: i64,
) -> ReachResult<Vec<(Value, Value, Option<String>)>> {
    let rows: Vec<(Value, Value, Option<String>)> = sqlx::query_as(
        "select to_jsonb(e), to_jsonb(p), m.email from reach_enrollments e
         join reach_prospects p on p.id = e.prospect_id
         left join reach_mailboxes m on m.id = e.mailbox_id
         where e.campaign_id = $1 and ($2::text is null or e.status = $2)
           and ($3::timestamptz is null or e.created_at < $3::timestamptz or (e.created_at = $3::timestamptz and e.id < $4))
         order by e.created_at desc, e.id desc limit $5",
    )
    .bind(campaign_id)
    .bind(status)
    .bind(cursor.map(|c| c.0.clone()))
    .bind(cursor.map(|c| c.1.clone()))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(e, p, m)| (weldsuite_db::js_row(e), weldsuite_db::js_row(p), m))
        .collect())
}

/// `countCampaignEnrollments(db, campaignId, status)`.
pub async fn count_campaign_enrollments(
    db: &PgPool,
    campaign_id: &str,
    status: Option<&str>,
) -> ReachResult<i64> {
    Ok(sqlx::query_scalar(
        "select count(*) from reach_enrollments where campaign_id = $1 and ($2::text is null or status = $2)",
    )
    .bind(campaign_id)
    .bind(status)
    .fetch_one(db)
    .await?)
}

/// `removeEnrollment(db, campaignId, enrollmentId)`.
pub async fn remove_enrollment(
    db: &PgPool,
    campaign_id: &str,
    enrollment_id: &str,
) -> ReachResult<bool> {
    let row: Option<String> = sqlx::query_scalar(
        "delete from reach_enrollments where id = $1 and campaign_id = $2 returning id",
    )
    .bind(enrollment_id)
    .bind(campaign_id)
    .fetch_optional(db)
    .await?;
    Ok(row.is_some())
}

/// `countActiveCampaignMailboxes(db, campaignId)`.
pub async fn count_active_campaign_mailboxes(db: &PgPool, campaign_id: &str) -> ReachResult<i64> {
    Ok(sqlx::query_scalar(
        "select count(*) from reach_campaign_mailboxes cm
         join reach_mailboxes m on m.id = cm.mailbox_id
         where cm.campaign_id = $1 and m.status = 'active' and m.deleted_at is null",
    )
    .bind(campaign_id)
    .fetch_one(db)
    .await?)
}
