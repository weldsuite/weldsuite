//! `/api/panel/comments` (`routes/comments/index.ts`, `services/comments.ts`):
//! comments on a report or a dashboard, and the in-app notification its
//! owner gets when someone else comments (in the owner's language).
//!
//!   GET    /       → ?targetType&targetId: the target's comments, oldest first
//!   POST   /       → new comment; the target's owner is told (unless it is theirs)
//!   PATCH  /:id    → change the body (the author)
//!   DELETE /:id    → soft delete (the author, or `panel_projects:manage`)
//!
//! Only someone who may see the target reads or writes its comments; any
//! other target is a 404. The body never goes on the entity bus.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_COMMENT_CREATED, PANEL_COMMENT_DELETED, PANEL_COMMENT_UPDATED,
};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_notifications::{
    NewNotification, Notifier, create_and_deliver, notification_preview,
};
use weldsuite_permissions::Permissions;

use crate::saved::{Actor, Target, can_see, field, get_target, rows, target_label, text};
use crate::schemas_gen::{CREATE_PANEL_COMMENT, PANEL_TARGET_QUERY, UPDATE_PANEL_COMMENT};
use crate::{Caller, PanelState, unexpected};

/// Comments listed per target, oldest first (`MAX_LISTED_COMMENTS`).
const MAX_LISTED: i64 = 500;

/// `toCommentDto(c)`: `edited` when changed more than a second after posting.
fn dto(row: &Value) -> Value {
    let millis = |key: &str| weldsuite_panel_domain::js::parse_iso(text(row, key)).unwrap_or(0);
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "targetType": field(row, "targetType"),
        "targetId": field(row, "targetId"),
        "body": field(row, "body"),
        "authorUserId": field(row, "authorUserId"),
        "edited": millis("updatedAt") - millis("createdAt") > 1000,
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// `commentEventData(c)`: never the body.
fn event_data(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "targetType": field(row, "targetType"),
        "targetId": field(row, "targetId"),
        "authorUserId": field(row, "authorUserId"),
    })
}

fn publish(caller: &Caller, state: &PanelState, comment: &Value, event: EventName) {
    caller.publish(state, event, text(comment, "id"), &event_data(comment));
}

/// `visibleTarget(c, targetType, targetId)`: the target when the caller may see it.
async fn visible_target(
    caller: &Caller,
    actor: &Actor,
    target_type: &str,
    target_id: &str,
) -> Result<Option<Target>, sqlx::Error> {
    Ok(get_target(&caller.db, target_type, target_id)
        .await?
        .filter(|target| can_see(&target.row, actor)))
}

/// `visibleComment(c)`: the comment when the caller may see its target.
async fn visible_comment(caller: &Caller, actor: &Actor, id: &str) -> Result<Value, Box<Response>> {
    let row: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(c) from panel_comments c where c.id = $1 and c.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await;
    let comment = match row {
        Ok(Some(row)) => weldsuite_db::js_row(row),
        Ok(None) => {
            return Err(Box::new(
                ApiError::not_found("Comment", Some(id)).into_response(),
            ));
        }
        Err(error) => return Err(Box::new(unexpected(&error, "get comment"))),
    };
    match visible_target(
        caller,
        actor,
        text(&comment, "targetType"),
        text(&comment, "targetId"),
    )
    .await
    {
        Ok(Some(_)) => Ok(comment),
        Ok(None) => Err(Box::new(
            ApiError::not_found("Comment", Some(id)).into_response(),
        )),
        Err(error) => Err(Box::new(unexpected(&error, "get comment"))),
    }
}

/// `GET /`.
pub(crate) async fn list(
    caller: Caller,
    permissions: Permissions,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = match weldsuite_zod::query(&PANEL_TARGET_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let target_type = query.text("targetType").unwrap_or_default().to_owned();
    let target_id = query.text("targetId").unwrap_or_default().to_owned();
    let actor = Actor::of(&caller, &permissions);
    match visible_target(&caller, &actor, &target_type, &target_id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return ApiError::not_found(target_label(&target_type), Some(&target_id))
                .into_response();
        }
        Err(error) => return unexpected(&error, "list comments"),
    }
    let found: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(c) from panel_comments c
         where c.target_type = $1 and c.target_id = $2 and c.deleted_at is null
         order by c.created_at asc, c.id asc limit $3",
    )
    .bind(&target_type)
    .bind(&target_id)
    .bind(MAX_LISTED)
    .fetch_all(&caller.db)
    .await;
    match found {
        Ok(found) => {
            let comments: Vec<Value> = rows(found).iter().map(dto).collect();
            let count = comments.len() as u64;
            List::new(comments, Pagination::new(count, false, None)).into_response()
        }
        Err(error) => unexpected(&error, "list comments"),
    }
}

