//! `/api/task-comments` (`routes/task-comments/index.ts`): comments on
//! tasks. A comment's access follows its task's project; only the author
//! edits a comment, and the author or a manager of the task's project
//! deletes it. A new comment notifies the task's assignees and reporter and
//! anyone @-mentioned ([`crate::notify::comment`]).

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, Query as Subquery};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    TASK_COMMENT_CREATED, TASK_COMMENT_DELETED, TASK_COMMENT_UPDATED,
};
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::validation::{Number, Presence};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::task_comments::{self, Column as Comment};
use weldsuite_schema::tenant::{tasks, workspace_members};

use crate::notify;
use crate::tasks::{TaskAccess, task_access};
use crate::{
    Caller, FlowState, Query, Refusal, Reply, access_scope, outside, reply, row_json, validate,
    validate_value,
};

const TASK_DENIED: &str = "You are not a member of this task's project";
const TASK_WRITE_DENIED: &str = "You do not have write access to this task's project";

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("tasks:read")))
        .route("/", post(create).route_layer(need("tasks:create")))
        .route("/{id}", get(detail).route_layer(need("tasks:read")))
        .route("/{id}", patch(update).route_layer(need("tasks:update")))
        // `tasks:update`, not `tasks:delete`: members delete their own comments.
        .route("/{id}", delete(remove).route_layer(need("tasks:update")))
        .with_state(state)
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// `listFiltersSchema`.
struct Filters {
    task_id: Option<String>,
    author_id: Option<String>,
    task_type: Option<String>,
    page: Option<i64>,
    limit: Option<i64>,
}

fn read_filters(
    issues: &mut weldsuite_kit::validation::Issues,
    fields: &Map<String, Value>,
) -> Filters {
    let number = |max: Option<f64>| Number {
        coerce: true,
        int: true,
        min: Some(1.0),
        max,
    };
    let task_id = issues
        .text(fields, "taskId", Presence::Optional, None, None)
        .into_option();
    let author_id = issues
        .text(fields, "authorId", Presence::Optional, None, None)
        .into_option();
    let task_type = issues
        .text(fields, "taskType", Presence::Optional, None, None)
        .into_option();
    let page = issues
        .whole_number(fields, "page", Presence::Optional, number(None))
        .into_option();
    let limit = issues
        .whole_number(fields, "limit", Presence::Optional, number(Some(200.0)))
        .into_option();
    Filters {
        task_id,
        author_id,
        task_type,
        page,
        limit,
    }
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let filters = match validate_value(&Value::Object(q.values().clone()), read_filters) {
        Ok(filters) => filters,
        Err(refused) => return refused.respond("Invalid query"),
    };
    outside(list_comments(&caller, filters).await)
}

async fn list_comments(caller: &Caller, f: Filters) -> Reply {
    let db = &caller.db;
    let page = f.page.unwrap_or(1);
    let limit = f.limit.unwrap_or(50);
    let offset = (page - 1).saturating_mul(limit);
    let task_id = f.task_id.filter(|t| !t.is_empty());
    let task_type = f.task_type.filter(|t| !t.is_empty());
    let author_id = f.author_id.filter(|a| !a.is_empty());
    // A comment's access follows its task's project.
    let (scoped, all_projects, ids) = if let Some(task_id) = &task_id {
        match task_access(caller, task_id, false).await? {
            TaskAccess::Ok => {}
            TaskAccess::NotFound => return Err(Refusal::not_found("Task", task_id)),
            TaskAccess::Denied => return Err(Refusal::forbidden(TASK_DENIED)),
        }
        (false, true, Vec::new())
    } else {
        let (all, ids) = access_scope(caller).await?;
        (true, all, ids)
    };
    let result = async {
        // Without a task: comments of live tasks in accessible projects, and
        // personal tasks.
        let filters = || {
            let mut all = Condition::all().add(Comment::DeletedAt.is_null());
            if let Some(task_id) = &task_id {
                all = all.add(Comment::TaskId.eq(task_id));
            }
            if let Some(task_type) = &task_type {
                all = all.add(Comment::TaskType.eq(task_type));
            }
            if let Some(author_id) = &author_id {
                all = all.add(Comment::AuthorId.eq(author_id));
            }
            if scoped {
                let mut visible = Condition::all().add(tasks::Column::DeletedAt.is_null());
                if !all_projects {
                    visible = visible.add(
                        Condition::any()
                            .add(tasks::Column::ProjectId.is_null())
                            .add(tasks::Column::ProjectId.is_in(ids.iter().map(String::as_str))),
                    );
                }
                all = all.add(
                    Comment::TaskId.in_subquery(
                        Subquery::select()
                            .column(tasks::Column::Id)
                            .from(tasks::Entity)
                            .cond_where(visible)
                            .to_owned(),
                    ),
                );
            }
            all
        };
        let db = &orm(db);
        let rows: Vec<Value> = task_comments::Entity::find()
            .filter(filters())
            .order_by_desc(Comment::CreatedAt)
            .limit(u64::try_from(limit).unwrap_or(0))
            .offset(u64::try_from(offset).unwrap_or(0))
            .all(db)
            .await?
            .into_iter()
            .map(row_json)
            .collect::<Result<_, DbErr>>()?;
        // `count(*)::int`.
        let total = task_comments::Entity::find()
            .filter(filters())
            .count(db)
            .await?;
        let total = i32::try_from(total).unwrap_or(i32::MAX);
        let returned = i64::try_from(rows.len()).unwrap_or(i64::MAX);
        let rows = with_authors(&caller.db, caller.request_master(), rows).await?;
        let total = i64::from(total);
        Ok(weldsuite_kit::List::new(
            rows,
            weldsuite_kit::Pagination::new(
                u64::try_from(total).unwrap_or(0),
                offset + returned < total,
                None,
            ),
        )
        .into_response())
    }
    .await;
    Ok(reply(result, "Failed to list task comments"))
}

