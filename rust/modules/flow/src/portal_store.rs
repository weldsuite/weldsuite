//! Queries behind the client portal (`services/project-portal.ts`).
//!
//! Every function starts from the contact's own access: the projects where one
//! of their CRM contacts is a stakeholder with `portal_access`, on a live
//! project. Nothing is read for a project outside that set, and every list of
//! shared items filters on `client_visible` in SQL, so a row the team did not
//! share never leaves the database.
//!
//! Rows are read through the entities, so they look as Drizzle returns them
//! (camelCase, ISO timestamps, a `numeric` column as its text).

use std::collections::{HashMap, HashSet};

use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde::Serialize;
use serde_json::{Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_flow_domain::project_portal::{
    ApprovalView, is_portal_approval_subject, next_milestone_of, present_approval,
    present_change_request, present_deliverable, present_document, present_file, present_message,
    present_milestone, present_report, progress_percent,
};
use weldsuite_kit::validation::js_trim;

use weldsuite_flow_domain::approvals::{
    PendingReview as CorePendingReview, PendingReviewFilters, compare_reviews,
    list_pending_for_approver,
};
use weldsuite_schema::tenant::{
    files, milestones, people, project_change_requests, project_deliverables, project_files,
    project_messages, project_stakeholders, project_status_reports, projects, workspace_members,
};

use crate::{json_rows, keyset_before, keyset_cursor, keyset_cursor_tz, row_json};

/// A CRM contact that may sign in.
pub(crate) struct ContactRow {
    pub(crate) id: String,
    pub(crate) name: String,
    #[allow(dead_code)]
    pub(crate) email: Option<String>,
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

// ── Who may sign in, and where ──────────────────────────────────────────────

/// `contactsWithAccess(db, email)`: the CRM contacts with this address that
/// are a stakeholder with portal access on at least one live project. A
/// duplicate contact (same address) is a second row.
pub(crate) async fn contacts_with_access(
    db: &PgPool,
    email: &str,
) -> Result<Vec<ContactRow>, DbErr> {
    use people::Column;
    let stakeholder = project_stakeholders::Entity::belongs_to(people::Entity)
        .from(project_stakeholders::Column::CrmContactId)
        .to(Column::Id)
        .into();
    let project = project_stakeholders::Entity::belongs_to(projects::Entity)
        .from(project_stakeholders::Column::ProjectId)
        .to(projects::Column::Id)
        .into();
    let rows: Vec<(String, String, Option<String>)> = people::Entity::find()
        .select_only()
        .columns([Column::Id, Column::DisplayName, Column::Email])
        .distinct()
        .join_rev(JoinType::InnerJoin, stakeholder)
        .join(JoinType::InnerJoin, project)
        .filter(lower_email_is(email))
        .filter(Column::DeletedAt.is_null())
        .filter(project_stakeholders::Column::PortalAccess.eq(true))
        .filter(project_stakeholders::Column::DeletedAt.is_null())
        .filter(projects::Column::DeletedAt.is_null())
        .order_by_asc(Column::Id)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, email)| ContactRow { id, name, email })
        .collect())
}

/// `contactsOfSession(db, contactIds)`: the contacts by id, in id order.
pub(crate) async fn contacts_of_session(
    db: &PgPool,
    contact_ids: &[String],
) -> Result<Vec<ContactRow>, DbErr> {
    use people::Column;
    if contact_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, String, Option<String>)> = people::Entity::find()
        .select_only()
        .columns([Column::Id, Column::DisplayName, Column::Email])
        .filter(Column::Id.is_in(contact_ids.iter().map(String::as_str)))
        .filter(Column::DeletedAt.is_null())
        .order_by_asc(Column::Id)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, email)| ContactRow { id, name, email })
        .collect())
}

/// `lower(people.email) = email`.
fn lower_email_is(email: &str) -> Expr {
    let lower = Func::lower(Expr::col((people::Entity, people::Column::Email)));
    sea_orm::ExprTrait::eq(Expr::from(lower), email)
}

