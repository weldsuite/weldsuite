//! `/api/project-lessons` (`routes/project-lessons/index.ts`): lessons learned
//! in `project_lessons`, and publishing them to WeldKnow (design:
//! weldflow-delivery-and-portfolio.md, "Close a project").
//!
//! ```text
//! GET    /                list (projectId optional, category, search, cursor)
//! GET    /:id             one lesson
//! POST   /                add a lesson
//! PATCH  /:id             edit (its author, or a project manager)
//! DELETE /:id             soft delete (its author, or a project manager)
//! POST   /:id/vote        vote for a lesson (no-op when already voted)
//! DELETE /:id/vote        take the vote back
//! POST   /publish         one WeldKnow page with every lesson of the project
//! ```
//!
//! The checks run in TypeScript's order: permission, then the lesson (404),
//! then project access (403), then the body (400), then the rules.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, KNOWLEDGE_PAGE_CREATED, PROJECT_LESSON_CREATED, PROJECT_LESSON_DELETED,
    PROJECT_LESSON_PUBLISHED, PROJECT_LESSON_UPDATED,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_flow_domain::blueprint::Json;
use weldsuite_flow_domain::js::{contains_pattern, parse_int};
use weldsuite_flow_domain::project_closing::{
    LESSON_LABEL, LessonPageLocale, NO_LESSONS, NOT_AUTHOR, lesson_blocks, lesson_event_data,
    lessons_page_title, may_change_lesson, present_lesson,
};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_know_domain::KnowError;
use weldsuite_know_domain::pages::{CreatePageInput, create_knowledge_page};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::project_lessons::{self, Column};

use crate::closing_body::{
    Body, LessonQuery, lesson_query, parse_body, read_create_lesson, read_publish,
    read_update_lesson,
};
use crate::closing_store::{PROJECT_DENIED, PROJECT_WRITE_DENIED, find_live_project};
use crate::{
    Caller, FlowState, Refusal, Reply, access_scope, in_accessible, keyset_before,
    keyset_cursor_tz, outside, page, paged, reply, row_json,
};

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("projects:read")))
        .route("/", post(create).route_layer(need("projects:create")))
        // `requirePermission('projects:update'), requirePermission('knowledge:create')`:
        // the last layer added runs first.
        .route(
            "/publish",
            post(publish)
                .route_layer(need("knowledge:create"))
                .route_layer(need("projects:update")),
        )
        .route("/{id}", get(detail).route_layer(need("projects:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("projects:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("projects:delete")),
        )
        .route(
            "/{id}/vote",
            post(vote)
                .delete(take_back)
                .route_layer(need("projects:update")),
        )
        .with_state(state)
}

