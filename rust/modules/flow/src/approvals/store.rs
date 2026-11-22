//! The queries behind My reviews, "Sent by me" and "Done"
//! (`services/approvals.ts`): what a subject is, review items, the count.

use std::collections::{HashMap, HashSet};

use sea_orm::sea_query::{Alias, Asterisk, Expr, Func, Query};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, RelationDef,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, js_timestamp, orm, orm_error};
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
use weldsuite_schema::tenant::{
    flow_approval_delegations as delegations, flow_approvals as approvals, milestones,
    project_change_requests as changes, project_decisions as decisions,
    project_deliverables as deliverables, project_members as members, project_phases as phases,
    project_raid_items as raid_items, project_requests as requests, projects, time_entries,
};

use crate::{fetch_limit, row_json};

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

/// A moment in epoch milliseconds, as the `timestamptz` it is compared with.
pub(crate) fn at_millis(millis: i64) -> Result<OffsetDateTime, DbErr> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .map_err(|error| DbErr::Type(error.to_string()))
}

/// `flow_approvals` rows as `ApprovalRow`s (a row it can't read is skipped).
pub(crate) fn approval_rows(models: Vec<approvals::Model>) -> Result<Vec<ApprovalRow>, DbErr> {
    let mut rows = Vec::with_capacity(models.len());
    for model in models {
        rows.extend(ApprovalRow::from_json(&row_json(model)?));
    }
    Ok(rows)
}

/// A change request with its project's budget currency.
#[derive(Debug, FromQueryResult)]
struct ChangeWithCurrency {
    #[sea_orm(nested)]
    change: changes::Model,
    budget_currency: Option<String>,
}

/// A register item with its project's budget currency.
#[derive(Debug, FromQueryResult)]
struct RaidWithCurrency {
    #[sea_orm(nested)]
    item: raid_items::Model,
    budget_currency: Option<String>,
}

/// `leftJoin(projects, eq(projects.id, changes.projectId))`.
fn change_project() -> RelationDef {
    changes::Entity::belongs_to(projects::Entity)
        .from(changes::Column::ProjectId)
        .to(projects::Column::Id)
        .into()
}

/// `leftJoin(projects, eq(projects.id, raid.projectId))`.
fn raid_project() -> RelationDef {
    raid_items::Entity::belongs_to(projects::Entity)
        .from(raid_items::Column::ProjectId)
        .to(projects::Column::Id)
        .into()
}

/// The change requests among `rows`: their codes, figures and the
/// milestones and deliverables they move, add or remove.
async fn change_infos(
    db: &PgPool,
    rows: &[ApprovalRow],
    out: &mut HashMap<String, SubjectInfo>,
) -> Result<(), DbErr> {
    let change_ids = ids_of(rows, "change_request");
    if change_ids.is_empty() {
        return Ok(());
    }
    let found: Vec<ChangeWithCurrency> = changes::Entity::find()
        .column_as(projects::Column::BudgetCurrency, "budget_currency")
        .join(JoinType::LeftJoin, change_project())
        .filter(changes::Column::Id.is_in(&change_ids))
        .into_model()
        .all(&orm(db))
        .await?;
    let found: Vec<(Value, Option<String>)> = found
        .into_iter()
        .map(|row| Ok((row_json(row.change)?, row.budget_currency)))
        .collect::<Result<_, DbErr>>()?;
    let (milestones, deliverables) = moved_objects(db, &found).await?;
    for (row, currency) in &found {
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
                links: change_links(row, &milestones, &deliverables),
            },
        );
    }
    Ok(())
}

/// Milestone names by id.
type MilestoneNames = HashMap<String, String>;
/// Deliverable numbers and titles by id.
type DeliverableTitles = HashMap<String, (i32, String)>;