/// `POST /`.
pub(crate) async fn create(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&CREATE_PANEL_COMMENT, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    if caller.user_id.is_empty() {
        return ApiError::unauthorized().into_response();
    }
    let target_type = input.text("targetType").unwrap_or_default().to_owned();
    let target_id = input.text("targetId").unwrap_or_default().to_owned();
    let actor = Actor::of(&caller, &permissions);
    let target = match visible_target(&caller, &actor, &target_type, &target_id).await {
        Ok(Some(target)) => target,
        Ok(None) => {
            return ApiError::not_found(target_label(&target_type), Some(&target_id))
                .into_response();
        }
        Err(error) => return unexpected(&error, "create comment"),
    };
    let created: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "insert into panel_comments as c (id, project_id, target_type, target_id, body, author_user_id)
         values ($1, $2, $3, $4, $5, $6)
         returning to_jsonb(c)",
    )
    .bind(weldsuite_kit::id::generate_id("pncm"))
    .bind(text(&target.row, "projectId"))
    .bind(target.target_type)
    .bind(text(&target.row, "id"))
    .bind(input.text("body"))
    .bind(&caller.user_id)
    .fetch_one(&caller.db)
    .await;
    let comment = match created {
        Ok(row) => weldsuite_db::js_row(row),
        Err(error) => return unexpected(&error, "create comment"),
    };
    publish(&caller, &state, &comment, PANEL_COMMENT_CREATED);
    if let Some(clerk_org_id) = caller.clerk_org_id.as_deref().filter(|id| !id.is_empty())
        && text(&target.row, "ownerUserId") != caller.user_id
    {
        notify_target_owner(&caller, &state, clerk_org_id, &target, &comment).await;
    }
    Created(dto(&comment)).into_response()
}

/// `PATCH /:id`: the author only.
pub(crate) async fn update(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&UPDATE_PANEL_COMMENT, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let actor = Actor::of(&caller, &permissions);
    let found = match visible_comment(&caller, &actor, &id).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    if text(&found, "authorUserId") != caller.user_id {
        return ApiError::forbidden()
            .with_message("Only the author can change this comment")
            .into_response();
    }
    let updated: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "update panel_comments as c set body = $2, updated_at = now()
         where c.id = $1 and c.deleted_at is null
         returning to_jsonb(c)",
    )
    .bind(text(&found, "id"))
    .bind(input.text("body"))
    .fetch_optional(&caller.db)
    .await;
    match updated {
        Ok(Some(row)) => {
            let comment = weldsuite_db::js_row(row);
            publish(&caller, &state, &comment, PANEL_COMMENT_UPDATED);
            Data(dto(&comment)).into_response()
        }
        Ok(None) => ApiError::not_found("Comment", Some(text(&found, "id"))).into_response(),
        Err(error) => unexpected(&error, "update comment"),
    }
}

/// `DELETE /:id`: the author, or a manager.
pub(crate) async fn remove(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
) -> Response {
    let actor = Actor::of(&caller, &permissions);
    let found = match visible_comment(&caller, &actor, &id).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    if text(&found, "authorUserId") != actor.user_id && !actor.can_manage {
        return ApiError::forbidden()
            .with_message("Only the author can delete this comment")
            .into_response();
    }
    let deleted: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "update panel_comments as c set deleted_at = now(), updated_at = now()
         where c.id = $1 and c.deleted_at is null
         returning to_jsonb(c)",
    )
    .bind(text(&found, "id"))
    .fetch_optional(&caller.db)
    .await;
    match deleted {
        Ok(Some(row)) => {
            let comment = weldsuite_db::js_row(row);
            publish(&caller, &state, &comment, PANEL_COMMENT_DELETED);
            NoContent.into_response()
        }
        Ok(None) => ApiError::not_found("Comment", Some(text(&found, "id"))).into_response(),
        Err(error) => unexpected(&error, "delete comment"),
    }
}

// ---------------------------------------------------------------------------
// The notification to the target's owner
// ---------------------------------------------------------------------------

/// `targetPath(target)`: the platform path that opens the target.
fn target_path(target: &Target) -> String {
    let id = text(&target.row, "id");
    if target.target_type == "dashboard" {
        return format!("/weldpanel/dashboards/{id}");
    }
    let path = match text(&target.row, "kind") {
        "web" => "/weldpanel",
        "trends" => "/weldpanel/insights",
        "funnel" => "/weldpanel/funnels",
        "retention" => "/weldpanel/retention",
        "flows" => "/weldpanel/flows",
        _ => "/weldpanel/reports",
    };
    let encoded: String = url::form_urlencoded::byte_serialize(id.as_bytes())
        .collect::<String>()
        .replace('+', "%20");
    format!("{path}?report={encoded}")
}

