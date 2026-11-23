//! Computed company attributes for the grid
//! (`@weldsuite/crm-domain/company-attributes`): team, interactions,
//! connection strength, next due task and deals, for a page of companies.
//! Related rows reach a company through its wrapping `parties` row.

use std::collections::HashMap;

use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder, QuerySelect,
    RelationDef,
};
use serde_json::{Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm};
use weldsuite_events::iso_timestamp;
use weldsuite_schema::tenant::{
    crm_activities, crm_opportunities, parties, people, person_companies, tasks,
};

use crate::{DomainResult, js_date};

/// `INTERACTION_TYPES`.
const INTERACTION_TYPES: [&str; 7] = [
    "call",
    "email",
    "meeting",
    "sms",
    "linkedin",
    "demo",
    "presentation",
];

/// `connectionStrengthFor(recentCount, hasAnyPast)`.
fn connection_strength(recent: i64, has_past: bool) -> &'static str {
    match recent {
        r if r >= 10 => "very_strong",
        r if r >= 5 => "strong",
        r if r >= 2 => "good",
        1 => "weak",
        _ if has_past => "very_weak",
        _ => "none",
    }
}

fn empty() -> Value {
    json!({
        "team": [],
        "firstInteraction": null,
        "lastInteraction": null,
        "nextInteraction": null,
        "connectionStrength": "none",
        "strongestConnectionUserId": null,
        "nextDueTask": null,
        "deals": [],
    })
}

/// Milliseconds of an ISO timestamp (`Date.parse`).
fn millis(at: &str) -> i128 {
    time::OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339)
        .map_or(0, |t| t.unix_timestamp_nanos() / 1_000_000)
}

type TeamRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// What one interaction group adds up to.
struct Stats {
    recent: i64,
    past: i64,
    by_user: Vec<(String, i64, i128)>,
}

