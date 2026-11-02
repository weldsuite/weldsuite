//! `/api/team-members/user/:userId/*` (`app-api/src/routes/team-members/index.ts`,
//! `services/team/{profile,notes,common-concepts,activity}.ts`): a member's
//! profile (self or `team:update` edits), the viewer's private note on them,
//! what the viewer and the member share, and the member's activity feed (self
//! or `team:read`).
//!
//! Every route resolves the viewer's permissions first (`gate.resolve()`,
//! app-api's `app.use('/user/*', ensurePermissionsLoaded)`).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries, has_app_permission};

use super::{failed, take_page};
use crate::{Caller, CoreTeamState, TeamResult, answer, now, validate, validate_query};

pub(super) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/user/{user_id}/profile",
            get(profile)
                .patch(update_profile)
                .route_layer(gate.resolve()),
        )
        .route(
            "/user/{user_id}/notes",
            get(note)
                .put(save_note)
                .delete(delete_note)
                .route_layer(gate.resolve()),
        )
        .route(
            "/user/{user_id}/common",
            get(common).route_layer(gate.resolve()),
        )
        .route(
            "/user/{user_id}/activity",
            get(activity).route_layer(gate.resolve()),
        )
}

/// `hasAppPermission(perms, key, null)` on the resolved permissions.
fn holds(caller: &Caller, key: &str) -> bool {
    caller
        .permissions
        .as_ref()
        .is_some_and(|permissions| has_app_permission(permissions.resolved(), key, None))
}

// ── profile ─────────────────────────────────────────────────────────────────

/// `getMemberProfile`: the member row with their timezone and working hours.
async fn member_profile(
    db: &PgPool,
    subject: &str,
    viewer: &str,
    admin: bool,
) -> Result<Option<Value>, sqlx::Error> {
    let member: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(m) || jsonb_build_object('hours_per_week', m.hours_per_week::text)
         from workspace_members m where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(subject)
    .fetch_optional(db)
    .await?;
    let Some(member) = member.map(js_row) else {
        return Ok(None);
    };
    let prefs: Option<(String, Option<Value>)> = sqlx::query_as(
        "select timezone, working_hours from user_preferences where user_id = $1 limit 1",
    )
    .bind(subject)
    .fetch_optional(db)
    .await?;
    let field = |key: &str| member.get(key).cloned().unwrap_or(Value::Null);
    let (timezone, working_hours) = match prefs {
        Some((timezone, hours)) => (timezone, hours.unwrap_or(Value::Null)),
        None => ("UTC".to_owned(), Value::Null),
    };
    Ok(Some(json!({
        "id": field("id"),
        "userId": field("userId"),
        "name": field("name"),
        "email": field("email"),
        "picture": field("picture"),
        "role": field("role"),
        "status": field("status"),
        "title": field("title"),
        "bio": field("bio"),
        "phone": field("phone"),
        "location": field("location"),
        "pronouns": field("pronouns"),
        "links": field("links"),
        "hoursPerWeek": field("hoursPerWeek"),
        "workingHours": working_hours,
        "timezone": timezone,
        "canEdit": viewer == subject || admin,
    })))
}

async fn profile(caller: Caller, Path(subject): Path<String>) -> Response {
    answer(profile_inner(&caller, &subject).await)
}

async fn profile_inner(caller: &Caller, subject: &str) -> TeamResult<Response> {
    let admin = holds(caller, "team:update");
    let profile = member_profile(&caller.db, subject, &caller.user_id, admin)
        .await
        .map_err(failed("Failed to fetch profile"))?
        .ok_or_else(|| ApiError::not_found("Member", Some(subject)))?;
    Ok(Data(profile).into_response())
}

/// `updateMemberProfileInput` as read: a field left out is `Absent`.
struct ProfilePatch {
    title: Field<String>,
    bio: Field<String>,
    phone: Field<String>,
    location: Field<String>,
    pronouns: Field<String>,
    links: Field<Vec<Value>>,
    hours_per_week: Field<f64>,
    working_hours: Field<Value>,
    timezone: Field<String>,
}