/// A project as the portal reads it, with the contact that holds it.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortalProject {
    id: String,
    name: String,
    description: Option<String>,
    status: String,
    #[serde(serialize_with = "weldsuite_schema::js::Numeric::<2>::serialize")]
    progress: BigDecimal,
    #[serde(serialize_with = "weldsuite_schema::js::timestamp::option::serialize")]
    start_date: Option<PrimitiveDateTime>,
    #[serde(serialize_with = "weldsuite_schema::js::timestamp::option::serialize")]
    end_date: Option<PrimitiveDateTime>,
    project_manager_id: Option<String>,
    currency: Option<String>,
    #[serde(serialize_with = "weldsuite_schema::js::timestamp::serialize")]
    updated_at: PrimitiveDateTime,
    contact_id: Option<String>,
}

/// `portalProjectRows(db, contactIds)`: the projects the contacts may see
/// (stakeholder with `portal_access` on a live project, for a live contact),
/// read on every request, which is what makes a revoked `portal_access` take
/// effect at once. A project two contacts hold counts once, for the first. The
/// contact's address must still be the session's `email` (normalised), so a
/// session does not follow a contact whose email changed after sign-in.
pub(crate) async fn portal_project_rows(
    db: &PgPool,
    contact_ids: &[String],
    email: &str,
) -> Result<Vec<Value>, DbErr> {
    use project_stakeholders::Column;
    if contact_ids.is_empty() {
        return Ok(Vec::new());
    }
    let project = project_stakeholders::Entity::belongs_to(projects::Entity)
        .from(Column::ProjectId)
        .to(projects::Column::Id)
        .into();
    let contact = project_stakeholders::Entity::belongs_to(people::Entity)
        .from(Column::CrmContactId)
        .to(people::Column::Id)
        .into();
    let rows: Vec<PortalProject> = project_stakeholders::Entity::find()
        .select_only()
        .column_as(projects::Column::Id, "id")
        .column_as(projects::Column::Name, "name")
        .column_as(projects::Column::Description, "description")
        .column_as(projects::Column::Status, "status")
        .column_as(projects::Column::Progress, "progress")
        .column_as(projects::Column::StartDate, "start_date")
        .column_as(projects::Column::EndDate, "end_date")
        .column_as(projects::Column::ProjectManagerId, "project_manager_id")
        .column_as(projects::Column::BudgetCurrency, "currency")
        .column_as(projects::Column::UpdatedAt, "updated_at")
        .column_as(Column::CrmContactId, "contact_id")
        .join(JoinType::InnerJoin, project)
        .join(JoinType::InnerJoin, contact)
        .filter(Column::CrmContactId.is_in(contact_ids.iter().map(String::as_str)))
        .filter(Column::PortalAccess.eq(true))
        .filter(Column::DeletedAt.is_null())
        .filter(projects::Column::DeletedAt.is_null())
        .filter(people::Column::DeletedAt.is_null())
        .filter(lower_email_is(email))
        .order_by_asc(projects::Column::Name)
        .order_by_asc(projects::Column::Id)
        .order_by_asc(Column::CrmContactId)
        .into_model()
        .all(&orm(db))
        .await?;
    let mut seen = HashSet::new();
    Ok(json_rows(rows)?
        .into_iter()
        .filter(|row| {
            let has_contact = row.get("contactId").is_some_and(|c| !c.is_null());
            has_contact && seen.insert(text(row, "id").to_owned())
        })
        .collect())
}

