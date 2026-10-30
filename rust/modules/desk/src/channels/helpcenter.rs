//! `routes/public-helpcenter/index.ts` and `middleware/helpcenter-domain.ts`:
//! the public help center feed at `/public/helpcenter/*`. The tenant is
//! resolved from `?domain=` through the master `helpcenter_domain_registry`
//! (cached in `WORKSPACE_CACHE` as `hc:<domain>` for five minutes); only
//! published, public articles are served.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::StatusCode;
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::{ApiError, Data};

use super::{PublicCtx, PublicState, error_body, json_object, kv_get_json, kv_put};
use crate::js::{js_parse_int, query_param};

pub(super) fn routes() -> Router<PublicState> {
    Router::new()
        .route("/config", get(config))
        .route("/folders", get(folders))
        .route("/articles", get(articles))
        .route("/articles/{slug}", get(article))
        .route("/articles/{slug}/feedback", post(feedback))
        .route("/search", get(search))
}

/// `helpcenterDomainMiddleware()`: the tenant database for `?domain=`, or
/// the middleware's answer.
#[allow(clippy::result_large_err)] // the response is the route's answer
async fn tenant(
    ctx: &PublicCtx,
    state: &PublicState,
    query: Option<&str>,
) -> Result<PgPool, Response> {
    let Some(domain) = query_param(query, "domain").filter(|d| !d.is_empty()) else {
        return Err(error_body(
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
            "Missing domain query parameter",
        ));
    };
    match resolve(ctx, state, &domain).await {
        Ok(Ok(db)) => Ok(db),
        Ok(Err(response)) => Err(response),
        Err(error) => {
            tracing::error!(%error, "[app-api/helpcenter-domain] resolution error");
            Err(error_body(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                "Failed to resolve help center domain",
            ))
        }
    }
}

async fn resolve(
    ctx: &PublicCtx,
    state: &PublicState,
    domain: &str,
) -> Result<Result<PgPool, Response>, String> {
    let kv = ctx.kv(state);
    let key = format!("hc:{domain}");
    let cached = kv_get_json(kv.as_ref(), &key)
        .await?
        .filter(|entry| !entry.is_null());
    let clerk_org_id = if let Some(entry) = cached {
        entry["clerkOrgId"]
            .as_str()
            .map_or_else(|| entry["clerkOrgId"].to_string(), str::to_owned)
    } else {
        let master = ctx.master(state).ok_or("no master database")?;
        let registry: Option<String> = sqlx::query_scalar(
            "select workspace_id from helpcenter_domain_registry where domain = $1 and is_active = 1 limit 1",
        )
        .bind(domain)
        .fetch_optional(&master)
        .await
        .map_err(|e| e.to_string())?;
        let Some(workspace_id) = registry else {
            return Ok(Err(error_body(
                StatusCode::NOT_FOUND,
                "NOT_FOUND",
                "Help center not found for this domain",
            )));
        };
        let org: Option<Option<String>> =
            sqlx::query_scalar("select clerk_org_id from workspaces where id = $1 limit 1")
                .bind(&workspace_id)
                .fetch_optional(&master)
                .await
                .map_err(|e| e.to_string())?;
        let Some(org) = org.flatten().filter(|o| !o.is_empty()) else {
            return Ok(Err(error_body(
                StatusCode::NOT_FOUND,
                "NOT_FOUND",
                "Workspace not found",
            )));
        };
        let entry = json_object(&[
            ("workspaceId", Some(&json!(workspace_id))),
            ("clerkOrgId", Some(&json!(org))),
        ]);
        kv_put(kv.as_ref(), &key, &entry, Some(300)).await?;
        org
    };
    ctx.tenant_db(state, &clerk_org_id).await.map(Ok)
}

macro_rules! tenant_or_answer {
    ($ctx:expr, $state:expr, $query:expr) => {
        match tenant(&$ctx, &$state, $query).await {
            Ok(db) => db,
            Err(response) => return response,
        }
    };
}