fn read_link(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let label = issues.text_with(
        fields,
        "label",
        Presence::Required,
        Text::length(Some(1), Some(40)),
    );
    let url = issues.text_with(
        fields,
        "url",
        Presence::Required,
        Text {
            format: Some(Format::Url),
            max: Some(500),
            ..Text::default()
        },
    );
    match (label, url) {
        (Field::Set(label), Field::Set(url)) => Some(json!({ "label": label, "url": url })),
        _ => None,
    }
}

fn read_patch(issues: &mut Issues, fields: &Map<String, Value>) -> ProfilePatch {
    let nullable = |issues: &mut Issues, key: &str, max: usize| {
        issues.text(fields, key, Presence::Nullish, None, Some(max))
    };
    ProfilePatch {
        title: nullable(issues, "title", 120),
        bio: nullable(issues, "bio", 4000),
        phone: nullable(issues, "phone", 40),
        location: nullable(issues, "location", 120),
        pronouns: nullable(issues, "pronouns", 40),
        links: issues.list(
            fields,
            "links",
            Presence::Nullish,
            None,
            Some(10),
            read_link,
        ),
        hours_per_week: issues.number(
            fields,
            "hoursPerWeek",
            Presence::Nullish,
            Number {
                min: Some(0.0),
                max: Some(168.0),
                ..Number::default()
            },
        ),
        working_hours: issues.nested(fields, "workingHours", Presence::Nullish, |_, map| {
            Value::Object(map.clone())
        }),
        timezone: issues.text(fields, "timezone", Presence::Optional, None, Some(100)),
    }
}

