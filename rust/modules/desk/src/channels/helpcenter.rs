//! `routes/public-helpcenter/index.ts` and `middleware/helpcenter-domain.ts`:
//! the public help center feed at `/public/helpcenter/*`. The tenant is
//! resolved from `?domain=` through the master `helpcenter_domain_registry`
//! (cached in `WORKSPACE_CACHE` as `hc:<domain>` for five minutes).
//!
//! The reader is anonymous, or signed in when the help center's server
//! forwards the portal session (`x-portal-session`, kept hashed in the same
//! KV by the help center's sign-in): only published articles the reader may
//! open are served, one per article in `?locale=` when it has a version in
//! that language ([`weldsuite_desk_domain::articles`]).

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use weldsuite_db::PgPool;
use weldsuite_desk_domain::articles::{self, Reader};
use weldsuite_desk_domain::webchat::normalize_email;
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
        .route("/announcements", get(announcements))
}

/// `helpcenterDomainMiddleware()`: the tenant database for `?domain=` and
/// the workspace (`workspaces.id`), or the middleware's answer.
#[allow(clippy::result_large_err)] // the response is the route's answer
async fn tenant(
    ctx: &PublicCtx,
    state: &PublicState,
    query: Option<&str>,
) -> Result<(PgPool, String), Response> {
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
) -> Result<Result<(PgPool, String), Response>, String> {
    let kv = ctx.kv(state);
    let key = format!("hc:{domain}");
    let cached = kv_get_json(kv.as_ref(), &key)
        .await?
        .filter(|entry| !entry.is_null());
    let text = |value: &Value| {
        value
            .as_str()
            .map_or_else(|| value.to_string(), str::to_owned)
    };
    let (workspace, clerk_org_id) = if let Some(entry) = cached {
        (text(&entry["workspaceId"]), text(&entry["clerkOrgId"]))
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
        (workspace_id, org)
    };
    let db = ctx.tenant_db(state, &clerk_org_id).await?;
    Ok(Ok((db, workspace)))
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
    let (db, _) = tenant_or_answer!(ctx, state, query.as_deref());
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

// ── the reader ────────────────────────────────────────────────────────────────

/// `DESK_PORTAL_SESSION_HEADER`.
const SESSION_HEADER: &str = "x-portal-session";

/// `readerOf(c)` (`deskPortalPrincipal` of
/// `@weldsuite/db/lib/desk-portal-session`, then `deskReaderOf`): the
/// signed-in reader whose portal session the help center's server forwarded,
/// else anonymous. A session that is unknown, expired, for another workspace,
/// while sign-in is off, or whose visitor is no longer verified for its
/// address reads as anonymous.
async fn reader_of(
    ctx: &PublicCtx,
    state: &PublicState,
    db: &PgPool,
    workspace_id: &str,
    headers: &HeaderMap,
) -> Result<Reader, String> {
    let Some(token) = headers.get(SESSION_HEADER).and_then(|v| v.to_str().ok()) else {
        return Ok(Reader::anonymous());
    };
    let Some(email) = portal_email(ctx, state, db, workspace_id, token).await? else {
        return Ok(Reader::anonymous());
    };
    articles::reader_of(db, Some(&email))
        .await
        .map_err(|e| e.to_string())
}

/// The verified email behind a portal session token, if it still holds.
async fn portal_email(
    ctx: &PublicCtx,
    state: &PublicState,
    db: &PgPool,
    workspace_id: &str,
    token: &str,
) -> Result<Option<String>, String> {
    let kv = ctx.kv(state);
    if kv.is_none()
        || token.len() != 64
        || !token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Ok(None);
    }
    let key = format!(
        "dportal:sess:{}",
        hex::encode(Sha256::digest(token.as_bytes()))
    );
    let Some(session) = kv_get_json(kv.as_ref(), &key)
        .await?
        .filter(|s| !s.is_null())
    else {
        return Ok(None);
    };
    if session["workspaceId"].as_str() != Some(workspace_id) {
        return Ok(None);
    }
    let expires = session["expiresAt"]
        .as_str()
        .and_then(weldsuite_kit::validation::js_date_parse);
    #[allow(clippy::cast_precision_loss)]
    let now = (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as f64;
    if !expires.is_some_and(|expires| expires > now) {
        return Ok(None);
    }
    let settings: Option<(Option<i32>, Option<i32>)> = sqlx::query_as(
        "select is_enabled, portal_enabled from helpcenter_settings
         where deleted_at is null order by created_at asc, id asc limit 1",
    )
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    if settings != Some((Some(1), Some(1))) {
        return Ok(None);
    }
    let Some(visitor_id) = session["visitorId"].as_str() else {
        return Ok(None);
    };
    let verified: Option<Option<String>> =
        sqlx::query_scalar("select verified_email from desk_visitors where id = $1 limit 1")
            .bind(visitor_id)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
    let Some(email) = verified
        .flatten()
        .filter(|email| !email.is_empty())
        .map(|email| normalize_email(&email))
    else {
        return Ok(None);
    };
    if session["email"].as_str() != Some(email.as_str()) {
        return Ok(None);
    }
    Ok(Some(email))
}

/// `localeOf(q)`: `?locale=` (its first 10 UTF-16 units), normalised.
fn locale_of(query: Option<&str>) -> Option<String> {
    let raw = query_param(query, "locale")?;
    let units: Vec<u16> = raw.encode_utf16().take(10).collect();
    articles::normalize_locale(Some(&String::from_utf16_lossy(&units)))
}

macro_rules! reader_or_answer {
    ($ctx:expr, $state:expr, $db:expr, $workspace:expr, $headers:expr, $scope:literal, $message:literal) => {
        match reader_of(&$ctx, &$state, &$db, &$workspace, &$headers).await {
            Ok(reader) => reader,
            Err(error) => {
                tracing::error!(%error, "[app-api/public-helpcenter] {} failed", $scope);
                return ApiError::internal().with_message($message).into_response();
            }
        }
    };
}

// ── GET /folders ──────────────────────────────────────────────────────────────

async fn folders(
    State(state): State<PublicState>,
    ctx: PublicCtx,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let (db, workspace) = tenant_or_answer!(ctx, state, query.as_deref());
    let reader = reader_or_answer!(
        ctx,
        state,
        db,
        workspace,
        headers,
        "folders",
        "Failed to fetch folders"
    );
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
    // The articles the reader may open per folder, one per article.
    let live = articles::live_sql("t", 1, 2);
    let counts: Result<Vec<(Option<String>, i32)>, sqlx::Error> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select t.category_id, count(*)::int from helpdesk_articles t
         where t.translation_of_id is null and {live} group by t.category_id"
        )))
        .bind(reader.signed_in())
        .bind(&reader.company_ids)
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

