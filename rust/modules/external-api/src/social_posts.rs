//! WeldSocial's posts: `/v1/social-posts` (`routes/v1/social-posts/index.ts`).
//! CRUD on `social_posts`, and publishing, scheduling and cancelling through
//! the shared publishing service (`weldsuite_social_domain::publishing`, the
//! same claim against double submission, credit metering and delivery index
//! as the platform). Deleting a post first stops its PostPeer delivery.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Extension, Path, RawQuery, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    SOCIAL_POST_CANCELLED, SOCIAL_POST_CREATED, SOCIAL_POST_DELETED, SOCIAL_POST_FAILED,
    SOCIAL_POST_PUBLISHED, SOCIAL_POST_SCHEDULED, SOCIAL_POST_UPDATED,
};
use weldsuite_db::PgPool;
use weldsuite_kit::RequestEnv;
use weldsuite_kit::id::generate_id;
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
};
use weldsuite_social_domain::publishing::{self, Context, PublishError, PublishOptions};

use crate::ExternalApiState;
use crate::crud::{
    Answer, Caller, Fail, created, dates, field, get_live, no_content, now, ok, page, soft_delete,
    table_list_sql, text, with_updated,
};
use crate::schemas::{LIST_SOCIAL_POSTS, SCHEDULE_SOCIAL_POST};
use crate::schemas_gen::{CREATE_SOCIAL_POST, UPDATE_SOCIAL_POST};
use crate::session::{bad_request, conflict, internal_with, not_found};
use crate::simple::scoped;
use crate::tables_gen::SOCIAL_POSTS;
use crate::zod;

type S = State<ExternalApiState>;
/// The request's env and outbound client (conformance builds give the
/// test's), else the process's and the state's.
type Env = Option<Extension<RequestEnv>>;
type Http = Option<Extension<OutboundHttp>>;

/// The posts' routes.
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    router
        .route(
            "/social-posts",
            scoped(get(list_posts), "social_posts:read")
                .merge(scoped(post(create_post), "social_posts:write")),
        )
        .route(
            "/social-posts/{id}",
            scoped(get(get_post), "social_posts:read").merge(scoped(
                patch(update_post).delete(delete_post),
                "social_posts:write",
            )),
        )
        .route(
            "/social-posts/{id}/publish",
            scoped(post(publish), "social_posts:write"),
        )
        .route(
            "/social-posts/{id}/schedule",
            scoped(post(schedule), "social_posts:write"),
        )
        .route(
            "/social-posts/{id}/cancel",
            scoped(post(cancel), "social_posts:write"),
        )
}

/// `stripServerFields(body)`.
fn strip_server_fields(values: &mut Map<String, Value>) {
    for key in [
        "id",
        "createdAt",
        "updatedAt",
        "deletedAt",
        "connectedByUserId",
        "createdByUserId",
        "uploadedByUserId",
    ] {
        values.remove(key);
    }
}

const POSTS_LIST: (&str, &str) = table_list_sql!(
    social_posts,
    "t.deleted_at is null \
     and ($3->>'status' is null or t.status::text = $3->>'status') \
     and ($3->>'campaignId' is null or t.campaign_id = $3->>'campaignId')"
);

async fn list_posts(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_SOCIAL_POSTS, raw.as_deref())?;
    let filters = json!({ "status": text(&q, "status"), "campaignId": text(&q, "campaignId") });
    page(&caller.db, POSTS_LIST, &SOCIAL_POSTS, &q, filters).await
}

async fn get_post(caller: Caller, Path(id): Path<String>) -> Answer {
    get_live(&caller.db, &SOCIAL_POSTS, "SocialPost", &id).await
}

async fn create_post(State(state): S, caller: Caller, headers: HeaderMap, body: Bytes) -> Answer {
    let parsed = zod::json(&CREATE_SOCIAL_POST, &headers, &body)?;
    let body = &parsed.body;
    let stamp = now();
    let id = generate_id("socp");
    let mut values = body.clone();
    strip_server_fields(&mut values);
    let present = |key: &str| body.get(key).filter(|v| !v.is_null()).cloned();
    values.insert("id".into(), json!(id));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    // NOT NULL: content, targetAccountIds, createdByUserId.
    values.insert("content".into(), present("content").unwrap_or(json!("")));
    values.insert(
        "targetAccountIds".into(),
        present("targetAccountIds")
            .or_else(|| present("accountIds"))
            .unwrap_or(json!([])),
    );
    values.insert("createdByUserId".into(), json!(caller.session.actor()));
    let row = SOCIAL_POSTS
        .insert(
            &caller.db,
            &values,
            &dates(&parsed, &["createdAt", "updatedAt"]),
        )
        .await?;
    caller.publish(
        &state.events,
        SOCIAL_POST_CREATED,
        &id,
        json!({
            "id": id,
            "status": field(&row, "status"),
            "createdByUserId": field(&row, "createdByUserId"),
        }),
    );
    created(row)
}

