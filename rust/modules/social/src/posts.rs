//! `/api/social-posts`: posts (CRUD), and publishing them through PostPeer:
//! publish now, schedule, reschedule, cancel (back to a draft), and a
//! delete that stops the delivery first.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, CreditShortfall, Data, NoContent};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_social_domain::publishing::{
    PublishError, PublishOptions, cancel_delivery_before_delete, cancel_post, publish_post,
};

use crate::crud::{
    self, Crud, Filter, Partial, Standard, event, field, or_default, update_or_existing,
    update_or_existing_or,
};
use crate::js::js_date_iso;
use crate::objects::{OPT, POSTS, messages, string, strings};
use crate::{Caller, SocialState, now, tables, validate};

const POST_LIST: (&str, &str) = listing!("social_posts";
    "($2::boolean or t.status = $3::social_post_status)",
    "($4::boolean or t.campaign_id = $5::text)";
    6, 7, 8; "$9");

const POST_TYPES: [&str; 6] = ["post", "story", "reel", "thread", "carousel", "poll"];

fn post_schema(issues: &mut Issues, body: &Map<String, Value>, _partial: Partial) {
    string(issues, body, "title", OPT, Some(255));
    string(issues, body, "content", OPT, None);
    issues.choice(body, "postType", OPT, &POST_TYPES);
    string(issues, body, "status", OPT, Some(30));
    strings(issues, body, "targetAccountIds", OPT);
    strings(issues, body, "accountIds", OPT);
    strings(issues, body, "mediaIds", OPT);
    string(issues, body, "scheduledAt", OPT, None);
    string(issues, body, "publishedAt", OPT, None);
    string(issues, body, "timezone", OPT, Some(50));
    string(issues, body, "campaignId", Presence::Nullish, None);
    strings(issues, body, "labels", OPT);
    strings(issues, body, "tags", OPT);
    string(issues, body, "internalNotes", OPT, None);
}

fn present(data: &Map<String, Value>, key: &str) -> Option<Value> {
    data.get(key).filter(|v| !v.is_null()).cloned()
}

/// The server-owned defaults of a new post: its content, targets (the
/// legacy `accountIds` alias), author, `scheduledAt` as a `Date`, and when
/// it went into the approval queue.
fn post_prepare(
    caller: &Caller,
    _id: &str,
    data: &mut Map<String, Value>,
) -> Result<Vec<&'static str>, ()> {
    let account_ids = data.remove("accountIds");
    let content = present(data, "content").unwrap_or_else(|| json!(""));
    data.insert("content".to_owned(), content);
    let targets = present(data, "targetAccountIds")
        .or_else(|| account_ids.filter(|v| !v.is_null()))
        .unwrap_or_else(|| json!([]));
    data.insert("targetAccountIds".to_owned(), targets);
    let author = present(data, "createdByUserId").unwrap_or_else(|| json!(caller.user_id));
    data.insert("createdByUserId".to_owned(), author);
    let mut trusted = Vec::new();
    if let Some(Value::String(at)) = data.get("scheduledAt")
        && !at.is_empty()
    {
        // `new Date(text)`: an Invalid Date makes the insert throw.
        let iso = js_date_iso(at).ok_or(())?;
        data.insert("scheduledAt".to_owned(), json!(iso));
        trusted.push("scheduledAt");
    }
    let queued = data.get("status") == Some(&json!("pending_approval"));
    let requested = data.get("approvalRequestedAt").is_some_and(|v| match v {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    });
    if queued && !requested {
        data.insert("approvalRequestedAt".to_owned(), json!(now()));
        trusted.push("approvalRequestedAt");
    }
    Ok(trusted)
}

fn post_created(id: &str, data: &Map<String, Value>) -> Value {
    event(&[
        ("id", Some(json!(id))),
        ("title", field(data, "title")),
        ("status", or_default(data, "status", "draft")),
        ("campaignId", field(data, "campaignId")),
    ])
}

