//! Queries behind the client portal (`services/project-portal.ts`).
//!
//! Every function starts from the contact's own access: the projects where one
//! of their CRM contacts is a stakeholder with `portal_access`, on a live
//! project. Nothing is read for a project outside that set, and every list of
//! shared items filters on `client_visible` in SQL, so a row the team did not
//! share never leaves the database.
//!
//! Rows are read as `to_jsonb(row)` and put through `js_row`, so they look as
//! Drizzle returns them (camelCase, ISO timestamps); a `numeric` column is cast
//! to text first, as Drizzle returns it.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_db::{js_row, js_timestamp};
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

/// A CRM contact that may sign in.
pub(crate) struct ContactRow {
    pub(crate) id: String,
    pub(crate) name: String,
    #[allow(dead_code)]
    pub(crate) email: Option<String>,
}

fn rows_of(rows: Vec<Value>) -> Vec<Value> {
    rows.into_iter().map(js_row).collect()
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
) -> Result<Vec<ContactRow>, sqlx::Error> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "select distinct p.id, p.display_name, p.email
         from people p
         inner join project_stakeholders s on s.crm_contact_id = p.id
         inner join projects pr on pr.id = s.project_id
         where lower(p.email) = $1 and p.deleted_at is null and s.portal_access = true
           and s.deleted_at is null and pr.deleted_at is null
         order by p.id asc",
    )
    .bind(email)
    .fetch_all(db)
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
) -> Result<Vec<ContactRow>, sqlx::Error> {
    if contact_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "select p.id, p.display_name, p.email from people p
         where p.id = any($1) and p.deleted_at is null order by p.id asc",
    )
    .bind(contact_ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, email)| ContactRow { id, name, email })
        .collect())
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
) -> Result<Vec<Value>, sqlx::Error> {
    if contact_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object(
            'id', pr.id, 'name', pr.name, 'description', pr.description,
            'status', pr.status, 'progress', pr.progress::text,
            'start_date', pr.start_date, 'end_date', pr.end_date,
            'project_manager_id', pr.project_manager_id, 'currency', pr.budget_currency,
            'updated_at', pr.updated_at, 'contact_id', s.crm_contact_id)
         from project_stakeholders s
         inner join projects pr on pr.id = s.project_id
         inner join people p on p.id = s.crm_contact_id
         where s.crm_contact_id = any($1) and s.portal_access = true and s.deleted_at is null
           and pr.deleted_at is null and p.deleted_at is null
           and lower(p.email) = $2
         order by pr.name asc, pr.id asc, s.crm_contact_id asc",
    )
    .bind(contact_ids)
    .bind(email)
    .fetch_all(db)
    .await?;
    let mut seen = HashSet::new();
    Ok(rows_of(rows)
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
) -> Result<HashMap<String, String>, sqlx::Error> {
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
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("select user_id, name from workspace_members where user_id = any($1)")
            .bind(&ids)
            .fetch_all(db)
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
) -> Result<Vec<PendingReview>, sqlx::Error> {
    let now = crate::now_ms();
    let filters = PendingReviewFilters {
        approver_kind: Some("contact".to_owned()),
        ..PendingReviewFilters::default()
    };
    let mut lists = Vec::new();
    for contact_id in contact_ids {
        lists.push(list_pending_for_approver(db, contact_id, &filters, now).await?);
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
) -> Result<Vec<Value>, sqlx::Error> {
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
        rows_of(
            sqlx::query_scalar(
                "select to_jsonb(d) from project_deliverables d where d.id = any($1) and d.deleted_at is null",
            )
            .bind(&deliverable_ids)
            .fetch_all(db)
            .await?,
        )
    };
    let changes: Vec<Value> = if change_ids.is_empty() {
        Vec::new()
    } else {
        rows_of(
            sqlx::query_scalar(
                "select to_jsonb(c) || jsonb_build_object('cost_delta', c.cost_delta::text)
                 from project_change_requests c where c.id = any($1) and c.deleted_at is null",
            )
            .bind(&change_ids)
            .fetch_all(db)
            .await?,
        )
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

/// `milestonesOf(db, projectIds)`: the milestones per project, earliest due first.
async fn milestones_of(
    db: &PgPool,
    project_ids: &[String],
) -> Result<HashMap<String, Vec<Value>>, sqlx::Error> {
    let mut by_project: HashMap<String, Vec<Value>> = HashMap::new();
    if project_ids.is_empty() {
        return Ok(by_project);
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', m.id, 'project_id', m.project_id, 'name', m.name,
                'description', m.description, 'due_date', m.due_date, 'status', m.status)
         from milestones m where m.project_id = any($1) and m.deleted_at is null
         order by m.due_date asc, m.id asc",
    )
    .bind(project_ids)
    .fetch_all(db)
    .await?;
    for row in rows_of(rows) {
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
) -> Result<Vec<Value>, sqlx::Error> {
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
) -> Result<Value, sqlx::Error> {
    let project_id = text(row, "id").to_owned();
    let id_set: HashSet<String> = HashSet::from([project_id.clone()]);
    let milestones = milestones_of(db, std::slice::from_ref(&project_id)).await?;
    let names = member_names(db, &[row.get("projectManagerId").and_then(Value::as_str)]).await?;
    let reviews = pending_reviews(db, contact_ids, &id_set).await?;
    let deliverables = rows_of(
        sqlx::query_scalar(
            "select to_jsonb(d) from project_deliverables d
             where d.project_id = $1 and d.client_visible = true and d.deleted_at is null
             order by d.number asc",
        )
        .bind(&project_id)
        .fetch_all(db)
        .await?,
    );
    let changes = rows_of(
        sqlx::query_scalar(
            "select to_jsonb(c) || jsonb_build_object('cost_delta', c.cost_delta::text)
             from project_change_requests c
             where c.project_id = $1 and c.client_visible = true and c.deleted_at is null
             order by c.number asc",
        )
        .bind(&project_id)
        .fetch_all(db)
        .await?,
    );
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

/// The keyset cursor row: `created_at`/`published_at` as milliseconds, and
/// the id. `None` when the row is gone (no condition then), as in TypeScript.
async fn cursor_row(
    db: &PgPool,
    sql: &'static str,
    cursor: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as(sql).bind(cursor).fetch_optional(db).await?;
    Ok(row.and_then(|(id, at)| {
        at.as_deref()
            .and_then(js_timestamp)
            .map(|stamp| (stamp, id))
    }))
}

/// `listPortalReports`: published, client visible reports of a project, newest
/// first. A report a published, shared correction supersedes is left out.
pub(crate) async fn list_portal_reports(
    db: &PgPool,
    project_id: &str,
    limit: i64,
    cursor: Option<&str>,
) -> Result<Page, sqlx::Error> {
    const BASE: &str = "r.project_id = $1 and r.status = 'published' and r.client_visible = true
        and r.deleted_at is null
        and not exists (
          select 1 from project_status_reports s
          where s.supersedes_id = r.id and s.status = 'published' and s.client_visible
            and s.deleted_at is null)";
    let cur = match cursor {
        Some(cursor) => {
            cursor_row(
                db,
                "select id, to_jsonb(published_at) #>> '{}' from project_status_reports where id = $1 limit 1",
                cursor,
            )
            .await?
        }
        None => None,
    };
    let rows: Vec<Value> = if let Some((at, id)) = &cur {
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select to_jsonb(r) from project_status_reports r where {BASE}
               and (r.published_at < $3::timestamptz
                    or (r.published_at = $3::timestamptz and r.id < $4))
             order by r.published_at desc, r.id desc limit $2"
        )))
        .bind(project_id)
        .bind(limit + 1)
        .bind(at)
        .bind(id)
        .fetch_all(db)
        .await?
    } else {
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select to_jsonb(r) from project_status_reports r where {BASE}
             order by r.published_at desc, r.id desc limit $2"
        )))
        .bind(project_id)
        .bind(limit + 1)
        .fetch_all(db)
        .await?
    };
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*)::int8 from project_status_reports r where {BASE}"
    )))
    .bind(project_id)
    .fetch_one(db)
    .await?;
    let rows = rows_of(rows);
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

