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
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, KNOWLEDGE_PAGE_CREATED, PROJECT_LESSON_CREATED, PROJECT_LESSON_DELETED,
    PROJECT_LESSON_PUBLISHED, PROJECT_LESSON_UPDATED,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_flow_domain::blueprint::Json;
use weldsuite_flow_domain::js::{contains_pattern, iso_from_millis, parse_int};
use weldsuite_flow_domain::project_closing::{
    LESSON_LABEL, LessonPageLocale, NO_LESSONS, NOT_AUTHOR, lesson_blocks, lesson_event_data,
    lessons_page_title, may_change_lesson, present_lesson,
};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_know_domain::KnowError;
use weldsuite_know_domain::pages::{CreatePageInput, create_knowledge_page};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::closing_body::{
    Body, LessonQuery, lesson_query, parse_body, read_create_lesson, read_publish,
    read_update_lesson,
};
use crate::closing_store::{PROJECT_DENIED, PROJECT_WRITE_DENIED, find_live_project};
use crate::{
    Caller, FlowState, Refusal, Reply, access_scope, keyset_cursor, outside, page, paged, reply,
};

const LESSON_SQL: &str =
    "select to_jsonb(l) from project_lessons l where l.id = $1 and l.deleted_at is null limit 1";

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

/// A live lesson by id.
async fn find_lesson(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(LESSON_SQL)
        .bind(id)
        .fetch_optional(db)
        .await?;
    Ok(row.map(js_row))
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

/// The list's `where`, without the cursor.
macro_rules! lesson_filters {
    () => {
        concat!(
            "t.deleted_at is null",
            " and ($1::text is null or t.project_id = $1)",
            " and ($1::text is not null or ",
            in_accessible!("t.project_id", "$2", "$3"),
            ")",
            " and ($4::text is null or t.category = $4)",
            " and ($5::text is null or t.text ilike $5)"
        )
    };
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
    let (all, ids) = match scope {
        Ok(scope) => scope,
        Err(error) => return outside(Err(error.into())),
    };
    let cursor = match &q.cursor {
        Some(cursor) => match keyset_cursor(
            &caller.db,
            "select id, to_jsonb(created_at) #>> '{}' from project_lessons where id = $1 limit 1",
            cursor,
        )
        .await
        {
            Ok(found) => found,
            Err(error) => return outside(Err(error.into())),
        },
        None => None,
    };
    reply(
        list_lessons(&caller, &q, limit, (all, &ids), cursor).await,
        "Failed to list lessons",
    )
}

async fn list_lessons(
    caller: &Caller,
    q: &LessonQuery,
    limit: i64,
    (all, ids): (bool, &[String]),
    cursor: Option<(String, String)>,
) -> Reply {
    let db = &caller.db;
    let search = q.search.as_deref().map(contains_pattern);
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select to_jsonb(t) from project_lessons t where ",
        lesson_filters!(),
        " and ($6::timestamptz is null or t.created_at < $6::timestamptz",
        " or (t.created_at = $6::timestamptz and t.id < $7))",
        " order by t.created_at desc, t.id desc limit $8"
    ))
    .bind(q.project_id.as_deref())
    .bind(all)
    .bind(ids)
    .bind(q.category.as_deref())
    .bind(search.as_deref())
    .bind(cursor.as_ref().map(|c| c.0.as_str()))
    .bind(cursor.as_ref().map(|c| c.1.as_str()))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*) from project_lessons t where ",
        lesson_filters!()
    ))
    .bind(q.project_id.as_deref())
    .bind(all)
    .bind(ids)
    .bind(q.category.as_deref())
    .bind(search.as_deref())
    .fetch_one(db)
    .await?;
    let (rows, has_more, next) = page(rows.into_iter().map(js_row).collect(), limit);
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
    sqlx::query(
        "insert into project_lessons (id, project_id, category, text, author_id, votes,
             know_page_id, created_by, created_at, updated_at)
         values ($1, $2, $3, $4, $5, '[]'::jsonb, null, $5, $6::timestamptz, $6::timestamptz)",
    )
    .bind(&id)
    .bind(text(input, "projectId"))
    .bind(text(input, "category"))
    .bind(text(input, "text"))
    .bind(&caller.user_id)
    .bind(crate::now())
    .execute(&caller.db)
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
    sqlx::query(
        "update project_lessons
         set category = coalesce($2, category), text = coalesce($3, text),
             updated_at = $4::timestamptz
         where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(input.get("category").and_then(Value::as_str))
    .bind(input.get("text").and_then(Value::as_str))
    .bind(crate::now())
    .execute(&caller.db)
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
            sqlx::query(
                "update project_lessons
                 set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
                 where id = $1 and deleted_at is null",
            )
            .bind(&id)
            .bind(crate::now())
            .execute(&caller.db)
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
            let sql = if vote {
                "update project_lessons set
                     votes = case when jsonb_exists(votes, $2) then votes
                            else votes || jsonb_build_array($2::text) end,
                     updated_at = $3::timestamptz
                 where id = $1 and deleted_at is null"
            } else {
                "update project_lessons set votes = votes - $2::text, updated_at = $3::timestamptz
                 where id = $1 and deleted_at is null"
            };
            sqlx::query(sql)
                .bind(id)
                .bind(user)
                .bind(crate::now())
                .execute(&caller.db)
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
        KnowError::Database(error) => Refusal::Database(error),
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
    let lessons: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(l) from project_lessons l where l.project_id = $1 and l.deleted_at is null
         order by l.created_at asc, l.id asc",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let lessons: Vec<Value> = lessons.into_iter().map(js_row).collect();
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
    let published: Vec<Value> = sqlx::query_scalar(
        "update project_lessons l set know_page_id = $2, updated_at = $3::timestamptz
         where l.project_id = $1 and l.deleted_at is null returning to_jsonb(l)",
    )
    .bind(project_id)
    .bind(page_id)
    .bind(iso_from_millis(crate::now_ms()))
    .fetch_all(db)
    .await?;
    let mut published: Vec<Value> = published.into_iter().map(js_row).collect();
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
