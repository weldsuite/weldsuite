//! The queries behind My reviews, "Sent by me" and "Done"
//! (`services/approvals.ts`): what a subject is, review items, the count.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_db::{js_row, js_timestamp};
use weldsuite_flow_domain::approval_views::{
    Figures, hours_of_minutes, present_review_approver, review_impacts, summarize,
};
use weldsuite_flow_domain::approvals::{
    ApprovalOutcome, ApprovalRow, PendingReviewFilters, is_step_active, list_pending_for_approver,
    resolve_subject_rows, review_bucket,
};
use weldsuite_flow_domain::changes::{change_code, deliverable_code};
use weldsuite_flow_domain::js::{iso_from_millis, millis_of, number_text};
use weldsuite_flow_domain::raid::{RaidKind, raid_code};

const DAY: i64 = 86_400_000;
const _: i64 = DAY;

/// The title, code and figures of one subject, as the reviewer sees them (`SubjectInfo`).
#[derive(Debug, Clone, Default)]
pub(crate) struct SubjectInfo {
    pub(crate) project_id: Option<String>,
    pub(crate) code: Option<String>,
    pub(crate) title: String,
    pub(crate) summary: Option<String>,
    pub(crate) impacts: Vec<Value>,
    pub(crate) links: Vec<Value>,
}

fn key_of(subject_type: &str, id: &str) -> String {
    format!("{subject_type}:{id}")
}