fn internal(scope: &str, error: &sqlx::Error, message: &str) -> Response {
    tracing::error!(%error, "[app-api/public-helpcenter] {scope} failed");
    ApiError::internal().with_message(message).into_response()
}

// ── GET /config ───────────────────────────────────────────────────────────────

async fn config(
    State(state): State<PublicState>,
    ctx: PublicCtx,
    RawQuery(query): RawQuery,
) -> Response {
    let db = tenant_or_answer!(ctx, state, query.as_deref());
    let row: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from helpcenter_settings t where t.deleted_at is null order by t.created_at asc, t.id asc limit 1",
    )
    .fetch_optional(&db)
    .await;
    let row = match row {
        Ok(row) => row,
        Err(error) => {
            return internal(
                "config",
                &error,
                "Failed to fetch help center configuration",
            );
        }
    };
    let Some(row) = row.filter(|row| row["is_enabled"].as_i64().is_some_and(|e| e != 0)) else {
        return error_body(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            "Help center is not enabled",
        );
    };
    let mut out = serde_json::Map::new();
    for (prop, column) in [
        ("siteName", "site_name"),
        ("logo", "logo"),
        ("logoDark", "logo_dark"),
        ("favicon", "favicon"),
        ("primaryColor", "primary_color"),
        ("accentColor", "accent_color"),
        ("heroTitle", "hero_title"),
        ("heroSubtitle", "hero_subtitle"),
        ("showSearch", "show_search"),
        ("showCategories", "show_categories"),
        ("metaTitle", "meta_title"),
        ("metaDescription", "meta_description"),
        ("ogImage", "og_image"),
        ("footerText", "footer_text"),
        ("socialLinks", "social_links"),
        ("customCss", "custom_css"),
        ("googleAnalyticsId", "google_analytics_id"),
    ] {
        out.insert(prop.to_owned(), row[column].clone());
    }
    Data(Value::Object(out)).into_response()
}

// ── GET /folders ──────────────────────────────────────────────────────────────

const LIVE_PUBLIC: &str =
    "t.status = 'published' and t.visibility = 'public' and t.deleted_at is null";

async fn folders(
    State(state): State<PublicState>,
    ctx: PublicCtx,
    RawQuery(query): RawQuery,
) -> Response {
    let db = tenant_or_answer!(ctx, state, query.as_deref());
    #[allow(clippy::type_complexity)] // the folder row's columns
    let rows: Result<
        Vec<(
            String,
            String,
            Option<String>,
            Option<i32>,
            Option<String>,
            Option<String>,
        )>,
        sqlx::Error,
    > = sqlx::query_as(
        "select id, name, parent_id, sort_order, icon, description from helpdesk_article_folders
             where deleted_at is null order by sort_order",
    )
    .fetch_all(&db)
    .await;
    let counts: Result<Vec<(Option<String>, i32)>, sqlx::Error> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select t.category_id, count(*)::int from helpdesk_articles t where {LIVE_PUBLIC} group by t.category_id"
    )))
    .fetch_all(&db)
    .await;
    let (rows, counts) = match (rows, counts) {
        (Ok(rows), Ok(counts)) => (rows, counts),
        (Err(error), _) | (_, Err(error)) => {
            return internal("folders", &error, "Failed to fetch folders");
        }
    };
    let data: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, parent_id, sort_order, icon, description)| {
            let count = counts
                .iter()
                .rev()
                .find(|(category, _)| category.as_deref() == Some(id.as_str()))
                .map_or(0, |(_, n)| *n);
            json!({
                "id": id,
                "name": name,
                "parentId": parent_id,
                "sortOrder": sort_order.unwrap_or(0),
                "icon": icon,
                "description": description,
                "articleCount": count,
            })
        })
        .collect();
    Data(data).into_response()
}

// ── paging ────────────────────────────────────────────────────────────────────

