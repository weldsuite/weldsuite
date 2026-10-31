//! `/api/social-analytics`: read-only aggregates (overview, dashboard
//! stats, search) and pulling a post's metrics from PostPeer.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_core_domain::js::{number_value, slice_utf16};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_social_domain::publishing::{PublishError, sync_analytics};

use crate::js::query_param;
use crate::{Caller, SocialState};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<SocialState> {
    let read = || gate.require([perm::ANALYTICS_READ]);
    Router::new()
        .route(
            "/{post_id}/sync",
            post(sync).route_layer(gate.require([perm::POSTS_UPDATE])),
        )
        .route("/overview", get(overview).route_layer(read()))
        .route("/stats", get(stats).route_layer(read()))
        .route("/search", get(search).route_layer(read()))
}

/// `POST /api/social-analytics/:postId/sync`.
async fn sync(
    State(state): State<SocialState>,
    caller: Caller,
    Path(post_id): Path<String>,
) -> Response {
    match sync_analytics(&caller.db, &caller.context(&state), &post_id).await {
        Ok(result) => Data(result).into_response(),
        Err(PublishError::NotConfigured) => {
            ApiError::bad_request("Social publishing is not configured").into_response()
        }
        Err(error) => crate::internal(&error, "Failed to sync analytics"),
    }
}

/// A lifetime snapshot's impressions, reach, engagement and clicks.
type Totals = (Option<i64>, Option<i64>, Option<i32>, Option<i32>);

/// `Number(value) || 0`.
fn number_or_zero(value: &Value) -> f64 {
    let number = match value {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(text) => weldsuite_kit::validation::js_number(text),
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        _ => 0.0,
    };
    if number.is_nan() { 0.0 } else { number }
}

/// `GET /api/social-analytics/overview`: lifetime totals and the active
/// accounts' platforms.
async fn overview(caller: Caller) -> Response {
    match overview_of(&caller).await {
        Ok(body) => Data(body).into_response(),
        Err(error) => crate::internal(&error, "Failed to fetch analytics overview"),
    }
}

async fn overview_of(caller: &Caller) -> Result<Value, sqlx::Error> {
    let analytics: Vec<Totals> = sqlx::query_as(
        "select impressions, reach, total_engagement, clicks from social_analytics
         where snapshot_period = 'lifetime'",
    )
    .fetch_all(&caller.db)
    .await?;
    let (mut impressions, mut reach, mut engagement, mut clicks) = (0.0, 0.0, 0.0, 0.0);
    for (i, r, e, c) in analytics {
        #[allow(clippy::cast_precision_loss)]
        {
            impressions += i.map_or(0.0, |v| number_or_zero(&json!(v)));
            reach += r.map_or(0.0, |v| v as f64);
            engagement += e.map_or(0.0, f64::from);
            clicks += c.map_or(0.0, f64::from);
        }
    }
    let rate = if impressions > 0.0 {
        engagement / impressions * 100.0
    } else {
        0.0
    };
    let accounts: Vec<(String, String, Option<i32>)> = sqlx::query_as(
        "select id, platform::text, follower_count from social_accounts
         where status = 'active' and deleted_at is null",
    )
    .fetch_all(&caller.db)
    .await?;
    let posts: Vec<Option<Value>> = sqlx::query_scalar(
        "select target_account_ids from social_posts where status = 'published' and deleted_at is null",
    )
    .fetch_all(&caller.db)
    .await?;
    let stats: Vec<Value> = accounts
        .iter()
        .map(|(id, platform, followers)| {
            let count = posts
                .iter()
                .filter(|targets| {
                    targets
                        .as_ref()
                        .and_then(Value::as_array)
                        .is_some_and(|ids| ids.iter().any(|t| t.as_str() == Some(id)))
                })
                .count();
            json!({
                "platform": platform,
                "followers": followers.filter(|f| *f != 0).unwrap_or(0),
                "posts": count,
                "engagement": 0,
            })
        })
        .collect();
    Ok(json!({
        "totalImpressions": number_value(impressions),
        "totalReach": number_value(reach),
        "totalEngagement": number_value(engagement),
        "totalClicks": number_value(clicks),
        "engagementRate": number_value(rate),
        "topPosts": [],
        "platformStats": stats,
    }))
}