fn text(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn ids_of(rows: &[ApprovalRow], subject_type: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    rows.iter()
        .filter(|row| row.subject_type == subject_type)
        .filter(|row| seen.insert(row.subject_id.clone()))
        .map(|row| row.subject_id.clone())
        .collect()
}

#[allow(clippy::too_many_lines)]
pub(crate) async fn load_subject_info(
    db: &PgPool,
    rows: &[ApprovalRow],
) -> Result<HashMap<String, SubjectInfo>, sqlx::Error> {
    let mut out = HashMap::new();

    let change_ids = ids_of(rows, "change_request");
    if !change_ids.is_empty() {
        let found: Vec<(Value, Option<String>)> = sqlx::query_as(
            "select to_jsonb(c) || jsonb_build_object('cost_delta', c.cost_delta::text), p.budget_currency
             from project_change_requests c left join projects p on p.id = c.project_id
             where c.id = any($1)",
        )
        .bind(&change_ids)
        .fetch_all(db)
        .await?;
        let found: Vec<(Value, Option<String>)> =
            found.into_iter().map(|(r, c)| (js_row(r), c)).collect();
        let mut milestone_ids = Vec::new();
        let mut deliverable_ids = Vec::new();
        for (row, _) in &found {
            let plan = row.get("planChanges").cloned().unwrap_or(Value::Null);
            let scope = row.get("scopeChanges").cloned().unwrap_or(Value::Null);
            for m in array(&plan, "milestones") {
                milestone_ids.extend(text(m, "milestoneId"));
            }
            for m in array(&plan, "deliverables") {
                deliverable_ids.extend(text(m, "deliverableId"));
            }
            deliverable_ids.extend(
                array(&scope, "remove")
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned),
            );
        }
        let milestones: HashMap<String, String> = if milestone_ids.is_empty() {
            HashMap::new()
        } else {
            sqlx::query_as::<_, (String, String)>(
                "select id, name from milestones where id = any($1)",
            )
            .bind(&milestone_ids)
            .fetch_all(db)
            .await?
            .into_iter()
            .collect()
        };
        let deliverables: HashMap<String, (i32, String)> = if deliverable_ids.is_empty() {
            HashMap::new()
        } else {
            sqlx::query_as::<_, (String, i32, String)>(
                "select id, number, title from project_deliverables where id = any($1)",
            )
            .bind(&deliverable_ids)
            .fetch_all(db)
            .await?
            .into_iter()
            .map(|(id, n, t)| (id, (n, t)))
            .collect()
        };
        for (row, currency) in &found {
            let plan = row.get("planChanges").cloned().unwrap_or(Value::Null);
            let scope = row.get("scopeChanges").cloned().unwrap_or(Value::Null);
            let mut links = Vec::new();
            for m in array(&plan, "milestones") {
                let id = text(m, "milestoneId").unwrap_or_default();
                if let Some(name) = milestones.get(&id) {
                    links.push(json!({"type": "milestone", "id": id, "title": name, "code": null, "relation": "moves"}));
                }
            }
            for m in array(&plan, "deliverables") {
                let id = text(m, "deliverableId").unwrap_or_default();
                if let Some((n, title)) = deliverables.get(&id) {
                    links.push(json!({"type": "deliverable", "id": id, "title": title, "code": deliverable_code(i64::from(*n)), "relation": "moves"}));
                }
            }
            for a in array(&scope, "add") {
                if let Some(id) = text(a, "deliverableId") {
                    links.push(json!({"type": "deliverable", "id": id, "title": a["title"], "code": null, "relation": "adds"}));
                }
            }
            for id in array(&scope, "remove").iter().filter_map(Value::as_str) {
                if let Some((n, title)) = deliverables.get(id) {
                    links.push(json!({"type": "deliverable", "id": id, "title": title, "code": deliverable_code(i64::from(*n)), "relation": "removes"}));
                }
            }
            out.insert(
                key_of("change_request", row["id"].as_str().unwrap_or_default()),
                SubjectInfo {
                    project_id: text(row, "projectId"),
                    code: Some(change_code(row["number"].as_i64().unwrap_or(0))),
                    title: text(row, "title").unwrap_or_default(),
                    summary: summarize(row["description"].as_str()),
                    impacts: review_impacts(&Figures {
                        cost: text(row, "costDelta"),
                        currency: currency.clone(),
                        schedule_days: row["scheduleDeltaDays"].as_i64(),
                        ..Figures::default()
                    }),
                    links,
                },
            );
        }
    }

    let risk_ids = ids_of(rows, "risk_acceptance");
    if !risk_ids.is_empty() {
        let found: Vec<(Value, Option<String>)> = sqlx::query_as(concat!(
            "select ",
            raid_json!("r"),
            ", p.budget_currency from project_raid_items r left join projects p on p.id = r.project_id where r.id = any($1)"
        ))
        .bind(&risk_ids)
        .fetch_all(db)
        .await?;
        for (row, currency) in found {
            let row = js_row(row);
            let score = row["probability"]
                .as_i64()
                .zip(row["impact"].as_i64())
                .map(|(p, i)| p * i);
            let kind = row["kind"].as_str().and_then(RaidKind::parse);
            out.insert(
                key_of("risk_acceptance", row["id"].as_str().unwrap_or_default()),
                SubjectInfo {
                    project_id: text(&row, "projectId"),
                    code: kind.map(|k| raid_code(k, row["number"].as_i64().unwrap_or(0))),
                    title: text(&row, "title").unwrap_or_default(),
                    summary: summarize(row["description"].as_str()),
                    impacts: review_impacts(&Figures {
                        risk_score: score,
                        cost: text(&row, "costImpact"),
                        currency,
                        schedule_days: row["scheduleImpactDays"].as_i64(),
                        ..Figures::default()
                    }),
                    links: Vec::new(),
                },
            );
        }
    }

    simple(
        db,
        rows,
        &mut out,
        "decision",
        "select to_jsonb(d) from project_decisions d where d.id = any($1)",
        |row| SubjectInfo {
            project_id: text(row, "projectId"),
            code: Some(format!("DEC-{}", row["number"].as_i64().unwrap_or(0))),
            title: text(row, "title").unwrap_or_default(),
            summary: summarize(row["context"].as_str()),
            ..SubjectInfo::default()
        },
    )
    .await?;
    simple(
        db,
        rows,
        &mut out,
        "deliverable",
        "select to_jsonb(d) from project_deliverables d where d.id = any($1)",
        |row| SubjectInfo {
            project_id: text(row, "projectId"),
            code: Some(deliverable_code(row["number"].as_i64().unwrap_or(0))),
            title: text(row, "title").unwrap_or_default(),
            summary: summarize(row["description"].as_str()),
            ..SubjectInfo::default()
        },
    )
    .await?;
    simple(
        db,
        rows,
        &mut out,
        "gate",
        "select to_jsonb(d) from project_phases d where d.id = any($1)",
        |row| SubjectInfo {
            project_id: text(row, "projectId"),
            title: text(row, "name").unwrap_or_default(),
            ..SubjectInfo::default()
        },
    )
    .await?;
    simple(db, rows, &mut out, "project_close", "select jsonb_build_object('id', d.id, 'name', d.name) from projects d where d.id = any($1)", |row| SubjectInfo {
        project_id: text(row, "id"),
        title: text(row, "name").unwrap_or_default(),
        ..SubjectInfo::default()
    })
    .await?;
    simple(
        db,
        rows,
        &mut out,
        "project_request",
        "select to_jsonb(d) || jsonb_build_object('estimated_cost', d.estimated_cost::text) from project_requests d where d.id = any($1)",
        |row| SubjectInfo {
            project_id: None,
            code: Some(format!("REQ-{}", row["number"].as_i64().unwrap_or(0))),
            title: text(row, "title").unwrap_or_default(),
            summary: summarize(row["businessCase"].as_str()),
            impacts: review_impacts(&Figures { cost: text(row, "estimatedCost"), ..Figures::default() }),
            links: Vec::new(),
        },
    )
    .await?;
    Ok(out)
}