/// `memberNames(db, userIds)`: member user ids to names, never an email.
pub(crate) async fn member_names(
    db: &PgPool,
    user_ids: &[Option<&str>],
) -> Result<HashMap<String, String>, DbErr> {
    use workspace_members::Column;
    let mut ids: Vec<String> = user_ids
        .iter()
        .flatten()
        .filter(|id| !id.is_empty())
        .map(|id| (*id).to_owned())
        .collect();
    ids.sort();
    ids.dedup();
    let mut names = HashMap::new();
    if ids.is_empty() {
        return Ok(names);
    }
    let rows: Vec<(String, Option<String>)> = workspace_members::Entity::find()
        .select_only()
        .columns([Column::UserId, Column::Name])
        .filter(Column::UserId.is_in(ids))
        .into_tuple()
        .all(&orm(db))
        .await?;
    for (user_id, name) in rows {
        if let Some(name) = name.filter(|n| !js_trim(n).is_empty()) {
            names.insert(user_id, name);
        }
    }
    Ok(names)
}

fn id_of(row: &Value, key: &str) -> Option<String> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

// ── Approvals ───────────────────────────────────────────────────────────────

/// A review waiting for a contact: the `flow_approvals` row (as Drizzle
/// returns it) and whether its earlier steps are answered.
pub(crate) struct PendingReview {
    pub(crate) approval: Value,
    pub(crate) actionable: bool,
}

/// `pendingReviews(db, contactIds, projectIds)`: the reviews addressed to
/// these contacts that wait for them, about a deliverable or a change request
/// on a project the contacts may see. Earliest due date first. The inbox is
/// the approvals core's (`list_pending_for_approver`, contact kind).
pub(crate) async fn pending_reviews(
    db: &PgPool,
    contact_ids: &[String],
    project_ids: &HashSet<String>,
) -> Result<Vec<PendingReview>, DbErr> {
    let now = crate::now_ms();
    let filters = PendingReviewFilters {
        approver_kind: Some("contact".to_owned()),
        ..PendingReviewFilters::default()
    };
    let mut lists = Vec::new();
    for contact_id in contact_ids {
        lists.push(
            list_pending_for_approver(db, contact_id, &filters, now)
                .await?,
        );
    }
    let mut seen = HashSet::new();
    let mut reviews: Vec<CorePendingReview> = lists
        .into_iter()
        .flatten()
        .filter(|review| {
            let approval = &review.approval;
            if !seen.insert(approval.id.clone()) {
                return false;
            }
            approval
                .project_id
                .as_ref()
                .is_some_and(|p| project_ids.contains(p))
                && is_portal_approval_subject(&approval.subject_type)
        })
        .collect();
    reviews.sort_by(|a, b| compare_reviews(&a.approval, &b.approval));
    Ok(reviews
        .into_iter()
        .map(|review| PendingReview {
            approval: review.approval.to_json(),
            actionable: review.actionable,
        })
        .collect())
}

/// `presentReviews`: the reviews as the portal presents them, with their
/// deliverable or change request.
pub(crate) async fn present_reviews(
    db: &PgPool,
    reviews: &[PendingReview],
    projects_by_id: &HashMap<String, &Value>,
) -> Result<Vec<Value>, DbErr> {
    if reviews.is_empty() {
        return Ok(Vec::new());
    }
    let ids_of = |subject: &str| -> Vec<String> {
        reviews
            .iter()
            .filter(|r| text(&r.approval, "subjectType") == subject)
            .map(|r| text(&r.approval, "subjectId").to_owned())
            .collect()
    };
    let deliverable_ids = ids_of("deliverable");
    let change_ids = ids_of("change_request");
    let deliverables: Vec<Value> = if deliverable_ids.is_empty() {
        Vec::new()
    } else {
        use project_deliverables::Column;
        json_rows(
            project_deliverables::Entity::find()
                .filter(Column::Id.is_in(deliverable_ids))
                .filter(Column::DeletedAt.is_null())
                .all(&orm(db))
                .await?,
        )?
    };
    let changes: Vec<Value> = if change_ids.is_empty() {
        Vec::new()
    } else {
        use project_change_requests::Column;
        json_rows(
            project_change_requests::Entity::find()
                .filter(Column::Id.is_in(change_ids))
                .filter(Column::DeletedAt.is_null())
                .all(&orm(db))
                .await?,
        )?
    };
    let creators: Vec<Option<&str>> = reviews
        .iter()
        .map(|r| r.approval.get("createdBy").and_then(Value::as_str))
        .collect();
    let names = member_names(db, &creators).await?;
    let deliverable_by_id: HashMap<&str, &Value> =
        deliverables.iter().map(|d| (text(d, "id"), d)).collect();
    let change_by_id: HashMap<&str, &Value> = changes.iter().map(|c| (text(c, "id"), c)).collect();

    Ok(reviews
        .iter()
        .filter_map(|review| {
            let approval = &review.approval;
            let project = projects_by_id.get(id_of(approval, "projectId")?.as_str())?;
            let subject_id = text(approval, "subjectId");
            present_approval(&ApprovalView {
                approval,
                project_name: text(project, "name"),
                currency: project.get("currency").and_then(Value::as_str),
                requested_by_name: names.get(text(approval, "createdBy")).map(String::as_str),
                actionable: review.actionable,
                deliverable: deliverable_by_id.get(subject_id).copied(),
                change: change_by_id.get(subject_id).copied(),
            })
        })
        .collect())
}