/// `GET /api/social-analytics/stats`: post counts by status and the
/// connected accounts.
async fn stats(caller: Caller) -> Response {
    let result = async {
        let posts: Vec<(String, Option<Value>)> = sqlx::query_as(
            "select status::text, to_jsonb(published_at) from social_posts where deleted_at is null",
        )
        .fetch_all(&caller.db)
        .await?;
        let accounts: Option<i32> = sqlx::query_scalar(
            "select count(*)::int from social_accounts where status = 'active' and deleted_at is null",
        )
        .fetch_one(&caller.db)
        .await?;
        Ok::<_, sqlx::Error>((posts, accounts))
    }
    .await;
    let (posts, accounts) = match result {
        Ok(result) => result,
        Err(error) => return crate::internal(&error, "Failed to fetch stats"),
    };
    let week_ago = iso_timestamp(OffsetDateTime::now_utc() - time::Duration::days(7));
    let count = |status: &str| posts.iter().filter(|(s, _)| s == status).count();
    let published_this_week = posts
        .iter()
        .filter(|(status, published_at)| {
            status == "published"
                && published_at
                    .as_ref()
                    .and_then(Value::as_str)
                    .and_then(weldsuite_db::js_timestamp)
                    .is_some_and(|at| at >= week_ago)
        })
        .count();
    Data(json!({
        "totalPosts": posts.len(),
        "scheduledPosts": count("scheduled"),
        "publishedThisWeek": published_this_week,
        "pendingApproval": count("pending_approval"),
        "totalEngagement": 0,
        "connectedAccounts": accounts.filter(|n| *n != 0).unwrap_or(0),
    }))
    .into_response()
}

/// `GET /api/social-analytics/search?q=`: posts, campaigns and accounts
/// matching `q` (five of each), once it is two characters long.
async fn search(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let q = query_param(query.as_deref(), "q").unwrap_or_default();
    if q.encode_utf16().count() < 2 {
        return Data(json!([])).into_response();
    }
    let term = format!("%{q}%");
    match search_for(&caller, &term).await {
        Ok(results) => Data(Value::Array(results)).into_response(),
        Err(error) => crate::internal(&error, "Failed to search social entities"),
    }
}

async fn search_for(caller: &Caller, term: &str) -> Result<Vec<Value>, sqlx::Error> {
    let mut results = Vec::new();
    let posts: Vec<(String, Option<String>, String)> = sqlx::query_as(
        "select id, title, content from social_posts
         where deleted_at is null and (title ilike $1 or content ilike $1) limit 5",
    )
    .bind(term)
    .fetch_all(&caller.db)
    .await?;
    for (id, title, content) in posts {
        results.push(json!({
            "type": "post",
            "id": id,
            "title": title.filter(|t| !t.is_empty()).unwrap_or_else(|| "Untitled Post".to_owned()),
            "description": slice_utf16(&content, 100),
            "url": format!("/social/posts/{id}"),
        }));
    }
    let campaigns: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "select id, name, description from social_campaigns
         where deleted_at is null and (name ilike $1 or description ilike $1) limit 5",
    )
    .bind(term)
    .fetch_all(&caller.db)
    .await?;
    for (id, name, description) in campaigns {
        let mut hit = json!({ "type": "campaign", "id": id, "title": name, "url": format!("/social/campaigns/{id}") });
        if let Some(description) = description.filter(|d| !d.is_empty()) {
            hit["description"] = json!(description);
        }
        results.push(hit);
    }
    let accounts: Vec<(String, String, Option<String>, String)> = sqlx::query_as(
        "select id, name, username, platform::text from social_accounts
         where deleted_at is null and (name ilike $1 or username ilike $1) limit 5",
    )
    .bind(term)
    .fetch_all(&caller.db)
    .await?;
    for (id, name, username, platform) in accounts {
        results.push(json!({
            "type": "account",
            "id": id,
            "title": name,
            "description": format!("@{} on {platform}", username.as_deref().unwrap_or("null")),
            "url": "/social/accounts",
        }));
    }
    Ok(results)
}