/// One subject type read from one table, `row.id` keyed.
async fn simple(
    db: &PgPool,
    rows: &[ApprovalRow],
    out: &mut HashMap<String, SubjectInfo>,
    subject_type: &str,
    sql: &'static str,
    info: impl Fn(&Value) -> SubjectInfo,
) -> Result<(), sqlx::Error> {
    let ids = ids_of(rows, subject_type);
    if ids.is_empty() {
        return Ok(());
    }
    let found: Vec<Value> = sqlx::query_scalar(sql).bind(&ids).fetch_all(db).await?;
    for row in found.into_iter().map(js_row) {
        out.insert(
            key_of(subject_type, row["id"].as_str().unwrap_or_default()),
            info(&row),
        );
    }
    Ok(())
}

/// `projectNamesOf(db, projectIds)`.
pub(crate) async fn project_names(
    db: &PgPool,
    project_ids: &[Option<String>],
) -> Result<HashMap<String, String>, sqlx::Error> {
    let mut ids: Vec<String> = project_ids.iter().flatten().cloned().collect();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(
        sqlx::query_as::<_, (String, String)>("select id, name from projects where id = any($1)")
            .bind(&ids)
            .fetch_all(db)
            .await?
            .into_iter()
            .collect(),
    )
}

/// `siblingsOf(db, rows)`: the live rows of the subjects, by `type:id`, in step order.
pub(crate) async fn siblings_of(
    db: &PgPool,
    subject_ids: &[String],
) -> Result<HashMap<String, Vec<ApprovalRow>>, sqlx::Error> {
    let mut out: HashMap<String, Vec<ApprovalRow>> = HashMap::new();
    if subject_ids.is_empty() {
        return Ok(out);
    }
    let found: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from flow_approvals a where a.subject_id = any($1) and a.deleted_at is null
         order by a.step asc, a.created_at asc, a.id asc",
    )
    .bind(subject_ids)
    .fetch_all(db)
    .await?;
    for row in found
        .into_iter()
        .filter_map(|v| ApprovalRow::from_json(&js_row(v)))
    {
        out.entry(key_of(&row.subject_type, &row.subject_id))
            .or_default()
            .push(row);
    }
    Ok(out)
}

fn iso(ms: Option<i64>) -> Value {
    ms.and_then(iso_from_millis)
        .map_or(Value::Null, Value::String)
}

fn review_item_of(
    row: &ApprovalRow,
    info: Option<&SubjectInfo>,
    siblings: &[ApprovalRow],
    project_name: Option<&String>,
    now: i64,
    via_delegation: bool,
) -> Value {
    let rule = if row.rule.is_null() {
        Value::Null
    } else {
        let mut rule = Map::new();
        rule.insert("code".to_owned(), row.rule["code"].clone());
        if let Some(params) = row.rule.get("params").filter(|p| !p.is_null()) {
            rule.insert("params".to_owned(), params.clone());
        }
        Value::Object(rule)
    };
    json!({
        "id": row.id,
        "source": "approval",
        "type": row.subject_type,
        "subjectId": row.subject_id,
        "projectId": row.project_id.clone().or_else(|| info.and_then(|i| i.project_id.clone())),
        "projectName": project_name,
        "code": info.and_then(|i| i.code.clone()),
        "title": info.map_or_else(|| row.subject_id.clone(), |i| i.title.clone()),
        "summary": info.and_then(|i| i.summary.clone()),
        "requestedBy": row.created_by,
        "requestedAt": iso(Some(row.created_at)),
        "dueAt": iso(row.due_at),
        "bucket": review_bucket(row.due_at, now).as_str(),
        "decision": row.decision,
        "note": row.note,
        "decidedAt": iso(row.decided_at),
        "step": row.step,
        "roleLabel": row.role_label,
        "rule": rule,
        "viaDelegation": via_delegation,
        "delegatedFrom": row.delegated_from,
        "actionable": is_step_active(row, siblings),
        "approvers": siblings.iter().map(present_review_approver).collect::<Vec<_>>(),
        "impacts": info.map(|i| i.impacts.clone()).unwrap_or_default(),
        "links": info.map(|i| i.links.clone()).unwrap_or_default(),
    })
}

