//! HR announcements (`routes/weldhr/announcements.ts`,
//! `services/weldhr/announcements.ts`, `announcement-push.ts`). Employees
//! read theirs under `/me` ([`crate::me`]).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    HR_ANNOUNCEMENT_CREATED, HR_ANNOUNCEMENT_DELETED, HR_ANNOUNCEMENT_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    ANNOUNCEMENTS_CREATE, ANNOUNCEMENTS_DELETE, ANNOUNCEMENTS_READ, ANNOUNCEMENTS_UPDATE,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_notifications::{NewNotification, create_and_deliver};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::departments::{department_lineage, employees_in_departments};
use crate::employees::{display_name_of, require_employee};
use crate::fields::{Fields, short_text};
use crate::{Caller, HrError, HrResult, HrState, hr_json, js_trim, locale_compare, member_names, now, text};

/// Recipients notified at once.
const BATCH: usize = 10;
const PREVIEW_LENGTH: usize = 160;

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([ANNOUNCEMENTS_READ]);
    Router::new()
        .route("/announcements", get(list).route_layer(read()))
        .route("/announcements", post(create).route_layer(gate.require([ANNOUNCEMENTS_CREATE])))
        .route("/announcements/{id}", patch(update).route_layer(gate.require([ANNOUNCEMENTS_UPDATE])))
        .route("/announcements/{id}", delete(remove).route_layer(gate.require([ANNOUNCEMENTS_DELETE])))
        .route("/announcements/{id}/reads", get(reads).route_layer(read()))
}

/// `requireAnnouncement(db, id)`.
async fn require_announcement(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_announcements t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.map(js_row)
        .ok_or_else(|| HrError::not_found("Announcement", id))
}