// ── Projects ────────────────────────────────────────────────────────────────

/// A milestone as the portal reads it.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortalMilestone {
    id: String,
    project_id: String,
    name: String,
    description: Option<String>,
    #[serde(serialize_with = "weldsuite_schema::js::timestamp::serialize")]
    due_date: PrimitiveDateTime,
    status: String,
}

/// `milestonesOf(db, projectIds)`: the milestones per project, earliest due first.
async fn milestones_of(
    db: &PgPool,
    project_ids: &[String],
) -> Result<HashMap<String, Vec<Value>>, DbErr> {
    use milestones::Column;
    let mut by_project: HashMap<String, Vec<Value>> = HashMap::new();
    if project_ids.is_empty() {
        return Ok(by_project);
    }
    let rows: Vec<PortalMilestone> = milestones::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::ProjectId,
            Column::Name,
            Column::Description,
            Column::DueDate,
            Column::Status,
        ])
        .filter(Column::ProjectId.is_in(project_ids.iter().map(String::as_str)))
        .filter(Column::DeletedAt.is_null())
        .order_by_asc(Column::DueDate)
        .order_by_asc(Column::Id)
        .into_model()
        .all(&orm(db))
        .await?;
    for row in json_rows(rows)? {
        by_project
            .entry(text(&row, "projectId").to_owned())
            .or_default()
            .push(row);
    }
    Ok(by_project)
}

fn summary_of(
    row: &Value,
    milestones: &[Value],
    manager_name: Option<&str>,
    waiting_for_you: usize,
) -> Value {
    let date = |key: &str| {
        row.get(key)
            .filter(|v| v.is_string())
            .cloned()
            .unwrap_or(Value::Null)
    };
    json!({
        "id": row["id"],
        "name": row["name"],
        "description": row.get("description").cloned().unwrap_or(Value::Null),
        "status": row["status"],
        "progress": progress_percent(row.get("progress")),
        "startDate": date("startDate"),
        "goLive": date("endDate"),
        "projectManagerName": manager_name,
        "nextMilestone": next_milestone_of(milestones),
        "waitingForYou": waiting_for_you,
        "updatedAt": row["updatedAt"],
    })
}

fn waiting_by_project(reviews: &[PendingReview]) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for review in reviews {
        if let Some(project) = id_of(&review.approval, "projectId") {
            *counts.entry(project).or_insert(0) += 1;
        }
    }
    counts
}