/// `buildReviewItems(db, rows, userId, now)`.
pub(crate) async fn build_review_items(
    db: &PgPool,
    rows: &[ApprovalRow],
    user_id: &str,
    now: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let mut subject_ids: Vec<String> = rows.iter().map(|r| r.subject_id.clone()).collect();
    subject_ids.sort();
    subject_ids.dedup();
    let info = load_subject_info(db, rows).await?;
    let siblings = siblings_of(db, &subject_ids).await?;
    let mut project_ids: Vec<Option<String>> = rows.iter().map(|r| r.project_id.clone()).collect();
    project_ids.extend(info.values().map(|i| i.project_id.clone()));
    let names = project_names(db, &project_ids).await?;
    Ok(rows
        .iter()
        .map(|row| {
            let key = key_of(&row.subject_type, &row.subject_id);
            let subject = info.get(&key);
            let project_id = row
                .project_id
                .clone()
                .or_else(|| subject.and_then(|s| s.project_id.clone()));
            let fallback = [row.clone()];
            review_item_of(
                row,
                subject,
                siblings.get(&key).map_or(&fallback[..], Vec::as_slice),
                project_id.as_ref().and_then(|p| names.get(p)),
                now,
                row.approver_id != user_id && row.delegated_from.as_deref() != Some(user_id),
            )
        })
        .collect())
}

/// A pending time entry with its project's name.
pub(crate) struct PendingEntry {
    pub(crate) entry: Value,
    pub(crate) project_name: Option<String>,
}

const PENDING_TIME_FILTER: &str = "t.deleted_at is null and t.status in ('draft', 'submitted')
    and t.user_id <> $1 and t.duration > 0
    and ($2::bool or p.project_manager_id = $1 or exists (
        select 1 from project_members pm
        where pm.project_id = p.id and pm.user_id = $1 and pm.is_active = true
          and pm.deleted_at is null and lower(pm.role) in ('owner', 'admin')))";

/// `listPendingTimeEntries`: pending time entries on projects the caller manages (never their own), oldest first.
pub(crate) async fn list_pending_time_entries(
    db: &PgPool,
    user_id: &str,
    scope_all: bool,
    project_id: Option<&str>,
    limit: i64,
) -> Result<Vec<PendingEntry>, sqlx::Error> {
    let rows: Vec<(Value, Option<String>)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {}, p.name from time_entries t
         join projects p on p.id = t.project_id and p.deleted_at is null
         where {PENDING_TIME_FILTER} and ($3::text is null or t.project_id = $3)
         order by t.date asc, t.id asc limit $4",
        time_entry_json!("t"),
    )))
    .bind(user_id)
    .bind(scope_all)
    .bind(project_id)
    .bind(limit.clamp(1, 500))
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(entry, project_name)| PendingEntry {
            entry: js_row(entry),
            project_name,
        })
        .collect())
}

/// `countPendingTimeEntries`.
pub(crate) async fn count_pending_time_entries(
    db: &PgPool,
    user_id: &str,
    scope_all: bool,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*)::int8 from time_entries t
         join projects p on p.id = t.project_id and p.deleted_at is null
         where {PENDING_TIME_FILTER}"
    )))
    .bind(user_id)
    .bind(scope_all)
    .fetch_one(db)
    .await
}