type InteractionRow = (
    Option<String>,
    Option<String>,
    i64,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// A next due task: the company, the task's id, title and due date.
type DueRow = (Option<String>, String, String, Option<PrimitiveDateTime>);

/// A deal: the company, then `id`, `name`, `stage`, `status`, `amount`,
/// `currency`, `closeDate` and `ownerId`.
type DealRow = (
    Option<String>,
    String,
    String,
    String,
    String,
    sea_orm::prelude::BigDecimal,
    Option<String>,
    Option<PrimitiveDateTime>,
    String,
);

/// `inner join parties p on p.id = x.counterparty_id and p.deleted_at is
/// null`: the wrapping party a related row reaches its company through.
fn live_party(relation: impl Into<RelationDef>) -> RelationDef {
    let relation: RelationDef = relation.into();
    relation.on_condition(|_, party| {
        Condition::all().add(sea_orm::ExprTrait::is_null(Expr::col((
            party,
            parties::Column::DeletedAt,
        ))))
    })
}

/// The interactions of the companies `ids`, by company and assignee: how
/// many up to `now`, how many since `since`, and the first, last and next
/// interaction's time and type.
#[allow(
    clippy::disallowed_methods,
    reason = "a report over a CTE: filtered aggregates and `array_agg(type order by at)[1]` per group"
)]
async fn interactions(
    db: &PgPool,
    ids: &[String],
    now: &str,
    since: &str,
) -> Result<Vec<InteractionRow>, DbErr> {
    sqlx::query_as(
        "with a as (
             select p.company_id, x.assigned_to_id, x.type, x.status,
                    coalesce(x.start_time, x.due_date, x.created_at) as at
             from crm_activities x
             inner join parties p on p.id = x.counterparty_id and p.deleted_at is null
             where p.company_id = any($1) and x.type = any($2) and x.deleted_at is null
               and x.status not in ('cancelled'))
         select company_id, assigned_to_id,
                count(*) filter (where at <= $3::timestamp),
                count(*) filter (where at <= $3::timestamp and at >= $4::timestamp),
                to_char(date_trunc('milliseconds', min(at) filter (where at <= $3::timestamp)), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                (array_agg(type order by at asc) filter (where at <= $3::timestamp))[1],
                to_char(date_trunc('milliseconds', max(at) filter (where at <= $3::timestamp)), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                (array_agg(type order by at desc) filter (where at <= $3::timestamp))[1],
                to_char(date_trunc('milliseconds', min(at) filter (where at > $3::timestamp and status in ('planned', 'in_progress'))), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                (array_agg(type order by at asc) filter (where at > $3::timestamp and status in ('planned', 'in_progress')))[1]
         from a
         group by company_id, assigned_to_id",
    )
    .bind(ids)
    .bind(INTERACTION_TYPES.map(str::to_owned).to_vec())
    .bind(now)
    .bind(since)
    .fetch_all(db)
    .await
    .map_err(weldsuite_db::orm_error)
}

/// `getCompanyAttributes(db, companyIds, now)`.
#[allow(clippy::too_many_lines)] // the five reads and their merges, as TypeScript has them
pub async fn company_attributes(
    db: &PgPool,
    ids: &[String],
) -> DomainResult<HashMap<String, Value>> {
    let mut result: HashMap<String, Value> = ids.iter().map(|id| (id.clone(), empty())).collect();
    if ids.is_empty() {
        return Ok(result);
    }
    let now = OffsetDateTime::now_utc();
    let now_iso = iso_timestamp(now);
    let since_iso = iso_timestamp(now - time::Duration::days(90));

    let conn = orm(db);
    // Team: people at the company now, primary first, then by name.
    let team: Vec<TeamRow> = person_companies::Entity::find()
        .select_only()
        .column(person_companies::Column::CompanyId)
        .columns([
            people::Column::Id,
            people::Column::DisplayName,
            people::Column::Email,
            people::Column::DirectPhone,
            people::Column::MobilePhone,
            people::Column::Title,
        ])
        .column(person_companies::Column::Role)
        .join(
            JoinType::InnerJoin,
            person_companies::Entity::belongs_to(people::Entity)
                .from(person_companies::Column::PersonId)
                .to(people::Column::Id)
                .into(),
        )
        .filter(person_companies::Column::CompanyId.is_in(ids.to_vec()))
        .filter(person_companies::Column::EndedAt.is_null())
        .filter(people::Column::DeletedAt.is_null())
        .order_by_desc(person_companies::Column::IsPrimary)
        .order_by_asc(people::Column::DisplayName)
        .into_tuple()
        .all(&conn)
        .await?;
    for (company, id, name, email, direct, mobile, title, role) in team {
        if let Some(Value::Array(members)) =
            result.get_mut(&company).and_then(|a| a.get_mut("team"))
        {
            members.push(json!({
                "id": id,
                "name": name,
                "email": email,
                "phone": direct.or(mobile),
                "jobTitle": title.or(role),
            }));
        }
    }

    // Interactions, grouped by company and assignee.
    let rows = interactions(db, ids, &now_iso, &since_iso).await?;
    let mut stats: Vec<(String, Stats)> = Vec::new();
    for (
        company,
        user,
        past,
        recent,
        first_at,
        first_type,
        last_at,
        last_type,
        next_at,
        next_type,
    ) in rows
    {
        let Some(company) = company else { continue };
        let Some(attrs) = result.get_mut(&company) else {
            continue;
        };
        let interaction = |at: &Option<String>, kind: &Option<String>| match (at, kind) {
            (Some(at), Some(kind)) => Some(json!({ "at": at, "type": kind, "userId": user })),
            _ => None,
        };
        let at_of = |v: &Value| v.get("at").and_then(Value::as_str).map_or(0, millis);
        if let Some(first) = interaction(&first_at, &first_type) {
            let current = &attrs["firstInteraction"];
            if current.is_null() || at_of(&first) < at_of(current) {
                attrs["firstInteraction"] = first;
            }
        }
        if let Some(last) = interaction(&last_at, &last_type) {
            let current = &attrs["lastInteraction"];
            if current.is_null() || at_of(&last) > at_of(current) {
                attrs["lastInteraction"] = last;
            }
        }
        if let Some(next) = interaction(&next_at, &next_type) {
            let current = &attrs["nextInteraction"];
            if current.is_null() || at_of(&next) < at_of(current) {
                attrs["nextInteraction"] = next;
            }
        }
        let index = if let Some(i) = stats.iter().position(|(c, _)| *c == company) {
            i
        } else {
            stats.push((
                company.clone(),
                Stats {
                    recent: 0,
                    past: 0,
                    by_user: Vec::new(),
                },
            ));
            stats.len() - 1
        };
        let s = &mut stats[index].1;
        s.past += past;
        s.recent += recent;
        if let (Some(user), true, Some(last)) = (&user, past > 0, &last_at) {
            let last = millis(last);
            if let Some(entry) = s.by_user.iter_mut().find(|(u, _, _)| u == user) {
                entry.1 = past;
                entry.2 = last;
            } else {
                s.by_user.push((user.clone(), past, last));
            }
        }
    }
    for (company, s) in stats {
        let mut best: Option<&(String, i64, i128)> = None;
        for entry in &s.by_user {
            if best.is_none_or(|b| entry.1 > b.1 || (entry.1 == b.1 && entry.2 > b.2)) {
                best = Some(entry);
            }
        }
        if let Some(attrs) = result.get_mut(&company) {
            attrs["connectionStrength"] = json!(connection_strength(s.recent, s.past > 0));
            attrs["strongestConnectionUserId"] = best.map_or(Value::Null, |b| json!(b.0));
        }
    }

    // Next due task: open tasks, then planned task activities.
    let open_tasks: Vec<DueRow> = tasks::Entity::find()
        .select_only()
        .distinct_on([(parties::Entity, parties::Column::CompanyId)])
        .column(parties::Column::CompanyId)
        .columns([tasks::Column::Id, tasks::Column::Title, tasks::Column::DueDate])
        .join(
            JoinType::InnerJoin,
            live_party(
                tasks::Entity::belongs_to(parties::Entity)
                    .from(tasks::Column::CounterpartyId)
                    .to(parties::Column::Id),
            ),
        )
        .filter(parties::Column::CompanyId.is_in(ids.to_vec()))
        .filter(tasks::Column::DeletedAt.is_null())
        .filter(tasks::Column::Status.is_not_in(["done", "cancelled"]))
        .filter(tasks::Column::DueDate.is_not_null())
        .order_by_asc(parties::Column::CompanyId)
        .order_by_asc(tasks::Column::DueDate)
        .into_tuple()
        .all(&conn)
        .await?;
    let task_activities: Vec<DueRow> = crm_activities::Entity::find()
        .select_only()
        .distinct_on([(parties::Entity, parties::Column::CompanyId)])
        .column(parties::Column::CompanyId)
        .columns([
            crm_activities::Column::Id,
            crm_activities::Column::Subject,
            crm_activities::Column::DueDate,
        ])
        .join(
            JoinType::InnerJoin,
            live_party(
                crm_activities::Entity::belongs_to(parties::Entity)
                    .from(crm_activities::Column::CounterpartyId)
                    .to(parties::Column::Id),
            ),
        )
        .filter(parties::Column::CompanyId.is_in(ids.to_vec()))
        .filter(crm_activities::Column::Type.eq("task"))
        .filter(crm_activities::Column::DeletedAt.is_null())
        .filter(crm_activities::Column::Status.is_in(["planned", "in_progress"]))
        .filter(crm_activities::Column::DueDate.is_not_null())
        .order_by_asc(parties::Column::CompanyId)
        .order_by_asc(crm_activities::Column::DueDate)
        .into_tuple()
        .all(&conn)
        .await?;
    for (company, id, title, due) in open_tasks.into_iter().chain(task_activities) {
        let (Some(company), Some(due)) = (company, due.map(js_date)) else {
            continue;
        };
        let Some(attrs) = result.get_mut(&company) else {
            continue;
        };
        let current = &attrs["nextDueTask"];
        let earlier = current.is_null()
            || millis(&due)
                < current
                    .get("dueDate")
                    .and_then(Value::as_str)
                    .map_or(0, millis);
        if earlier {
            attrs["nextDueTask"] = json!({ "id": id, "title": title, "dueDate": due });
        }
    }

    // Deals, newest first.
    let deals: Vec<DealRow> = crm_opportunities::Entity::find()
        .select_only()
        .column(parties::Column::CompanyId)
        .columns([
            crm_opportunities::Column::Id,
            crm_opportunities::Column::Name,
            crm_opportunities::Column::Stage,
            crm_opportunities::Column::Status,
            crm_opportunities::Column::Amount,
            crm_opportunities::Column::Currency,
            crm_opportunities::Column::CloseDate,
            crm_opportunities::Column::OwnerId,
        ])
        .join(
            JoinType::InnerJoin,
            live_party(
                crm_opportunities::Entity::belongs_to(parties::Entity)
                    .from(crm_opportunities::Column::CounterpartyId)
                    .to(parties::Column::Id),
            ),
        )
        .filter(parties::Column::CompanyId.is_in(ids.to_vec()))
        .filter(crm_opportunities::Column::DeletedAt.is_null())
        .order_by_desc(crm_opportunities::Column::CreatedAt)
        .into_tuple()
        .all(&conn)
        .await?;
    for (company, id, name, stage, status, amount, currency, close_date, owner_id) in deals {
        let Some(company) = company else {
            continue;
        };
        // `amount::float8`, a JS number.
        let amount = amount
            .to_string()
            .parse::<f64>()
            .map_or(Value::Null, crate::js::number_value);
        let deal = json!({
            "id": id,
            "name": name,
            "stage": stage,
            "status": status,
            "amount": amount,
            "currency": currency,
            "closeDate": close_date.map(js_date),
            "ownerId": owner_id,
        });
        if let Some(Value::Array(list)) = result.get_mut(&company).and_then(|a| a.get_mut("deals"))
        {
            list.push(deal);
        }
    }
    Ok(result)
}