fn post_updated(id: &str, data: &Map<String, Value>, existing: &Value) -> Value {
    event(&[
        ("id", Some(json!(id))),
        ("title", update_or_existing(data, existing, "title")),
        (
            "status",
            update_or_existing_or(data, existing, "status", "draft"),
        ),
        (
            "campaignId",
            update_or_existing(data, existing, "campaignId"),
        ),
    ])
}

static POSTS_CRUD: Crud = Crud {
    table: &tables::SOCIAL_POSTS,
    resource: "Social post",
    id_prefix: "spo",
    gates: POSTS,
    messages: messages(
        "Failed to list social posts",
        "Failed to fetch social post",
        "Failed to create social post",
        "Failed to update social post",
        "Failed to delete social post",
    ),
    schema: post_schema,
    filters: &[Filter::eq("status"), Filter::eq("campaignId")],
    list_sql: POST_LIST.0,
    count_sql: POST_LIST.1,
    slice_count: true,
    hidden: &[],
    prepare: post_prepare,
    created: ev::SOCIAL_POST_CREATED,
    created_event: post_created,
    updated: ev::SOCIAL_POST_UPDATED,
    updated_event: post_updated,
    guard: None,
    deleted: ev::SOCIAL_POST_DELETED,
};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<SocialState> {
    let update = || gate.require([perm::POSTS_UPDATE]);
    crud::routes(
        &POSTS_CRUD,
        gate,
        Standard {
            create: true,
            remove: false,
        },
    )
    .route("/{id}/publish", post(publish).route_layer(update()))
    .route("/{id}/schedule", post(schedule).route_layer(update()))
    .route("/{id}/reschedule", post(reschedule).route_layer(update()))
    .route("/{id}/cancel", post(cancel).route_layer(update()))
    .route(
        "/{id}",
        delete(remove).route_layer(gate.require([perm::POSTS_DELETE])),
    )
}

/// The answer a publish failure gets (`error.badRequest`, `conflict`,
/// `insufficientCredits`, else a 500 with the error's message).
fn publish_refused(error: PublishError, fallback: &str) -> Response {
    match error {
        PublishError::NotConfigured => {
            ApiError::bad_request("Social publishing is not configured").into_response()
        }
        PublishError::Conflict(message) => ApiError::conflict(message).into_response(),
        PublishError::InsufficientCredits {
            current_balance,
            required,
        } => {
            #[allow(clippy::cast_precision_loss)]
            let shortfall = CreditShortfall {
                current_balance: Some(current_balance as f64),
                required: Some(required as f64),
                shortfall: Some((required - current_balance) as f64),
            };
            ApiError::insufficient_credits(Some(shortfall)).into_response()
        }
        other => {
            tracing::error!(error = %other, "[social-api/social-posts] {fallback}");
            // `error.internal(c, err.message)`.
            ApiError::internal()
                .with_message(other.to_string())
                .into_response()
        }
    }
}

/// `POST /api/social-posts/:id/publish`.
async fn publish(
    State(state): State<SocialState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let options = PublishOptions {
        now: true,
        scheduled_at: None,
        timezone: None,
    };
    match publish_post(
        &caller.db,
        &caller.context(&state),
        caller.clerk_org_id.as_deref(),
        &id,
        &options,
    )
    .await
    {
        Ok(result) => {
            let action = if result.status == "failed" {
                ev::SOCIAL_POST_FAILED
            } else {
                ev::SOCIAL_POST_PUBLISHED
            };
            let data = event(&[
                ("id", Some(json!(id))),
                ("status", Some(json!(result.status))),
                ("postpeerPostId", result.postpeer_post_id.clone()),
            ]);
            caller.publish(&state, action, &id, &data);
            Data(result.to_json()).into_response()
        }
        Err(error) => publish_refused(error, "Failed to publish post"),
    }
}

