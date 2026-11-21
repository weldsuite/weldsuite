//! Problem management: `routes/desk-problems/index.ts` at
//! `/api/desk/problems` (the cause behind one or more incidents, with its
//! root cause, workaround and known-error status) and
//! `routes/desk-conversations/problem.ts` at
//! `/api/desk/conversations/{id}/problem` (the problem an incident is linked
//! to). The rules and writes are [`weldsuite_desk_domain::problems`];
//! timeline entries on incidents are published like the linked-ticket routes
//! publish theirs ([`super::links::publish_changes`]). What writes to
//! conversations also needs `conversations:update`, as the conversation's
//! own routes do: creating a problem with `conversationIds` (checked in the
//! handler, after the body) and sharing the workaround (a second gate).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_desk_domain::attributes::PRIORITIES;
use weldsuite_desk_domain::problems::{self, ProblemError, STATUSES};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text, js_trim};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::Ctx;
use super::inbox::{self, read_query};
use super::links::{publish_changes, publish_changes_after};
use crate::crud::write_failed;
use crate::knowledge::{DraftArticle, insert_draft};
use crate::{DeskState, Refusal, validate};

/// The most linked tickets an article records as related.
const RELATED_TICKETS: f64 = 50.0;

/// `/desk/problems`.
pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need(perm::PROBLEMS_READ)))
        .route("/", post(create).route_layer(need(perm::PROBLEMS_CREATE)))
        .route("/{id}", get(detail).route_layer(need(perm::PROBLEMS_READ)))
        .route(
            "/{id}",
            patch(update).route_layer(need(perm::PROBLEMS_UPDATE)),
        )
        .route(
            "/{id}",
            delete(remove).route_layer(need(perm::PROBLEMS_DELETE)),
        )
        .route(
            "/{id}/conversations",
            get(incidents).route_layer(need(perm::PROBLEMS_READ)),
        )
        .route(
            "/{id}/share-workaround",
            post(share_workaround)
                .route_layer(need(perm::CONVERSATIONS_UPDATE))
                .route_layer(need(perm::PROBLEMS_UPDATE)),
        )
        .route(
            "/{id}/article",
            post(article)
                .route_layer(need(perm::ARTICLES_CREATE))
                .route_layer(need(perm::PROBLEMS_READ)),
        )
}

/// `/desk/conversations/{id}/problem`, next to the inbox routes.
pub(super) fn conversation_routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let read = gate.require([perm::CONVERSATIONS_READ.to_owned()]);
    let update = gate.require([perm::CONVERSATIONS_UPDATE.to_owned()]);
    Router::new()
        .route("/{id}/problem", get(read_problem).route_layer(read))
        .route("/{id}/problem", put(set_problem).route_layer(update))
}

/// The answer to a refusal, a missing record or a failure.
fn refused(error: ProblemError, failure: &str) -> Response {
    match error {
        ProblemError::NotFound(id) => ApiError::not_found("Problem", Some(&id)).into_response(),
        ProblemError::ConversationNotFound(id) => {
            ApiError::not_found("Conversation", Some(&id)).into_response()
        }
        ProblemError::Rejected { reason, message } => ApiError::conflict(message)
            .with_details(json!({ "reason": reason }))
            .into_response(),
        ProblemError::Field { field, message } => ApiError::bad_request(message)
            .with_details(json!({ "field": field }))
            .into_response(),
        ProblemError::Write(error) => {
            tracing::error!(%error, "[desk-api/desk-problems] {failure}");
            ApiError::internal().with_message(failure).into_response()
        }
    }
}

/// The 403 the permission gate answers (`requirePermission`), `success:
/// false` included, for a permission that depends on the body.
fn permission_refused() -> Response {
    let body = json!({
        "success": false,
        "error": {
            "code": "FORBIDDEN",
            "message": "You do not have permission to perform this action",
        },
    });
    (http::StatusCode::FORBIDDEN, axum::Json(body)).into_response()
}

