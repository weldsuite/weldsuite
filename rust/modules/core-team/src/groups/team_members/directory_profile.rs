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
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, QueryTrait, RelationDef,
};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries, has_app_permission};
use weldsuite_schema::tenant::{
    audit_logs, chat_channel_members as channel_members, chat_channels, crm_activities,
    crm_opportunities, helpdesk_conversation_events as conversation_events,
    helpdesk_conversations as conversations, member_notes, project_members, projects, tasks,
    user_preferences, workspace_members as members,
};

use super::{failed, take_page};
use crate::access::js;
use crate::{Caller, CoreTeamState, TeamResult, answer, validate, validate_query};

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

/// What the profile reads of the member row, `hours_per_week` as its
/// `::text` (the column's own scale).
#[derive(Debug, FromQueryResult, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileRow {
    id: String,
    user_id: String,
    name: Option<String>,
    email: Option<String>,
    role: String,
    status: String,
    title: Option<String>,
    bio: Option<String>,
    phone: Option<String>,
    location: Option<String>,
    pronouns: Option<String>,
    links: Option<Value>,
    hours_per_week: Option<String>,
}

/// `getMemberProfile`: the member row with their timezone and working hours.
/// `picture` is the account picture (`master`), not the member row's copy.
async fn member_profile(
    db: &PgPool,
    master: Option<&PgPool>,
    subject: &str,
    viewer: &str,
    admin: bool,
) -> Result<Option<Value>, DbErr> {
    let orm = orm(db);
    let member = members::Entity::find()
        .select_only()
        .columns([
            members::Column::Id,
            members::Column::UserId,
            members::Column::Name,
            members::Column::Email,
            members::Column::Role,
            members::Column::Status,
            members::Column::Title,
            members::Column::Bio,
            members::Column::Phone,
            members::Column::Location,
            members::Column::Pronouns,
            members::Column::Links,
        ])
        .column_as(
            sea_orm::ExprTrait::cast_as(Expr::col(members::Column::HoursPerWeek), "text"),
            "hours_per_week",
        )
        .filter(members::Column::UserId.eq(subject))
        .filter(members::Column::DeletedAt.is_null())
        .into_model::<ProfileRow>()
        .one(&orm)
        .await?;
    let Some(member) = member.map(js).transpose()? else {
        return Ok(None);
    };
    let prefs: Option<(String, Option<Value>)> = user_preferences::Entity::find()
        .select_only()
        .columns([
            user_preferences::Column::Timezone,
            user_preferences::Column::WorkingHours,
        ])
        .filter(user_preferences::Column::UserId.eq(subject))
        .into_tuple()
        .one(&orm)
        .await?;
    let field = |key: &str| member.get(key).cloned().unwrap_or(Value::Null);
    let picture = weldsuite_db::AccountPictures::load(master, member["userId"].as_str())
        .await
        .value(member["userId"].as_str());
    let (timezone, working_hours) = match prefs {
        Some((timezone, hours)) => (timezone, hours.unwrap_or(Value::Null)),
        None => ("UTC".to_owned(), Value::Null),
    };
    Ok(Some(json!({
        "id": field("id"),
        "userId": field("userId"),
        "name": field("name"),
        "email": field("email"),
        "picture": picture,
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
    let profile = member_profile(
        &caller.db,
        caller.request_master(),
        subject,
        &caller.user_id,
        admin,
    )
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
    let profile = member_profile(
        &caller.db,
        caller.request_master(),
        subject,
        &caller.user_id,
        admin,
    )
    .await
    .map_err(failed(message))?
    .ok_or_else(|| ApiError::not_found("Member", Some(subject)))?;
    Ok(Data(profile).into_response())
}

/// The member columns, then the preferences (updated, or inserted when the
/// subject has none), as `updateMemberProfile` writes them.
async fn save_profile(db: &PgPool, subject: &str, patch: &ProfilePatch) -> Result<(), DbErr> {
    let now = utc_now().assume_utc();
    let texts = [
        (members::Column::Title, &patch.title),
        (members::Column::Bio, &patch.bio),
        (members::Column::Phone, &patch.phone),
        (members::Column::Location, &patch.location),
        (members::Column::Pronouns, &patch.pronouns),
    ];
    let touches_member = texts.iter().any(|(_, field)| !field.is_absent())
        || !patch.links.is_absent()
        || !patch.hours_per_week.is_absent();
    if touches_member {
        // `case when $sent then $value else column end`: only what was sent.
        let mut write = members::Entity::update_many();
        for (column, field) in texts {
            if !field.is_absent() {
                write = write.col_expr(column, Expr::value(field.as_set().cloned()));
            }
        }
        if !patch.links.is_absent() {
            let links = patch
                .links
                .as_set()
                .map(|links| Value::Array(links.clone()));
            write = write.col_expr(members::Column::Links, Expr::value(links));
        }
        if !patch.hours_per_week.is_absent() {
            let hours = patch.hours_per_week.as_set().map(|n| number_text(*n));
            write = write.col_expr(
                members::Column::HoursPerWeek,
                sea_orm::ExprTrait::cast_as(Expr::value(hours), "numeric"),
            );
        }
        write
            .col_expr(members::Column::UpdatedAt, Expr::value(now))
            .filter(members::Column::UserId.eq(subject))
            .filter(members::Column::DeletedAt.is_null())
            .exec(&orm(db))
            .await?;
    }
    save_preferences(db, subject, patch, now).await
}

/// The subject's timezone and working hours: their preferences row updated,
/// or inserted when they have none.
async fn save_preferences(
    db: &PgPool,
    subject: &str,
    patch: &ProfilePatch,
    now: OffsetDateTime,
) -> Result<(), DbErr> {
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
    let db = orm(db);
    let existing: Option<String> = user_preferences::Entity::find()
        .select_only()
        .column(user_preferences::Column::Id)
        .filter(user_preferences::Column::UserId.eq(subject))
        .into_tuple()
        .one(&db)
        .await?;
    if existing.is_some() {
        let mut write = user_preferences::Entity::update_many();
        // `coalesce($timezone, timezone)`.
        if let Some(timezone) = timezone {
            write = write.col_expr(user_preferences::Column::Timezone, Expr::value(timezone));
        }
        if set_hours {
            write = write.col_expr(user_preferences::Column::WorkingHours, Expr::value(hours));
        }
        write
            .col_expr(user_preferences::Column::UpdatedAt, Expr::value(now))
            .filter(user_preferences::Column::UserId.eq(subject))
            .exec(&db)
            .await?;
        return Ok(());
    }
    let mut row = user_preferences::ActiveModel {
        id: Set(generate_id("upref")),
        user_id: Set(subject.to_owned()),
        working_hours: Set(hours),
        updated_at: Set(now),
        ..Default::default()
    };
    // No timezone in the patch: the column keeps its default.
    if let Some(timezone) = timezone {
        row.timezone = Set(timezone);
    }
    user_preferences::Entity::insert(row)
        .exec_without_returning(&db)
        .await?;
    Ok(())
}

// ── notes ───────────────────────────────────────────────────────────────────

/// `toApi(row)`: the note as the client sees it.
fn note_view(row: &Value) -> Value {
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

/// `and(eq(authorUserId, author), eq(subjectUserId, subject))`.
fn note_of(author: &str, subject: &str) -> Condition {
    Condition::all()
        .add(member_notes::Column::AuthorUserId.eq(author))
        .add(member_notes::Column::SubjectUserId.eq(subject))
}

async fn note_inner(caller: &Caller, subject: &str) -> TeamResult<Response> {
    let row = member_notes::Entity::find()
        .filter(note_of(&caller.user_id, subject))
        .one(&orm(&caller.db))
        .await
        .and_then(|row| row.map(js).transpose())
        .map_err(failed("Failed to fetch note"))?;
    Ok(Data(row.as_ref().map_or(Value::Null, note_view)).into_response())
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
    Ok(Data(note_view(&row)).into_response())
}

async fn upsert_note(db: &PgPool, author: &str, subject: &str, body: &str) -> Result<Value, DbErr> {
    let db = orm(db);
    let now = utc_now().assume_utc();
    let existing: Option<String> = member_notes::Entity::find()
        .select_only()
        .column(member_notes::Column::Id)
        .filter(note_of(author, subject))
        .into_tuple()
        .one(&db)
        .await?;
    let row = if let Some(id) = existing {
        member_notes::Entity::update_many()
            .col_expr(member_notes::Column::Body, Expr::value(body))
            .col_expr(member_notes::Column::UpdatedAt, Expr::value(now))
            .filter(member_notes::Column::Id.eq(id))
            .exec_with_returning(&db)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| DbErr::RecordNotFound("member_notes".to_owned()))?
    } else {
        member_notes::Entity::insert(member_notes::ActiveModel {
            id: Set(generate_id("mnote")),
            author_user_id: Set(author.to_owned()),
            subject_user_id: Set(subject.to_owned()),
            body: Set(body.to_owned()),
            created_at: Set(now),
            updated_at: Set(now),
        })
        .exec_with_returning(&db)
        .await?
    };
    js(row)
}

async fn delete_note(caller: Caller, Path(subject): Path<String>) -> Response {
    let result = member_notes::Entity::delete_many()
        .filter(note_of(&caller.user_id, &subject))
        .exec(&orm(&caller.db))
        .await;
    answer(
        result
            .map(|_| NoContent.into_response())
            .map_err(failed("Failed to delete note")),
    )
}

// ── common ──────────────────────────────────────────────────────────────────

const PER_CATEGORY_LIMIT: u64 = 20;
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
    let empty = || Ok::<_, DbErr>(Vec::<Value>::new());
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

/// `count(distinct <column>) = 2`: both people are in it.
fn both(column: impl sea_orm::sea_query::IntoColumnRef) -> Expr {
    sea_orm::ExprTrait::eq(Expr::from(Func::count_distinct(Expr::col(column))), 2)
}

/// `jsonb_column @> jsonb_build_array(user)`.
fn lists(column: impl sea_orm::sea_query::IntoColumnRef, user: &str) -> Expr {
    sea_orm::sea_query::extension::postgres::PgExpr::contains(
        Expr::col(column),
        Expr::value(json!([user])),
    )
}

async fn common_channels(db: &PgPool, viewer: &str, subject: &str) -> Result<Vec<Value>, DbErr> {
    let membership: RelationDef = chat_channels::Entity::belongs_to(channel_members::Entity)
        .from(chat_channels::Column::Id)
        .to(channel_members::Column::ChannelId)
        .into();
    let found: Vec<(String, String, String, i32)> = chat_channels::Entity::find()
        .select_only()
        .columns([
            chat_channels::Column::Id,
            chat_channels::Column::Name,
            chat_channels::Column::Type,
        ])
        .column_as(
            Expr::from(Func::coalesce([
                Expr::col((chat_channels::Entity, chat_channels::Column::MemberCount)),
                Expr::val(0),
            ])),
            "member_count",
        )
        .join(JoinType::InnerJoin, membership)
        .filter(chat_channels::Column::DeletedAt.is_null())
        .filter(chat_channels::Column::IsArchived.eq(false))
        .filter(channel_members::Column::UserId.is_in([viewer, subject]))
        .group_by(chat_channels::Column::Id)
        .group_by(chat_channels::Column::Name)
        .group_by(chat_channels::Column::Type)
        .group_by(chat_channels::Column::MemberCount)
        .having(both((channel_members::Entity, channel_members::Column::UserId)))
        .order_by_desc(chat_channels::Column::LastMessageAt)
        .limit(PER_CATEGORY_LIMIT)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(found
        .into_iter()
        .map(|(id, name, kind, member_count)| {
            json!({ "id": id, "name": name, "type": kind, "memberCount": member_count })
        })
        .collect())
}

async fn common_projects(db: &PgPool, viewer: &str, subject: &str) -> Result<Vec<Value>, DbErr> {
    let membership: RelationDef = projects::Entity::belongs_to(project_members::Entity)
        .from(projects::Column::Id)
        .to(project_members::Column::ProjectId)
        .into();
    let found: Vec<(String, String, String, Option<String>)> = projects::Entity::find()
        .select_only()
        .columns([
            projects::Column::Id,
            projects::Column::Name,
            projects::Column::Status,
            projects::Column::Color,
        ])
        .join(JoinType::InnerJoin, membership)
        .filter(projects::Column::DeletedAt.is_null())
        .filter(projects::Column::IsActive.eq(true))
        .filter(project_members::Column::UserId.is_in([viewer, subject]))
        .group_by(projects::Column::Id)
        .group_by(projects::Column::Name)
        .group_by(projects::Column::Status)
        .group_by(projects::Column::Color)
        .having(both((project_members::Entity, project_members::Column::UserId)))
        .order_by_desc(projects::Column::UpdatedAt)
        .limit(PER_CATEGORY_LIMIT)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(found
        .into_iter()
        .map(|(id, name, status, color)| {
            json!({ "id": id, "name": name, "status": status, "color": color })
        })
        .collect())
}

/// A task both people are on, as `common_tasks` reads it.
#[derive(Debug, FromQueryResult)]
struct CommonTask {
    id: String,
    title: String,
    status: String,
    project_id: Option<String>,
    due_date: Option<PrimitiveDateTime>,
    assignee_id: Option<String>,
    reporter_id: Option<String>,
}

/// Assignee, reporter, or in `assignee_ids` or `watchers`.
fn on_task(user: &str) -> Condition {
    Condition::any()
        .add(tasks::Column::AssigneeId.eq(user))
        .add(tasks::Column::ReporterId.eq(user))
        .add(lists(tasks::Column::AssigneeIds, user))
        .add(lists(tasks::Column::Watchers, user))
}

async fn common_tasks(db: &PgPool, viewer: &str, subject: &str) -> Result<Vec<Value>, DbErr> {
    let found = tasks::Entity::find()
        .select_only()
        .columns([
            tasks::Column::Id,
            tasks::Column::Title,
            tasks::Column::Status,
            tasks::Column::ProjectId,
            tasks::Column::DueDate,
            tasks::Column::AssigneeId,
            tasks::Column::ReporterId,
        ])
        .filter(tasks::Column::DeletedAt.is_null())
        .filter(on_task(viewer))
        .filter(on_task(subject))
        .order_by_desc(tasks::Column::UpdatedAt)
        .limit(PER_CATEGORY_LIMIT)
        .into_model::<CommonTask>()
        .all(&orm(db))
        .await?;
    Ok(found
        .into_iter()
        .map(|task| {
            let assignee = task.assignee_id.as_deref();
            let reporter = task.reporter_id.as_deref();
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
                "id": task.id,
                "title": task.title,
                "status": task.status,
                "projectId": task.project_id,
                "dueDate": js_date(task.due_date),
                "role": role,
            })
        })
        .collect())
}

/// A `timestamp` as the route's `Date` serializes: `toISOString()`.
fn js_date(at: Option<PrimitiveDateTime>) -> Value {
    weldsuite_schema::js::timestamp::option::serialize(&at, serde_json::value::Serializer)
        .unwrap_or(Value::Null)
}

async fn common_crm(db: &PgPool, viewer: &str, subject: &str) -> Result<Vec<Value>, DbErr> {
    let db = orm(db);
    let opportunities: Vec<(String, String, String)> = crm_opportunities::Entity::find()
        .select_only()
        .columns([
            crm_opportunities::Column::Id,
            crm_opportunities::Column::Name,
            crm_opportunities::Column::Status,
        ])
        .filter(crm_opportunities::Column::DeletedAt.is_null())
        .filter(lists(crm_opportunities::Column::TeamMembers, viewer))
        .filter(lists(crm_opportunities::Column::TeamMembers, subject))
        .order_by_desc(crm_opportunities::Column::UpdatedAt)
        .limit(PER_CATEGORY_LIMIT)
        .into_tuple()
        .all(&db)
        .await?;
    let activities: Vec<(String, String, String)> = crm_activities::Entity::find()
        .select_only()
        .columns([
            crm_activities::Column::Id,
            crm_activities::Column::Subject,
            crm_activities::Column::Status,
        ])
        .filter(crm_activities::Column::DeletedAt.is_null())
        .filter(lists(crm_activities::Column::Attendees, viewer))
        .filter(lists(crm_activities::Column::Attendees, subject))
        .order_by_desc(crm_activities::Column::UpdatedAt)
        .limit(PER_CATEGORY_LIMIT)
        .into_tuple()
        .all(&db)
        .await?;
    let item = |kind: &str, (id, name, status): (String, String, String)| {
        json!({ "id": id, "kind": kind, "name": name, "status": status })
    };
    let mut merged: Vec<Value> = opportunities
        .into_iter()
        .map(|row| item("opportunity", row))
        .chain(activities.into_iter().map(|row| item("activity", row)))
        .collect();
    merged.truncate(usize::try_from(PER_CATEGORY_LIMIT).unwrap_or(20));
    Ok(merged)
}

async fn common_helpdesk(db: &PgPool, viewer: &str, subject: &str) -> Result<Vec<Value>, DbErr> {
    // `exists (select 1 from helpdesk_conversation_events e where
    // e.conversation_id = c.id and e.actor_id in (…) group by
    // e.conversation_id having count(distinct e.actor_id) = 2)`.
    let both_acted = conversation_events::Entity::find()
        .select_only()
        .expr(Expr::val(1))
        .filter(sea_orm::ExprTrait::equals(
            Expr::col((
                conversation_events::Entity,
                conversation_events::Column::ConversationId,
            )),
            (conversations::Entity, conversations::Column::Id),
        ))
        .filter(conversation_events::Column::ActorId.is_in([viewer, subject]))
        .group_by(conversation_events::Column::ConversationId)
        .having(both((
            conversation_events::Entity,
            conversation_events::Column::ActorId,
        )))
        .into_query();
    let found: Vec<(String, String, String)> = conversations::Entity::find()
        .select_only()
        .columns([
            conversations::Column::Id,
            conversations::Column::Subject,
            conversations::Column::Status,
        ])
        .filter(conversations::Column::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(conversations::Column::AssigneeId.eq(viewer))
                .add(conversations::Column::AssigneeId.eq(subject)),
        )
        .filter(Expr::exists(both_acted))
        .order_by_desc(conversations::Column::UpdatedAt)
        .limit(PER_CATEGORY_LIMIT)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(found
        .into_iter()
        .map(|(id, subject, status)| {
            json!({ "id": id, "kind": "conversation", "subject": subject, "status": status })
        })
        .collect())
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

/// One audit entry as the activity feed shows it.
#[derive(Debug, FromQueryResult, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityRow {
    id: String,
    action: String,
    entity_type: String,
    entity_id: String,
    description: String,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    created_at: PrimitiveDateTime,
    changes: Option<Value>,
}

/// `listMemberActivity`, the keyset cursor and its count quirk included.
async fn member_activity(
    db: &PgPool,
    performed_by: &str,
    cursor: Option<&str>,
    limit: f64,
) -> Result<(Vec<Value>, Pagination), DbErr> {
    let db = orm(db);
    let cursor = cursor.filter(|c| !c.is_empty());
    // The cursor row's `createdAt`, to the millisecond as the route's `Date`.
    let keyset: Option<(PrimitiveDateTime, String)> = match cursor {
        Some(cursor) => audit_logs::Entity::find_by_id(cursor)
            .select_only()
            .columns([audit_logs::Column::CreatedAt, audit_logs::Column::Id])
            .into_tuple::<(PrimitiveDateTime, String)>()
            .one(&db)
            .await?
            .map(|(at, id)| (utc_timestamp(at.assume_utc()), id)),
        None => None,
    };
    let limit = limit.min(100.0);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let fetch = (limit + 1.0).round() as u64;
    let mut select = audit_logs::Entity::find()
        .select_only()
        .columns([
            audit_logs::Column::Id,
            audit_logs::Column::Action,
            audit_logs::Column::EntityType,
            audit_logs::Column::EntityId,
            audit_logs::Column::Description,
            audit_logs::Column::CreatedAt,
            audit_logs::Column::Changes,
        ])
        .filter(audit_logs::Column::PerformedBy.eq(performed_by));
    if let Some((at, id)) = &keyset {
        select = select.filter(
            Condition::any()
                .add(audit_logs::Column::CreatedAt.lt(*at))
                .add(
                    Condition::all()
                        .add(audit_logs::Column::CreatedAt.eq(*at))
                        .add(audit_logs::Column::Id.lt(id)),
                ),
        );
    }
    let found = select
        .order_by_desc(audit_logs::Column::CreatedAt)
        .order_by_desc(audit_logs::Column::Id)
        .limit(fetch)
        .into_model::<ActivityRow>()
        .all(&db)
        .await?;
    // A cursor that matched nothing drops the only filter from the count.
    let mut count = audit_logs::Entity::find();
    if !(cursor.is_some() && keyset.is_none()) {
        count = count.filter(audit_logs::Column::PerformedBy.eq(performed_by));
    }
    let total = count.count(&db).await?;
    let mut found: Vec<Value> = found.into_iter().map(js).collect::<Result<_, _>>()?;
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
    Ok((data, Pagination::new(total, has_more, next)))
}
