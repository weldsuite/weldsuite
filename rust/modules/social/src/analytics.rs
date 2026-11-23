//! `/api/social-analytics`: read-only aggregates (overview, dashboard
//! stats, search) and pulling a post's metrics from PostPeer.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use sea_orm::{
    ActiveEnum, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QuerySelect,
};
use serde_json::{Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_core_domain::js::{number_value, slice_utf16};
use weldsuite_db::orm;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::enums::{
    SocialAccountStatus, SocialAnalyticsSnapshotPeriod, SocialPlatform, SocialPostStatus,
};
use weldsuite_schema::tenant::{social_accounts, social_analytics, social_campaigns, social_posts};
use weldsuite_social_domain::publishing::{PublishError, sync_analytics};

use crate::js::query_param;
use crate::table::iso;
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

/// `eq(status, 'active'), isNull(deletedAt)` on `social_accounts`.
fn active_accounts() -> Condition {
    Condition::all()
        .add(social_accounts::Column::Status.eq(SocialAccountStatus::Active))
        .add(social_accounts::Column::DeletedAt.is_null())
}

async fn overview_of(caller: &Caller) -> Result<Value, DbErr> {
    let db = orm(&caller.db);
    let analytics: Vec<Totals> = social_analytics::Entity::find()
        .select_only()
        .columns([
            social_analytics::Column::Impressions,
            social_analytics::Column::Reach,
            social_analytics::Column::TotalEngagement,
            social_analytics::Column::Clicks,
        ])
        .filter(
            social_analytics::Column::SnapshotPeriod.eq(SocialAnalyticsSnapshotPeriod::Lifetime),
        )
        .into_tuple()
        .all(&db)
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
    let accounts: Vec<(String, SocialPlatform, Option<i32>)> = social_accounts::Entity::find()
        .select_only()
        .columns([
            social_accounts::Column::Id,
            social_accounts::Column::Platform,
            social_accounts::Column::FollowerCount,
        ])
        .filter(active_accounts())
        .into_tuple()
        .all(&db)
        .await?;
    let posts: Vec<Option<Value>> = social_posts::Entity::find()
        .select_only()
        .column(social_posts::Column::TargetAccountIds)
        .filter(social_posts::Column::Status.eq(SocialPostStatus::Published))
        .filter(social_posts::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&db)
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
                "platform": platform.to_value(),
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
        let db = orm(&caller.db);
        let posts: Vec<(SocialPostStatus, Option<PrimitiveDateTime>)> =
            social_posts::Entity::find()
                .select_only()
                .columns([
                    social_posts::Column::Status,
                    social_posts::Column::PublishedAt,
                ])
                .filter(social_posts::Column::DeletedAt.is_null())
                .into_tuple()
                .all(&db)
                .await?;
        let accounts = social_accounts::Entity::find()
            .filter(active_accounts())
            .count(&db)
            .await?;
        Ok::<_, DbErr>((posts, accounts))
    }
    .await;
    let (posts, accounts) = match result {
        Ok(result) => result,
        Err(error) => return crate::internal(&error, "Failed to fetch stats"),
    };
    let week_ago = iso_timestamp(OffsetDateTime::now_utc() - time::Duration::days(7));
    let count = |status: SocialPostStatus| posts.iter().filter(|(s, _)| *s == status).count();
    let published_this_week = posts
        .iter()
        .filter(|(status, published_at)| {
            *status == SocialPostStatus::Published
                && published_at.is_some_and(|at| iso(at) >= week_ago)
        })
        .count();
    Data(json!({
        "totalPosts": posts.len(),
        "scheduledPosts": count(SocialPostStatus::Scheduled),
        "publishedThisWeek": published_this_week,
        "pendingApproval": count(SocialPostStatus::PendingApproval),
        "totalEngagement": 0,
        "connectedAccounts": accounts,
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

async fn search_for(caller: &Caller, term: &str) -> Result<Vec<Value>, DbErr> {
    let db = orm(&caller.db);
    let mut results = Vec::new();
    let posts: Vec<(String, Option<String>, String)> = social_posts::Entity::find()
        .select_only()
        .columns([
            social_posts::Column::Id,
            social_posts::Column::Title,
            social_posts::Column::Content,
        ])
        .filter(social_posts::Column::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(social_posts::Column::Title.ilike(term))
                .add(social_posts::Column::Content.ilike(term)),
        )
        .limit(5)
        .into_tuple()
        .all(&db)
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
    let campaigns: Vec<(String, String, Option<String>)> = social_campaigns::Entity::find()
        .select_only()
        .columns([
            social_campaigns::Column::Id,
            social_campaigns::Column::Name,
            social_campaigns::Column::Description,
        ])
        .filter(social_campaigns::Column::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(social_campaigns::Column::Name.ilike(term))
                .add(social_campaigns::Column::Description.ilike(term)),
        )
        .limit(5)
        .into_tuple()
        .all(&db)
        .await?;
    for (id, name, description) in campaigns {
        let mut hit = json!({ "type": "campaign", "id": id, "title": name, "url": format!("/social/campaigns/{id}") });
        if let Some(description) = description.filter(|d| !d.is_empty()) {
            hit["description"] = json!(description);
        }
        results.push(hit);
    }
    let accounts: Vec<(String, String, Option<String>, SocialPlatform)> =
        social_accounts::Entity::find()
            .select_only()
            .columns([
                social_accounts::Column::Id,
                social_accounts::Column::Name,
                social_accounts::Column::Username,
                social_accounts::Column::Platform,
            ])
            .filter(social_accounts::Column::DeletedAt.is_null())
            .filter(
                Condition::any()
                    .add(social_accounts::Column::Name.ilike(term))
                    .add(social_accounts::Column::Username.ilike(term)),
            )
            .limit(5)
            .into_tuple()
            .all(&db)
            .await?;
    for (id, name, username, platform) in accounts {
        let platform = platform.to_value();
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