/// `listPortalProjects`: the contact's projects, with their next milestone and
/// what waits for them.
pub(crate) async fn list_portal_projects(
    db: &PgPool,
    rows: &[Value],
    contact_ids: &[String],
) -> Result<Vec<Value>, DbErr> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let project_ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let id_set: HashSet<String> = project_ids.iter().cloned().collect();
    let milestones = milestones_of(db, &project_ids).await?;
    let managers: Vec<Option<&str>> = rows
        .iter()
        .map(|r| r.get("projectManagerId").and_then(Value::as_str))
        .collect();
    let names = member_names(db, &managers).await?;
    let reviews = pending_reviews(db, contact_ids, &id_set).await?;
    let waiting = waiting_by_project(&reviews);
    Ok(rows
        .iter()
        .map(|row| {
            let id = text(row, "id");
            summary_of(
                row,
                milestones.get(id).map_or(&[][..], Vec::as_slice),
                row.get("projectManagerId")
                    .and_then(Value::as_str)
                    .and_then(|m| names.get(m))
                    .map(String::as_str),
                waiting.get(id).copied().unwrap_or(0),
            )
        })
        .collect())
}

/// `getPortalProject`: one project with its milestones, shared deliverables
/// and changes, and the latest shared report.
pub(crate) async fn get_portal_project(
    db: &PgPool,
    row: &Value,
    contact_ids: &[String],
) -> Result<Value, DbErr> {
    let project_id = text(row, "id").to_owned();
    let id_set: HashSet<String> = HashSet::from([project_id.clone()]);
    let milestones = milestones_of(db, std::slice::from_ref(&project_id)).await?;
    let names = member_names(db, &[row.get("projectManagerId").and_then(Value::as_str)]).await?;
    let reviews = pending_reviews(db, contact_ids, &id_set).await?;
    let deliverables = {
        use project_deliverables::Column;
        json_rows(
            project_deliverables::Entity::find()
                .filter(Column::ProjectId.eq(project_id.as_str()))
                .filter(Column::ClientVisible.eq(true))
                .filter(Column::DeletedAt.is_null())
                .order_by_asc(Column::Number)
                .all(&orm(db))
                .await?,
        )?
    };
    let changes = {
        use project_change_requests::Column;
        json_rows(
            project_change_requests::Entity::find()
                .filter(Column::ProjectId.eq(project_id.as_str()))
                .filter(Column::ClientVisible.eq(true))
                .filter(Column::DeletedAt.is_null())
                .order_by_asc(Column::Number)
                .all(&orm(db))
                .await?,
        )?
    };
    let latest = list_portal_reports(db, &project_id, 1, None).await?;
    let milestone_rows = milestones.get(&project_id).map_or(&[][..], Vec::as_slice);
    let mut out = summary_of(
        row,
        milestone_rows,
        row.get("projectManagerId")
            .and_then(Value::as_str)
            .and_then(|m| names.get(m))
            .map(String::as_str),
        reviews.len(),
    );
    let currency = row.get("currency").and_then(Value::as_str);
    if let Value::Object(map) = &mut out {
        map.insert(
            "milestones".to_owned(),
            Value::Array(milestone_rows.iter().map(present_milestone).collect()),
        );
        map.insert(
            "deliverables".to_owned(),
            Value::Array(deliverables.iter().map(present_deliverable).collect()),
        );
        map.insert(
            "changeRequests".to_owned(),
            Value::Array(
                changes
                    .iter()
                    .map(|c| present_change_request(c, currency))
                    .collect(),
            ),
        );
        map.insert(
            "latestReport".to_owned(),
            latest.items.into_iter().next().unwrap_or(Value::Null),
        );
    }
    Ok(out)
}

// ── Paged lists of shared items ─────────────────────────────────────────────

/// A page of presented items.
pub(crate) struct Page {
    pub(crate) items: Vec<Value>,
    pub(crate) has_more: bool,
    pub(crate) cursor: Option<String>,
    pub(crate) total: i64,
}

fn paged_items(
    rows: Vec<Value>,
    limit: i64,
    total: i64,
    present: impl FnOnce(&[Value]) -> Vec<Value>,
) -> Page {
    let (rows, has_more, cursor) = crate::page(rows, limit);
    Page {
        items: present(&rows),
        has_more,
        cursor,
        total,
    }
}

