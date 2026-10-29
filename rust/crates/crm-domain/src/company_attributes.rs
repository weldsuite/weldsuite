//! Computed company attributes for the grid
//! (`@weldsuite/crm-domain/company-attributes`): team, interactions,
//! connection strength, next due task and deals, for a page of companies.
//! Related rows reach a company through its wrapping `parties` row.

use std::collections::HashMap;

use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_events::iso_timestamp;

use crate::DomainResult;

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

    // Team: people at the company now, primary first, then by name.
    let team: Vec<(String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "select pc.company_id, p.id, p.display_name, p.email, p.direct_phone, p.mobile_phone, p.title, pc.role
             from person_companies pc inner join people p on p.id = pc.person_id
             where pc.company_id = any($1) and pc.ended_at is null and p.deleted_at is null
             order by pc.is_primary desc, p.display_name asc",
        )
        .bind(ids)
        .fetch_all(db)
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
    let rows: Vec<InteractionRow> = sqlx::query_as(
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
    .bind(&now_iso)
    .bind(&since_iso)
    .fetch_all(db)
    .await?;
    struct Stats {
        recent: i64,
        past: i64,
        by_user: Vec<(String, i64, i128)>,
    }
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
    let tasks: Vec<(Option<String>, String, String, Option<String>)> = sqlx::query_as(
        "(select distinct on (p.company_id) p.company_id, t.id, t.title,
                 to_char(date_trunc('milliseconds', t.due_date), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
          from tasks t inner join parties p on p.id = t.counterparty_id and p.deleted_at is null
          where p.company_id = any($1) and t.deleted_at is null and t.status not in ('done', 'cancelled')
            and t.due_date is not null
          order by p.company_id, t.due_date asc)
         union all
         (select distinct on (p.company_id) p.company_id, x.id, x.subject,
                 to_char(date_trunc('milliseconds', x.due_date), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
          from crm_activities x inner join parties p on p.id = x.counterparty_id and p.deleted_at is null
          where p.company_id = any($1) and x.type = 'task' and x.deleted_at is null
            and x.status in ('planned', 'in_progress') and x.due_date is not null
          order by p.company_id, x.due_date asc)",
    )
    .bind(ids)
    .fetch_all(db)
    .await?;
    for (company, id, title, due) in tasks {
        let (Some(company), Some(due)) = (company, due) else {
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
    let deals: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('companyId', p.company_id, 'id', o.id, 'name', o.name, 'stage', o.stage,
                 'status', o.status, 'amount', o.amount::float8, 'currency', o.currency,
                 'closeDate', to_char(date_trunc('milliseconds', o.close_date), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                 'ownerId', o.owner_id)
         from crm_opportunities o inner join parties p on p.id = o.counterparty_id and p.deleted_at is null
         where p.company_id = any($1) and o.deleted_at is null
         order by o.created_at desc",
    )
    .bind(ids)
    .fetch_all(db)
    .await?;
    for mut deal in deals {
        let Some(company) = deal
            .get("companyId")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };
        if let Value::Object(fields) = &mut deal {
            fields.remove("companyId");
            if let Some(amount) = fields.get("amount").and_then(Value::as_f64) {
                fields.insert("amount".into(), crate::js::number_value(amount));
            }
        }
        if let Some(Value::Array(list)) = result.get_mut(&company).and_then(|a| a.get_mut("deals"))
        {
            list.push(deal);
        }
    }
    Ok(result)
}