/// `String(n)` for the `numeric` column (which reads it back with its scale).
fn number_text(n: f64) -> String {
    #[allow(clippy::cast_possible_truncation)]
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

async fn update_profile(
    caller: Caller,
    Path(subject): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(update_profile_inner(&caller, &subject, &headers, &body).await)
}

async fn update_profile_inner(
    caller: &Caller,
    subject: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let patch = validate(headers, body, read_patch)?;
    let admin = holds(caller, "team:update");
    if caller.user_id != subject && !admin {
        return Err(ApiError::forbidden().into());
    }
    let message = "Failed to update profile";
    save_profile(&caller.db, subject, &patch)
        .await
        .map_err(failed(message))?;
    let profile = member_profile(&caller.db, subject, &caller.user_id, admin)
        .await
        .map_err(failed(message))?
        .ok_or_else(|| ApiError::not_found("Member", Some(subject)))?;
    Ok(Data(profile).into_response())
}

/// The member columns, then the preferences (updated, or inserted when the
/// subject has none), as `updateMemberProfile` writes them.
async fn save_profile(db: &PgPool, subject: &str, patch: &ProfilePatch) -> Result<(), sqlx::Error> {
    let now = now();
    let present = |field: &Field<String>| !field.is_absent();
    let text = |field: &Field<String>| field.as_set().cloned();
    let touches_member = [
        &patch.title,
        &patch.bio,
        &patch.phone,
        &patch.location,
        &patch.pronouns,
    ]
    .into_iter()
    .any(present)
        || !patch.links.is_absent()
        || !patch.hours_per_week.is_absent();
    if touches_member {
        sqlx::query(
            "update workspace_members set
                 title = case when $2 then $3 else title end,
                 bio = case when $4 then $5 else bio end,
                 phone = case when $6 then $7 else phone end,
                 location = case when $8 then $9 else location end,
                 pronouns = case when $10 then $11 else pronouns end,
                 links = case when $12 then $13::jsonb else links end,
                 hours_per_week = case when $14 then $15::numeric else hours_per_week end,
                 updated_at = $16::timestamptz
             where user_id = $1 and deleted_at is null",
        )
        .bind(subject)
        .bind(present(&patch.title))
        .bind(text(&patch.title))
        .bind(present(&patch.bio))
        .bind(text(&patch.bio))
        .bind(present(&patch.phone))
        .bind(text(&patch.phone))
        .bind(present(&patch.location))
        .bind(text(&patch.location))
        .bind(present(&patch.pronouns))
        .bind(text(&patch.pronouns))
        .bind(!patch.links.is_absent())
        .bind(
            patch
                .links
                .as_set()
                .map(|links| Value::Array(links.clone())),
        )
        .bind(!patch.hours_per_week.is_absent())
        .bind(patch.hours_per_week.as_set().map(|n| number_text(*n)))
        .bind(&now)
        .execute(db)
        .await?;
    }
    save_preferences(db, subject, patch, &now).await
}

/// The subject's timezone and working hours: their preferences row updated,
/// or inserted when they have none.
async fn save_preferences(
    db: &PgPool,
    subject: &str,
    patch: &ProfilePatch,
    now: &str,
) -> Result<(), sqlx::Error> {
    // `timezone` only when set to something; `workingHours` whenever sent.
    let timezone = patch.timezone.as_set().filter(|tz| !tz.is_empty()).cloned();
    let set_hours = !patch.working_hours.is_absent();
    let hours = patch
        .working_hours
        .as_set()
        .filter(|value| !value.is_null())
        .cloned();
    if timezone.is_none() && !set_hours {
        return Ok(());
    }
    let existing: Option<String> =
        sqlx::query_scalar("select id from user_preferences where user_id = $1 limit 1")
            .bind(subject)
            .fetch_optional(db)
            .await?;
    if existing.is_some() {
        sqlx::query(
            "update user_preferences set
                 timezone = coalesce($2, timezone),
                 working_hours = case when $3 then $4::jsonb else working_hours end,
                 updated_at = $5::timestamptz
             where user_id = $1",
        )
        .bind(subject)
        .bind(timezone)
        .bind(set_hours)
        .bind(hours)
        .bind(now)
        .execute(db)
        .await?;
    } else if let Some(timezone) = timezone {
        sqlx::query(
            "insert into user_preferences (id, user_id, timezone, working_hours, updated_at)
             values ($1, $2, $3, $4::jsonb, $5::timestamptz)",
        )
        .bind(generate_id("upref"))
        .bind(subject)
        .bind(timezone)
        .bind(hours)
        .bind(now)
        .execute(db)
        .await?;
    } else {
        // No timezone in the patch: the column keeps its default.
        sqlx::query(
            "insert into user_preferences (id, user_id, working_hours, updated_at)
             values ($1, $2, $3::jsonb, $4::timestamptz)",
        )
        .bind(generate_id("upref"))
        .bind(subject)
        .bind(hours)
        .bind(now)
        .execute(db)
        .await?;
    }
    Ok(())
}

// ── notes ───────────────────────────────────────────────────────────────────

/// `toApi(row)`: the note as the client sees it.
fn note_view(row: Value) -> Value {
    let row = js_row(row);
    json!({
        "id": row["id"],
        "authorUserId": row["authorUserId"],
        "subjectUserId": row["subjectUserId"],
        "body": row["body"].as_str().unwrap_or_default(),
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    })
}

async fn note(caller: Caller, Path(subject): Path<String>) -> Response {
    answer(note_inner(&caller, &subject).await)
}

async fn note_inner(caller: &Caller, subject: &str) -> TeamResult<Response> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(n) from member_notes n
         where author_user_id = $1 and subject_user_id = $2 limit 1",
    )
    .bind(&caller.user_id)
    .bind(subject)
    .fetch_optional(&caller.db)
    .await
    .map_err(failed("Failed to fetch note"))?;
    Ok(Data(row.map_or(Value::Null, note_view)).into_response())
}

async fn save_note(
    caller: Caller,
    Path(subject): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(save_note_inner(&caller, &subject, &headers, &body).await)
}

async fn save_note_inner(
    caller: &Caller,
    subject: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let text = validate(headers, body, |issues, fields| {
        issues.string(fields, "body", true, None, Some(20000))
    })?
    .unwrap_or_default();
    let row = upsert_note(&caller.db, &caller.user_id, subject, &text)
        .await
        .map_err(failed("Failed to save note"))?;
    Ok(Data(note_view(row)).into_response())
}