async fn update_post(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_SOCIAL_POST, &headers, &body)?;
    let mut values = parsed.body.clone();
    strip_server_fields(&mut values);
    let row = SOCIAL_POSTS
        .patch(
            &caller.db,
            &id,
            &with_updated(&values, &now()),
            true,
            &dates(&parsed, &["updatedAt"]),
        )
        .await?
        .ok_or_else(|| not_found("SocialPost", &id))?;
    caller.publish(
        &state.events,
        SOCIAL_POST_UPDATED,
        &id,
        json!({ "id": id, "status": field(&row, "status") }),
    );
    ok(row)
}

// ── publishing ───────────────────────────────────────────────────────────────

/// `socialContext(c.env)`: PostPeer's settings, the master database and the
/// HTTP client.
fn context(
    state: &ExternalApiState,
    caller: &Caller,
    env: Option<&RequestEnv>,
    http: Option<OutboundHttp>,
) -> Context {
    let value = |name: &str| {
        match env {
            Some(env) => env.get(name).map(str::to_owned),
            None => std::env::var(name).ok(),
        }
        .filter(|value| !value.is_empty())
    };
    Context {
        api_key: value("POSTPEER_API_KEY"),
        base_url: value("POSTPEER_BASE_URL"),
        app_ids: value("POSTPEER_APP_IDS"),
        master: Some(crate::master_db_of(state, caller)),
        http: http
            .or_else(|| state.http.clone())
            .unwrap_or_else(|| OutboundHttp(Arc::new(Unreachable))),
    }
}

/// A deployment without an HTTP client: every call fails like a `fetch`
/// that can't connect.
struct Unreachable;

impl DynOutboundHttp for Unreachable {
    fn send(&self, _request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        Box::pin(std::future::ready(Err(PortError::backend(
            "no outbound HTTP client",
        ))))
    }
}

/// `resolveClerkOrgId(env, workspaceId)`: the workspace's org id in the
/// master database; a failed read is the worker's 500.
async fn clerk_org_id(master: &PgPool, caller: &Caller) -> Result<Option<String>, Fail> {
    let org: Option<Option<String>> =
        sqlx::query_scalar("select clerk_org_id from workspaces where id = $1 limit 1")
            .bind(&caller.session.workspace_id)
            .fetch_optional(master)
            .await?;
    Ok(org.flatten())
}

/// The org id, or `Workspace is not linked to an organization`.
async fn require_org(master: &PgPool, caller: &Caller) -> Result<String, Fail> {
    clerk_org_id(master, caller)
        .await?
        .ok_or_else(|| internal_with("Workspace is not linked to an organization").into())
}

/// A live post's id, or the v1 404.
async fn require_post(caller: &Caller, id: &str) -> Result<(), Fail> {
    match SOCIAL_POSTS.find_live(&caller.db, id).await? {
        Some(_) => Ok(()),
        None => Err(not_found("SocialPost", id).into()),
    }
}

/// `publishErrorResponse(c, err)`.
fn publish_error(error: &PublishError) -> Fail {
    match error {
        PublishError::NotConfigured => Fail(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(json!({
                    "error": {
                        "code": "SOCIAL_PUBLISHING_NOT_CONFIGURED",
                        "message": "Social publishing is not configured",
                    }
                })),
            )
                .into_response(),
        ),
        PublishError::Conflict(message) => conflict(message.clone()).into(),
        PublishError::InsufficientCredits {
            current_balance,
            required,
        } => Fail(
            (
                StatusCode::PAYMENT_REQUIRED,
                axum::Json(json!({
                    "error": {
                        "code": "INSUFFICIENT_CREDITS",
                        "message": error.to_string(),
                        "details": {
                            "currentBalance": current_balance,
                            "required": required,
                            "shortfall": required - current_balance,
                        },
                    }
                })),
            )
                .into_response(),
        ),
        _ => {
            let message = error.to_string();
            tracing::error!(%message, "[external-api/social-posts] publish failed");
            // A post with no targets, or none of them connected, is a
            // caller error.
            if message == "Post has no target accounts"
                || message == "No PostPeer-connected accounts among the post targets"
            {
                bad_request(message).into()
            } else {
                internal_with(message).into()
            }
        }
    }
}