/// `{ scheduledAt: z.string().datetime({ offset: true }), timezone? }`.
fn schedule_input(
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<(String, Option<String>), Box<Response>> {
    let read = validate(headers, body, |issues, fields| {
        let at = issues.text_with(
            fields,
            "scheduledAt",
            Presence::Required,
            Text {
                format: Some(Format::DatetimeOffset),
                ..Text::default()
            },
        );
        let timezone = issues.text(fields, "timezone", Presence::Optional, None, None);
        (at.into_option(), timezone.into_option())
    })?;
    match read {
        (Some(at), timezone) => Ok((at, timezone)),
        _ => Err(Box::new(ApiError::internal().into_response())),
    }
}

async fn schedule_post(
    state: &SocialState,
    caller: &Caller,
    id: &str,
    headers: &HeaderMap,
    body: &Bytes,
    fallback: &str,
) -> Response {
    let (scheduled_at, timezone) = match schedule_input(headers, body) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let options = PublishOptions {
        now: false,
        scheduled_at: Some(scheduled_at.clone()),
        timezone,
    };
    match publish_post(
        &caller.db,
        &caller.context(state),
        caller.clerk_org_id.as_deref(),
        id,
        &options,
    )
    .await
    {
        Ok(result) => {
            let data = event(&[
                ("id", Some(json!(id))),
                ("status", Some(json!(result.status))),
                ("scheduledAt", Some(json!(scheduled_at))),
                ("postpeerPostId", result.postpeer_post_id.clone()),
            ]);
            caller.publish(state, ev::SOCIAL_POST_SCHEDULED, id, &data);
            Data(result.to_json()).into_response()
        }
        Err(error) => publish_refused(error, fallback),
    }
}

/// `POST /api/social-posts/:id/schedule { scheduledAt, timezone? }`.
async fn schedule(
    State(state): State<SocialState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    schedule_post(
        &state,
        &caller,
        &id,
        &headers,
        &body,
        "Failed to schedule post",
    )
    .await
}

/// `POST /api/social-posts/:id/reschedule { scheduledAt, timezone? }`.
async fn reschedule(
    State(state): State<SocialState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    schedule_post(
        &state,
        &caller,
        &id,
        &headers,
        &body,
        "Failed to reschedule post",
    )
    .await
}

/// `POST /api/social-posts/:id/cancel`: give up the slot; the post stays,
/// as a draft.
async fn cancel(
    State(state): State<SocialState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    match cancel_post(
        &caller.db,
        &caller.context(&state),
        caller.clerk_org_id.as_deref(),
        &id,
    )
    .await
    {
        Ok(false) => ApiError::not_found("Social post", Some(&id)).into_response(),
        Ok(true) => {
            caller.publish(
                &state,
                ev::SOCIAL_POST_CANCELLED,
                &id,
                &json!({ "id": id, "status": "draft" }),
            );
            Data(json!({ "id": id, "status": "draft" })).into_response()
        }
        Err(PublishError::Conflict(message)) => ApiError::conflict(message).into_response(),
        Err(PublishError::CancelUpstream(message)) => upstream(&message),
        Err(error) => crate::internal(&error, "Failed to cancel post"),
    }
}

/// `error.badGateway(c, message)`.
fn upstream(message: &str) -> Response {
    ApiError::bad_gateway()
        .with_message(message)
        .into_response()
}

/// `DELETE /api/social-posts/:id`: stop the PostPeer delivery, then delete.
async fn remove(
    State(state): State<SocialState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let table = &tables::SOCIAL_POSTS;
    match table.find_live(&caller.db, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Social post", Some(&id)).into_response(),
        Err(error) => return crate::internal(&error, "Failed to delete social post"),
    }
    let ctx = caller.context(&state);
    if let Err(error) =
        cancel_delivery_before_delete(&caller.db, &ctx, caller.clerk_org_id.as_deref(), &id).await
    {
        if let PublishError::CancelUpstream(message) = &error {
            return upstream(message);
        }
        return crate::internal(&error, "Failed to delete social post");
    }
    if let Err(error) = crud::soft_delete(&caller.db, table, &id).await {
        return crate::internal(&error, "Failed to delete social post");
    }
    caller.publish(&state, ev::SOCIAL_POST_DELETED, &id, &json!({ "id": id }));
    NoContent.into_response()
}
