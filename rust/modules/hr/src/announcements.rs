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
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, EntityTrait, JoinType, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    HR_ANNOUNCEMENT_CREATED, HR_ANNOUNCEMENT_DELETED, HR_ANNOUNCEMENT_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    ANNOUNCEMENTS_CREATE, ANNOUNCEMENTS_DELETE, ANNOUNCEMENTS_READ, ANNOUNCEMENTS_UPDATE,
};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_notifications::{NewNotification, create_and_deliver};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    hr_announcement_reads as reads, hr_announcements as announcements, hr_departments,
};

use crate::departments::{department_lineage, employees_in_departments};
use crate::employees::{display_name_of, no_row, require_employee, to_json};
use crate::fields::{Fields, short_text};
use crate::{
    Caller, HrError, HrResult, HrState, hr_json, js_trim, locale_compare, member_names, now, text,
};

/// A `timestamptz` read as Drizzle hands a `Date` to `JSON.stringify`.
fn js_timestamptz(at: OffsetDateTime) -> Value {
    weldsuite_schema::js::timestamptz::serialize(&at, serde_json::value::Serializer)
        .unwrap_or(Value::Null)
}

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
        .route(
            "/announcements",
            post(create).route_layer(gate.require([ANNOUNCEMENTS_CREATE])),
        )
        .route(
            "/announcements/{id}",
            patch(update).route_layer(gate.require([ANNOUNCEMENTS_UPDATE])),
        )
        .route(
            "/announcements/{id}",
            delete(remove).route_layer(gate.require([ANNOUNCEMENTS_DELETE])),
        )
        .route("/announcements/{id}/reads", get(reads).route_layer(read()))
}