/// `listPortalReports`: published, client visible reports of a project, newest
/// first. A report a published, shared correction supersedes is left out.
pub(crate) async fn list_portal_reports(
    db: &PgPool,
    project_id: &str,
    limit: i64,
    cursor: Option<&str>,
) -> Result<Page, DbErr> {
    use project_status_reports::Column;
    // `not exists (select 1 from project_status_reports s where s.supersedes_id =
    // r.id and s.status = 'published' and s.client_visible and s.deleted_at is
    // null)`, as `r.id not in` the superseded ids (never null).
    let superseded = Query::select()
        .column(Column::SupersedesId)
        .from(project_status_reports::Entity)
        .and_where(Column::SupersedesId.is_not_null())
        .and_where(Column::Status.eq("published"))
        .and_where(Column::ClientVisible.eq(true))
        .and_where(Column::DeletedAt.is_null())
        .to_owned();
    let base = Condition::all()
        .add(Column::ProjectId.eq(project_id))
        .add(Column::Status.eq("published"))
        .add(Column::ClientVisible.eq(true))
        .add(Column::DeletedAt.is_null())
        .add(Column::Id.not_in_subquery(superseded));
    // The cursor row's `published_at` as milliseconds, and its id; `None`
    // when the row is gone (no condition then), as in TypeScript.
    let cur = match cursor {
        Some(cursor) => keyset_cursor_tz(db, Column::Id, Column::PublishedAt, cursor).await?,
        None => None,
    };
    let mut rows = project_status_reports::Entity::find().filter(base.clone());
    if let Some(cur) = &cur {
        rows = rows.filter(keyset_before(Column::Id, Column::PublishedAt, cur));
    }
    let rows = rows
        .order_by_desc(Column::PublishedAt)
        .order_by_desc(Column::Id)
        .limit(crate::fetch_limit(limit)?)
        .all(&orm(db))
        .await?;
    let total = project_status_reports::Entity::find()
        .filter(base)
        .count(&orm(db))
        .await?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    let rows = json_rows(rows)?;
    let publishers: Vec<Option<&str>> = rows
        .iter()
        .map(|r| r.get("publishedBy").and_then(Value::as_str))
        .collect();
    let names = member_names(db, &publishers).await?;
    Ok(paged_items(rows, limit, total, |rows| {
        rows.iter()
            .map(|row| {
                let by = row
                    .get("publishedBy")
                    .and_then(Value::as_str)
                    .and_then(|id| names.get(id))
                    .map(String::as_str);
                present_report(row, by)
            })
            .collect()
    }))
}

/// A `created_at desc, id desc` keyset page of the rows matching `base` of
/// the table whose `id` and `created_at` (a `timestamp` without a time zone)
/// columns are given, and their count.
async fn keyset_page<C>(
    db: &PgPool,
    (id, created_at): (C, C),
    base: Condition,
    limit: i64,
    cursor: Option<&str>,
) -> Result<(Vec<Value>, i64), DbErr>
where
    C: ColumnTrait + Copy,
    C::EntityName: EntityTrait,
    <C::EntityName as EntityTrait>::Model: Serialize + Sync,
{
    let cur = match cursor {
        Some(cursor) => keyset_cursor(db, id, created_at, cursor).await?,
        None => None,
    };
    let mut rows = <C::EntityName as EntityTrait>::find().filter(base.clone());
    if let Some(cur) = &cur {
        rows = rows.filter(keyset_before(id, created_at, cur));
    }
    let rows = rows
        .order_by_desc(created_at)
        .order_by_desc(id)
        .limit(crate::fetch_limit(limit)?)
        .all(&orm(db))
        .await?;
    let total = <C::EntityName as EntityTrait>::find()
        .filter(base)
        .count(&orm(db))
        .await?;
    Ok((json_rows(rows)?, i64::try_from(total).unwrap_or(i64::MAX)))
}

