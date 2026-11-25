//! `/api/social-approvals`: submitting a post for approval, approving it
//! (which schedules it when it has a time), rejecting it or asking for a
//! revision, and the approvals themselves.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect, UpdateMany};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::orm;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::enums::{SocialApprovalStatus, SocialPostStatus};
use weldsuite_schema::tenant::{social_approvals, social_posts};
use weldsuite_social_domain::publishing::{PublishError, PublishOptions, publish_post};

use crate::crud::{self, Crud, Filter, Partial, Standard, event, update_or_existing_or};
use crate::js::{js_date_iso, query_param};
use crate::objects::{OPT, POSTS, messages, string};
use crate::table::{iso, now_both};
use crate::{Caller, SocialState, tables, validate};

fn approval_schema(issues: &mut Issues, body: &Map<String, Value>, _partial: Partial) {
    string(issues, body, "postId", Presence::Nullish, None);
    string(issues, body, "approverId", Presence::Nullish, None);
    string(issues, body, "status", OPT, Some(30));
    string(issues, body, "comment", OPT, None);
}

fn approval_updated(id: &str, data: &Map<String, Value>, existing: &Value) -> Value {
    event(&[
        ("id", Some(json!(id))),
        ("postId", existing.get("postId").cloned()),
        (
            "status",
            update_or_existing_or(data, existing, "status", "pending"),
        ),
    ])
}

/// Status changes with side effects go through the action routes.
fn approval_guard(data: &Map<String, Value>, existing: &Value) -> Option<&'static str> {
    if existing.get("status") != Some(&json!("pending")) {
        return None;
    }
    match data.get("status").and_then(Value::as_str) {
        Some("approved") => Some(
            "Use POST /social-approvals/:id/approve to approve (auto-schedules when scheduledAt is set)",
        ),
        Some("rejected" | "revision_requested") => {
            Some("Use POST /social-approvals/:id/reject to reject or request revision")
        }
        _ => None,
    }
}

fn unused_created(_id: &str, _data: &Map<String, Value>) -> Value {
    Value::Null
}

static APPROVALS: Crud = Crud {
    table: &tables::SOCIAL_APPROVALS,
    resource: "Social approval",
    id_prefix: "sap",
    gates: POSTS,
    messages: messages(
        "Failed to list social approvals",
        "Failed to fetch social approval",
        "Failed to create social approval",
        "Failed to update social approval",
        "Failed to delete social approval",
    ),
    schema: approval_schema,
    filters: &[
        Filter::eq("postId", |v| {
            Condition::all().add(social_approvals::Column::PostId.eq(v))
        }),
        Filter::eq("status", |v| {
            Condition::all().add(social_approvals::Column::Status.eq(v))
        }),
    ],
    slice_count: false,
    hidden: &[],
    prepare: crud::no_prepare,
    created: ev::SOCIAL_APPROVAL_CREATED,
    created_event: unused_created,
    updated: ev::SOCIAL_APPROVAL_UPDATED,
    updated_event: approval_updated,
    guard: Some(approval_guard),
    edit: None,
    deleted: ev::SOCIAL_APPROVAL_DELETED,
};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<SocialState> {
    let update = || gate.require([perm::POSTS_UPDATE]);
    crud::routes(
        &APPROVALS,
        gate,
        Standard {
            create: false,
            remove: true,
        },
    )
    .route(
        "/",
        post(create).route_layer(gate.require([perm::POSTS_CREATE])),
    )
    .route("/{id}/approve", post(approve).route_layer(update()))
    .route("/{id}/reject", post(reject).route_layer(update()))
}

/// A live post's id and what approving it needs.
struct PostRef {
    id: String,
    scheduled_at: Option<String>,
    timezone: Option<String>,
}

async fn live_post(caller: &Caller, id: &str) -> Result<Option<PostRef>, DbErr> {
    let row: Option<(String, Option<PrimitiveDateTime>, Option<String>)> =
        social_posts::Entity::find()
            .select_only()
            .columns([
                social_posts::Column::Id,
                social_posts::Column::ScheduledAt,
                social_posts::Column::Timezone,
            ])
            .filter(social_posts::Column::Id.eq(id))
            .filter(social_posts::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(&caller.db))
            .await?;
    Ok(row.map(|(id, scheduled_at, timezone)| PostRef {
        id,
        scheduled_at: scheduled_at.map(iso),
        timezone,
    }))
}

