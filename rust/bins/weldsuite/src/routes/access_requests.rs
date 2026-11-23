//! `/api/access-requests` (`app-api/src/routes/access-requests/index.ts`,
//! `services/access-requests.ts`): a member asks for a permission they lack;
//! every OWNER and ADMIN is notified, and resolving needs `team:update` plus
//! holding the permission (the grant ceiling).
//!
//! - `POST /`: ask. A pending request for the same permission is returned
//!   instead of a new one (200 rather than 201).
//! - `PATCH /:id`: approve or deny. Approving adds the key to the requester's
//!   per-member extras; a key the resolver can't grant is refused and the
//!   request stays pending.
//! - `GET /me/pending`: the caller's pending requests.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::header::CONTENT_TYPE;
use http::{HeaderMap, StatusCode};
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde::Serialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_auth::AuthContext;
use weldsuite_db::{PgPool, Tenant, orm, utc_now};
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, Created, Data, List, Pagination, generate_id};
use weldsuite_permissions::{Permissions, check_permission_grants, is_grantable_permission_key};
use weldsuite_ports::{DynRealtimePublisher, RealtimeMessage};
use weldsuite_schema::tenant::{access_requests, notifications, workspace_members};

use crate::server::AppState;

/// The roles whose members are asked to resolve a request.
const ADMIN_ROLES: [&str; 2] = ["OWNER", "ADMIN"];

fn content_type(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
}

/// Publish to the workspace's realtime hub without holding up the response
/// (`c.executionCtx.waitUntil`); a failure is logged.
fn publish_later(state: &AppState, messages: Vec<RealtimeMessage>) {
    let Some(realtime) = state.infra.realtime.clone() else {
        return;
    };
    state.infra.events.tracker().spawn(async move {
        for message in messages {
            if let Err(error) = DynRealtimePublisher::publish_boxed(&*realtime, &message).await {
                tracing::error!(%error, "access requests: realtime publish failed");
            }
        }
    });
}

/// `RealtimePublisher.notify`: the notification row on the recipient's
/// personal `notification.<userId>` topic.
fn notify(clerk_org_id: &str, user_id: &str, notification: &Value) -> RealtimeMessage {
    RealtimeMessage::personal(
        clerk_org_id,
        &format!("notification.{user_id}"),
        "created",
        notification.clone(),
        user_id,
    )
}

/// A row as the route returns it: the entity serializes as Drizzle did.
fn row_json(model: impl Serialize) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// `date_trunc('milliseconds', clock_timestamp())`: now, to the millisecond.
fn now_ms() -> OffsetDateTime {
    utc_now().assume_utc()
}

/// `insert into notifications (…) returning *`: one in-app notification of
/// an access request, as the route returns it.
async fn insert_notification(
    db: &PgPool,
    notification: notifications::ActiveModel,
) -> Result<Value, DbErr> {
    let row = notifications::Entity::insert(notification)
        .exec_with_returning(&orm(db))
        .await?;
    row_json(row)
}

// ── POST / ──────────────────────────────────────────────────────────────────

pub(crate) async fn create(
    State(state): State<AppState>,
    auth: AuthContext,
    tenant: Tenant,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match json_body(content_type(&headers), &body) {
        Ok(body) => body,
        Err(malformed) => return malformed.into_response(),
    };
    let mut issues = Issues::default();
    let (permission, page_label, page_path) = match issues.object(&body) {
        Some(fields) => (
            issues.string(fields, "permission", true, Some(1), Some(100)),
            issues.string(fields, "pageLabel", false, None, Some(120)),
            issues.string(fields, "pagePath", false, None, Some(255)),
        ),
        None => (None, None, None),
    };
    if let Err(invalid) = issues.finish() {
        return invalid.into_response();
    }
    let permission = permission.unwrap_or_default();
    // Only real keys can be requested, never `*`: approving one writes it
    // into the requester's own grants.
    if !is_grantable_permission_key(&permission) {
        return ApiError::bad_request("Unknown permission")
            .with_details(json!({ "field": "permission" }))
            .into_response();
    }

    match create_request(
        &tenant.db,
        &auth.user_id,
        &permission,
        page_label.as_deref(),
        page_path.as_deref(),
    )
    .await
    {
        Ok(created) => {
            if !created.deduped
                && let Some(org) = tenant.clerk_org_id.as_deref()
            {
                let messages = created
                    .notifications
                    .iter()
                    .filter_map(|n| n["userId"].as_str().map(|user| notify(org, user, n)))
                    .collect::<Vec<_>>();
                if !messages.is_empty() {
                    publish_later(&state, messages);
                }
            }
            if created.deduped {
                Data(created.request).into_response()
            } else {
                Created(created.request).into_response()
            }
        }
        Err(error) => {
            tracing::error!(%error, "access requests: create failed");
            ApiError::internal()
                .with_message("Failed to submit access request")
                .into_response()
        }
    }
}