/// The author's `authorName` from `workspace_members` and `authorAvatar`, the
/// account picture.
async fn with_authors(
    db: &weldsuite_db::PgPool,
    master: Option<&weldsuite_db::PgPool>,
    rows: Vec<Value>,
) -> Result<Vec<Value>, DbErr> {
    let mut author_ids: Vec<String> = Vec::new();
    for row in &rows {
        if let Some(author) = row["authorId"].as_str().filter(|a| !a.is_empty())
            && !author_ids.iter().any(|known| known == author)
        {
            author_ids.push(author.to_owned());
        }
    }
    if author_ids.is_empty() {
        return Ok(rows);
    }
    let authors: Vec<(String, Option<String>)> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::UserId)
        .column(workspace_members::Column::Name)
        .filter(workspace_members::Column::UserId.is_in(author_ids.iter().map(String::as_str)))
        .into_tuple()
        .all(&orm(db))
        .await?;
    // `new Map(authors.map(...))`: a later row for the same user wins.
    let names: HashMap<String, Option<String>> = authors.into_iter().collect();
    // Avatars are account pictures, not the member row's copy.
    let pictures = weldsuite_db::AccountPictures::load(master, &author_ids).await;
    Ok(rows
        .into_iter()
        .map(|mut row| {
            let author_id = row["authorId"].clone();
            let author = author_id.as_str().filter(|a| !a.is_empty());
            let avatar = pictures.value(author);
            let name = author
                .and_then(|a| names.get(a))
                .and_then(Clone::clone)
                .map_or(author_id, Value::String);
            if let Value::Object(fields) = &mut row {
                fields.insert("authorName".to_owned(), name);
                fields.insert("authorAvatar".to_owned(), avatar);
            }
            row
        })
        .collect())
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn comment_row(db: &weldsuite_db::PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    task_comments::Entity::find_by_id(id.to_owned())
        .filter(Comment::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(row) = comment_row(&caller.db, &id).await? else {
                return Err(Refusal::not_found("Task comment", &id));
            };
            let task_id = row["taskId"].as_str().unwrap_or_default().to_owned();
            match task_access(&caller, &task_id, false).await? {
                TaskAccess::Ok => Ok(Data(row).into_response()),
                // The comments of a deleted task are gone with it.
                TaskAccess::NotFound => Err(Refusal::not_found("Task comment", &id)),
                TaskAccess::Denied => Err(Refusal::forbidden(TASK_DENIED)),
            }
        }
        .await,
        "Failed to fetch task comment",
    )
}

// ── POST / ──────────────────────────────────────────────────────────────────

/// `createCommentSchema`.
struct NewComment {
    task_id: String,
    task_type: String,
    content: String,
}