/// `new Date()` as the row stores it: the request's instant, to the millisecond.
fn now() -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(crate::now_ms()) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// A live lesson by id.
async fn find_lesson(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    project_lessons::Entity::find_by_id(id)
        .filter(Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

fn publish_lesson(state: &FlowState, caller: &Caller, event: EventName, row: &Value) {
    let id = row.text("id").unwrap_or_default();
    caller.publish(state, event, id, &lesson_event_data(row));
}

/// `parseLimit(raw, fallback, max)`.
fn parse_limit(raw: Option<&str>, fallback: i64, max: i64) -> i64 {
    match raw.and_then(parse_int) {
        Some(parsed) if parsed >= 1 => parsed.min(max),
        _ => fallback,
    }
}

fn text<'a>(body: &'a Body, key: &str) -> &'a str {
    body.get(key).and_then(Value::as_str).unwrap_or_default()
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// The list's `where`, without the cursor: the project (or the accessible
/// ones), the category and the search.
fn lesson_filters(q: &LessonQuery, scope: &(bool, Vec<String>)) -> Condition {
    let mut filters = Condition::all().add(Column::DeletedAt.is_null());
    filters = match q.project_id.as_deref() {
        Some(project_id) => filters.add(Column::ProjectId.eq(project_id)),
        None => filters.add(in_accessible(Column::ProjectId, scope)),
    };
    if let Some(category) = q.category.as_deref() {
        filters = filters.add(Column::Category.eq(category));
    }
    if let Some(search) = q.search.as_deref() {
        filters = filters.add(Column::Text.ilike(contains_pattern(search)));
    }
    filters
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match lesson_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let limit = parse_limit(q.limit.as_deref(), 50, 100);
    let scope = match q.project_id.as_deref() {
        Some(project_id) => match caller.can_access(project_id).await {
            Ok(true) => Ok((true, Vec::new())),
            Ok(false) => return outside(Err(Refusal::forbidden(PROJECT_DENIED))),
            Err(error) => Err(error),
        },
        None => access_scope(&caller).await,
    };
    let scope = match scope {
        Ok(scope) => scope,
        Err(error) => return outside(Err(error.into())),
    };
    let cursor = match &q.cursor {
        Some(cursor) => {
            match keyset_cursor_tz(&caller.db, Column::Id, Column::CreatedAt, cursor).await {
                Ok(found) => found,
                Err(error) => return outside(Err(error.into())),
            }
        }
        None => None,
    };
    reply(
        list_lessons(&caller, &q, limit, &scope, cursor).await,
        "Failed to list lessons",
    )
}

async fn list_lessons(
    caller: &Caller,
    q: &LessonQuery,
    limit: i64,
    scope: &(bool, Vec<String>),
    cursor: Option<(OffsetDateTime, String)>,
) -> Reply {
    let db = &orm(&caller.db);
    let filters = lesson_filters(q, scope);
    let mut select = project_lessons::Entity::find().filter(filters.clone());
    if let Some(cursor) = &cursor {
        select = select.filter(keyset_before(Column::Id, Column::CreatedAt, cursor));
    }
    let rows = select
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(db)
        .await?;
    let total = project_lessons::Entity::find()
        .filter(filters)
        .count(db)
        .await?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    let rows = rows
        .into_iter()
        .map(row_json)
        .collect::<Result<Vec<_>, _>>()?;
    let (rows, has_more, next) = page(rows, limit);
    let user = caller.user();
    let lessons = rows.iter().map(|row| present_lesson(row, user)).collect();
    Ok(paged(lessons, total, has_more, next))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(row) = find_lesson(&caller.db, &id).await? else {
                return Err(Refusal::not_found(LESSON_LABEL, &id));
            };
            if !caller
                .can_access(row.text("projectId").unwrap_or_default())
                .await?
            {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            Ok(Data(present_lesson(&row, caller.user())).into_response())
        }
        .await,
        "Failed to fetch lesson",
    )
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let checked = async {
        let input = parse_body(&body, read_create_lesson)?;
        let project_id = text(&input, "projectId").to_owned();
        if !caller.can_write(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        if find_live_project(&caller.db, &project_id).await?.is_none() {
            return Err(Refusal::not_found("Project", &project_id));
        }
        Ok(input)
    }
    .await;
    let input = match checked {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        create_lesson(&state, &caller, &input).await,
        "Failed to create lesson",
    )
}

async fn create_lesson(state: &FlowState, caller: &Caller, input: &Body) -> Reply {
    let id = generate_id("les");
    let now = now();
    project_lessons::Entity::insert(project_lessons::ActiveModel {
        id: Set(id.clone()),
        project_id: Set(text(input, "projectId").to_owned()),
        category: Set(text(input, "category").to_owned()),
        text: Set(text(input, "text").to_owned()),
        author_id: Set(caller.user_id.clone()),
        votes: Set(json!([])),
        know_page_id: Set(None),
        created_by: Set(caller.user_id.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(&caller.db))
    .await?;
    let Some(row) = find_lesson(&caller.db, &id).await? else {
        return Err(Refusal::Internal("the new lesson is missing".to_owned()));
    };
    publish_lesson(state, caller, PROJECT_LESSON_CREATED, &row);
    Ok(Created(present_lesson(&row, caller.user())).into_response())
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

/// Whether the caller may change the lesson: the checks every edit and delete runs.
async fn changeable(caller: &Caller, existing: &Value) -> Result<(), Refusal> {
    let project_id = existing.text("projectId").unwrap_or_default();
    if !caller.can_write(project_id).await? {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    Ok(())
}

async fn author_only(caller: &Caller, existing: &Value) -> Result<(), Refusal> {
    let project_id = existing.text("projectId").unwrap_or_default();
    let manages = caller.can_manage(project_id).await?;
    let author = existing.text("authorId").unwrap_or_default();
    if may_change_lesson(author, caller.user(), manages) {
        Ok(())
    } else {
        Err(Refusal::forbidden(NOT_AUTHOR))
    }
}

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(existing) = find_lesson(&caller.db, &id).await? else {
            return Err(Refusal::not_found(LESSON_LABEL, &id));
        };
        changeable(&caller, &existing).await?;
        let input = parse_body(&body, read_update_lesson)?;
        author_only(&caller, &existing).await?;
        Ok(input)
    }
    .await;
    let input = match checked {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        update_lesson(&state, &caller, &id, &input).await,
        "Failed to update lesson",
    )
}

async fn update_lesson(state: &FlowState, caller: &Caller, id: &str, input: &Body) -> Reply {
    // `coalesce(new, old)`: a field left out or null keeps its value.
    let mut update = project_lessons::Entity::update_many();
    if let Some(category) = input.get("category").and_then(Value::as_str) {
        update = update.col_expr(Column::Category, Expr::value(category));
    }
    if let Some(text) = input.get("text").and_then(Value::as_str) {
        update = update.col_expr(Column::Text, Expr::value(text));
    }
    update
        .col_expr(Column::UpdatedAt, Expr::value(now()))
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(&caller.db))
        .await?;
    let Some(row) = find_lesson(&caller.db, id).await? else {
        return Err(Refusal::not_found(LESSON_LABEL, id));
    };
    publish_lesson(state, caller, PROJECT_LESSON_UPDATED, &row);
    Ok(Data(present_lesson(&row, caller.user())).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let Some(existing) = find_lesson(&caller.db, &id).await? else {
                return Err(Refusal::not_found(LESSON_LABEL, &id));
            };
            changeable(&caller, &existing).await?;
            author_only(&caller, &existing).await?;
            let now = now();
            project_lessons::Entity::update_many()
                .col_expr(Column::DeletedAt, Expr::value(now))
                .col_expr(Column::UpdatedAt, Expr::value(now))
                .filter(Column::Id.eq(id.as_str()))
                .filter(Column::DeletedAt.is_null())
                .exec(&orm(&caller.db))
                .await?;
            caller.publish(
                &state,
                PROJECT_LESSON_DELETED,
                &id,
                &json!({
                    "id": id, "projectId": existing.at("projectId"),
                    "category": existing.at("category"),
                }),
            );
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to delete lesson",
    )
}

// ── Votes ───────────────────────────────────────────────────────────────────

async fn vote(State(state): State<FlowState>, caller: Caller, Path(id): Path<String>) -> Response {
    change_vote(&state, &caller, &id, true).await
}

async fn take_back(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    change_vote(&state, &caller, &id, false).await
}

/// `votes` with `user` added (`case when jsonb_exists(votes, user) then votes
/// else votes || jsonb_build_array(user::text) end`) or taken out
/// (`votes - user::text`), computed by the database.
fn votes_with(user: &str, vote: bool) -> Expr {
    use sea_orm::ExprTrait as _;
    use sea_orm::sea_query::Func;
    use sea_orm::sea_query::extension::postgres::PgExpr as _;

    let user = Expr::value(user).cast_as("text");
    if vote {
        Expr::case(
            Expr::expr(
                Func::cust("jsonb_exists")
                    .arg(Expr::col(Column::Votes))
                    .arg(user.clone()),
            ),
            Expr::col(Column::Votes),
        )
        .finally(Expr::col(Column::Votes).concat(Func::cust("jsonb_build_array").arg(user)))
        .into()
    } else {
        Expr::col(Column::Votes).sub(user)
    }
}

/// Add or take back the caller's vote. The array is changed in the database,
/// not read and written back, so two votes at once cannot lose one. Answers
/// the lesson; `updated` is published only when the vote set changed.
async fn change_vote(state: &FlowState, caller: &Caller, id: &str, vote: bool) -> Response {
    let fallback = if vote {
        "Failed to vote for lesson"
    } else {
        "Failed to take back the vote"
    };
    reply(
        async {
            let Some(existing) = find_lesson(&caller.db, id).await? else {
                return Err(Refusal::not_found(LESSON_LABEL, id));
            };
            changeable(caller, &existing).await?;
            let user = caller.user_id.as_str();
            let had = existing
                .items("votes")
                .iter()
                .any(|v| v.as_str() == Some(user));
            if had == vote {
                return Ok(Data(present_lesson(&existing, caller.user())).into_response());
            }
            project_lessons::Entity::update_many()
                .col_expr(Column::Votes, votes_with(user, vote))
                .col_expr(Column::UpdatedAt, Expr::value(now()))
                .filter(Column::Id.eq(id))
                .filter(Column::DeletedAt.is_null())
                .exec(&orm(&caller.db))
                .await?;
            let Some(row) = find_lesson(&caller.db, id).await? else {
                return Err(Refusal::not_found(LESSON_LABEL, id));
            };
            publish_lesson(state, caller, PROJECT_LESSON_UPDATED, &row);
            Ok(Data(present_lesson(&row, caller.user())).into_response())
        }
        .await,
        fallback,
    )
}

// ── POST /publish ───────────────────────────────────────────────────────────

fn know_refusal(error: KnowError) -> Refusal {
    match error {
        KnowError::NotFound { resource, id } => Refusal::not_found(resource, &id),
        KnowError::Forbidden(message) => Refusal::forbidden(message),
        KnowError::Conflict(message) => Refusal::conflict(message),
        KnowError::Database(error) => Refusal::Internal(error.to_string()),
    }
}

async fn publish(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let checked = async {
        let input = parse_body(&body, read_publish)?;
        let project_id = text(&input, "projectId").to_owned();
        if !caller.can_write(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        let Some(project) = find_live_project(&caller.db, &project_id).await? else {
            return Err(Refusal::not_found("Project", &project_id));
        };
        Ok((input, project))
    }
    .await;
    let (input, project) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        publish_lessons(&state, &caller, &input, &project).await,
        "Failed to publish the lessons",
    )
}

async fn publish_lessons(
    state: &FlowState,
    caller: &Caller,
    input: &Body,
    project: &Value,
) -> Reply {
    let db = &caller.db;
    let project_id = text(input, "projectId");
    let lessons = project_lessons::Entity::find()
        .filter(Column::ProjectId.eq(project_id))
        .filter(Column::DeletedAt.is_null())
        .order_by_asc(Column::CreatedAt)
        .order_by_asc(Column::Id)
        .all(&orm(db))
        .await?;
    let lessons = lessons
        .into_iter()
        .map(row_json)
        .collect::<Result<Vec<_>, _>>()?;
    if lessons.is_empty() {
        return Err(Refusal::bad_request(NO_LESSONS));
    }
    let locale = LessonPageLocale::parse(text(input, "locale")).unwrap_or(LessonPageLocale::En);
    let given = input.get("title").and_then(Value::as_str);
    let title = lessons_page_title(project.text("name").unwrap_or_default(), locale, given);
    let blocks = lesson_blocks(&lessons, locale);
    let created = create_knowledge_page(
        db,
        &caller.user_id,
        &CreatePageInput {
            space_id: text(input, "spaceId"),
            title: &title,
            content_json: &blocks,
            can_manage_all: caller.can("knowledge:manage"),
        },
    )
    .await
    .map_err(know_refusal)?;

    // Every lesson of the project now points at the page (a later publish makes a new page and moves them over).
    let page_id = created.text("id").unwrap_or_default();
    let published = project_lessons::Entity::update_many()
        .col_expr(Column::KnowPageId, Expr::value(page_id))
        .col_expr(Column::UpdatedAt, Expr::value(now()))
        .filter(Column::ProjectId.eq(project_id))
        .filter(Column::DeletedAt.is_null())
        .exec_with_returning(&orm(db))
        .await?;
    let mut published = published
        .into_iter()
        .map(row_json)
        .collect::<Result<Vec<_>, _>>()?;
    published.sort_by(|a, b| {
        (a.text("createdAt"), a.text("id")).cmp(&(b.text("createdAt"), b.text("id")))
    });

    caller.publish(
        state,
        KNOWLEDGE_PAGE_CREATED,
        page_id,
        &json!({
            "id": page_id, "spaceId": created.at("spaceId"), "parentId": null,
            "title": created.at("title"),
        }),
    );
    for row in &published {
        publish_lesson(state, caller, PROJECT_LESSON_PUBLISHED, row);
    }
    Ok(Created(json!({
        "pageId": page_id,
        "spaceId": created.at("spaceId"),
        "title": created.at("title"),
        "lessonCount": published.len(),
    }))
    .into_response())
}