struct CreatedRequest {
    request: Value,
    deduped: bool,
    notifications: Vec<Value>,
}

async fn create_request(
    db: &PgPool,
    requester_id: &str,
    permission: &str,
    page_label: Option<&str>,
    page_path: Option<&str>,
) -> Result<CreatedRequest, DbErr> {
    let requester_name: Option<Option<String>> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::Name)
        .filter(workspace_members::Column::UserId.eq(requester_id))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;

    let existing = access_requests::Entity::find()
        .filter(access_requests::Column::RequesterId.eq(requester_id))
        .filter(access_requests::Column::Permission.eq(permission))
        .filter(access_requests::Column::Status.eq("pending"))
        .order_by_desc(access_requests::Column::CreatedAt)
        .one(&orm(db))
        .await?;
    if let Some(existing) = existing {
        return Ok(CreatedRequest {
            request: row_json(existing)?,
            deduped: true,
            notifications: Vec::new(),
        });
    }

    let now = now_ms();
    let request = access_requests::Entity::insert(access_requests::ActiveModel {
        id: Set(generate_id("areq")),
        requester_id: Set(requester_id.to_owned()),
        permission: Set(permission.to_owned()),
        page_label: Set(page_label.map(str::to_owned)),
        page_path: Set(page_path.map(str::to_owned)),
        status: Set("pending".to_owned()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    let request_id = request.id.clone();
    let request = row_json(request)?;

    let admins: Vec<String> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::UserId)
        .filter(workspace_members::Column::Role.is_in(ADMIN_ROLES))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    let recipients: Vec<String> = admins
        .into_iter()
        .filter(|user| !user.is_empty() && user != requester_id)
        .collect();

    let mut notifications = Vec::with_capacity(recipients.len());
    if !recipients.is_empty() {
        let requester = requester_name
            .flatten()
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "A team member".to_owned());
        let page = page_label
            .map(|label| format!(" to access {label}"))
            .unwrap_or_default();
        let body = format!("{requester} is requesting the \"{permission}\" permission{page}.");
        let data = json!({
            "accessRequestId": request_id,
            "permission": permission,
            "pageLabel": page_label,
            "pagePath": page_path,
            "requesterId": requester_id,
        });
        for user in &recipients {
            let row = insert_notification(
                db,
                notifications::ActiveModel {
                    id: Set(generate_id("ntf")),
                    user_id: Set(user.clone()),
                    title: Set("Access request".to_owned()),
                    body: Set(Some(body.clone())),
                    category: Set("security".to_owned()),
                    notification_type: Set("access_request".to_owned()),
                    entity_type: Set(Some("access_request".to_owned())),
                    entity_id: Set(Some(request_id.clone())),
                    action_url: Set(Some("/settings/team".to_owned())),
                    actor_type: Set(Some("user".to_owned())),
                    actor_id: Set(Some(requester_id.to_owned())),
                    icon: Set(Some("lock".to_owned())),
                    severity: Set("info".to_owned()),
                    data: Set(Some(data.clone())),
                    ..Default::default()
                },
            )
            .await?;
            notifications.push(row);
        }
    }

    Ok(CreatedRequest {
        request,
        deduped: false,
        notifications,
    })
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

pub(crate) async fn resolve(
    State(state): State<AppState>,
    auth: AuthContext,
    tenant: Tenant,
    permissions: Permissions,
    Path(request_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match json_body(content_type(&headers), &body) {
        Ok(body) => body,
        Err(malformed) => return malformed.into_response(),
    };
    let mut issues = Issues::default();
    let status = issues
        .object(&body)
        .and_then(|fields| issues.one_of(fields, "status", &["approved", "denied"]));
    if let Err(invalid) = issues.finish() {
        return invalid.into_response();
    }
    let status = status.unwrap_or_default();

    match resolve_request(
        &tenant.db,
        &request_id,
        &auth.user_id,
        &status,
        &permissions,
    )
    .await
    {
        Ok(Outcome::NotFound) => {
            ApiError::not_found("Access request", Some(&request_id)).into_response()
        }
        Ok(Outcome::Ungrantable) => ApiError::forbidden()
            .with_message("You cannot grant permissions you do not hold yourself")
            .into_response(),
        Ok(Outcome::AlreadyResolved) => {
            ApiError::conflict("Access request has already been resolved").into_response()
        }
        Ok(Outcome::Resolved {
            request,
            requester_id,
            requester_notification,
        }) => {
            if let Some(org) = tenant.clerk_org_id.as_deref() {
                publish_later(
                    &state,
                    vec![
                        notify(org, &requester_id, &requester_notification),
                        RealtimeMessage::workspace(
                            org,
                            "access_request",
                            "resolved",
                            json!({
                                "accessRequestId": request["id"],
                                "status": request["status"],
                                "resolvedBy": auth.user_id,
                            }),
                            &auth.user_id,
                        ),
                    ],
                );
            }
            Data(request).into_response()
        }
        Err(error) => {
            tracing::error!(%error, "access requests: resolve failed");
            ApiError::internal()
                .with_message("Failed to resolve access request")
                .into_response()
        }
    }
}

enum Outcome {
    NotFound,
    /// Approval refused: the permission isn't grantable or not held by the resolver.
    Ungrantable,
    AlreadyResolved,
    Resolved {
        request: Value,
        requester_id: String,
        requester_notification: Value,
    },
}

async fn resolve_request(
    db: &PgPool,
    request_id: &str,
    resolver_id: &str,
    status: &str,
    grantor: &Permissions,
) -> Result<Outcome, DbErr> {
    let Some(existing) = access_requests::Entity::find_by_id(request_id.to_owned())
        .one(&orm(db))
        .await?
    else {
        return Ok(Outcome::NotFound);
    };
    if existing.status != "pending" {
        return Ok(Outcome::AlreadyResolved);
    }
    let requester_id = existing.requester_id;
    let permission = existing.permission;

    if status == "approved" && !grant(db, &requester_id, &permission, grantor).await? {
        // Left pending, so someone who does hold the permission can approve it.
        return Ok(Outcome::Ungrantable);
    }

    let resolved_at = now_ms();
    let request = access_requests::Entity::update_many()
        .col_expr(access_requests::Column::Status, Expr::value(status))
        .col_expr(
            access_requests::Column::ResolvedBy,
            Expr::value(resolver_id),
        )
        .col_expr(
            access_requests::Column::ResolvedAt,
            Expr::value(resolved_at),
        )
        .col_expr(access_requests::Column::UpdatedAt, Expr::value(resolved_at))
        .filter(access_requests::Column::Id.eq(request_id))
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| DbErr::RecordNotFound("access_requests".to_owned()))?;
    let request = row_json(request)?;

    // Stamp the admins' original notifications with the outcome and mark them
    // read, so the panel shows "Approved"/"Denied" and the badge settles.
    // `coalesce(data, '{}'::jsonb) || jsonb_build_object(…)`.
    let stamped = sea_orm::sea_query::extension::postgres::PgExpr::concat(
        Expr::from(Func::coalesce([
            Expr::col(notifications::Column::Data),
            Expr::val(json!({})),
        ])),
        Expr::val(json!({ "resolvedStatus": status, "resolvedBy": resolver_id })),
    );
    notifications::Entity::update_many()
        .col_expr(notifications::Column::Data, stamped)
        .col_expr(notifications::Column::IsRead, Expr::value(true))
        .col_expr(notifications::Column::ReadAt, Expr::value(now_ms()))
        .filter(notifications::Column::EntityType.eq("access_request"))
        .filter(notifications::Column::EntityId.eq(request_id))
        .exec(&orm(db))
        .await?;

    let approved = status == "approved";
    let (title, body, icon, severity) = if approved {
        (
            "Access request approved",
            format!("You now have the \"{permission}\" permission."),
            "check",
            "success",
        )
    } else {
        (
            "Access request denied",
            format!("Your request for \"{permission}\" was denied."),
            "x",
            "info",
        )
    };
    let notification = insert_notification(
        db,
        notifications::ActiveModel {
            id: Set(generate_id("ntf")),
            user_id: Set(requester_id.clone()),
            title: Set(title.to_owned()),
            body: Set(Some(body)),
            category: Set("security".to_owned()),
            notification_type: Set("access_request_resolved".to_owned()),
            entity_type: Set(Some("access_request".to_owned())),
            entity_id: Set(Some(request_id.to_owned())),
            action_url: Set(existing.page_path),
            actor_type: Set(Some("user".to_owned())),
            actor_id: Set(Some(resolver_id.to_owned())),
            icon: Set(Some(icon.to_owned())),
            severity: Set(severity.to_owned()),
            data: Set(Some(json!({
                "accessRequestId": request_id,
                "permission": permission,
                "status": status,
            }))),
            ..Default::default()
        },
    )
    .await?;

    Ok(Outcome::Resolved {
        request,
        requester_id,
        requester_notification: notification,
    })
}

/// Add the requested key to the requester's per-member extras, under the
/// grant ceiling. `false` when the resolver may not grant it; `true` when it
/// was granted or the requester has no active membership to grant to.
async fn grant(
    db: &PgPool,
    requester_id: &str,
    permission: &str,
    grantor: &Permissions,
) -> Result<bool, DbErr> {
    let member: Option<(String, Option<Value>)> = workspace_members::Entity::find()
        .select_only()
        .columns([
            workspace_members::Column::Id,
            workspace_members::Column::Permissions,
        ])
        .filter(workspace_members::Column::UserId.eq(requester_id))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let Some((member_id, stored)) = member else {
        return Ok(true);
    };
    let current: Vec<String> = stored
        .as_ref()
        .and_then(Value::as_array)
        .map(|keys| {
            keys.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if !check_permission_grants(grantor.resolved(), &[permission], &current).ok {
        return Ok(false);
    }
    if !current.iter().any(|key| key == permission) {
        let mut next = stored
            .and_then(|value| match value {
                Value::Array(keys) => Some(keys),
                _ => None,
            })
            .unwrap_or_default();
        next.push(Value::String(permission.to_owned()));
        workspace_members::Entity::update_many()
            .col_expr(
                workspace_members::Column::Permissions,
                Expr::value(Value::Array(next)),
            )
            .col_expr(workspace_members::Column::UpdatedAt, Expr::value(now_ms()))
            .filter(workspace_members::Column::Id.eq(member_id))
            .exec(&orm(db))
            .await?;
    }
    Ok(true)
}

// ── GET /me/pending ─────────────────────────────────────────────────────────

pub(crate) async fn my_pending(auth: AuthContext, tenant: Tenant) -> Response {
    let rows = access_requests::Entity::find()
        .filter(access_requests::Column::RequesterId.eq(&auth.user_id))
        .filter(access_requests::Column::Status.eq("pending"))
        .order_by_desc(access_requests::Column::CreatedAt)
        .all(&orm(&tenant.db))
        .await
        .and_then(|rows| {
            rows.into_iter()
                .map(row_json)
                .collect::<Result<Vec<_>, _>>()
        });
    match rows {
        Ok(rows) => {
            let total = u64::try_from(rows.len()).unwrap_or(u64::MAX);
            List::new(rows, Pagination::new(total, false, None)).into_response()
        }
        Err(error) => {
            tracing::error!(%error, "access requests: list me/pending failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                ApiError::internal().with_message("Failed to list access requests"),
            )
                .into_response()
        }
    }
}