/// `requireAnnouncement(db, id)`.
async fn require_announcement(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row = announcements::Entity::find()
        .filter(announcements::Column::Id.eq(id))
        .filter(announcements::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    to_json(row.ok_or_else(|| HrError::not_found("Announcement", id))?)
}

fn department_ids(row: &Value) -> Vec<String> {
    row["departmentIds"]
        .as_array()
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect()
        })
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
    let rows = announcements::Entity::find()
        .filter(announcements::Column::DeletedAt.is_null())
        .order_by_desc(announcements::Column::PublishedAt)
        .limit(500)
        .all(&orm(db))
        .await?;
    let mut rows: Vec<Value> = rows.into_iter().map(to_json).collect::<Result<_, _>>()?;
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
        audiences.insert(
            key,
            employees.iter().map(|e| text(e, "id").to_owned()).collect(),
        );
    }
    let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let reads: Vec<(String, String)> = reads::Entity::find()
        .select_only()
        .columns([reads::Column::AnnouncementId, reads::Column::EmployeeId])
        .filter(reads::Column::AnnouncementId.is_in(ids.iter().map(String::as_str)))
        .into_tuple()
        .all(&orm(db))
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
        hr_departments::Entity::find()
            .select_only()
            .columns([hr_departments::Column::Id, hr_departments::Column::Name])
            .filter(hr_departments::Column::Id.is_in(all_departments.iter().map(String::as_str)))
            .into_tuple::<(String, String)>()
            .all(&orm(db))
            .await?
            .into_iter()
            .collect()
    };
    let authors_of: Vec<Option<&str>> = rows.iter().map(|r| r["createdBy"].as_str()).collect();
    let authors = member_names(db, &authors_of).await?;
    Ok(rows
        .into_iter()
        .map(|mut row| {
            let audience = audiences
                .get(&audience_key(&row))
                .cloned()
                .unwrap_or_default();
            let id = text(&row, "id").to_owned();
            let read_count = reads
                .iter()
                .filter(|(announcement, employee)| {
                    *announcement == id && audience.contains(employee)
                })
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
    let found = hr_departments::Entity::find()
        .filter(hr_departments::Column::Id.is_in(ids.iter().map(String::as_str)))
        .filter(hr_departments::Column::DeletedAt.is_null())
        .count(&orm(db))
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
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    AnnouncementInput {
        title: short_text(issues, fields, "title", required, 200, true),
        body: issues.text_with(
            fields,
            "body",
            required,
            Text::trimmed(Some(1), Some(20000)),
        ),
        pinned: issues.boolean(fields, "pinned", Presence::Optional),
        department_ids: issues.list(
            fields,
            "departmentIds",
            Presence::Optional,
            None,
            Some(100),
            |issues, item| issues.item_text(item, Text::length(Some(1), Some(30))),
        ),
        notify: if partial {
            Field::Absent
        } else {
            issues.boolean(fields, "notify", Presence::Optional)
        },
    }
}

async fn create(
    State(state): State<HrState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        announcement_input(issues, fields, false)
    })?;
    let db = &caller.db;
    let departments = dedupe(input.department_ids.into_option().unwrap_or_default());
    assert_departments(db, &departments).await?;
    let row = announcements::Entity::insert(announcements::ActiveModel {
        id: Set(generate_id("hrann")),
        title: Set(input
            .title
            .as_set()
            .map(|t| js_trim(t).to_owned())
            .unwrap_or_default()),
        body: Set(input
            .body
            .as_set()
            .map(|b| js_trim(b).to_owned())
            .unwrap_or_default()),
        pinned: Set(input.pinned.as_set().copied().unwrap_or(false)),
        department_ids: Set(json!(departments)),
        created_by: Set(Some(caller.user_id.clone())),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    let row = to_json(row)?;
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
            if let Err(error) =
                notify_announcement(&db, &notifier, &workspace, &announcement, &actor).await
            {
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
    let input = hr_json(&headers, &body, |issues, fields| {
        announcement_input(issues, fields, true)
    })?;
    let db = &caller.db;
    require_announcement(db, &id).await?;
    let departments = input.department_ids.into_option().map(dedupe);
    if let Some(departments) = &departments {
        assert_departments(db, departments).await?;
    }
    // `coalesce($n, column)`: only what the body sent changes.
    let mut update = announcements::Entity::update_many();
    if let Some(title) = input.title.as_set() {
        update = update.col_expr(announcements::Column::Title, Expr::value(js_trim(title)));
    }
    if let Some(body) = input.body.as_set() {
        update = update.col_expr(announcements::Column::Body, Expr::value(js_trim(body)));
    }
    if let Some(pinned) = input.pinned.as_set() {
        update = update.col_expr(announcements::Column::Pinned, Expr::value(*pinned));
    }
    if let Some(departments) = departments {
        update = update.col_expr(
            announcements::Column::DepartmentIds,
            Expr::value(json!(departments)),
        );
    }
    let row = update
        .col_expr(announcements::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(announcements::Column::Id.eq(id.as_str()))
        .exec_with_returning(&orm(db))
        .await?
        .pop()
        .ok_or_else(|| no_row("hr_announcements"))?;
    let row = to_json(row)?;
    caller.emit(&state, HR_ANNOUNCEMENT_UPDATED, text(&row, "id"), &[]);
    Ok(Data(announcement_with_details(db, &id).await?).into_response())
}

async fn remove(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    require_announcement(&caller.db, &id).await?;
    let now = utc_now();
    announcements::Entity::update_many()
        .col_expr(announcements::Column::DeletedAt, Expr::value(now))
        .col_expr(announcements::Column::UpdatedAt, Expr::value(now))
        .filter(announcements::Column::Id.eq(id.as_str()))
        .exec(&orm(&caller.db))
        .await?;
    caller.emit(&state, HR_ANNOUNCEMENT_DELETED, &id, &[]);
    Ok(NoContent.into_response())
}

async fn reads(caller: Caller, Path(id): Path<String>) -> HrResult {
    let db = &caller.db;
    let row = require_announcement(db, &id).await?;
    let audience = employees_in_departments(db, &department_ids(&row)).await?;
    let reads: Vec<(String, OffsetDateTime)> = reads::Entity::find()
        .select_only()
        .columns([reads::Column::EmployeeId, reads::Column::ReadAt])
        .filter(reads::Column::AnnouncementId.eq(id.as_str()))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let read_at: HashMap<String, Value> = reads
        .into_iter()
        .map(|(employee, at)| (employee, js_timestamptz(at)))
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
    announcements::Entity::update_many()
        .col_expr(
            announcements::Column::NotifiedAt,
            Expr::value(utc_now().assume_utc()),
        )
        .filter(announcements::Column::Id.eq(id.as_str()))
        .exec(&orm(db))
        .await?;
    Ok(recipients.len())
}

/// `meantFor(row, lineage)`.
fn meant_for(row: &Value, lineage: &HashSet<String>) -> bool {
    let ids = department_ids(row);
    ids.is_empty() || ids.iter().any(|id| lineage.contains(id))
}

/// `announcementsForEmployee(db, employeeId)`.
pub(crate) async fn announcements_for_employee(
    db: &PgPool,
    employee_id: &str,
) -> Result<Value, HrError> {
    let employee = require_employee(db, employee_id).await?;
    let lineage = department_lineage(db, employee["departmentId"].as_str()).await?;
    let rows = announcements::Entity::find()
        .filter(announcements::Column::DeletedAt.is_null())
        .order_by_desc(announcements::Column::PublishedAt)
        .limit(200)
        .all(&orm(db))
        .await?;
    let mut rows: Vec<Value> = rows
        .into_iter()
        .map(to_json)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|row| meant_for(row, &lineage))
        .collect();
    sort_pinned_then_newest(&mut rows);
    let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let reads: Vec<(String, OffsetDateTime)> = if rows.is_empty() {
        Vec::new()
    } else {
        reads::Entity::find()
            .select_only()
            .columns([reads::Column::AnnouncementId, reads::Column::ReadAt])
            .filter(reads::Column::EmployeeId.eq(employee_id))
            .filter(reads::Column::AnnouncementId.is_in(ids.iter().map(String::as_str)))
            .into_tuple()
            .all(&orm(db))
            .await?
    };
    let read_at: HashMap<String, Value> = reads
        .into_iter()
        .map(|(id, at)| (id, js_timestamptz(at)))
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
    let unread = announcements
        .iter()
        .filter(|a| a["readAt"].is_null())
        .count();
    Ok(json!({ "announcements": announcements, "unread": unread }))
}

/// `unreadAnnouncementCount(db, employeeId)`.
pub(crate) async fn unread_announcement_count(
    db: &PgPool,
    employee_id: &str,
) -> Result<usize, HrError> {
    let employee = require_employee(db, employee_id).await?;
    let lineage = department_lineage(db, employee["departmentId"].as_str()).await?;
    let employee = employee_id.to_owned();
    let rows: Vec<Value> = announcements::Entity::find()
        .select_only()
        .column(announcements::Column::DepartmentIds)
        .join(
            JoinType::LeftJoin,
            announcements::Entity::belongs_to(reads::Entity)
                .from(announcements::Column::Id)
                .to(reads::Column::AnnouncementId)
                .on_condition(move |_, read| {
                    sea_orm::ExprTrait::eq(
                        Expr::col((read, reads::Column::EmployeeId)),
                        employee.as_str(),
                    )
                    .into()
                })
                .into(),
        )
        .filter(announcements::Column::DeletedAt.is_null())
        .filter(reads::Column::Id.is_null())
        .limit(500)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .filter(|ids| meant_for(&json!({ "departmentIds": ids }), &lineage))
        .count())
}

/// `markAnnouncementRead(db, id, employeeId)`.
pub(crate) async fn mark_announcement_read(
    db: &PgPool,
    id: &str,
    employee_id: &str,
) -> Result<Value, HrError> {
    let row = require_announcement(db, id).await?;
    let employee = require_employee(db, employee_id).await?;
    let lineage = department_lineage(db, employee["departmentId"].as_str()).await?;
    if !meant_for(&row, &lineage) {
        return Err(HrError::not_found("Announcement", id));
    }
    let db = &orm(db);
    reads::Entity::insert(reads::ActiveModel {
        id: Set(generate_id("hranr")),
        announcement_id: Set(id.to_owned()),
        employee_id: Set(employee_id.to_owned()),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::columns([reads::Column::AnnouncementId, reads::Column::EmployeeId])
            .do_nothing()
            .to_owned(),
    )
    .exec_without_returning(db)
    .await?;
    let read: Option<OffsetDateTime> = reads::Entity::find()
        .select_only()
        .column(reads::Column::ReadAt)
        .filter(reads::Column::AnnouncementId.eq(id))
        .filter(reads::Column::EmployeeId.eq(employee_id))
        .into_tuple()
        .one(db)
        .await?;
    let read_at = read.map_or_else(|| json!(now()), js_timestamptz);
    Ok(json!({ "id": id, "readAt": read_at }))
}