/// The timeline entries of `changes`, in order.
fn messages(changes: &[weldsuite_desk_domain::webchat::Appended]) -> Vec<Value> {
    changes
        .iter()
        .map(|change| change.message.clone())
        .collect()
}

// ── GET / ─────────────────────────────────────────────────────────────────────

/// `listDeskProblemsQuerySchema`. `status` is comma-separated; its transform
/// settles after the other fields' checks, so its issue comes last.
fn list_schema(issues: &mut Issues, values: &Map<String, Value>) -> problems::ListQuery {
    let text = |issues: &mut Issues, key: &str, rules: Text| {
        issues
            .text_with(values, key, Presence::Optional, rules)
            .into_option()
    };
    let status = text(issues, "status", Text::default());
    let known_errors = issues
        .choice(
            values,
            "knownErrors",
            Presence::Optional,
            &["1", "0", "true", "false"],
        )
        .into_option()
        .is_some_and(|flag| flag == "1" || flag == "true");
    let assignee_id = text(issues, "assigneeId", Text::length(None, Some(255)));
    let department_id = text(issues, "departmentId", Text::length(None, Some(30)));
    let q = text(issues, "q", Text::trimmed(None, Some(200)));
    let cursor = text(issues, "cursor", Text::default());
    let limit = issues
        .number(
            values,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                int: true,
                min: Some(1.0),
                max: Some(100.0),
            },
        )
        .into_option();
    let mut statuses = Vec::new();
    if let Some(value) = status.as_deref().filter(|value| !value.is_empty()) {
        let parts: Vec<&str> = value
            .split(',')
            .map(js_trim)
            .filter(|part| !part.is_empty())
            .collect();
        if parts.iter().all(|part| STATUSES.contains(part)) {
            statuses = parts.into_iter().map(str::to_owned).collect();
        } else {
            issues.custom("status", "Unknown problem status");
        }
    }
    problems::ListQuery {
        statuses,
        known_errors,
        assignee_id,
        department_id,
        q,
        cursor,
        limit,
    }
}

async fn list(ctx: Ctx, RawQuery(query): RawQuery) -> Response {
    let query = match read_query(query.as_deref(), list_schema) {
        Ok(query) => query,
        Err(response) => return response,
    };
    match problems::list(&ctx.caller.db, &query).await {
        Ok((data, total, has_more, cursor)) => List::new(
            data,
            Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
        )
        .into_response(),
        Err(error) => Refusal::from(error).respond("Failed to list problems"),
    }
}

// ── POST / ────────────────────────────────────────────────────────────────────

/// `longText.nullable().optional()`.
fn long_text(issues: &mut Issues, body: &Map<String, Value>, key: &str) -> Field<String> {
    issues.text(body, key, Presence::Nullish, None, Some(20_000))
}

/// `createDeskProblemSchema`.
fn create_schema(issues: &mut Issues, body: &Map<String, Value>) -> problems::NewProblem {
    let title = issues
        .text_with(
            body,
            "title",
            Presence::Required,
            Text::trimmed(Some(1), Some(500)),
        )
        .into_option()
        .unwrap_or_default();
    let description = long_text(issues, body, "description").into_option();
    let priority = issues
        .choice(body, "priority", Presence::Nullish, PRIORITIES)
        .into_option();
    let assignee_id = issues
        .text(body, "assigneeId", Presence::Nullish, Some(1), Some(255))
        .into_option();
    let department_id = issues
        .text(body, "departmentId", Presence::Nullish, Some(1), Some(30))
        .into_option();
    let root_cause = long_text(issues, body, "rootCause").into_option();
    let workaround = long_text(issues, body, "workaround").into_option();
    let status = issues
        .choice(body, "status", Presence::Optional, STATUSES)
        .into_option();
    let conversation_ids = issues
        .list(
            body,
            "conversationIds",
            Presence::Optional,
            None,
            Some(200),
            |issues, item| issues.item_text(item, Text::length(Some(1), Some(30))),
        )
        .into_option()
        .unwrap_or_default();
    problems::NewProblem {
        title,
        description,
        priority,
        assignee_id,
        department_id,
        root_cause,
        workaround,
        status,
        conversation_ids,
    }
}