/// A `created_at desc, id desc` keyset page of `table` rows matching `base`
/// (which binds the project, or the project's id, as `$1`). `table_sql` is
/// the `from` clause with its alias `t`; the timestamps are `timestamp`
/// without a time zone.
async fn keyset_page(
    db: &PgPool,
    table_sql: &'static str,
    base: &'static str,
    cursor_sql: &'static str,
    project_id: &str,
    limit: i64,
    cursor: Option<&str>,
) -> Result<(Vec<Value>, i64), sqlx::Error> {
    let cur = match cursor {
        Some(cursor) => cursor_row(db, cursor_sql, cursor).await?,
        None => None,
    };
    let rows: Vec<Value> = if let Some((at, id)) = &cur {
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select to_jsonb(t) from {table_sql} where {base}
               and (t.created_at < $3::timestamp or (t.created_at = $3::timestamp and t.id < $4))
             order by t.created_at desc, t.id desc limit $2"
        )))
        .bind(project_id)
        .bind(limit + 1)
        .bind(at)
        .bind(id)
        .fetch_all(db)
        .await?
    } else {
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select to_jsonb(t) from {table_sql} where {base}
             order by t.created_at desc, t.id desc limit $2"
        )))
        .bind(project_id)
        .bind(limit + 1)
        .fetch_all(db)
        .await?
    };
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*)::int8 from {table_sql} where {base}"
    )))
    .bind(project_id)
    .fetch_one(db)
    .await?;
    Ok((rows_of(rows), total))
}