/// `parsePaging(q)`.
fn paging(query: Option<&str>) -> (i64, i64, i64) {
    let int = |key: &str, fallback: &str| {
        let raw = query_param(query, key).unwrap_or_else(|| fallback.to_owned());
        js_parse_int(&raw).filter(|n| *n != 0.0)
    };
    #[allow(clippy::cast_possible_truncation)]
    let page = int("page", "1").unwrap_or(1.0).max(1.0) as i64;
    #[allow(clippy::cast_possible_truncation)]
    let size = int("pageSize", "20").unwrap_or(20.0).clamp(1.0, 50.0) as i64;
    (page, size, (page - 1) * size)
}

/// `pageMeta(page, pageSize, totalCount)`.
fn page_meta(page: i64, size: i64, total: i64) -> Value {
    let pages = (total + size - 1) / size;
    json!({ "page": page, "pageSize": size, "totalCount": total, "totalPages": pages, "hasMore": page < pages })
}

/// `%term%`, wildcards and all (Drizzle's `like` takes the pattern as given).
fn like(term: &str) -> String {
    format!("%{term}%")
}

fn iso(value: &Value) -> Value {
    value
        .as_str()
        .map_or(Value::Null, |text| json!(crate::table::js_date(text)))
}

fn or_zero(value: &Value) -> Value {
    if value.is_null() {
        json!(0)
    } else {
        value.clone()
    }
}

fn or_empty(value: &Value) -> Value {
    if value.is_null() {
        json!([])
    } else {
        value.clone()
    }
}

// ── GET /articles ─────────────────────────────────────────────────────────────

async fn articles(
    State(state): State<PublicState>,
    ctx: PublicCtx,
    RawQuery(query): RawQuery,
) -> Response {
    let query = query.as_deref();
    let db = tenant_or_answer!(ctx, state, query);
    let (page, size, offset) = paging(query);
    let search = query_param(query, "search")
        .filter(|s| !s.is_empty())
        .map(|s| like(&s));
    let folder = query_param(query, "folderId").filter(|f| !f.is_empty());
    let filters = format!(
        "{LIVE_PUBLIC} and ($1::text is null or (t.title like $1 or t.content like $1 or t.excerpt like $1))
         and ($2::text is null or t.category_id = $2)"
    );
    let total: Result<i32, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*)::int from helpdesk_articles t where {filters}"
    )))
    .bind(&search)
    .bind(&folder)
    .fetch_one(&db)
    .await;
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from helpdesk_articles t where {filters} order by t.updated_at desc limit $3 offset $4"
    )))
    .bind(&search)
    .bind(&folder)
    .bind(size)
    .bind(offset)
    .fetch_all(&db)
    .await;
    let (total, rows) = match (total, rows) {
        (Ok(total), Ok(rows)) => (total, rows),
        (Err(error), _) | (_, Err(error)) => {
            return internal("articles", &error, "Failed to fetch articles");
        }
    };
    let data: Vec<Value> = rows
        .iter()
        .map(|a| {
            json!({
                "id": a["id"], "title": a["title"], "slug": a["slug"], "excerpt": a["excerpt"], "folderId": a["category_id"],
                "viewCount": or_zero(&a["view_count"]), "helpfulCount": or_zero(&a["helpful_count"]),
                "notHelpfulCount": or_zero(&a["not_helpful_count"]), "tags": or_empty(&a["tags"]),
                "createdAt": iso(&a["created_at"]), "updatedAt": iso(&a["updated_at"]),
            })
        })
        .collect();
    axum::Json(json!({ "data": data, "pagination": page_meta(page, size, i64::from(total)) }))
        .into_response()
}

// ── GET /articles/:slug ───────────────────────────────────────────────────────