/// `new Date(value)` as `toISOString()`; `None` for an Invalid Date.
fn js_date_of(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => js_date_iso(text),
        Value::Number(number) => {
            let millis = number.as_f64()?;
            if !millis.is_finite() || millis.abs() > 8.64e15 {
                return None;
            }
            #[allow(clippy::cast_possible_truncation)]
            let nanos = (millis.trunc() as i128) * 1_000_000;
            time::OffsetDateTime::from_unix_timestamp_nanos(nanos)
                .ok()
                .map(weldsuite_events::iso_timestamp)
        }
        _ => None,
    }
}

/// What a JavaScript `||` keeps.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `a ?? b ?? null` over body keys.
fn first_present(data: &Map<String, Value>, keys: &[&str]) -> Value {
    keys.iter()
        .find_map(|key| data.get(*key).filter(|v| !v.is_null()).cloned())
        .unwrap_or(Value::Null)
}

/// `POST /api/social-approvals`: submit a post; it moves into the queue.
async fn create(
    State(state): State<SocialState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match crud::read_body(&APPROVALS, &headers, &body, false) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let id = generate_id("sap");
    let (now, stamp) = now_both();
    let Some(post_id) = data
        .get("postId")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
    else {
        return ApiError::bad_request("postId is required").into_response();
    };
    let failed =
        |error: &dyn std::fmt::Display| crate::internal(error, "Failed to create social approval");
    match live_post(&caller, &post_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Social post", Some(&post_id)).into_response(),
        Err(error) => return failed(&error),
    }
    let submitted_by = data
        .get("submittedByUserId")
        .filter(|v| truthy(Some(v)))
        .cloned()
        .unwrap_or_else(|| json!(caller.user_id));
    let submitted_at = match data.get("submittedAt") {
        Some(value) if truthy(Some(value)) => match js_date_of(value) {
            Some(at) => at,
            None => return failed(&"Invalid time value"),
        },
        _ => now.clone(),
    };
    let version = match data.get("version") {
        Some(Value::Number(version)) => Value::Number(version.clone()),
        _ => json!(1),
    };
    let table = &tables::SOCIAL_APPROVALS;
    let mut values = Map::new();
    for (prop, value) in [
        ("id", json!(id)),
        ("postId", json!(post_id)),
        ("version", version),
        ("status", json!("pending")),
        ("submittedByUserId", submitted_by.clone()),
        ("submittedAt", json!(submitted_at)),
        (
            "submissionNotes",
            first_present(&data, &["submissionNotes", "comment"]),
        ),
        (
            "assignedToUserId",
            first_present(&data, &["assignedToUserId", "approverId"]),
        ),
        ("createdAt", json!(now)),
        ("updatedAt", json!(now)),
    ] {
        table.set(&mut values, prop, value);
    }
    if let Err(error) = table
        .insert(
            &caller.db,
            values,
            &["submittedAt", "createdAt", "updatedAt"],
        )
        .await
    {
        return failed(&error);
    }
    let queued = social_posts::Entity::update_many()
        .col_expr(
            social_posts::Column::Status,
            social_posts::Column::Status.save_as(Expr::val(SocialPostStatus::PendingApproval)),
        )
        .col_expr(social_posts::Column::ApprovalRequestedAt, Expr::val(stamp))
        .col_expr(social_posts::Column::UpdatedAt, Expr::val(stamp))
        .filter(social_posts::Column::Id.eq(&post_id))
        .filter(social_posts::Column::DeletedAt.is_null())
        .exec(&orm(&caller.db))
        .await;
    if let Err(error) = queued {
        return failed(&error);
    }
    caller.publish(
        &state,
        ev::SOCIAL_APPROVAL_CREATED,
        &id,
        &json!({ "id": id, "postId": post_id, "status": "pending", "submittedByUserId": submitted_by }),
    );
    caller.publish(
        &state,
        ev::SOCIAL_POST_UPDATED,
        &post_id,
        &json!({ "id": post_id, "status": "pending_approval" }),
    );
    Created(json!({ "id": id, "postId": post_id })).into_response()
}