/// The reader's articles (`$1` signed in, `$2` companies, `$3` locale, `$4`
/// folder), matching the search at `$5`/`$6` when there is one.
fn listed_filter() -> String {
    let displayed = articles::displayed_ids_sql(1, 2, 3, 4);
    let matches = articles::matches_sql("t", 5, 6);
    format!("t.id in {displayed} and ($6::text is null or {matches})")
}

/// A listed article row: the row and the folder it is listed under.
type Listed = (Value, Option<String>);

// ── GET /articles ─────────────────────────────────────────────────────────────

async fn articles(
    State(state): State<PublicState>,
    ctx: PublicCtx,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let query = query.as_deref();
    let (db, workspace) = tenant_or_answer!(ctx, state, query);
    let (page, size, offset) = paging(query);
    let reader = reader_or_answer!(
        ctx,
        state,
        db,
        workspace,
        headers,
        "articles",
        "Failed to fetch articles"
    );
    let search = query_param(query, "search")
        .filter(|s| !s.is_empty())
        .and_then(|s| articles::typed_search(&s));
    let folder = query_param(query, "folderId").filter(|f| !f.is_empty());
    let locale = locale_of(query);
    let filters = listed_filter();
    let folder_id = articles::FOLDER_ID_SQL;
    let bind = |sql: String| {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(reader.signed_in())
            .bind(reader.company_ids.clone())
            .bind(locale.clone())
            .bind(folder.clone())
            .bind(search.as_ref().and_then(|s| s.websearch.clone()))
            .bind(search.as_ref().map(|s| s.tsquery.clone()))
    };
    let total = bind(format!(
        "select count(*)::int from helpdesk_articles t where {filters}"
    ))
    .fetch_one(&db)
    .await
    .and_then(|row| sqlx::Row::try_get::<i32, _>(&row, 0));
    let rows = bind(format!(
        "select to_jsonb(t), {folder_id} from helpdesk_articles t where {filters}
         order by t.updated_at desc, t.id desc limit $7 offset $8"
    ))
    .bind(size)
    .bind(offset)
    .fetch_all(&db)
    .await
    .and_then(|rows| {
        rows.iter()
            .map(|row| Ok((sqlx::Row::try_get(row, 0)?, sqlx::Row::try_get(row, 1)?)))
            .collect::<Result<Vec<Listed>, sqlx::Error>>()
    });
    let (total, rows) = match (total, rows) {
        (Ok(total), Ok(rows)) => (total, rows),
        (Err(error), _) | (_, Err(error)) => {
            return internal("articles", &error, "Failed to fetch articles");
        }
    };
    let data: Vec<Value> = rows
        .iter()
        .map(|(a, folder)| {
            json!({
                "id": a["id"], "title": a["title"], "slug": a["slug"], "excerpt": a["excerpt"], "folderId": folder,
                "locale": a["locale"],
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
    headers: HeaderMap,
    Path(slug): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let (db, workspace) = tenant_or_answer!(ctx, state, query.as_deref());
    let reader = reader_or_answer!(
        ctx,
        state,
        db,
        workspace,
        headers,
        "article",
        "Failed to fetch article"
    );
    let live_t = articles::live_sql("t", 2, 3);
    let live_o = articles::live_sql("o", 2, 3);
    let row: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from helpdesk_articles t where t.slug = $1 and {live_t}
           and (t.translation_of_id is null or exists (select 1 from helpdesk_articles o where o.id = t.translation_of_id and {live_o}))
         order by t.created_at asc, t.id asc limit 1"
    )))
    .bind(&slug)
    .bind(reader.signed_in())
    .bind(&reader.company_ids)
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
    let root = a["translation_of_id"]
        .as_str()
        .or_else(|| a["id"].as_str())
        .unwrap_or_default()
        .to_owned();
    let versions: Result<Vec<(Option<String>, String, String)>, sqlx::Error> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select t.locale, t.slug, t.title from helpdesk_articles t
             where (t.id = $1 or t.translation_of_id = $1) and {live_t}
             order by (t.translation_of_id is not null), t.locale asc nulls first, t.id asc"
        )))
        .bind(&root)
        .bind(reader.signed_in())
        .bind(&reader.company_ids)
        .fetch_all(&db)
        .await;
    let folder: Result<Value, sqlx::Error> = match a["translation_of_id"].as_str() {
        Some(original) => sqlx::query_scalar::<_, Option<String>>(
            "select category_id from helpdesk_articles where id = $1 limit 1",
        )
        .bind(original)
        .fetch_optional(&db)
        .await
        .map(|folder| json!(folder.flatten())),
        None => Ok(a["category_id"].clone()),
    };
    let (versions, folder) = match (versions, folder) {
        (Ok(versions), Ok(folder)) => (versions, folder),
        (Err(error), _) | (_, Err(error)) => {
            return internal("article", &error, "Failed to fetch article");
        }
    };
    let versions: Vec<Value> = versions
        .into_iter()
        .map(|(locale, slug, title)| json!({ "locale": locale, "slug": slug, "title": title }))
        .collect();
    let views = a["view_count"].as_i64().unwrap_or(0) + 1;
    Data(json!({
        "id": a["id"], "title": a["title"], "slug": a["slug"], "content": a["content"], "excerpt": a["excerpt"],
        "folderId": folder, "locale": a["locale"], "viewCount": views,
        "helpfulCount": or_zero(&a["helpful_count"]), "notHelpfulCount": or_zero(&a["not_helpful_count"]),
        "tags": or_empty(&a["tags"]), "createdAt": iso(&a["created_at"]), "updatedAt": iso(&a["updated_at"]),
        "versions": versions,
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
    let (db, _) = tenant_or_answer!(ctx, state, query.as_deref());
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
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let query = query.as_deref();
    let (db, workspace) = tenant_or_answer!(ctx, state, query);
    let term = query_param(query, "q").unwrap_or_default();
    let Some(search) = articles::typed_search(&term) else {
        return axum::Json(json!({ "data": [], "pagination": page_meta(1, 20, 0) }))
            .into_response();
    };
    let (page, size, offset) = paging(query);
    let reader = reader_or_answer!(
        ctx,
        state,
        db,
        workspace,
        headers,
        "search",
        "Search failed"
    );
    let locale = locale_of(query);
    let filters = listed_filter();
    let rank = articles::rank_sql("t", 5, 6);
    let folder_id = articles::FOLDER_ID_SQL;
    let bind = |sql: String| {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(reader.signed_in())
            .bind(reader.company_ids.clone())
            .bind(locale.clone())
            .bind(None::<String>)
            .bind(search.websearch.clone())
            .bind(Some(search.tsquery.clone()))
    };
    let total = bind(format!(
        "select count(*)::int from helpdesk_articles t where {filters}"
    ))
    .fetch_one(&db)
    .await
    .and_then(|row| sqlx::Row::try_get::<i32, _>(&row, 0));
    let rows = bind(format!(
        "select to_jsonb(t), {folder_id} from helpdesk_articles t where {filters}
         order by {rank} desc, t.updated_at desc, t.id desc limit $7 offset $8"
    ))
    .bind(size)
    .bind(offset)
    .fetch_all(&db)
    .await
    .and_then(|rows| {
        rows.iter()
            .map(|row| Ok((sqlx::Row::try_get(row, 0)?, sqlx::Row::try_get(row, 1)?)))
            .collect::<Result<Vec<Listed>, sqlx::Error>>()
    });
    let (total, rows) = match (total, rows) {
        (Ok(total), Ok(rows)) => (total, rows),
        (Err(error), _) | (_, Err(error)) => return internal("search", &error, "Search failed"),
    };
    let data: Vec<Value> = rows
        .iter()
        .map(|(a, folder)| {
            json!({
                "id": a["id"], "title": a["title"], "slug": a["slug"], "excerpt": a["excerpt"], "folderId": folder,
                "locale": a["locale"], "tags": or_empty(&a["tags"]), "updatedAt": iso(&a["updated_at"]),
            })
        })
        .collect();
    axum::Json(json!({ "data": data, "pagination": page_meta(page, size, i64::from(total)) }))
        .into_response()
}

// ── GET /announcements ────────────────────────────────────────────────────────

async fn announcements(
    State(state): State<PublicState>,
    ctx: PublicCtx,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let (db, workspace) = tenant_or_answer!(ctx, state, query.as_deref());
    let reader = reader_or_answer!(
        ctx,
        state,
        db,
        workspace,
        headers,
        "announcements",
        "Failed to fetch announcements"
    );
    match articles::announcements_for(&db, &reader).await {
        Ok(list) => Data(list).into_response(),
        Err(error) => internal("announcements", &error, "Failed to fetch announcements"),
    }
}