fn department_ids(row: &Value) -> Vec<String> {
    row["departmentIds"]
        .as_array()
        .map(|ids| ids.iter().filter_map(|id| id.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

/// `byPinnedThenNewest`: pinned first, then newest; a stable sort.
fn sort_pinned_then_newest(rows: &mut [Value]) {
    rows.sort_by(|a, b| {
        let (pa, pb) = (a["pinned"] == true, b["pinned"] == true);
        if pa != pb {
            return if pa {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        // ISO strings with milliseconds compare as `getTime()` does.
        text(b, "publishedAt").cmp(text(a, "publishedAt"))
    });
}

/// The audience key: the department set, sorted and joined.
fn audience_key(row: &Value) -> String {
    let mut ids = department_ids(row);
    ids.sort();
    ids.join(",")
}

/// `listAnnouncements(db)`.
async fn list_announcements(db: &PgPool) -> Result<Vec<Value>, HrError> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_announcements t where t.deleted_at is null
         order by t.published_at desc limit 500",
    )
    .fetch_all(db)
    .await?;
    let mut rows: Vec<Value> = rows.into_iter().map(js_row).collect();
    sort_pinned_then_newest(&mut rows);
    if rows.is_empty() {
        return Ok(rows);
    }
    let mut audiences: HashMap<String, HashSet<String>> = HashMap::new();
    for row in &rows {
        let key = audience_key(row);
        if audiences.contains_key(&key) {
            continue;
        }
        let ids: Vec<String> = if key.is_empty() {
            Vec::new()
        } else {
            key.split(',').map(str::to_owned).collect()
        };
        let employees = employees_in_departments(db, &ids).await?;
        audiences.insert(key, employees.iter().map(|e| text(e, "id").to_owned()).collect());
    }
    let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let reads: Vec<(String, String)> = sqlx::query_as(
        "select announcement_id, employee_id from hr_announcement_reads where announcement_id = any($1)",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let mut all_departments: Vec<String> = Vec::new();
    for row in &rows {
        for id in department_ids(row) {
            if !all_departments.contains(&id) {
                all_departments.push(id);
            }
        }
    }
    let departments: HashMap<String, String> = if all_departments.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (String, String)>("select id, name from hr_departments where id = any($1)")
            .bind(&all_departments)
            .fetch_all(db)
            .await?
            .into_iter()
            .collect()
    };
    let authors_of: Vec<Option<&str>> = rows.iter().map(|r| r["createdBy"].as_str()).collect();
    let authors = member_names(db, &authors_of).await?;
    Ok(rows
        .into_iter()
        .map(|mut row| {
            let audience = audiences.get(&audience_key(&row)).cloned().unwrap_or_default();
            let id = text(&row, "id").to_owned();
            let read_count = reads
                .iter()
                .filter(|(announcement, employee)| *announcement == id && audience.contains(employee))
                .count();
            let names: Vec<String> = department_ids(&row)
                .iter()
                .filter_map(|id| departments.get(id).cloned())
                .filter(|name| !name.is_empty())
                .collect();
            let author = row["createdBy"]
                .as_str()
                .filter(|by| !by.is_empty())
                .and_then(|by| authors.get(by).cloned());
            if let Some(map) = row.as_object_mut() {
                map.insert("departmentNames".to_owned(), json!(names));
                map.insert("createdByName".to_owned(), json!(author));
                map.insert("audienceCount".to_owned(), json!(audience.len()));
                map.insert("readCount".to_owned(), json!(read_count));
            }
            row
        })
        .collect())
}

/// `announcementWithDetails(db, id)`.
async fn announcement_with_details(db: &PgPool, id: &str) -> Result<Value, HrError> {
    list_announcements(db)
        .await?
        .into_iter()
        .find(|row| row["id"] == id)
        .ok_or_else(|| HrError::not_found("Announcement", id))
}

async fn list(caller: Caller) -> HrResult {
    Ok(Data(list_announcements(&caller.db).await?).into_response())
}

/// `assertDepartments(db, ids)`.
async fn assert_departments(db: &PgPool, ids: &[String]) -> Result<(), HrError> {
    if ids.is_empty() {
        return Ok(());
    }
    let found: i64 = sqlx::query_scalar(
        "select count(*) from hr_departments where id = any($1) and deleted_at is null",
    )
    .bind(ids)
    .fetch_one(db)
    .await?;
    let unique: HashSet<&String> = ids.iter().collect();
    if usize::try_from(found).unwrap_or_default() != unique.len() {
        return Err(HrError::not_found("Department", &ids.join(",")));
    }
    Ok(())
}

/// `[...new Set(ids)]`.
fn dedupe(ids: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

struct AnnouncementInput {
    title: Field<String>,
    body: Field<String>,
    pinned: Field<bool>,
    department_ids: Field<Vec<String>>,
    notify: Field<bool>,
}

fn announcement_input(issues: &mut Issues, fields: &Fields, partial: bool) -> AnnouncementInput {
    let required = if partial { Presence::Optional } else { Presence::Required };
    AnnouncementInput {
        title: short_text(issues, fields, "title", required, 200, true),
        body: issues.text_with(fields, "body", required, Text::trimmed(Some(1), Some(20000))),
        pinned: issues.boolean(fields, "pinned", Presence::Optional),
        department_ids: issues.list(fields, "departmentIds", Presence::Optional, None, Some(100), |issues, item| {
            issues.item_text(item, Text::length(Some(1), Some(30)))
        }),
        notify: if partial {
            Field::Absent
        } else {
            issues.boolean(fields, "notify", Presence::Optional)
        },
    }
}

async fn create(State(state): State<HrState>, caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| announcement_input(issues, fields, false))?;
    let db = &caller.db;
    let departments = dedupe(input.department_ids.into_option().unwrap_or_default());
    assert_departments(db, &departments).await?;
    let row: Value = sqlx::query_scalar(
        "insert into hr_announcements (id, title, body, pinned, department_ids, created_by)
         values ($1, $2, $3, $4, $5, $6) returning to_jsonb(hr_announcements)",
    )
    .bind(generate_id("hrann"))
    .bind(input.title.as_set().map(|t| js_trim(t)))
    .bind(input.body.as_set().map(|b| js_trim(b)))
    .bind(input.pinned.as_set().copied().unwrap_or(false))
    .bind(json!(departments))
    .bind(&caller.user_id)
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    let id = text(&row, "id").to_owned();
    caller.emit(&state, HR_ANNOUNCEMENT_CREATED, &id, &[]);
    if input.notify.as_set() == Some(&true) {
        // Fan-out runs after the response; the row gets `notifiedAt` when done.
        let db = db.clone();
        let notifier = caller.notifier(&state);
        let workspace = caller.clerk_org_id.clone();
        let actor = caller.user_id.clone();
        let announcement = row.clone();
        state.events.tracker().spawn(async move {
            if let Err(error) = notify_announcement(&db, &notifier, &workspace, &announcement, &actor).await {
                tracing::error!(?error, "[weldhr] announcement push failed");
            }
        });
    }
    Ok(Created(announcement_with_details(db, &id).await?).into_response())
}

async fn update(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| announcement_input(issues, fields, true))?;
    let db = &caller.db;
    require_announcement(db, &id).await?;
    let departments = input.department_ids.into_option().map(dedupe);
    if let Some(departments) = &departments {
        assert_departments(db, departments).await?;
    }
    let row: Value = sqlx::query_scalar(
        "update hr_announcements set
             title = coalesce($2, title),
             body = coalesce($3, body),
             pinned = coalesce($4, pinned),
             department_ids = coalesce($5, department_ids),
             updated_at = $6::timestamp
         where id = $1 returning to_jsonb(hr_announcements)",
    )
    .bind(&id)
    .bind(input.title.as_set().map(|t| js_trim(t)))
    .bind(input.body.as_set().map(|b| js_trim(b)))
    .bind(input.pinned.as_set())
    .bind(departments.map(|d| json!(d)))
    .bind(now())
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    caller.emit(&state, HR_ANNOUNCEMENT_UPDATED, text(&row, "id"), &[]);
    Ok(Data(announcement_with_details(db, &id).await?).into_response())
}

async fn remove(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    require_announcement(&caller.db, &id).await?;
    sqlx::query("update hr_announcements set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
    caller.emit(&state, HR_ANNOUNCEMENT_DELETED, &id, &[]);
    Ok(NoContent.into_response())
}

async fn reads(caller: Caller, Path(id): Path<String>) -> HrResult {
    let db = &caller.db;
    let row = require_announcement(db, &id).await?;
    let audience = employees_in_departments(db, &department_ids(&row)).await?;
    let reads: Vec<(String, Value)> = sqlx::query_as(
        "select employee_id, to_jsonb(read_at) from hr_announcement_reads where announcement_id = $1",
    )
    .bind(&id)
    .fetch_all(db)
    .await?;
    let read_at: HashMap<String, Value> = reads
        .into_iter()
        .map(|(employee, at)| (employee, crate::js_time(&at)))
        .collect();
    let mut out: Vec<Value> = audience
        .iter()
        .map(|e| {
            json!({
                "employeeId": e["id"],
                "employeeName": display_name_of(e),
                "readAt": read_at.get(text(e, "id")).cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        let (ra, rb) = (!a["readAt"].is_null(), !b["readAt"].is_null());
        if ra != rb {
            return if ra {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Less
            };
        }
        locale_compare(text(a, "employeeName"), text(b, "employeeName"))
    });
    Ok(Data(out).into_response())
}

/// `announcementPreview(body)`: whitespace collapsed, cut at 160 characters.
fn announcement_preview(body: &str) -> String {
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let units: Vec<u16> = flat.encode_utf16().collect();
    if units.len() > PREVIEW_LENGTH {
        let cut = String::from_utf16_lossy(&units[..PREVIEW_LENGTH - 1]);
        format!("{cut}…")
    } else {
        flat
    }
}

/// `notifyAnnouncement(db, env, workspaceId, announcement, actorId)`.
async fn notify_announcement(
    db: &PgPool,
    notifier: &weldsuite_notifications::Notifier,
    workspace_id: &str,
    announcement: &Value,
    actor_id: &str,
) -> Result<usize, HrError> {
    let audience = employees_in_departments(db, &department_ids(announcement)).await?;
    let mut recipients: Vec<String> = Vec::new();
    for employee in &audience {
        if let Some(user) = employee["userId"].as_str().filter(|u| !u.is_empty())
            && !recipients.iter().any(|known| known == user)
        {
            recipients.push(user.to_owned());
        }
    }
    recipients.retain(|user| user != actor_id);
    let id = text(announcement, "id").to_owned();
    for batch in recipients.chunks(BATCH) {
        for user in batch {
            let params = NewNotification {
                workspace_id: workspace_id.to_owned(),
                user_id: user.clone(),
                title: text(announcement, "title").to_owned(),
                body: announcement_preview(text(announcement, "body")),
                category: "weldhr".to_owned(),
                notification_type: "hr_announcement".to_owned(),
                entity_type: "hr_announcement".to_owned(),
                entity_id: id.clone(),
                action_url: format!("/weldhr/me/announcements?announcement={id}"),
                severity: "info".to_owned(),
                actor_type: Some("user".to_owned()),
                actor_id: Some(actor_id.to_owned()),
                exclude_email: true,
                data: vec![("announcementId".to_owned(), id.clone())],
                ..NewNotification::default()
            };
            if let Err(error) = create_and_deliver(db, notifier, &params).await {
                tracing::error!(%error, "[weldhr] announcement notification failed");
            }
        }
    }
    sqlx::query("update hr_announcements set notified_at = $2::timestamptz where id = $1")
        .bind(&id)
        .bind(now())
        .execute(db)
        .await?;
    Ok(recipients.len())
}

/// `meantFor(row, lineage)`.
fn meant_for(row: &Value, lineage: &HashSet<String>) -> bool {
    let ids = department_ids(row);
    ids.is_empty() || ids.iter().any(|id| lineage.contains(id))
}

/// `announcementsForEmployee(db, employeeId)`.
pub(crate) async fn announcements_for_employee(db: &PgPool, employee_id: &str) -> Result<Value, HrError> {
    let employee = require_employee(db, employee_id).await?;
    let lineage = department_lineage(db, employee["departmentId"].as_str()).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_announcements t where t.deleted_at is null
         order by t.published_at desc limit 200",
    )
    .fetch_all(db)
    .await?;
    let mut rows: Vec<Value> = rows
        .into_iter()
        .map(js_row)
        .filter(|row| meant_for(row, &lineage))
        .collect();
    sort_pinned_then_newest(&mut rows);
    let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let reads: Vec<(String, Value)> = if rows.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "select announcement_id, to_jsonb(read_at) from hr_announcement_reads
             where employee_id = $1 and announcement_id = any($2)",
        )
        .bind(employee_id)
        .bind(&ids)
        .fetch_all(db)
        .await?
    };
    let read_at: HashMap<String, Value> = reads
        .into_iter()
        .map(|(id, at)| (id, crate::js_time(&at)))
        .collect();
    let authors_of: Vec<Option<&str>> = rows.iter().map(|r| r["createdBy"].as_str()).collect();
    let authors = member_names(db, &authors_of).await?;
    let announcements: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "id": row["id"],
                "title": row["title"],
                "body": row["body"],
                "pinned": row["pinned"],
                "publishedAt": row["publishedAt"],
                "updatedAt": row["updatedAt"],
                "createdByName": row["createdBy"].as_str().filter(|b| !b.is_empty()).and_then(|b| authors.get(b).cloned()),
                "readAt": read_at.get(text(row, "id")).cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    let unread = announcements.iter().filter(|a| a["readAt"].is_null()).count();
    Ok(json!({ "announcements": announcements, "unread": unread }))
}

/// `unreadAnnouncementCount(db, employeeId)`.
pub(crate) async fn unread_announcement_count(db: &PgPool, employee_id: &str) -> Result<usize, HrError> {
    let employee = require_employee(db, employee_id).await?;
    let lineage = department_lineage(db, employee["departmentId"].as_str()).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('departmentIds', an.department_ids) from hr_announcements an
         left join hr_announcement_reads ar on ar.announcement_id = an.id and ar.employee_id = $1
         where an.deleted_at is null and ar.id is null
         limit 500",
    )
    .bind(employee_id)
    .fetch_all(db)
    .await?;
    Ok(rows.iter().filter(|row| meant_for(row, &lineage)).count())
}

/// `markAnnouncementRead(db, id, employeeId)`.
pub(crate) async fn mark_announcement_read(db: &PgPool, id: &str, employee_id: &str) -> Result<Value, HrError> {
    let row = require_announcement(db, id).await?;
    let employee = require_employee(db, employee_id).await?;
    let lineage = department_lineage(db, employee["departmentId"].as_str()).await?;
    if !meant_for(&row, &lineage) {
        return Err(HrError::not_found("Announcement", id));
    }
    sqlx::query(
        "insert into hr_announcement_reads (id, announcement_id, employee_id) values ($1, $2, $3)
         on conflict (announcement_id, employee_id) do nothing",
    )
    .bind(generate_id("hranr"))
    .bind(id)
    .bind(employee_id)
    .execute(db)
    .await?;
    let read: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(read_at) from hr_announcement_reads where announcement_id = $1 and employee_id = $2 limit 1",
    )
    .bind(id)
    .bind(employee_id)
    .fetch_optional(db)
    .await?;
    let read_at = read.map_or_else(|| json!(now()), |at| crate::js_time(&at));
    Ok(json!({ "id": id, "readAt": read_at }))
}