async fn upsert_note(
    db: &PgPool,
    author: &str,
    subject: &str,
    body: &str,
) -> Result<Value, sqlx::Error> {
    let now = now();
    let existing: Option<String> = sqlx::query_scalar(
        "select id from member_notes where author_user_id = $1 and subject_user_id = $2 limit 1",
    )
    .bind(author)
    .bind(subject)
    .fetch_optional(db)
    .await?;
    if let Some(id) = existing {
        return sqlx::query_scalar(
            "update member_notes set body = $2, updated_at = $3::timestamptz
             where id = $1 returning to_jsonb(member_notes)",
        )
        .bind(id)
        .bind(body)
        .bind(&now)
        .fetch_one(db)
        .await;
    }
    sqlx::query_scalar(
        "insert into member_notes (id, author_user_id, subject_user_id, body, created_at, updated_at)
         values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz)
         returning to_jsonb(member_notes)",
    )
    .bind(generate_id("mnote"))
    .bind(author)
    .bind(subject)
    .bind(body)
    .bind(&now)
    .fetch_one(db)
    .await
}

async fn delete_note(caller: Caller, Path(subject): Path<String>) -> Response {
    let result =
        sqlx::query("delete from member_notes where author_user_id = $1 and subject_user_id = $2")
            .bind(&caller.user_id)
            .bind(&subject)
            .execute(&caller.db)
            .await;
    answer(
        result
            .map(|_| NoContent.into_response())
            .map_err(failed("Failed to delete note")),
    )
}

// ── common ──────────────────────────────────────────────────────────────────

const PER_CATEGORY_LIMIT: i64 = 20;
const CATEGORIES: [&str; 5] = ["channels", "projects", "tasks", "crm", "helpdesk"];

async fn common(
    caller: Caller,
    Path(subject): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    answer(common_inner(&caller, &subject, query.as_deref()).await)
}

async fn common_inner(caller: &Caller, subject: &str, query: Option<&str>) -> TeamResult<Response> {
    let categories = validate_query(query, |issues, values| {
        issues.text(values, "categories", Presence::Optional, None, None)
    })?;
    // `v ? v.split(',').filter(Boolean) : every category`.
    let wanted: Vec<String> = match categories.as_set().filter(|v| !v.is_empty()) {
        Some(list) => list
            .split(',')
            .filter(|c| !c.is_empty())
            .map(str::to_owned)
            .collect(),
        None => CATEGORIES.iter().map(|c| (*c).to_owned()).collect(),
    };
    let viewer = caller.user_id.as_str();
    let empty = || Ok::<_, sqlx::Error>(Vec::<Value>::new());
    if viewer == subject {
        return Ok(Data(json!({
            "channels": [], "projects": [], "tasks": [], "crm": [], "helpdesk": [],
        }))
        .into_response());
    }
    let wants = |category: &str| wanted.iter().any(|c| c == category);
    let db = &caller.db;
    let message = "Failed to fetch common concepts";
    let channels = if wants("channels") {
        common_channels(db, viewer, subject).await
    } else {
        empty()
    }
    .map_err(failed(message))?;
    let projects = if wants("projects") {
        common_projects(db, viewer, subject).await
    } else {
        empty()
    }
    .map_err(failed(message))?;
    let tasks = if wants("tasks") {
        common_tasks(db, viewer, subject).await
    } else {
        empty()
    }
    .map_err(failed(message))?;
    let crm = if wants("crm") {
        common_crm(db, viewer, subject).await
    } else {
        empty()
    }
    .map_err(failed(message))?;
    let helpdesk = if wants("helpdesk") {
        common_helpdesk(db, viewer, subject).await
    } else {
        empty()
    }
    .map_err(failed(message))?;
    Ok(Data(json!({
        "channels": channels,
        "projects": projects,
        "tasks": tasks,
        "crm": crm,
        "helpdesk": helpdesk,
    }))
    .into_response())
}

