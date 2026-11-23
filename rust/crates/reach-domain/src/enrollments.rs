//! `enrollments.ts`: a prospect's place in a campaign.

use std::collections::HashSet;

use sea_orm::sea_query::{Alias, Expr, OnConflict, TableRef, ValueTuple};
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, FromQueryResult, IdenStatic, Iterable, JoinType,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, QueryTrait, RelationDef, Set,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    reach_campaign_mailboxes as campaign_mailboxes, reach_enrollments as enrollments,
    reach_mailboxes, reach_prospect_list_members as members, reach_prospects,
};

use crate::lists::{CursorRow, before, member_prospect};
use crate::schemas::is_consumer_email;
use crate::suppressions::load_index;
use crate::{ReachResult, field, js, js_all, stamp, text};

const CHUNK: usize = 500;

/// `bulkSetNextSendAt(db, items, { status, now })`.
pub async fn bulk_set_next_send_at(
    db: &PgPool,
    items: &[(String, OffsetDateTime)],
    activate: bool,
    now: OffsetDateTime,
) -> ReachResult<()> {
    use enrollments::Column;
    use sea_orm::ExprTrait as _;
    // `update … set next_send_at = v.at … from (values (id, at), …) as v(id, at)
    // where reach_enrollments.id = v.id`: `VALUES` names its columns
    // `column1`, `column2`.
    let v = Alias::new("v");
    let db = orm(db);
    for chunk in items.chunks(CHUNK) {
        let values: Vec<ValueTuple> = chunk
            .iter()
            .map(|(id, at)| ValueTuple::Two(id.clone().into(), stamp(*at).into()))
            .collect();
        let mut update = enrollments::Entity::update_many()
            .col_expr(
                Column::NextSendAt,
                Expr::col((v.clone(), Alias::new("column2"))),
            );
        if activate {
            update = update.col_expr(Column::Status, Expr::value("active"));
        }
        let mut update = update
            .col_expr(Column::ClaimedAt, Expr::value(None::<OffsetDateTime>))
            .col_expr(Column::UpdatedAt, Expr::value(stamp(now)))
            .filter(
                Expr::col((enrollments::Entity, Column::Id))
                    .equals((v.clone(), Alias::new("column1"))),
            );
        QueryTrait::query(&mut update).from(TableRef::ValuesList(values, v.clone().into()));
        update.exec(&db).await?;
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
    let db = orm(db);
    for chunk in ids.chunks(CHUNK) {
        let rows = reach_prospects::Entity::find()
            .filter(reach_prospects::Column::Id.is_in(chunk))
            .filter(reach_prospects::Column::DeletedAt.is_null())
            .all(&db)
            .await?;
        for row in js_all(rows.into_iter().map(serde_json::to_value))? {
            put(row);
        }
    }
    if let Some(list_id) = list_id {
        let rows = members::Entity::find()
            .select_only()
            .columns(reach_prospects::Column::iter())
            .join(JoinType::InnerJoin, member_prospect())
            .filter(members::Column::ListId.eq(list_id))
            .filter(reach_prospects::Column::DeletedAt.is_null())
            .into_model::<reach_prospects::Model>()
            .all(&db)
            .await?;
        for row in js_all(rows.into_iter().map(serde_json::to_value))? {
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
    let conn = orm(db);
    for chunk in ids.chunks(CHUNK) {
        let rows: Vec<(String, String)> = enrollments::Entity::find()
            .select_only()
            .column(enrollments::Column::ProspectId)
            .column(enrollments::Column::CampaignId)
            .filter(enrollments::Column::ProspectId.is_in(chunk))
            .filter(
                Condition::any()
                    .add(enrollments::Column::CampaignId.eq(campaign_id))
                    .add(enrollments::Column::Status.is_in(["queued", "active"])),
            )
            .into_tuple()
            .all(&conn)
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
        let inserted = enrollments::Entity::insert_many(chunk.iter().map(|prospect_id| {
            enrollments::ActiveModel {
                id: Set(generate_id("renr")),
                campaign_id: Set(campaign_id.to_owned()),
                prospect_id: Set(prospect_id.clone()),
                status: Set("queued".to_owned()),
                ..Default::default()
            }
        }))
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .exec_with_returning_keys(&conn)
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

/// An enrollment with its prospect (the `p_` columns) and its mailbox's
/// address.
#[derive(Debug, FromQueryResult)]
struct EnrollmentRow {
    #[sea_orm(nested)]
    enrollment: enrollments::Model,
    #[sea_orm(nested(prefix = "p_"))]
    prospect: reach_prospects::Model,
    mailbox_email: Option<String>,
}

/// `listCampaignEnrollments(db, campaignId, options)`: (enrollment, prospect,
/// mailbox email), newest first, `limit + 1` of them.
pub async fn list_campaign_enrollments(
    db: &PgPool,
    campaign_id: &str,
    status: Option<&str>,
    cursor: Option<&CursorRow>,
    limit: i64,
) -> ReachResult<Vec<(Value, Value, Option<String>)>> {
    use enrollments::Column;
    let mut select = enrollments::Entity::find();
    for column in reach_prospects::Column::iter() {
        select = select.column_as(column, format!("p_{}", column.as_str()));
    }
    let mut filters = Condition::all().add(Column::CampaignId.eq(campaign_id));
    if let Some(status) = status {
        filters = filters.add(Column::Status.eq(status));
    }
    if let Some(cursor) = cursor {
        filters = filters.add(before(Column::CreatedAt, Column::Id, cursor));
    }
    let rows = select
        .column_as(reach_mailboxes::Column::Email, "mailbox_email")
        .join(
            JoinType::InnerJoin,
            enrollments::Entity::belongs_to(reach_prospects::Entity)
                .from(Column::ProspectId)
                .to(reach_prospects::Column::Id)
                .into(),
        )
        .join(JoinType::LeftJoin, enrollment_mailbox())
        .filter(filters)
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(crate::lists::probe(limit))
        .into_model::<EnrollmentRow>()
        .all(&orm(db))
        .await?;
    rows.into_iter()
        .map(|row| {
            Ok((
                js(serde_json::to_value(row.enrollment))?,
                js(serde_json::to_value(row.prospect))?,
                row.mailbox_email,
            ))
        })
        .collect()
}

/// `leftJoin(reachMailboxes, eq(reachMailboxes.id, reachEnrollments.mailboxId))`.
fn enrollment_mailbox() -> RelationDef {
    enrollments::Entity::belongs_to(reach_mailboxes::Entity)
        .from(enrollments::Column::MailboxId)
        .to(reach_mailboxes::Column::Id)
        .into()
}

/// `countCampaignEnrollments(db, campaignId, status)`.
pub async fn count_campaign_enrollments(
    db: &PgPool,
    campaign_id: &str,
    status: Option<&str>,
) -> ReachResult<i64> {
    let mut count = enrollments::Entity::find()
        .filter(enrollments::Column::CampaignId.eq(campaign_id));
    if let Some(status) = status {
        count = count.filter(enrollments::Column::Status.eq(status));
    }
    let n = count.count(&orm(db)).await?;
    Ok(i64::try_from(n).unwrap_or(i64::MAX))
}

/// `removeEnrollment(db, campaignId, enrollmentId)`.
pub async fn remove_enrollment(
    db: &PgPool,
    campaign_id: &str,
    enrollment_id: &str,
) -> ReachResult<bool> {
    let removed = enrollments::Entity::delete_many()
        .filter(enrollments::Column::Id.eq(enrollment_id))
        .filter(enrollments::Column::CampaignId.eq(campaign_id))
        .exec(&orm(db))
        .await?;
    Ok(removed.rows_affected > 0)
}

/// `countActiveCampaignMailboxes(db, campaignId)`.
pub async fn count_active_campaign_mailboxes(db: &PgPool, campaign_id: &str) -> ReachResult<i64> {
    let n = campaign_mailboxes::Entity::find()
        .join(
            JoinType::InnerJoin,
            campaign_mailboxes::Entity::belongs_to(reach_mailboxes::Entity)
                .from(campaign_mailboxes::Column::MailboxId)
                .to(reach_mailboxes::Column::Id)
                .into(),
        )
        .filter(campaign_mailboxes::Column::CampaignId.eq(campaign_id))
        .filter(reach_mailboxes::Column::Status.eq("active"))
        .filter(reach_mailboxes::Column::DeletedAt.is_null())
        .count(&orm(db))
        .await?;
    Ok(i64::try_from(n).unwrap_or(i64::MAX))
}