async fn create(
    State(state): State<DeskState>,
    ctx: Ctx,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let failure = "Failed to create the problem";
    let input = match validate(&headers, &body, create_schema) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(failure),
    };
    let caller = &ctx.caller;
    // Linking incidents writes to those conversations.
    if !input.conversation_ids.is_empty() && !caller.can(perm::CONVERSATIONS_UPDATE) {
        return permission_refused();
    }
    match problems::create(&caller.db, Some(&caller.user_id), &input).await {
        Ok(created) => {
            let id = created.problem["id"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let first = vec![(ev::DESK_PROBLEM_CREATED, id, created.problem.clone())];
            publish_changes_after(&ctx, &state, first, &created.changes).await;
            Created(json!({
                "problem": created.problem,
                "messages": messages(&created.changes),
            }))
            .into_response()
        }
        Err(error) => refused(error, failure),
    }
}

// ── GET /:id ──────────────────────────────────────────────────────────────────

async fn detail(ctx: Ctx, Path(id): Path<String>) -> Response {
    match problems::get(&ctx.caller.db, &id).await {
        Ok(Some(problem)) => Data(problem).into_response(),
        Ok(None) => ApiError::not_found("Problem", Some(&id)).into_response(),
        Err(error) => Refusal::from(error).respond("Failed to load the problem"),
    }
}

// ── PATCH /:id ────────────────────────────────────────────────────────────────

/// `updateDeskProblemSchema`: omitted fields are left alone, null clears one.
fn update_schema(issues: &mut Issues, body: &Map<String, Value>) -> problems::Patch {
    const KEYS: [&str; 9] = [
        "title",
        "description",
        "status",
        "priority",
        "assigneeId",
        "departmentId",
        "rootCause",
        "workaround",
        "resolution",
    ];
    let title = issues
        .text_with(
            body,
            "title",
            Presence::Optional,
            Text::trimmed(Some(1), Some(500)),
        )
        .into_option();
    let description = long_text(issues, body, "description");
    let status = issues
        .choice(body, "status", Presence::Optional, STATUSES)
        .into_option();
    let priority = issues.choice(body, "priority", Presence::Nullish, PRIORITIES);
    let assignee_id = issues.text(body, "assigneeId", Presence::Nullish, Some(1), Some(255));
    let department_id = issues.text(body, "departmentId", Presence::Nullish, Some(1), Some(30));
    let root_cause = long_text(issues, body, "rootCause");
    let workaround = long_text(issues, body, "workaround");
    let resolution = long_text(issues, body, "resolution");
    // `.refine(data => Object.values(data).some(v => v !== undefined))`.
    if KEYS.iter().all(|key| !body.contains_key(*key)) {
        issues.custom_root("Nothing to update");
    }
    problems::Patch {
        title,
        description,
        status,
        priority,
        assignee_id,
        department_id,
        root_cause,
        workaround,
        resolution,
    }
}

async fn update(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let failure = "Failed to update the problem";
    let patch = match validate(&headers, &body, update_schema) {
        Ok(patch) => patch,
        Err(refusal) => return refusal.respond(failure),
    };
    let caller = &ctx.caller;
    match problems::update(&caller.db, &id, &patch).await {
        Ok(updated) => {
            if !updated.changes.is_empty() {
                let mut data = updated.problem.clone();
                if let Some(fields) = data.as_object_mut() {
                    fields.insert("changes".to_owned(), Value::Object(updated.changes));
                }
                caller.publish(&state, ev::DESK_PROBLEM_UPDATED, &id, &data);
            }
            Data(updated.problem).into_response()
        }
        Err(error) => refused(error, failure),
    }
}

// ── DELETE /:id ───────────────────────────────────────────────────────────────