async fn rows(db: &PgPool, sql: &'static str, binds: &[&str]) -> Result<Vec<Value>, sqlx::Error> {
    let mut query = sqlx::query_scalar::<_, Value>(sql);
    for bind in binds {
        query = query.bind(*bind);
    }
    query = query.bind(PER_CATEGORY_LIMIT);
    Ok(query.fetch_all(db).await?.into_iter().map(js_row).collect())
}

async fn common_channels(
    db: &PgPool,
    viewer: &str,
    subject: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let found = rows(
        db,
        "select jsonb_build_object('id', c.id, 'name', c.name, 'type', c.type,
                                   'memberCount', coalesce(c.member_count, 0))
         from chat_channels c
         join chat_channel_members m on m.channel_id = c.id
         where c.deleted_at is null and c.is_archived = false and m.user_id in ($1, $2)
         group by c.id, c.name, c.type, c.member_count
         having count(distinct m.user_id) = 2
         order by c.last_message_at desc
         limit $3",
        &[viewer, subject],
    )
    .await?;
    Ok(found)
}

async fn common_projects(
    db: &PgPool,
    viewer: &str,
    subject: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    rows(
        db,
        "select jsonb_build_object('id', p.id, 'name', p.name, 'status', p.status, 'color', p.color)
         from projects p
         join project_members m on m.project_id = p.id
         where p.deleted_at is null and p.is_active = true and m.user_id in ($1, $2)
         group by p.id, p.name, p.status, p.color
         having count(distinct m.user_id) = 2
         order by p.updated_at desc
         limit $3",
        &[viewer, subject],
    )
    .await
}

async fn common_tasks(db: &PgPool, viewer: &str, subject: &str) -> Result<Vec<Value>, sqlx::Error> {
    let found = rows(
        db,
        "select jsonb_build_object('id', id, 'title', title, 'status', status,
                                   'projectId', project_id, 'dueDate', due_date,
                                   'assigneeId', assignee_id, 'reporterId', reporter_id)
         from tasks
         where deleted_at is null
           and (assignee_id = $1 or reporter_id = $1
                or assignee_ids @> jsonb_build_array($1::text)
                or watchers @> jsonb_build_array($1::text))
           and (assignee_id = $2 or reporter_id = $2
                or assignee_ids @> jsonb_build_array($2::text)
                or watchers @> jsonb_build_array($2::text))
         order by updated_at desc
         limit $3",
        &[viewer, subject],
    )
    .await?;
    Ok(found
        .into_iter()
        .map(|task| {
            let assignee = task["assigneeId"].as_str();
            let reporter = task["reporterId"].as_str();
            let role = if (assignee == Some(viewer) && reporter == Some(subject))
                || (assignee == Some(subject) && reporter == Some(viewer))
            {
                "delegated"
            } else if assignee == Some(viewer) || assignee == Some(subject) {
                "shared_assignee"
            } else {
                "shared_watcher"
            };
            json!({
                "id": task["id"],
                "title": task["title"],
                "status": task["status"],
                "projectId": task["projectId"],
                "dueDate": task["dueDate"],
                "role": role,
            })
        })
        .collect())
}

async fn common_crm(db: &PgPool, viewer: &str, subject: &str) -> Result<Vec<Value>, sqlx::Error> {
    let opportunities = rows(
        db,
        "select jsonb_build_object('id', id, 'kind', 'opportunity', 'name', name, 'status', status)
         from crm_opportunities
         where deleted_at is null
           and team_members @> jsonb_build_array($1::text)
           and team_members @> jsonb_build_array($2::text)
         order by updated_at desc
         limit $3",
        &[viewer, subject],
    )
    .await?;
    let activities = rows(
        db,
        "select jsonb_build_object('id', id, 'kind', 'activity', 'name', subject, 'status', status)
         from crm_activities
         where deleted_at is null
           and attendees @> jsonb_build_array($1::text)
           and attendees @> jsonb_build_array($2::text)
         order by updated_at desc
         limit $3",
        &[viewer, subject],
    )
    .await?;
    let mut merged: Vec<Value> = opportunities.into_iter().chain(activities).collect();
    merged.truncate(usize::try_from(PER_CATEGORY_LIMIT).unwrap_or(20));
    Ok(merged)
}

