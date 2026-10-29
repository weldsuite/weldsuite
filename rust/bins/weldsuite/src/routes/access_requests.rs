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
use serde_json::{Value, json};
use weldsuite_auth::AuthContext;
use weldsuite_db::{PgPool, Tenant, js_row};
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, Created, Data, List, Pagination, generate_id};
use weldsuite_permissions::{Permissions, check_permission_grants, is_grantable_permission_key};
use weldsuite_ports::{DynRealtimePublisher, RealtimeMessage};

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

async fn fetch_row(
    db: &PgPool,
    sql: &'static str,
    binds: &[&str],
) -> Result<Option<Value>, sqlx::Error> {
    let mut query = sqlx::query_scalar::<_, Value>(sql);
    for bind in binds {
        query = query.bind(*bind);
    }
    Ok(query.fetch_optional(db).await?.map(js_row))
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
) -> Result<CreatedRequest, sqlx::Error> {
    let requester_name: Option<Option<String>> = sqlx::query_scalar(
        "select name from workspace_members where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(requester_id)
    .fetch_optional(db)
    .await?;

    if let Some(existing) = fetch_row(
        db,
        "select to_jsonb(a) from access_requests a
         where requester_id = $1 and permission = $2 and status = 'pending'
         order by created_at desc limit 1",
        &[requester_id, permission],
    )
    .await?
    {
        return Ok(CreatedRequest {
            request: existing,
            deduped: true,
            notifications: Vec::new(),
        });
    }

    let request: Value = sqlx::query_scalar(
        "insert into access_requests
             (id, requester_id, permission, page_label, page_path, status, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 'pending',
                 date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', clock_timestamp()))
         returning to_jsonb(access_requests)",
    )
    .bind(generate_id("areq"))
    .bind(requester_id)
    .bind(permission)
    .bind(page_label)
    .bind(page_path)
    .fetch_one(db)
    .await?;
    let request = js_row(request);
    let request_id = request["id"].as_str().unwrap_or_default().to_owned();

    let admins: Vec<String> = sqlx::query_scalar(
        "select user_id from workspace_members where role = any($1) and deleted_at is null",
    )
    .bind(ADMIN_ROLES.map(str::to_owned).to_vec())
    .fetch_all(db)
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
            let row: Value = sqlx::query_scalar(
                "insert into notifications
                     (id, user_id, title, body, category, notification_type, entity_type, entity_id,
                      action_url, actor_type, actor_id, icon, severity, data)
                 values ($1, $2, 'Access request', $3, 'security', 'access_request', 'access_request', $4,
                         '/settings/team', 'user', $5, 'lock', 'info', $6)
                 returning to_jsonb(notifications)",
            )
            .bind(generate_id("ntf"))
            .bind(user)
            .bind(&body)
            .bind(&request_id)
            .bind(requester_id)
            .bind(&data)
            .fetch_one(db)
            .await?;
            notifications.push(js_row(row));
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
) -> Result<Outcome, sqlx::Error> {
    let Some(existing) = fetch_row(
        db,
        "select to_jsonb(a) from access_requests a where id = $1 limit 1",
        &[request_id],
    )
    .await?
    else {
        return Ok(Outcome::NotFound);
    };
    if existing["status"] != "pending" {
        return Ok(Outcome::AlreadyResolved);
    }
    let requester_id = existing["requesterId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let permission = existing["permission"]
        .as_str()
        .unwrap_or_default()
        .to_owned();

    if status == "approved" && !grant(db, &requester_id, &permission, grantor).await? {
        // Left pending, so someone who does hold the permission can approve it.
        return Ok(Outcome::Ungrantable);
    }

    let request: Value = sqlx::query_scalar(
        "update access_requests
         set status = $2, resolved_by = $3,
             resolved_at = date_trunc('milliseconds', clock_timestamp()),
             updated_at = date_trunc('milliseconds', clock_timestamp())
         where id = $1
         returning to_jsonb(access_requests)",
    )
    .bind(request_id)
    .bind(status)
    .bind(resolver_id)
    .fetch_one(db)
    .await?;
    let request = js_row(request);

    // Stamp the admins' original notifications with the outcome and mark them
    // read, so the panel shows "Approved"/"Denied" and the badge settles.
    sqlx::query(
        "update notifications
         set data = coalesce(data, '{}'::jsonb)
                    || jsonb_build_object('resolvedStatus', $2::text, 'resolvedBy', $3::text),
             is_read = true,
             read_at = date_trunc('milliseconds', clock_timestamp())
         where entity_type = 'access_request' and entity_id = $1",
    )
    .bind(request_id)
    .bind(status)
    .bind(resolver_id)
    .execute(db)
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
    let notification: Value = sqlx::query_scalar(
        "insert into notifications
             (id, user_id, title, body, category, notification_type, entity_type, entity_id,
              action_url, actor_type, actor_id, icon, severity, data)
         values ($1, $2, $3, $4, 'security', 'access_request_resolved', 'access_request', $5,
                 $6, 'user', $7, $8, $9, $10)
         returning to_jsonb(notifications)",
    )
    .bind(generate_id("ntf"))
    .bind(&requester_id)
    .bind(title)
    .bind(body)
    .bind(request_id)
    .bind(existing["pagePath"].as_str())
    .bind(resolver_id)
    .bind(icon)
    .bind(severity)
    .bind(json!({ "accessRequestId": request_id, "permission": permission, "status": status }))
    .fetch_one(db)
    .await?;

    Ok(Outcome::Resolved {
        request,
        requester_id,
        requester_notification: js_row(notification),
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
) -> Result<bool, sqlx::Error> {
    let member: Option<(String, Option<Value>)> = sqlx::query_as(
        "select id, permissions from workspace_members
         where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(requester_id)
    .fetch_optional(db)
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
        sqlx::query(
            "update workspace_members
             set permissions = $2, updated_at = date_trunc('milliseconds', clock_timestamp())
             where id = $1",
        )
        .bind(member_id)
        .bind(Value::Array(next))
        .execute(db)
        .await?;
    }
    Ok(true)
}

// ── GET /me/pending ─────────────────────────────────────────────────────────

pub(crate) async fn my_pending(auth: AuthContext, tenant: Tenant) -> Response {
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(a) from access_requests a
         where requester_id = $1 and status = 'pending'
         order by created_at desc",
    )
    .bind(&auth.user_id)
    .fetch_all(&tenant.db)
    .await;
    match rows {
        Ok(rows) => {
            let rows: Vec<Value> = rows.into_iter().map(js_row).collect();
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