async fn remove(State(state): State<DeskState>, ctx: Ctx, Path(id): Path<String>) -> Response {
    let caller = &ctx.caller;
    match problems::delete(&caller.db, &id).await {
        Ok((problem, _unlinked)) => {
            caller.publish(&state, ev::DESK_PROBLEM_DELETED, &id, &problem);
            NoContent.into_response()
        }
        Err(error) => refused(error, "Failed to delete the problem"),
    }
}

// ── GET /:id/conversations ────────────────────────────────────────────────────

async fn incidents(ctx: Ctx, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let failure = "Failed to load the linked tickets";
    let limit = match read_query(query.as_deref(), |issues, values| {
        issues
            .number(
                values,
                "limit",
                Presence::Optional,
                Number {
                    coerce: true,
                    int: true,
                    min: Some(1.0),
                    max: Some(500.0),
                },
            )
            .into_option()
    }) {
        Ok(limit) => limit,
        Err(response) => return response,
    };
    let db = &ctx.caller.db;
    match problems::get(db, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Problem", Some(&id)).into_response(),
        Err(error) => return Refusal::from(error).respond(failure),
    }
    match problems::conversations(db, &id, limit).await {
        Ok(incidents) => Data(incidents).into_response(),
        Err(error) => Refusal::from(error).respond(failure),
    }
}

// ── POST /:id/share-workaround ────────────────────────────────────────────────

/// `shareDeskProblemWorkaroundSchema`: the text (the problem's workaround
/// when left out) and whether it is a note or a reply.
fn share_schema(issues: &mut Issues, body: &Map<String, Value>) -> (Option<String>, String) {
    let text = issues
        .text_with(
            body,
            "body",
            Presence::Optional,
            Text::trimmed(None, Some(20_000)),
        )
        .into_option();
    let visibility = issues
        .choice(body, "visibility", Presence::Required, &["note", "reply"])
        .into_option()
        .unwrap_or_default();
    (text, visibility)
}

/// A note or a reply with the workaround on every open linked ticket.
/// Replies are delivered per channel like an incident update (messenger: the
/// visitor's room; email: the outbound reply; other channels: the timeline).
async fn share_workaround(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let failure = "Failed to share the workaround";
    let (text, visibility) = match validate(&headers, &body, share_schema) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(failure),
    };
    let caller = &ctx.caller;
    let note = visibility == "note";
    let shared = match problems::share_workaround(
        &caller.db,
        Some(&caller.user_id),
        &id,
        text.as_deref(),
        note,
    )
    .await
    {
        Ok(shared) => shared,
        Err(error) => return refused(error, failure),
    };
    publish_changes(&ctx, &state, &shared.changes).await;
    if visibility == "reply" {
        for change in &shared.changes {
            if change.conversation["channel"] == "email" {
                inbox::send_email_reply(&ctx, &state, &change.conversation, &change.message).await;
            }
        }
    }
    let conversation_ids: Vec<Value> = shared
        .changes
        .iter()
        .map(|change| change.conversation["id"].clone())
        .collect();
    Data(json!({
        "visibility": visibility,
        "delivered": shared.changes.len(),
        "skipped": shared.skipped,
        "conversationIds": conversation_ids,
    }))
    .into_response()
}

// ── POST /:id/article ─────────────────────────────────────────────────────────