/// The approval and the status it must have, read as the action routes do.
async fn live_approval(
    caller: &Caller,
    id: &str,
) -> Result<Option<(String, SocialApprovalStatus)>, DbErr> {
    social_approvals::Entity::find()
        .select_only()
        .columns([
            social_approvals::Column::PostId,
            social_approvals::Column::Status,
        ])
        .filter(social_approvals::Column::Id.eq(id))
        .filter(social_approvals::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
        .await
}

/// `update(socialApprovals).set({ status, decidedByUserId: userId,
/// decidedAt: now, decisionNotes, updatedAt: now }).where(eq(id))`; a
/// rejection sets its reason too.
fn decision(
    caller: &Caller,
    id: &str,
    status: SocialApprovalStatus,
    at: PrimitiveDateTime,
    notes: Option<String>,
) -> UpdateMany<social_approvals::Entity> {
    social_approvals::Entity::update_many()
        .col_expr(
            social_approvals::Column::Status,
            social_approvals::Column::Status.save_as(Expr::val(status)),
        )
        .col_expr(
            social_approvals::Column::DecidedByUserId,
            Expr::val(caller.user_id.as_str()),
        )
        .col_expr(social_approvals::Column::DecidedAt, Expr::val(at))
        .col_expr(social_approvals::Column::DecisionNotes, Expr::val(notes))
        .col_expr(social_approvals::Column::UpdatedAt, Expr::val(at))
        .filter(social_approvals::Column::Id.eq(id))
}

/// `readDecisionNotes`: the body's `decisionNotes` when it is a string; a
/// missing or unreadable body has none.
fn decision_notes(body: &Bytes) -> Option<String> {
    serde_json::from_slice::<Value>(body).ok().and_then(|body| {
        body.get("decisionNotes")
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}

/// `scheduleErrorMessage`.
fn schedule_error_message(error: &PublishError) -> String {
    match error {
        PublishError::NotConfigured => "Social publishing is not configured".to_owned(),
        PublishError::InsufficientCredits {
            current_balance,
            required,
        } => format!("Insufficient credits (need {required}, have {current_balance})"),
        other => other.to_string(),
    }
}

/// `POST /api/social-approvals/:id/approve`: approve, and schedule the post
/// when it already has a time (a failed schedule doesn't fail the approval).
async fn approve(
    State(state): State<SocialState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let notes = decision_notes(&body);
    match approve_inner(&state, &caller, &id, notes).await {
        Ok(response) => response,
        Err(error) => crate::internal(&error, "Failed to approve social post"),
    }
}

async fn approve_inner(
    state: &SocialState,
    caller: &Caller,
    id: &str,
    notes: Option<String>,
) -> Result<Response, DbErr> {
    let Some((post_id, status)) = live_approval(caller, id).await? else {
        return Ok(ApiError::not_found("Social approval", Some(id)).into_response());
    };
    if status != SocialApprovalStatus::Pending {
        return Ok(ApiError::conflict("Approval is not pending").into_response());
    }
    let Some(post) = live_post(caller, &post_id).await? else {
        return Ok(ApiError::not_found("Social post", Some(&post_id)).into_response());
    };
    let now = weldsuite_db::utc_now();
    decision(caller, id, SocialApprovalStatus::Approved, now, notes)
        .exec(&orm(&caller.db))
        .await?;
    social_posts::Entity::update_many()
        .col_expr(
            social_posts::Column::Status,
            social_posts::Column::Status.save_as(Expr::val(SocialPostStatus::Approved)),
        )
        .col_expr(social_posts::Column::ApprovedAt, Expr::val(now))
        .col_expr(
            social_posts::Column::ApprovedByUserId,
            Expr::val(caller.user_id.as_str()),
        )
        .col_expr(social_posts::Column::UpdatedAt, Expr::val(now))
        .filter(social_posts::Column::Id.eq(&post.id))
        .exec(&orm(&caller.db))
        .await?;

    // PostPeer switched off (ADR OPS-026): approved, but not scheduled there.
    let postpeer_off = match &post.scheduled_at {
        Some(_) => crate::postpeer_switch(&caller.db).await.err(),
        None => None,
    };
    let (scheduled, schedule_error, publish_result) = match &post.scheduled_at {
        None => (false, Value::Null, Value::Null),
        Some(_) if postpeer_off.is_some() => (
            false,
            json!(postpeer_off.as_ref().map(ToString::to_string)),
            Value::Null,
        ),
        Some(scheduled_at) => {
            let options = PublishOptions {
                now: false,
                scheduled_at: Some(scheduled_at.clone()),
                timezone: post.timezone.clone(),
            };
            match publish_post(
                &caller.db,
                &caller.context(state),
                caller.clerk_org_id.as_deref(),
                &post.id,
                &options,
            )
            .await
            {
                Ok(result) => {
                    let data = event(&[
                        ("id", Some(json!(post.id))),
                        ("status", Some(json!(result.status))),
                        ("scheduledAt", Some(json!(scheduled_at))),
                        ("postpeerPostId", result.postpeer_post_id.clone()),
                    ]);
                    caller.publish(state, ev::SOCIAL_POST_SCHEDULED, &post.id, &data);
                    (true, Value::Null, result.to_json())
                }
                Err(error) => {
                    tracing::error!(%error, "[social-api/social-approvals] auto-schedule after approve failed");
                    (false, json!(schedule_error_message(&error)), Value::Null)
                }
            }
        }
    };
    caller.publish(
        state,
        ev::SOCIAL_APPROVAL_UPDATED,
        id,
        &json!({ "id": id, "postId": post.id, "status": "approved" }),
    );
    Ok(Data(json!({
        "approvalId": id,
        "postId": post.id,
        "status": "approved",
        "scheduled": scheduled,
        "scheduleError": schedule_error,
        "publishResult": publish_result,
    }))
    .into_response())
}

/// `POST /api/social-approvals/:id/reject[?revision=1|true] { decisionNotes?, rejectionReason? }`.
async fn reject(
    State(state): State<SocialState>,
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, fields| {
        (
            issues
                .text(fields, "decisionNotes", Presence::Optional, None, None)
                .into_option(),
            issues
                .text(fields, "rejectionReason", Presence::Optional, None, None)
                .into_option(),
        )
    });
    let (notes, reason) = match input {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let revision = matches!(
        query_param(query.as_deref(), "revision").as_deref(),
        Some("1" | "true")
    );
    match reject_inner(&state, &caller, &id, notes, reason, revision).await {
        Ok(response) => response,
        Err(error) => crate::internal(&error, "Failed to reject social approval"),
    }
}

async fn reject_inner(
    state: &SocialState,
    caller: &Caller,
    id: &str,
    notes: Option<String>,
    reason: Option<String>,
    revision: bool,
) -> Result<Response, DbErr> {
    let Some((post_id, status)) = live_approval(caller, id).await? else {
        return Ok(ApiError::not_found("Social approval", Some(id)).into_response());
    };
    if status != SocialApprovalStatus::Pending {
        return Ok(ApiError::conflict("Approval is not pending").into_response());
    }
    let now = weldsuite_db::utc_now();
    let (next, status) = if revision {
        (
            "revision_requested",
            SocialApprovalStatus::RevisionRequested,
        )
    } else {
        ("rejected", SocialApprovalStatus::Rejected)
    };
    let reason = reason.or_else(|| notes.clone());
    decision(caller, id, status, now, notes)
        .col_expr(
            social_approvals::Column::RejectionReason,
            Expr::val(reason.clone()),
        )
        .exec(&orm(&caller.db))
        .await?;
    // A revision clears who rejected it and when.
    let rejected_at = (!revision).then_some(now);
    let rejected_by = (!revision).then(|| caller.user_id.clone());
    social_posts::Entity::update_many()
        .col_expr(
            social_posts::Column::Status,
            social_posts::Column::Status.save_as(Expr::val(SocialPostStatus::Draft)),
        )
        .col_expr(social_posts::Column::RejectedAt, Expr::val(rejected_at))
        .col_expr(
            social_posts::Column::RejectedByUserId,
            Expr::val(rejected_by),
        )
        .col_expr(social_posts::Column::RejectionReason, Expr::val(reason))
        .col_expr(social_posts::Column::UpdatedAt, Expr::val(now))
        .filter(social_posts::Column::Id.eq(&post_id))
        .filter(social_posts::Column::DeletedAt.is_null())
        .exec(&orm(&caller.db))
        .await?;
    caller.publish(
        state,
        ev::SOCIAL_APPROVAL_UPDATED,
        id,
        &json!({ "id": id, "postId": post_id, "status": next }),
    );
    caller.publish(
        state,
        ev::SOCIAL_POST_UPDATED,
        &post_id,
        &json!({ "id": post_id, "status": "draft" }),
    );
    Ok(Data(json!({ "approvalId": id, "postId": post_id, "status": next })).into_response())
}