/// The names of the milestones and deliverables the change requests move
/// or remove, by id.
async fn moved_objects(
    db: &PgPool,
    found: &[(Value, Option<String>)],
) -> Result<(MilestoneNames, DeliverableTitles), DbErr> {
    let mut milestone_ids = Vec::new();
    let mut deliverable_ids = Vec::new();
    for (row, _) in found {
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
    let milestones: MilestoneNames = if milestone_ids.is_empty() {
        HashMap::new()
    } else {
        milestones::Entity::find()
            .select_only()
            .columns([milestones::Column::Id, milestones::Column::Name])
            .filter(milestones::Column::Id.is_in(milestone_ids))
            .into_tuple::<(String, String)>()
            .all(&orm(db))
            .await?
            .into_iter()
            .collect()
    };
    let deliverables: DeliverableTitles = if deliverable_ids.is_empty() {
        HashMap::new()
    } else {
        deliverables::Entity::find()
            .select_only()
            .columns([
                deliverables::Column::Id,
                deliverables::Column::Number,
                deliverables::Column::Title,
            ])
            .filter(deliverables::Column::Id.is_in(deliverable_ids))
            .into_tuple::<(String, i32, String)>()
            .all(&orm(db))
            .await?
            .into_iter()
            .map(|(id, n, t)| (id, (n, t)))
            .collect()
    };
    Ok((milestones, deliverables))
}

/// What a change request moves, adds and removes, as review links.
fn change_links(
    row: &Value,
    milestones: &MilestoneNames,
    deliverables: &DeliverableTitles,
) -> Vec<Value> {
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
    links
}

/// The accepted risks among `rows`: their codes, scores and figures.
async fn risk_infos(
    db: &PgPool,
    rows: &[ApprovalRow],
    out: &mut HashMap<String, SubjectInfo>,
) -> Result<(), DbErr> {
    let risk_ids = ids_of(rows, "risk_acceptance");
    if risk_ids.is_empty() {
        return Ok(());
    }
    let found: Vec<RaidWithCurrency> = raid_items::Entity::find()
        .column_as(projects::Column::BudgetCurrency, "budget_currency")
        .join(JoinType::LeftJoin, raid_project())
        .filter(raid_items::Column::Id.is_in(risk_ids))
        .into_model()
        .all(&orm(db))
        .await?;
    for found in found {
        let currency = found.budget_currency;
        let row = row_json(found.item)?;
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
    Ok(())
}

pub(crate) async fn load_subject_info(
    db: &PgPool,
    rows: &[ApprovalRow],
) -> Result<HashMap<String, SubjectInfo>, DbErr> {
    let mut out = HashMap::new();
    change_infos(db, rows, &mut out).await?;
    risk_infos(db, rows, &mut out).await?;
    simple::<decisions::Entity>(
        db,
        rows,
        &mut out,
        "decision",
        decisions::Column::Id,
        |row| SubjectInfo {
            project_id: text(row, "projectId"),
            code: Some(format!("DEC-{}", row["number"].as_i64().unwrap_or(0))),
            title: text(row, "title").unwrap_or_default(),
            summary: summarize(row["context"].as_str()),
            ..SubjectInfo::default()
        },
    )
    .await?;
    simple::<deliverables::Entity>(
        db,
        rows,
        &mut out,
        "deliverable",
        deliverables::Column::Id,
        |row| SubjectInfo {
            project_id: text(row, "projectId"),
            code: Some(deliverable_code(row["number"].as_i64().unwrap_or(0))),
            title: text(row, "title").unwrap_or_default(),
            summary: summarize(row["description"].as_str()),
            ..SubjectInfo::default()
        },
    )
    .await?;
    simple::<phases::Entity>(db, rows, &mut out, "gate", phases::Column::Id, |row| {
        SubjectInfo {
            project_id: text(row, "projectId"),
            title: text(row, "name").unwrap_or_default(),
            ..SubjectInfo::default()
        }
    })
    .await?;
    let close_ids = ids_of(rows, "project_close");
    if !close_ids.is_empty() {
        let found: Vec<(String, String)> = projects::Entity::find()
            .select_only()
            .columns([projects::Column::Id, projects::Column::Name])
            .filter(projects::Column::Id.is_in(close_ids))
            .into_tuple()
            .all(&orm(db))
            .await?;
        for (id, name) in found {
            out.insert(
                key_of("project_close", &id),
                SubjectInfo {
                    project_id: Some(id),
                    title: name,
                    ..SubjectInfo::default()
                },
            );
        }
    }
    simple::<requests::Entity>(
        db,
        rows,
        &mut out,
        "project_request",
        requests::Column::Id,
        |row| SubjectInfo {
            project_id: None,
            code: Some(format!("REQ-{}", row["number"].as_i64().unwrap_or(0))),
            title: text(row, "title").unwrap_or_default(),
            summary: summarize(row["businessCase"].as_str()),
            impacts: review_impacts(&Figures {
                cost: text(row, "estimatedCost"),
                ..Figures::default()
            }),
            links: Vec::new(),
        },
    )
    .await?;
    Ok(out)
}

/// One subject type read from one table, `row.id` keyed.
async fn simple<E>(
    db: &PgPool,
    rows: &[ApprovalRow],
    out: &mut HashMap<String, SubjectInfo>,
    subject_type: &str,
    id: E::Column,
    info: impl Fn(&Value) -> SubjectInfo,
) -> Result<(), DbErr>
where
    E: EntityTrait,
    E::Model: serde::Serialize,
{
    let ids = ids_of(rows, subject_type);
    if ids.is_empty() {
        return Ok(());
    }
    for model in E::find().filter(id.is_in(ids)).all(&orm(db)).await? {
        let row = row_json(model)?;
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
) -> Result<HashMap<String, String>, DbErr> {
    let mut ids: Vec<String> = project_ids.iter().flatten().cloned().collect();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    Ok(projects::Entity::find()
        .select_only()
        .columns([projects::Column::Id, projects::Column::Name])
        .filter(projects::Column::Id.is_in(ids))
        .into_tuple::<(String, String)>()
        .all(&orm(db))
        .await?
        .into_iter()
        .collect())
}

/// `siblingsOf(db, rows)`: the live rows of the subjects, by `type:id`, in step order.
pub(crate) async fn siblings_of(
    db: &PgPool,
    subject_ids: &[String],
) -> Result<HashMap<String, Vec<ApprovalRow>>, DbErr> {
    let mut out: HashMap<String, Vec<ApprovalRow>> = HashMap::new();
    if subject_ids.is_empty() {
        return Ok(out);
    }
    let found = approvals::Entity::find()
        .filter(approvals::Column::SubjectId.is_in(subject_ids))
        .filter(approvals::Column::DeletedAt.is_null())
        .order_by_asc(approvals::Column::Step)
        .order_by_asc(approvals::Column::CreatedAt)
        .order_by_asc(approvals::Column::Id)
        .all(&orm(db))
        .await?;
    for row in approval_rows(found)? {
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
) -> Result<Vec<Value>, DbErr> {
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

/// A time entry with its project's name.
#[derive(Debug, FromQueryResult)]
struct EntryWithProject {
    #[sea_orm(nested)]
    entry: time_entries::Model,
    project_name: Option<String>,
}

/// `innerJoin(projects, and(eq(projects.id, t.projectId), isNull(projects.deletedAt)))`.
fn entry_project() -> RelationDef {
    time_entries::Entity::belongs_to(projects::Entity)
        .from(time_entries::Column::ProjectId)
        .to(projects::Column::Id)
        .into()
}

/// `exists (select 1 from project_members pm where pm.project_id = p.id …)`:
/// the caller is an active owner or admin of the entry's project.
fn owns_project(user_id: &str) -> sea_orm::sea_query::SelectStatement {
    use sea_orm::ExprTrait as _;
    Query::select()
        .expr(Expr::val(1))
        .from(members::Entity)
        .and_where(
            Expr::col((members::Entity, members::Column::ProjectId))
                .equals((projects::Entity, projects::Column::Id)),
        )
        .and_where(members::Column::UserId.eq(user_id))
        .and_where(members::Column::IsActive.eq(true))
        .and_where(members::Column::DeletedAt.is_null())
        .and_where(
            Func::lower(Expr::col((members::Entity, members::Column::Role)))
                .is_in(["owner", "admin"]),
        )
        .to_owned()
}

/// The pending time entries the caller may review: draft or submitted, with
/// time on them, never their own, on a live project they manage (any project
/// for `projects:scope:all`).
fn pending_time(user_id: &str, scope_all: bool) -> sea_orm::Select<time_entries::Entity> {
    let mut find = time_entries::Entity::find()
        .join(JoinType::InnerJoin, entry_project())
        .filter(projects::Column::DeletedAt.is_null())
        .filter(time_entries::Column::DeletedAt.is_null())
        .filter(time_entries::Column::Status.is_in(["draft", "submitted"]))
        .filter(time_entries::Column::UserId.ne(user_id))
        .filter(time_entries::Column::Duration.gt(0));
    if !scope_all {
        find = find.filter(
            Condition::any()
                .add(projects::Column::ProjectManagerId.eq(user_id))
                .add(Expr::exists(owns_project(user_id))),
        );
    }
    find
}

/// `listPendingTimeEntries`: pending time entries on projects the caller manages (never their own), oldest first.
pub(crate) async fn list_pending_time_entries(
    db: &PgPool,
    user_id: &str,
    scope_all: bool,
    project_id: Option<&str>,
    limit: i64,
) -> Result<Vec<PendingEntry>, DbErr> {
    let mut find =
        pending_time(user_id, scope_all).column_as(projects::Column::Name, "project_name");
    if let Some(project_id) = project_id {
        find = find.filter(time_entries::Column::ProjectId.eq(project_id));
    }
    let rows: Vec<EntryWithProject> = find
        .order_by_asc(time_entries::Column::Date)
        .order_by_asc(time_entries::Column::Id)
        .limit(u64::try_from(limit.clamp(1, 500)).unwrap_or(1))
        .into_model()
        .all(&orm(db))
        .await?;
    rows.into_iter()
        .map(|row| {
            Ok(PendingEntry {
                entry: row_json(row.entry)?,
                project_name: row.project_name,
            })
        })
        .collect()
}

/// `countPendingTimeEntries`.
pub(crate) async fn count_pending_time_entries(
    db: &PgPool,
    user_id: &str,
    scope_all: bool,
) -> Result<i64, DbErr> {
    let count = pending_time(user_id, scope_all).count(&orm(db)).await?;
    Ok(i64::try_from(count).unwrap_or(i64::MAX))
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
pub(crate) async fn load_my_reviews(db: &PgPool, o: &MineOptions<'_>) -> Result<Value, DbErr> {
    let filters = PendingReviewFilters {
        project_id: o.project_id.map(str::to_owned),
        accessible_project_ids: o.accessible_project_ids.map(<[String]>::to_vec),
        ..PendingReviewFilters::default()
    };
    let pending = list_pending_for_approver(db, o.user_id, &filters, o.now)
        .await
        .map_err(orm_error)?;
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

/// The member reviews `user_id` may answer: theirs, those of a member who
/// delegated to them now, and those delegated away from them.
fn reviewable_by(user_id: &str, at: OffsetDateTime) -> Condition {
    let delegated_to_me = Query::select()
        .column(delegations::Column::MemberId)
        .from(delegations::Entity)
        .and_where(delegations::Column::DelegateId.eq(user_id))
        .and_where(delegations::Column::DeletedAt.is_null())
        .and_where(delegations::Column::StartsAt.lte(at))
        .and_where(delegations::Column::EndsAt.gt(at))
        .to_owned();
    Condition::any()
        .add(approvals::Column::ApproverId.eq(user_id))
        .add(approvals::Column::ApproverId.in_subquery(delegated_to_me))
        .add(approvals::Column::DelegatedFrom.eq(user_id))
}

/// `not exists` an earlier step of the same subject that is not approved yet.
fn step_is_active() -> Condition {
    use sea_orm::ExprTrait as _;
    let earlier = Alias::new("s");
    let column = |c: approvals::Column| Expr::col((earlier.clone(), c));
    let blocking = Query::select()
        .expr(Expr::val(1))
        .from_as(approvals::Entity, earlier.clone())
        .and_where(
            column(approvals::Column::SubjectType)
                .equals((approvals::Entity, approvals::Column::SubjectType)),
        )
        .and_where(
            column(approvals::Column::SubjectId)
                .equals((approvals::Entity, approvals::Column::SubjectId)),
        )
        .and_where(column(approvals::Column::DeletedAt).is_null())
        .and_where(
            column(approvals::Column::Step)
                .lt(Expr::col((approvals::Entity, approvals::Column::Step))),
        )
        .and_where(
            column(approvals::Column::Decision).is_not_in(["approved", "approved_with_conditions"]),
        )
        .to_owned();
    Condition::all().add(Expr::exists(blocking).not())
}

/// `a.project_id is null or a.project_id = any(accessible)`, none for scope:all.
fn in_accessible(accessible_project_ids: Option<&[String]>) -> Condition {
    match accessible_project_ids {
        None => Condition::all(),
        Some(ids) => Condition::any()
            .add(approvals::Column::ProjectId.is_null())
            .add(approvals::Column::ProjectId.is_in(ids)),
    }
}

/// `countMyReviews`: one indexed `count(*)`, plus the pending time entries.
pub(crate) async fn count_my_reviews(
    db: &PgPool,
    user_id: &str,
    accessible_project_ids: Option<&[String]>,
    scope_all: bool,
    can_review_time: bool,
    now: i64,
) -> Result<Value, DbErr> {
    let at = at_millis(now)?;
    let counted: Option<(i64, i64)> = approvals::Entity::find()
        .select_only()
        .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "count")
        .column_as(
            Expr::from(Func::count(Expr::case(approvals::Column::DueAt.lt(at), 1))),
            "overdue",
        )
        .filter(approvals::Column::ApproverKind.eq("member"))
        .filter(approvals::Column::Decision.eq("pending"))
        .filter(approvals::Column::DeletedAt.is_null())
        .filter(reviewable_by(user_id, at))
        .filter(in_accessible(accessible_project_ids))
        .filter(step_is_active())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let (count, overdue) = counted.unwrap_or_default();
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

/// A page of `(subject type, subject id, first request)` and the number of
/// subjects `user_id` asked approval for that still wait.
#[allow(
    clippy::disallowed_methods,
    reason = "one CTE groups the caller's requests per subject (bool_or over the rows) and pages the groups with a keyset that reads the CTE again"
)]
async fn sent_subjects(
    db: &PgPool,
    user_id: &str,
    f: &ListFilters<'_>,
) -> Result<(Vec<(String, String, Option<String>)>, i64), DbErr> {
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
    .await
    .map_err(orm_error)?;
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "{SUBJECTS} select count(*)::int8 from subjects"
    )))
    .bind(user_id)
    .bind(f.review_type)
    .bind(f.project_id)
    .bind(f.accessible_project_ids)
    .fetch_one(db)
    .await
    .map_err(orm_error)?;
    Ok((page, total))
}

/// `loadSentReviews`: subjects the caller asked approval for that still wait, newest request first.
pub(crate) async fn load_sent_reviews(
    db: &PgPool,
    user_id: &str,
    f: &ListFilters<'_>,
) -> Result<PageOf, DbErr> {
    if f.review_type == Some("timesheet") {
        return Ok((Vec::new(), false, None, 0));
    }
    let (page, total) = sent_subjects(db, user_id, f).await?;
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

/// The keyset after the `cursor` review: `(decided_at, id) < (cursor's)`,
/// everything when the cursor names no answered review.
fn done_before(cursor: &str) -> Condition {
    use sea_orm::ExprTrait as _;
    let cursor_row = || {
        Query::select()
            .from_as(approvals::Entity, Alias::new("c"))
            .and_where(Expr::col((Alias::new("c"), approvals::Column::Id)).eq(cursor))
            .to_owned()
    };
    let decided = cursor_row()
        .expr(Expr::val(1))
        .and_where(Expr::col((Alias::new("c"), approvals::Column::DecidedAt)).is_not_null())
        .to_owned();
    let key = cursor_row()
        .column((Alias::new("c"), approvals::Column::DecidedAt))
        .column((Alias::new("c"), approvals::Column::Id))
        .to_owned();
    Condition::any().add(Expr::exists(decided).not()).add(
        Expr::tuple([
            Expr::col((approvals::Entity, approvals::Column::DecidedAt)),
            Expr::col((approvals::Entity, approvals::Column::Id)),
        ])
        .lt(Expr::from(key)),
    )
}

/// `loadDoneReviews`: the reviews the caller answered, newest first.
pub(crate) async fn load_done_reviews(
    db: &PgPool,
    user_id: &str,
    f: &ListFilters<'_>,
    now: i64,
) -> Result<PageOf, DbErr> {
    if f.review_type == Some("timesheet") {
        return Ok((Vec::new(), false, None, 0));
    }
    let mut answered = approvals::Entity::find()
        .filter(approvals::Column::DecidedBy.eq(user_id))
        .filter(approvals::Column::DeletedAt.is_null())
        .filter(approvals::Column::Decision.is_in([
            "approved",
            "approved_with_conditions",
            "rejected",
        ]))
        .filter(in_accessible(f.accessible_project_ids));
    if let Some(review_type) = f.review_type {
        answered = answered.filter(approvals::Column::SubjectType.eq(review_type));
    }
    if let Some(project_id) = f.project_id {
        answered = answered.filter(approvals::Column::ProjectId.eq(project_id));
    }
    let mut page = answered.clone();
    if let Some(cursor) = f.cursor {
        page = page.filter(done_before(cursor));
    }
    let rows = page
        .order_by_desc(approvals::Column::DecidedAt)
        .order_by_desc(approvals::Column::Id)
        .limit(fetch_limit(f.limit)?)
        .all(&orm(db))
        .await?;
    let total = i64::try_from(answered.count(&orm(db)).await?).unwrap_or(i64::MAX);
    let limit = usize::try_from(f.limit).unwrap_or(0);
    let all: Vec<ApprovalRow> = approval_rows(rows)?;
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