const FILES_FROM: &str = "project_files t";
const FILES_BASE: &str = "t.project_id = $1 and t.client_visible = true and t.is_folder = false and t.deleted_at is null";

/// `listPortalFiles`: files of a project marked client visible (folders are
/// not files here), newest first.
pub(crate) async fn list_portal_files(
    db: &PgPool,
    project_id: &str,
    limit: i64,
    cursor: Option<&str>,
) -> Result<Page, sqlx::Error> {
    let (rows, total) = keyset_page(
        db,
        FILES_FROM,
        FILES_BASE,
        "select id, to_jsonb(created_at) #>> '{}' from project_files where id = $1 limit 1",
        project_id,
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
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from project_files t
         where t.id = $1 and t.project_id = $2 and t.client_visible = true
           and t.is_folder = false and t.deleted_at is null limit 1",
    )
    .bind(file_id)
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

const DOCUMENTS_FROM: &str = "files t";
const DOCUMENTS_BASE: &str =
    "t.entity_type = 'project' and t.entity_id = $1 and t.file_type = 'document'
    and t.client_visible = true and t.deleted_at is null";

/// `listPortalDocuments`: the project's documents (drive files of type
/// document) marked client visible, newest first.
pub(crate) async fn list_portal_documents(
    db: &PgPool,
    project_id: &str,
    limit: i64,
    cursor: Option<&str>,
) -> Result<Page, sqlx::Error> {
    let (rows, total) = keyset_page(
        db,
        DOCUMENTS_FROM,
        DOCUMENTS_BASE,
        "select id, to_jsonb(created_at) #>> '{}' from files where id = $1 limit 1",
        project_id,
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
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from {DOCUMENTS_FROM} where t.id = $2 and {DOCUMENTS_BASE} limit 1"
    )))
    .bind(project_id)
    .bind(document_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

const MESSAGES_FROM: &str = "project_messages t";
const MESSAGES_BASE: &str =
    "t.project_id = $1 and t.client_visible = true and t.deleted_at is null";

/// `listPortalMessages`: the thread of a project, messages marked client
/// visible, newest first.
pub(crate) async fn list_portal_messages(
    db: &PgPool,
    project_id: &str,
    contact_ids: &[String],
    limit: i64,
    cursor: Option<&str>,
) -> Result<Page, sqlx::Error> {
    let (rows, total) = keyset_page(
        db,
        MESSAGES_FROM,
        MESSAGES_BASE,
        "select id, to_jsonb(created_at) #>> '{}' from project_messages where id = $1 limit 1",
        project_id,
        limit,
        cursor,
    )
    .await?;
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