/// A draft, internal help-center article from the problem (symptoms, cause,
/// workaround), stored on the problem.
async fn article(State(state): State<DeskState>, ctx: Ctx, Path(id): Path<String>) -> Response {
    let failure = "Failed to create the article";
    let caller = &ctx.caller;
    let db = &caller.db;
    let problem = match problems::get(db, &id).await {
        Ok(Some(problem)) => problem,
        Ok(None) => return ApiError::not_found("Problem", Some(&id)).into_response(),
        Err(error) => return Refusal::from(error).respond(failure),
    };
    if let Some(article_id) = problem["articleId"].as_str().filter(|id| !id.is_empty()) {
        let existing: Result<Option<String>, sqlx::Error> =
            sqlx::query_scalar("select id from helpdesk_articles where id = $1 limit 1")
                .bind(article_id)
                .fetch_optional(db)
                .await;
        match existing {
            Ok(Some(existing)) => {
                return ApiError::conflict("This problem already has an article")
                    .with_details(json!({ "reason": "article_exists", "articleId": existing }))
                    .into_response();
            }
            Ok(None) => {}
            Err(error) => return Refusal::from(error).respond(failure),
        }
    }

    let draft = problems::article_draft(&problem);
    let related = match problems::conversations(db, &id, Some(RELATED_TICKETS)).await {
        Ok(incidents) => incidents,
        Err(error) => return Refusal::from(error).respond(failure),
    };
    let draft_article = DraftArticle {
        title: &draft.title,
        content: &draft.content,
        excerpt: draft.excerpt.as_deref(),
        visibility: "internal",
        author_id: &caller.user_id,
        related_tickets: related
            .iter()
            .filter_map(|incident| incident["id"].as_str().map(str::to_owned))
            .collect(),
    };
    let (article_id, slug, _row) = match insert_draft(db, &draft_article).await {
        Ok(inserted) => inserted,
        Err(error) => return write_failed(&error, failure),
    };
    let article_created = (
        ev::HELPDESK_ARTICLE_CREATED,
        article_id.clone(),
        json!({
            "id": article_id, "title": draft.title, "slug": slug, "status": "draft",
            "authorId": caller.user_id, "problemId": id,
        }),
    );

    let updated = match problems::set_article(db, &id, Some(&article_id)).await {
        Ok(updated) => updated,
        Err(error) => {
            // The article stands, and so does its event.
            caller.publish_in_order(&state, vec![article_created]);
            return refused(error, failure);
        }
    };
    let mut data = updated.clone();
    if let Some(fields) = data.as_object_mut() {
        fields.insert(
            "changes".to_owned(),
            json!({ "articleId": { "from": problem["articleId"], "to": article_id } }),
        );
    }
    caller.publish_in_order(
        &state,
        vec![
            article_created,
            (ev::DESK_PROBLEM_UPDATED, id.clone(), data),
        ],
    );
    Created(updated).into_response()
}

// ── GET /desk/conversations/:id/problem ───────────────────────────────────────

async fn read_problem(ctx: Ctx, Path(id): Path<String>) -> Response {
    let failure = "Failed to load the problem";
    let db = &ctx.caller.db;
    let conversation: Result<Option<String>, sqlx::Error> =
        sqlx::query_scalar("select id from desk_conversations where id = $1 limit 1")
            .bind(&id)
            .fetch_optional(db)
            .await;
    match conversation {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Conversation", Some(&id)).into_response(),
        Err(error) => return Refusal::from(error).respond(failure),
    }
    match problems::conversation_problem(db, &id).await {
        Ok(problem) => Data(problem.unwrap_or(Value::Null)).into_response(),
        Err(error) => Refusal::from(error).respond(failure),
    }
}

// ── PUT /desk/conversations/:id/problem ───────────────────────────────────────

/// `setDeskConversationProblemSchema`: `problemId`, a string or null.
fn problem_schema(issues: &mut Issues, body: &Map<String, Value>) -> Option<String> {
    issues
        .text(body, "problemId", Presence::Nullable, Some(1), Some(30))
        .into_option()
}