/// `timesheetReviewItem(entry, now)`.
pub(crate) fn timesheet_review_item(pending: &PendingEntry, now: i64) -> Value {
    let entry = &pending.entry;
    let hours = hours_of_minutes(weldsuite_flow_domain::js::numeric(&entry["duration"]));
    let pick = |key: &str| {
        entry[key]
            .as_str()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
    };
    let title = pick("description")
        .or_else(|| pick("activity"))
        .unwrap_or_else(|| "Time entry".to_owned());
    json!({
        "id": entry["id"],
        "source": "timesheet",
        "type": "timesheet",
        "subjectId": entry["id"],
        "projectId": entry["projectId"],
        "projectName": pending.project_name,
        "code": null,
        "title": title,
        "summary": format!("{} · {}h", entry["date"].as_str().unwrap_or_default(), number_text(hours)),
        "requestedBy": entry["userId"],
        "requestedAt": entry["createdAt"],
        "dueAt": null,
        "bucket": review_bucket(None, now).as_str(),
        "decision": "pending",
        "note": null,
        "decidedAt": null,
        "step": 1,
        "roleLabel": null,
        "rule": null,
        "viaDelegation": false,
        "delegatedFrom": null,
        "actionable": true,
        "approvers": [],
        "impacts": review_impacts(&Figures { hours: Some(hours), ..Figures::default() }),
        "links": [],
    })
}

/// How `GET /mine` is asked.
pub(crate) struct MineOptions<'a> {
    pub(crate) user_id: &'a str,
    pub(crate) scope_all: bool,
    pub(crate) can_review_time: bool,
    pub(crate) review_type: Option<&'a str>,
    pub(crate) project_id: Option<&'a str>,
    /// `accessibleProjectIds`: `None` for scope:all holders.
    pub(crate) accessible_project_ids: Option<&'a [String]>,
    pub(crate) now: i64,
}

fn due_of(item: &Value) -> i64 {
    item["dueAt"]
        .as_str()
        .and_then(millis_of)
        .unwrap_or(i64::MAX)
}