/// `publishOrSchedule(c, id, options)`.
async fn publish_or_schedule(
    state: &ExternalApiState,
    caller: &Caller,
    id: &str,
    options: &PublishOptions,
    env: Env,
    http: Http,
) -> Answer {
    require_post(caller, id).await?;
    let master = crate::master_db_of(state, caller);
    let org = require_org(&master, caller).await?;
    let ctx = context(
        state,
        caller,
        env.as_ref().map(|Extension(env)| env),
        http.map(|Extension(http)| http),
    );
    let result = publishing::publish_post(&caller.db, &ctx, Some(&org), id, options)
        .await
        .map_err(|error| publish_error(&error))?;
    let event = if !options.now {
        SOCIAL_POST_SCHEDULED
    } else if result.status == "failed" {
        SOCIAL_POST_FAILED
    } else {
        SOCIAL_POST_PUBLISHED
    };
    let mut data = Map::new();
    data.insert("id".into(), json!(id));
    data.insert("status".into(), json!(result.status));
    if let Some(upstream) = &result.postpeer_post_id {
        data.insert("postpeerPostId".into(), upstream.clone());
    }
    caller.publish(&state.events, event, id, Value::Object(data));
    ok(result.to_json())
}

async fn publish(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    env: Env,
    http: Http,
) -> Answer {
    let options = PublishOptions {
        now: true,
        scheduled_at: None,
        timezone: None,
    };
    publish_or_schedule(&state, &caller, &id, &options, env, http).await
}

async fn schedule(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    env: Env,
    http: Http,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&SCHEDULE_SOCIAL_POST, &headers, &body)?;
    let options = PublishOptions {
        now: false,
        scheduled_at: parsed.text("scheduledAt").map(str::to_owned),
        timezone: parsed.text("timezone").map(str::to_owned),
    };
    publish_or_schedule(&state, &caller, &id, &options, env, http).await
}

/// Cancel a scheduled post, keeping the record (and refunding its credits).
async fn cancel(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    env: Env,
    http: Http,
) -> Answer {
    let master = crate::master_db_of(&state, &caller);
    let org = require_org(&master, &caller).await?;
    let ctx = context(
        &state,
        &caller,
        env.as_ref().map(|Extension(env)| env),
        http.map(|Extension(http)| http),
    );
    match publishing::cancel_post(&caller.db, &ctx, Some(&org), &id).await {
        Ok(true) => {}
        Ok(false) => return Err(not_found("SocialPost", &id).into()),
        Err(PublishError::Conflict(message)) => return Err(conflict(message).into()),
        Err(error) => {
            let message = error.to_string();
            tracing::error!(%message, "[external-api/social-posts] cancel failed");
            return Err(internal_with(message).into());
        }
    }
    caller.publish(
        &state.events,
        SOCIAL_POST_CANCELLED,
        &id,
        json!({ "id": id, "status": "cancelled" }),
    );
    ok(json!({ "id": id, "status": "cancelled" }))
}

async fn delete_post(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    env: Env,
    http: Http,
) -> Answer {
    require_post(&caller, &id).await?;
    // Stop the upstream delivery before the row goes away; fail closed.
    let master = crate::master_db_of(&state, &caller);
    let org = require_org(&master, &caller).await?;
    let ctx = context(
        &state,
        &caller,
        env.as_ref().map(|Extension(env)| env),
        http.map(|Extension(http)| http),
    );
    if let Err(error) =
        publishing::cancel_delivery_before_delete(&caller.db, &ctx, Some(&org), &id).await
    {
        let message = error.to_string();
        tracing::error!(%message, "[external-api/social-posts] failed to cancel delivery before deleting {id}");
        return Err(internal_with(message).into());
    }
    soft_delete(&caller.db, &SOCIAL_POSTS, &id)
        .await?
        .ok_or_else(|| not_found("SocialPost", &id))?;
    caller.publish(&state.events, SOCIAL_POST_DELETED, &id, json!({ "id": id }));
    no_content()
}