async fn create(
    State(state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        let task_id = issues.text(fields, "taskId", Presence::Required, Some(1), None);
        let task_type = issues.text(fields, "taskType", Presence::Optional, None, None);
        let content = issues.text(fields, "content", Presence::Required, Some(1), None);
        NewComment {
            task_id: task_id.into_option().unwrap_or_default(),
            task_type: task_type
                .into_option()
                .unwrap_or_else(|| "project".to_owned()),
            content: content.into_option().unwrap_or_default(),
        }
    }) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid body"),
    };
    if caller.user().is_none() {
        return ApiError::unauthorized().into_response();
    }
    match task_access(&caller, &data.task_id, true).await {
        Ok(TaskAccess::Ok) => {}
        Ok(TaskAccess::NotFound) => {
            return ApiError::not_found("Task", Some(&data.task_id)).into_response();
        }
        Ok(TaskAccess::Denied) => return crate::forbidden(TASK_WRITE_DENIED),
        Err(error) => return outside(Err(error.into())),
    }
    reply(
        create_comment(&state, &caller, data).await,
        "Failed to create task comment",
    )
}

async fn create_comment(state: &FlowState, caller: &Caller, data: NewComment) -> Reply {
    let id = generate_id("tcmt");
    let at = utc_now();
    task_comments::Entity::insert(task_comments::ActiveModel {
        id: Set(id.clone()),
        task_id: Set(data.task_id.clone()),
        task_type: Set(data.task_type.clone()),
        content: Set(data.content.clone()),
        author_id: Set(caller.user_id.clone()),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    })
    .exec_without_returning(&orm(&caller.db))
    .await?;
    caller.publish(
        state,
        TASK_COMMENT_CREATED,
        &id,
        &json!({ "id": id, "taskId": data.task_id, "content": data.content }),
    );
    notify::comment(
        state,
        caller,
        notify::Comment {
            id: id.clone(),
            task_id: data.task_id.clone(),
            content: data.content.clone(),
        },
    );
    Ok(Created(json!({
        "id": id,
        "taskId": data.task_id,
        "content": data.content,
        "authorId": caller.user_id,
    }))
    .into_response())
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let content = match validate(&headers, &body, |issues, fields| {
        issues
            .text(fields, "content", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(content) => content,
        Err(refused) => return refused.respond("Invalid body"),
    };
    reply(
        async {
            let db = &orm(&caller.db);
            let author: Option<String> = task_comments::Entity::find()
                .select_only()
                .column(Comment::AuthorId)
                .filter(Comment::Id.eq(&id))
                .filter(Comment::DeletedAt.is_null())
                .into_tuple()
                .one(db)
                .await?;
            let Some(author) = author else {
                return Err(Refusal::not_found("Task comment", &id));
            };
            if author != caller.user_id {
                return Err(Refusal::forbidden("You can only edit your own comments"));
            }
            task_comments::Entity::update_many()
                .col_expr(Comment::Content, Expr::value(&content))
                .col_expr(Comment::UpdatedAt, Expr::value(utc_now()))
                .filter(Comment::Id.eq(&id))
                .exec(db)
                .await?;
            caller.publish(
                &state,
                TASK_COMMENT_UPDATED,
                &id,
                &json!({ "id": id, "content": content }),
            );
            Ok(Data(json!({ "id": id, "content": content })).into_response())
        }
        .await,
        "Failed to update task comment",
    )
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

/// `canModerateComment`: the caller manages the task's project.
async fn can_moderate(caller: &Caller, task_id: &str) -> Result<bool, DbErr> {
    let project: Option<Option<String>> = tasks::Entity::find()
        .select_only()
        .column(tasks::Column::ProjectId)
        .filter(tasks::Column::Id.eq(task_id))
        .into_tuple()
        .one(&orm(&caller.db))
        .await?;
    match project.flatten().filter(|p| !p.is_empty()) {
        Some(project) => caller.can_manage(&project).await,
        None => Ok(false),
    }
}

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let db = &orm(&caller.db);
            let existing: Option<(String, String)> = task_comments::Entity::find()
                .select_only()
                .column(Comment::AuthorId)
                .column(Comment::TaskId)
                .filter(Comment::Id.eq(&id))
                .filter(Comment::DeletedAt.is_null())
                .into_tuple()
                .one(db)
                .await?;
            let Some((author, task_id)) = existing else {
                return Err(Refusal::not_found("Task comment", &id));
            };
            if author != caller.user_id && !can_moderate(&caller, &task_id).await? {
                return Err(Refusal::forbidden("You can only delete your own comments"));
            }
            let at = utc_now();
            task_comments::Entity::update_many()
                .col_expr(Comment::DeletedAt, Expr::value(at))
                .col_expr(Comment::UpdatedAt, Expr::value(at))
                .filter(Comment::Id.eq(&id))
                .exec(db)
                .await?;
            caller.publish(&state, TASK_COMMENT_DELETED, &id, &json!({ "id": id }));
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to delete task comment",
    )
}