/// `loadMyReviews(db, options)`.
pub(crate) async fn load_my_reviews(
    db: &PgPool,
    o: &MineOptions<'_>,
) -> Result<Value, sqlx::Error> {
    let filters = PendingReviewFilters {
        project_id: o.project_id.map(str::to_owned),
        accessible_project_ids: o.accessible_project_ids.map(<[String]>::to_vec),
        ..PendingReviewFilters::default()
    };
    let pending = list_pending_for_approver(db, o.user_id, &filters, o.now).await?;
    let approvals: Vec<ApprovalRow> = pending.into_iter().map(|p| p.approval).collect();
    let approval_items = build_review_items(db, &approvals, o.user_id, o.now).await?;
    let timesheets: Vec<Value> =
        if o.can_review_time && o.review_type.is_none_or(|t| t == "timesheet") {
            list_pending_time_entries(db, o.user_id, o.scope_all, o.project_id, 200)
                .await?
                .iter()
                .map(|p| timesheet_review_item(p, o.now))
                .collect()
        } else {
            Vec::new()
        };
    let mut counts = Map::new();
    for item in &approval_items {
        let t = item["type"].as_str().unwrap_or_default().to_owned();
        let n = counts.get(&t).and_then(Value::as_i64).unwrap_or(0);
        counts.insert(t, json!(n + 1));
    }
    if o.can_review_time {
        let n = if o.review_type.is_some_and(|t| t != "timesheet") {
            list_pending_time_entries(db, o.user_id, o.scope_all, o.project_id, 200)
                .await?
                .len()
        } else {
            timesheets.len()
        };
        counts.insert("timesheet".to_owned(), json!(n));
    }
    let mut all: Vec<Value> = approval_items
        .into_iter()
        .chain(timesheets)
        .filter(|item| o.review_type.is_none_or(|t| item["type"] == t))
        .collect();
    all.sort_by(|a, b| {
        due_of(a)
            .cmp(&due_of(b))
            .then_with(|| {
                a["requestedAt"]
                    .as_str()
                    .and_then(millis_of)
                    .cmp(&b["requestedAt"].as_str().and_then(millis_of))
            })
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let group = |bucket: &str| {
        all.iter()
            .filter(|i| i["bucket"] == bucket)
            .cloned()
            .collect::<Vec<_>>()
    };
    Ok(json!({
        "total": all.len(),
        "counts": counts,
        "groups": {"overdue": group("overdue"), "this_week": group("this_week"), "later": group("later")},
    }))
}

/// `countMyReviews`: one indexed `count(*)`, plus the pending time entries.
pub(crate) async fn count_my_reviews(
    db: &PgPool,
    user_id: &str,
    accessible_project_ids: Option<&[String]>,
    scope_all: bool,
    can_review_time: bool,
    now: i64,
) -> Result<Value, sqlx::Error> {
    let at = iso_from_millis(now).unwrap_or_default();
    let (count, overdue): (i64, i64) = sqlx::query_as(
        "select count(*)::int8, (count(*) filter (where a.due_at < $2::timestamptz))::int8
         from flow_approvals a
         where a.approver_kind = 'member' and a.decision = 'pending' and a.deleted_at is null
           and (a.approver_id = $1 or a.approver_id in (
               select d.member_id from flow_approval_delegations d
               where d.delegate_id = $1 and d.deleted_at is null
                 and d.starts_at <= $2::timestamptz and d.ends_at > $2::timestamptz)
               or a.delegated_from = $1)
           and ($3::text[] is null or a.project_id is null or a.project_id = any($3))
           and not exists (
               select 1 from flow_approvals s
               where s.subject_type = a.subject_type and s.subject_id = a.subject_id
                 and s.deleted_at is null and s.step < a.step
                 and s.decision not in ('approved', 'approved_with_conditions'))",
    )
    .bind(user_id)
    .bind(&at)
    .bind(accessible_project_ids)
    .fetch_one(db)
    .await?;
    let timesheets = if can_review_time {
        count_pending_time_entries(db, user_id, scope_all).await?
    } else {
        0
    };
    Ok(json!({"count": count + timesheets, "overdue": overdue}))
}

/// Parsed `GET /sent` and `/done` filters.
pub(crate) struct ListFilters<'a> {
    pub(crate) review_type: Option<&'a str>,
    pub(crate) project_id: Option<&'a str>,
    pub(crate) cursor: Option<&'a str>,
    pub(crate) limit: i64,
    /// `accessibleProjectIds`: `None` for scope:all holders.
    pub(crate) accessible_project_ids: Option<&'a [String]>,
}

/// A page of a list: items, hasMore, next cursor, total.
pub(crate) type PageOf = (Vec<Value>, bool, Option<String>, i64);

/// `loadSentReviews`: subjects the caller asked approval for that still wait, newest request first.
#[allow(clippy::items_after_statements)]
pub(crate) async fn load_sent_reviews(
    db: &PgPool,
    user_id: &str,
    f: &ListFilters<'_>,
) -> Result<PageOf, sqlx::Error> {
    if f.review_type == Some("timesheet") {
        return Ok((Vec::new(), false, None, 0));
    }
    const SUBJECTS: &str = "with subjects as (
        select a.subject_type, a.subject_id, min(a.created_at) as requested_at
        from flow_approvals a
        where a.created_by = $1 and a.deleted_at is null
          and ($2::text is null or a.subject_type = $2) and ($3::text is null or a.project_id = $3)
          and ($4::text[] is null or a.project_id is null or a.project_id = any($4))
        group by a.subject_type, a.subject_id
        having bool_or(a.decision in ('pending', 'info_requested')))";
    let page: Vec<(String, String, Option<String>)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SUBJECTS} select subject_type, subject_id, to_jsonb(requested_at) #>> '{{}}' from subjects
         where ($5::text is null or not exists (select 1 from subjects where subject_id = $5)
                or (requested_at, subject_id) < (select requested_at, subject_id from subjects where subject_id = $5 limit 1))
         order by requested_at desc, subject_id desc limit $6"
    )))
    .bind(user_id)
    .bind(f.review_type)
    .bind(f.project_id)
    .bind(f.accessible_project_ids)
    .bind(f.cursor)
    .bind(f.limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "{SUBJECTS} select count(*)::int8 from subjects"
    )))
    .bind(user_id)
    .bind(f.review_type)
    .bind(f.project_id)
    .bind(f.accessible_project_ids)
    .fetch_one(db)
    .await?;
    let limit = usize::try_from(f.limit).unwrap_or(0);
    let has_more = page.len() > limit;
    let slice: Vec<_> = page.into_iter().take(limit).collect();
    let next = if has_more {
        slice.last().map(|s| s.1.clone())
    } else {
        None
    };

    let mut subject_ids: Vec<String> = slice.iter().map(|s| s.1.clone()).collect();
    subject_ids.sort();
    subject_ids.dedup();
    let siblings = siblings_of(db, &subject_ids).await?;
    let probe: Vec<ApprovalRow> = slice
        .iter()
        .map(|(t, id, _)| ApprovalRow {
            subject_type: t.clone(),
            subject_id: id.clone(),
            ..ApprovalRow::default()
        })
        .collect();
    let info = load_subject_info(db, &probe).await?;
    let mut project_ids: Vec<Option<String>> = siblings
        .values()
        .flatten()
        .map(|r| r.project_id.clone())
        .collect();
    project_ids.extend(info.values().map(|i| i.project_id.clone()));
    let names = project_names(db, &project_ids).await?;
    let items = slice
        .iter()
        .map(|(subject_type, subject_id, requested_at)| {
            let key = key_of(subject_type, subject_id);
            let rows = siblings.get(&key).cloned().unwrap_or_default();
            let subject = info.get(&key);
            let project_id = rows
                .first()
                .and_then(|r| r.project_id.clone())
                .or_else(|| subject.and_then(|s| s.project_id.clone()));
            let due = rows.iter().filter_map(|r| r.due_at).min();
            let outcome = match resolve_subject_rows(subject_type, &rows) {
                ApprovalOutcome::Approved => "approved",
                ApprovalOutcome::Rejected => "rejected",
                ApprovalOutcome::Pending => "pending",
            };
            json!({
                "type": subject_type,
                "subjectId": subject_id,
                "projectId": project_id,
                "projectName": project_id.as_ref().and_then(|p| names.get(p)),
                "code": subject.and_then(|s| s.code.clone()),
                "title": subject.map_or_else(|| subject_id.clone(), |s| s.title.clone()),
                "requestedAt": requested_at.as_deref().and_then(js_timestamp),
                "dueAt": iso(due),
                "outcome": outcome,
                "approvers": rows.iter().map(present_review_approver).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok((items, has_more, next, total))
}

/// `loadDoneReviews`: the reviews the caller answered, newest first.
#[allow(clippy::items_after_statements)]
pub(crate) async fn load_done_reviews(
    db: &PgPool,
    user_id: &str,
    f: &ListFilters<'_>,
    now: i64,
) -> Result<PageOf, sqlx::Error> {
    if f.review_type == Some("timesheet") {
        return Ok((Vec::new(), false, None, 0));
    }
    const WHERE: &str = "a.decided_by = $1 and a.deleted_at is null
        and a.decision in ('approved', 'approved_with_conditions', 'rejected')
        and ($2::text is null or a.subject_type = $2) and ($3::text is null or a.project_id = $3)
        and ($4::text[] is null or a.project_id is null or a.project_id = any($4))";
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(a) from flow_approvals a where {WHERE}
           and ($5::text is null or not exists (select 1 from flow_approvals c where c.id = $5 and c.decided_at is not null)
                or (a.decided_at, a.id) < (select c.decided_at, c.id from flow_approvals c where c.id = $5))
         order by a.decided_at desc, a.id desc limit $6"
    )))
    .bind(user_id)
    .bind(f.review_type)
    .bind(f.project_id)
    .bind(f.accessible_project_ids)
    .bind(f.cursor)
    .bind(f.limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*)::int8 from flow_approvals a where {WHERE}"
    )))
    .bind(user_id)
    .bind(f.review_type)
    .bind(f.project_id)
    .bind(f.accessible_project_ids)
    .fetch_one(db)
    .await?;
    let limit = usize::try_from(f.limit).unwrap_or(0);
    let all: Vec<ApprovalRow> = rows
        .into_iter()
        .filter_map(|v| ApprovalRow::from_json(&js_row(v)))
        .collect();
    let has_more = all.len() > limit;
    let slice: Vec<ApprovalRow> = all.into_iter().take(limit).collect();
    let next = if has_more {
        slice.last().map(|r| r.id.clone())
    } else {
        None
    };
    Ok((
        build_review_items(db, &slice, user_id, now).await?,
        has_more,
        next,
        total,
    ))
}