/// Link the conversation to a problem, replace it, or unlink it
/// (`problemId: null`).
async fn set_problem(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let failure = "Failed to link the problem";
    let problem_id = match validate(&headers, &body, problem_schema) {
        Ok(problem_id) => problem_id,
        Err(refusal) => return refusal.respond(failure),
    };
    let caller = &ctx.caller;
    let result = problems::set_conversation_problem(
        &caller.db,
        Some(&caller.user_id),
        &id,
        problem_id.as_deref(),
    )
    .await;
    match result {
        Ok(result) => {
            publish_changes(&ctx, &state, &result.changes).await;
            Data(json!({
                "conversation": result.conversation,
                "problem": result.problem,
                "messages": messages(&result.changes),
            }))
            .into_response()
        }
        Err(error) => refused(error, failure),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use weldsuite_kit::validation::query_values;

    fn list_issues(query: &str) -> Result<problems::ListQuery, Value> {
        let values = query_values(Some(query));
        let mut issues = Issues::default();
        let read = list_schema(&mut issues, &values);
        issues
            .finish()
            .map(|()| read)
            .map_err(|invalid| json!(invalid.issues()))
    }

    /// Zod 3's own output for `listDeskProblemsQuerySchema`: the status
    /// transform's issue settles after the other fields' checks.
    #[test]
    fn an_unknown_status_is_reported_last() {
        assert_eq!(
            list_issues("status=nope&limit=0").err(),
            Some(json!([
                {"code":"too_small","minimum":1,"type":"number","inclusive":true,"exact":false,"message":"Number must be greater than or equal to 1","path":["limit"]},
                {"code":"custom","message":"Unknown problem status","path":["status"]},
            ]))
        );
        assert_eq!(
            list_issues("status=open&status=closed").err(),
            Some(json!([
                {"code":"invalid_type","expected":"string","received":"array","path":["status"],"message":"Expected string, received array"},
            ]))
        );
        assert_eq!(
            list_issues("knownErrors=yes").err(),
            Some(json!([
                {"received":"yes","code":"invalid_enum_value","options":["1","0","true","false"],"path":["knownErrors"],"message":"Invalid enum value. Expected '1' | '0' | 'true' | 'false', received 'yes'"},
            ]))
        );
    }

    #[test]
    fn statuses_are_comma_separated_and_trimmed() {
        let query =
            list_issues("status=%20open%20,%20,closed&knownErrors=1&limit=5").expect("valid");
        assert_eq!(query.statuses, ["open", "closed"]);
        assert!(query.known_errors);
        assert_eq!(query.limit, Some(5.0));
        let none = list_issues("status=&knownErrors=false").expect("valid");
        assert_eq!(none.statuses, Vec::<String>::new());
        assert!(!none.known_errors);
    }

    fn body_issues<T>(
        body: &Value,
        read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
    ) -> Value {
        let mut issues = Issues::default();
        let _ = read(&mut issues, body.as_object().expect("object"));
        issues
            .finish()
            .map_or_else(|invalid| json!(invalid.issues()), |()| json!([]))
    }

    /// Zod 3's own output for `updateDeskProblemSchema`'s refinement: it
    /// fails only when the body names none of the fields.
    #[test]
    fn an_empty_patch_is_nothing_to_update() {
        let nothing = json!([{"code":"custom","message":"Nothing to update","path":[]}]);
        assert_eq!(body_issues(&json!({}), update_schema), nothing);
        assert_eq!(body_issues(&json!({ "foo": 1 }), update_schema), nothing);
        assert_eq!(
            body_issues(&json!({ "description": null }), update_schema),
            json!([])
        );
        assert_eq!(
            body_issues(&json!({ "title": "   " }), update_schema),
            json!([{"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["title"]}])
        );
    }

    /// Zod 3's own output for `createDeskProblemSchema`, in the schema's order.
    #[test]
    fn a_new_problem_is_checked_field_by_field() {
        assert_eq!(
            body_issues(
                &json!({ "title": "x", "conversationIds": ["", 5, "ok"], "assigneeId": "" }),
                create_schema
            ),
            json!([
                {"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["assigneeId"]},
                {"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["conversationIds",0]},
                {"code":"invalid_type","expected":"string","received":"number","path":["conversationIds",1],"message":"Expected string, received number"},
            ])
        );
        assert_eq!(
            body_issues(&json!({}), share_schema),
            json!([{"expected":"'note' | 'reply'","received":"undefined","code":"invalid_type","path":["visibility"],"message":"Required"}])
        );
    }
}