async fn article(
    State(state): State<PublicState>,
    ctx: PublicCtx,
    Path(slug): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let db = tenant_or_answer!(ctx, state, query.as_deref());
    let row: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from helpdesk_articles t where t.slug = $1 and {LIVE_PUBLIC} limit 1"
    )))
    .bind(&slug)
    .fetch_optional(&db)
    .await;
    let a = match row {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Article", None).into_response(),
        Err(error) => return internal("article", &error, "Failed to fetch article"),
    };
    let bumped =
        sqlx::query("update helpdesk_articles set view_count = view_count + 1 where id = $1")
            .bind(a["id"].as_str())
            .execute(&db)
            .await;
    if let Err(error) = bumped {
        return internal("article", &error, "Failed to fetch article");
    }
    let views = a["view_count"].as_i64().unwrap_or(0) + 1;
    Data(json!({
        "id": a["id"], "title": a["title"], "slug": a["slug"], "content": a["content"], "excerpt": a["excerpt"],
        "folderId": a["category_id"], "viewCount": views,
        "helpfulCount": or_zero(&a["helpful_count"]), "notHelpfulCount": or_zero(&a["not_helpful_count"]),
        "tags": or_empty(&a["tags"]), "createdAt": iso(&a["created_at"]), "updatedAt": iso(&a["updated_at"]),
    }))
    .into_response()
}

// ── POST /articles/:id/feedback ───────────────────────────────────────────────

async fn feedback(
    State(state): State<PublicState>,
    ctx: PublicCtx,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
    body: Bytes,
) -> Response {
    let db = tenant_or_answer!(ctx, state, query.as_deref());
    // `(await c.req.json()).helpful === true`; `null` has no properties.
    let helpful = match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Null) | Err(_) => {
            return error_body(StatusCode::BAD_REQUEST, "BAD_REQUEST", "Invalid body");
        }
        Ok(value) => value.get("helpful") == Some(&Value::Bool(true)),
    };
    let existing: Result<Option<String>, sqlx::Error> = sqlx::query_scalar(
        "select id from helpdesk_articles where id = $1 and status = 'published' and deleted_at is null limit 1",
    )
    .bind(&id)
    .fetch_optional(&db)
    .await;
    match existing {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Article", Some(&id)).into_response(),
        Err(error) => return internal("feedback", &error, "Failed to record feedback"),
    }
    let column = if helpful {
        "helpful_count"
    } else {
        "not_helpful_count"
    };
    let updated = sqlx::query(sqlx::AssertSqlSafe(format!(
        "update helpdesk_articles set {column} = {column} + 1 where id = $1"
    )))
    .bind(&id)
    .execute(&db)
    .await;
    if let Err(error) = updated {
        return internal("feedback", &error, "Failed to record feedback");
    }
    Data(json!({ "recorded": true })).into_response()
}

// ── GET /search ───────────────────────────────────────────────────────────────

async fn search(
    State(state): State<PublicState>,
    ctx: PublicCtx,
    RawQuery(query): RawQuery,
) -> Response {
    let query = query.as_deref();
    let db = tenant_or_answer!(ctx, state, query);
    let term = query_param(query, "q").unwrap_or_default();
    let term = weldsuite_kit::validation::js_trim(&term).to_owned();
    if term.is_empty() {
        return axum::Json(json!({ "data": [], "pagination": page_meta(1, 20, 0) }))
            .into_response();
    }
    let (page, size, offset) = paging(query);
    let pattern = like(&term);
    let filters =
        format!("{LIVE_PUBLIC} and (t.title like $1 or t.content like $1 or t.excerpt like $1)");
    let total: Result<i32, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*)::int from helpdesk_articles t where {filters}"
    )))
    .bind(&pattern)
    .fetch_one(&db)
    .await;
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from helpdesk_articles t where {filters} order by t.updated_at desc limit $2 offset $3"
    )))
    .bind(&pattern)
    .bind(size)
    .bind(offset)
    .fetch_all(&db)
    .await;
    let (total, rows) = match (total, rows) {
        (Ok(total), Ok(rows)) => (total, rows),
        (Err(error), _) | (_, Err(error)) => return internal("search", &error, "Search failed"),
    };
    let data: Vec<Value> = rows
        .iter()
        .map(|a| {
            json!({
                "id": a["id"], "title": a["title"], "slug": a["slug"], "excerpt": a["excerpt"], "folderId": a["category_id"],
                "tags": or_empty(&a["tags"]), "updatedAt": iso(&a["updated_at"]),
            })
        })
        .collect();
    axum::Json(json!({ "data": data, "pagination": page_meta(page, size, i64::from(total)) }))
        .into_response()
}