/// A project's files marked client visible (folders are not files here),
/// live.
fn shared_files(project_id: &str) -> Condition {
    use project_files::Column;
    Condition::all()
        .add(Column::ProjectId.eq(project_id))
        .add(Column::ClientVisible.eq(true))
        .add(Column::IsFolder.eq(false))
        .add(Column::DeletedAt.is_null())
}

/// `listPortalFiles`: files of a project marked client visible (folders are
/// not files here), newest first.
pub(crate) async fn list_portal_files(
    db: &PgPool,
    project_id: &str,
    limit: i64,
    cursor: Option<&str>,
) -> Result<Page, DbErr> {
    use project_files::Column;
    let (rows, total) = keyset_page(
        db,
        (Column::Id, Column::CreatedAt),
        shared_files(project_id),
        limit,
        cursor,
    )
    .await?;
    let uploaders: Vec<Option<&str>> = rows
        .iter()
        .map(|r| r.get("uploadedById").and_then(Value::as_str))
        .collect();
    let names = member_names(db, &uploaders).await?;
    Ok(paged_items(rows, limit, total, |rows| {
        rows.iter().map(|row| present_file(row, &names)).collect()
    }))
}

/// `findPortalFile`: one shared file of a project, for its download.
pub(crate) async fn find_portal_file(
    db: &PgPool,
    project_id: &str,
    file_id: &str,
) -> Result<Option<Value>, DbErr> {
    project_files::Entity::find()
        .filter(project_files::Column::Id.eq(file_id))
        .filter(shared_files(project_id))
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// The project's documents (drive files of type document) marked client
/// visible, live.
fn shared_documents(project_id: &str) -> Condition {
    use files::Column;
    Condition::all()
        .add(Column::EntityType.eq("project"))
        .add(Column::EntityId.eq(project_id))
        .add(Column::FileType.eq("document"))
        .add(Column::ClientVisible.eq(true))
        .add(Column::DeletedAt.is_null())
}

/// `listPortalDocuments`: the project's documents (drive files of type
/// document) marked client visible, newest first.
pub(crate) async fn list_portal_documents(
    db: &PgPool,
    project_id: &str,
    limit: i64,
    cursor: Option<&str>,
) -> Result<Page, DbErr> {
    use files::Column;
    let (rows, total) = keyset_page(
        db,
        (Column::Id, Column::CreatedAt),
        shared_documents(project_id),
        limit,
        cursor,
    )
    .await?;
    Ok(paged_items(rows, limit, total, |rows| {
        rows.iter().map(present_document).collect()
    }))
}

/// `findPortalDocument`: one shared document of a project, for its download.
pub(crate) async fn find_portal_document(
    db: &PgPool,
    project_id: &str,
    document_id: &str,
) -> Result<Option<Value>, DbErr> {
    files::Entity::find()
        .filter(files::Column::Id.eq(document_id))
        .filter(shared_documents(project_id))
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// `listPortalMessages`: the thread of a project, messages marked client
/// visible, newest first.
pub(crate) async fn list_portal_messages(
    db: &PgPool,
    project_id: &str,
    contact_ids: &[String],
    limit: i64,
    cursor: Option<&str>,
) -> Result<Page, DbErr> {
    use project_messages::Column;
    let shared = Condition::all()
        .add(Column::ProjectId.eq(project_id))
        .add(Column::ClientVisible.eq(true))
        .add(Column::DeletedAt.is_null());
    let (rows, total) =
        keyset_page(db, (Column::Id, Column::CreatedAt), shared, limit, cursor).await?;
    let senders: Vec<Option<&str>> = rows
        .iter()
        .map(|r| r.get("senderId").and_then(Value::as_str))
        .collect();
    let names = member_names(db, &senders).await?;
    Ok(paged_items(rows, limit, total, |rows| {
        rows.iter()
            .map(|row| present_message(row, &names, contact_ids))
            .collect()
    }))
}