/// `commentTitle(locale, targetType, authorName, targetName)`.
fn comment_title(
    locale: &str,
    target_type: &str,
    author: Option<&str>,
    target_name: &str,
) -> String {
    let (template, someone) = match (locale, target_type) {
        ("nl", "dashboard") => ("{author} reageerde op het dashboard \"{name}\"", "Iemand"),
        ("nl", _) => ("{author} reageerde op het rapport \"{name}\"", "Iemand"),
        (_, "dashboard") => ("{author} commented on the dashboard \"{name}\"", "Someone"),
        _ => ("{author} commented on the report \"{name}\"", "Someone"),
    };
    let author = author.filter(|name| !name.is_empty()).unwrap_or(someone);
    template
        .replacen("{author}", author, 1)
        .replacen("{name}", target_name, 1)
}

/// `resolveEmailLocale(user's, workspace's)`, as `en` or `nl`.
fn email_locale(candidates: &[Option<String>]) -> &'static str {
    for candidate in candidates.iter().flatten() {
        let lower = candidate.trim().to_lowercase();
        let base = lower.split(['-', '_']).next().unwrap_or_default();
        match base {
            "nl" => return "nl",
            "en" => return "en",
            _ => {}
        }
    }
    "en"
}

/// The first `max` UTF-16 units of `text`.
fn slice_utf16(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        out.push(c);
    }
    out
}

/// `notifyTargetOwner`: an in-app notification to the target's owner. Never
/// fails the request: a failure is logged and the comment stands.
async fn notify_target_owner(
    caller: &Caller,
    state: &PanelState,
    clerk_org_id: &str,
    target: &Target,
    comment: &Value,
) {
    let owner = text(&target.row, "ownerUserId");
    let author = text(comment, "authorUserId");
    let lookups = async {
        let preference: Option<Option<String>> =
            sqlx::query_scalar("select language from user_preferences where user_id = $1 limit 1")
                .bind(owner)
                .fetch_optional(&caller.db)
                .await?;
        let workspace: Option<Option<String>> =
            sqlx::query_scalar("select language from workspace_settings limit 1")
                .fetch_optional(&caller.db)
                .await?;
        let name: Option<Option<String>> =
            sqlx::query_scalar("select name from workspace_members where user_id = $1 limit 1")
                .bind(author)
                .fetch_optional(&caller.db)
                .await?;
        Ok::<_, sqlx::Error>((
            email_locale(&[preference.flatten(), workspace.flatten()]),
            name.flatten(),
        ))
    };
    let (locale, author_name) = match lookups.await {
        Ok(found) => found,
        Err(error) => {
            tracing::error!(%error, "[panel-api] comment notification failed");
            return;
        }
    };
    let title = comment_title(
        locale,
        target.target_type,
        author_name.as_deref(),
        text(&target.row, "name"),
    );
    let notification = NewNotification {
        workspace_id: clerk_org_id.to_owned(),
        clerk_org_id: Some(clerk_org_id.to_owned()),
        user_id: owner.to_owned(),
        title: slice_utf16(&title, 255),
        body: notification_preview(text(comment, "body"), 180),
        category: "system".to_owned(),
        notification_type: "comment".to_owned(),
        entity_type: "panel_comment".to_owned(),
        entity_id: text(comment, "id").to_owned(),
        action_url: target_path(target),
        severity: "info".to_owned(),
        actor_type: Some("user".to_owned()),
        actor_id: Some(author.to_owned()),
        // In-app only: the panel has no comment email template and no mobile app.
        exclude_email: true,
        exclude_push: true,
        ..NewNotification::default()
    };
    let notifier = Notifier {
        realtime: state.realtime.clone(),
        ..Notifier::default()
    };
    if let Err(error) = create_and_deliver(&caller.db, &notifier, &notification).await {
        tracing::error!(%error, "[panel-api] comment notification failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_and_paths_read_like_the_worker() {
        assert_eq!(
            comment_title("nl", "report", None, "Weekly visitors"),
            "Iemand reageerde op het rapport \"Weekly visitors\""
        );
        assert_eq!(
            comment_title("en", "dashboard", Some("Bob"), "Growth"),
            "Bob commented on the dashboard \"Growth\""
        );
        let report = Target {
            target_type: "report",
            row: json!({ "id": "pnr_1", "kind": "trends" }),
        };
        assert_eq!(target_path(&report), "/weldpanel/insights?report=pnr_1");
        assert_eq!(email_locale(&[None, Some("nl-NL".to_owned())]), "nl");
        assert_eq!(email_locale(&[Some("de".to_owned())]), "en");
    }
}