async fn common_helpdesk(
    db: &PgPool,
    viewer: &str,
    subject: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    rows(
        db,
        "select jsonb_build_object('id', c.id, 'kind', 'conversation', 'subject', c.subject,
                                   'status', c.status)
         from helpdesk_conversations c
         where c.deleted_at is null
           and (c.assignee_id = $1 or c.assignee_id = $2)
           and exists (
             select 1 from helpdesk_conversation_events e
             where e.conversation_id = c.id and e.actor_id in ($1, $2)
             group by e.conversation_id
             having count(distinct e.actor_id) = 2)
         order by c.updated_at desc
         limit $3",
        &[viewer, subject],
    )
    .await
}

// ── activity ────────────────────────────────────────────────────────────────

async fn activity(
    caller: Caller,
    Path(subject): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    answer(activity_inner(&caller, &subject, query.as_deref()).await)
}

async fn activity_inner(
    caller: &Caller,
    subject: &str,
    query: Option<&str>,
) -> TeamResult<Response> {
    let (cursor, limit) = validate_query(query, |issues, values| {
        let cursor = issues.text(values, "cursor", Presence::Optional, None, None);
        let limit = issues.number(
            values,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                min: Some(1.0),
                max: Some(100.0),
                ..Number::default()
            },
        );
        (cursor.into_option(), limit.into_option().unwrap_or(25.0))
    })?;
    if caller.user_id != subject && !holds(caller, "team:read") {
        return Err(ApiError::forbidden().into());
    }
    let page = member_activity(&caller.db, subject, cursor.as_deref(), limit)
        .await
        .map_err(failed("Failed to fetch activity"))?;
    Ok(List::new(page.0, page.1).into_response())
}

/// `listMemberActivity`, the keyset cursor and its count quirk included.
async fn member_activity(
    db: &PgPool,
    performed_by: &str,
    cursor: Option<&str>,
    limit: f64,
) -> Result<(Vec<Value>, Pagination), sqlx::Error> {
    let cursor = cursor.filter(|c| !c.is_empty());
    let keyset: Option<(String, String)> = match cursor {
        Some(cursor) => {
            sqlx::query_as(
                "select date_trunc('milliseconds', created_at)::text, id
                 from audit_logs where id = $1 limit 1",
            )
            .bind(cursor)
            .fetch_optional(db)
            .await?
        }
        None => None,
    };
    let limit = limit.min(100.0);
    #[allow(clippy::cast_possible_truncation)]
    let fetch = (limit + 1.0).round() as i64;
    let found: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'action', action, 'entityType', entity_type,
                                   'entityId', entity_id, 'description', description,
                                   'createdAt', created_at, 'changes', changes)
         from audit_logs
         where performed_by = $1
           and ($2::timestamp is null or created_at < $2::timestamp
                or (created_at = $2::timestamp and id < $3))
         order by created_at desc, id desc
         limit $4",
    )
    .bind(performed_by)
    .bind(keyset.as_ref().map(|(at, _)| at.as_str()))
    .bind(keyset.as_ref().map(|(_, id)| id.as_str()))
    .bind(fetch)
    .fetch_all(db)
    .await?;
    // A cursor that matched nothing drops the only filter from the count.
    let count_by = if cursor.is_some() && keyset.is_none() {
        None
    } else {
        Some(performed_by)
    };
    let total: i32 = sqlx::query_scalar(
        "select count(*)::int from audit_logs where ($1::text is null or performed_by = $1)",
    )
    .bind(count_by)
    .fetch_one(db)
    .await?;
    let mut found: Vec<Value> = found.into_iter().map(js_row).collect();
    #[allow(clippy::cast_possible_truncation)]
    let keep = limit.trunc() as i64;
    #[allow(clippy::cast_precision_loss)]
    let has_more = found.len() as f64 > limit;
    let (data, _) = take_page(&mut found, keep);
    let next = if has_more {
        data.last()
            .and_then(|row| row["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    Ok((
        data,
        Pagination::new(u64::try_from(total).unwrap_or(0), has_more, next),
    ))
}
