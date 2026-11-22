//! WeldDesk knowledge base: articles, canned responses (search, categories, use), helpdesk changelog and stats.
//!
//! `/api/articles` (`routes/articles/index.ts`): the cursor list and the soft
//! delete are the shared CRUD's; create and update are the route's own
//! (slug, content aliases, excerpt, folder resolution, publish lifecycle,
//! audience and locale), and so are the language versions
//! (`GET|POST /:id/translations`, one version per locale).
//! `/api/canned-responses` (`routes/canned-responses/index.ts`): the CRUD of
//! [`crate::library::CANNED_RESPONSES`] plus `/search`, `/categories` and
//! `POST /:id/use`. `/api/helpdesk-changelog` and `/api/helpdesk-stats` are
//! read-only.

use std::cmp::Ordering;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, Func, NullOrdering, Order};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_desk_domain::articles::{article_slug, normalize_locale};
use weldsuite_kit::validation::{Issues, Number, Presence, Text, js_trim, query_values};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::crud::{CursorRow, Filter, Listing, fetch, page_list, soft_delete, write_failed};
use crate::js::{js_parse_int, query_param};
use crate::library::{ARTICLES, CANNED_RESPONSES, TICKETS};
use crate::tables::{HELPDESK_ARTICLES, HELPDESK_CANNED_RESPONSES};
use crate::{Caller, DeskState, Refusal, now, validate};
use weldsuite_db::orm;
use weldsuite_schema::tenant::helpdesk_articles::{self, Column as Article};
use weldsuite_schema::tenant::{
    helpdesk_article_folders, helpdesk_canned_responses, helpdesk_changelog, helpdesk_tickets,
};

/// The routes, relative to `/api`, each with its `requirePermission`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    let articles = Router::new()
        .route("/", get(list_articles).route_layer(need(ARTICLES.read)))
        .route("/", post(create_article).route_layer(need(ARTICLES.create)))
        .route(
            "/{id}",
            get(article_detail).route_layer(need(ARTICLES.read)),
        )
        .route(
            "/{id}",
            patch(update_article).route_layer(need(ARTICLES.update)),
        )
        .route(
            "/{id}",
            delete(delete_article).route_layer(need(ARTICLES.delete)),
        )
        .route(
            "/{id}/translations",
            get(list_translations).route_layer(need(ARTICLES.read)),
        )
        .route(
            "/{id}/translations",
            post(create_translation).route_layer(need(ARTICLES.create)),
        );
    let canned = crate::crud::routes(&CANNED_RESPONSES, gate)
        .route(
            "/search",
            get(search_canned).route_layer(need(TICKETS.read)),
        )
        .route(
            "/categories",
            get(canned_categories).route_layer(need(TICKETS.read)),
        )
        .route(
            "/{id}/use",
            post(use_canned).route_layer(need(TICKETS.read)),
        );
    Router::new()
        .nest("/articles", articles)
        .nest("/canned-responses", canned)
        .route(
            "/helpdesk-changelog",
            get(list_changelog).route_layer(need(perm::ARTICLES_READ)),
        )
        .route(
            "/helpdesk-stats",
            get(helpdesk_stats).route_layer(need(perm::TICKETS_READ)),
        )
}

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

pub(crate) const ARTICLE_LISTING: Listing = Listing {
    table: &HELPDESK_ARTICLES,
    filters: &[
        Filter::eq("status", |v| Condition::all().add(Article::Status.eq(v))),
        Filter::eq("visibility", |v| {
            Condition::all().add(Article::Visibility.eq(v))
        }),
        Filter::eq("folderId", |v| {
            Condition::all().add(Article::CategoryId.eq(v))
        }),
        Filter::eq("authorId", |v| {
            Condition::all().add(Article::AuthorId.eq(v))
        }),
        Filter::like("search", |v| Condition::all().add(Article::Title.like(v))),
        // `?originals=1`: only originals, no language versions.
        Filter::eq("originals", |_| {
            Condition::all().add(Article::TranslationOfId.is_null())
        }),
    ],
    slice_count: true,
};

const ARTICLE_STATUSES: [&str; 5] = ["draft", "review", "published", "archived", "outdated"];
const ARTICLE_VISIBILITIES: [&str; 4] = ["public", "logged_in", "groups", "internal"];

/// `ARTICLE_LOCALE_PATTERN`: `/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/`.
fn is_locale(text: &str) -> bool {
    let (language, region) = match text.split_once('-') {
        Some((language, region)) => (language, Some(region)),
        None => (text, None),
    };
    (2..=3).contains(&language.len())
        && language.bytes().all(|b| b.is_ascii_alphabetic())
        && region.is_none_or(|region| {
            (2..=8).contains(&region.len()) && region.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}

/// `articleAudienceSchema` at `key`: up to 100 company ids of 1–30 characters.
fn audience(issues: &mut Issues, body: &Map<String, Value>, key: &str, presence: Presence) {
    issues.list(body, key, presence, None, Some(100), |issues, item| {
        issues.item_text(item, Text::length(Some(1), Some(30)))
    });
}

/// `createArticleSchema` (`.partial()` for the update), passthrough.
fn article_schema(issues: &mut Issues, body: &Map<String, Value>, partial: bool) {
    let title = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let opt = Presence::Optional;
    let nullish = Presence::Nullish;
    issues.text(body, "title", title, Some(1), Some(500));
    issues.text(body, "slug", opt, None, Some(500));
    issues.text(body, "excerpt", opt, None, None);
    issues.text(body, "content", opt, None, None);
    issues.text(body, "body", opt, None, None);
    issues.text(body, "bodyHtml", opt, None, None);
    issues.text(body, "folderId", nullish, None, None);
    issues.text(body, "categoryId", nullish, None, None);
    issues.text(body, "authorId", nullish, None, None);
    issues.text(body, "authorName", opt, None, Some(255));
    issues.choice(body, "status", opt, &ARTICLE_STATUSES);
    issues.choice(body, "visibility", opt, &ARTICLE_VISIBILITIES);
    audience(issues, body, "audienceCompanyIds", opt);
    issues.pattern(
        body,
        "locale",
        nullish,
        None,
        None,
        is_locale,
        "Invalid locale",
    );
    issues.list(body, "tags", opt, None, None, |issues, item| {
        issues.item_text(item, Text::default())
    });
}

fn read_article(
    headers: &HeaderMap,
    body: &Bytes,
    partial: bool,
) -> Result<Map<String, Value>, Refusal> {
    validate(headers, body, |issues, fields| {
        article_schema(issues, fields, partial);
        fields.clone()
    })
}

/// `pickContent`: the first non-empty string of `content`, `body`, `bodyHtml`.
fn pick_content(data: &Map<String, Value>) -> Option<String> {
    ["content", "body", "bodyHtml"]
        .iter()
        .find_map(|key| match data.get(*key) {
            Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
            _ => None,
        })
}

/// `slugify`: lower case, every run of non-`[a-z0-9]` a dash, one dash off
/// each end, at most 500 characters.
fn slugify(input: &str) -> String {
    let lower = input.to_lowercase();
    let mut out = String::new();
    let mut in_run = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    let out = out.strip_prefix('-').unwrap_or(&out);
    let out = out.strip_suffix('-').unwrap_or(out);
    out.chars().take(500).collect()
}

/// `stripTags` (`@weldsuite/text`): every `<…>` span removed; a `<` without
/// a `>` after it, and the rest, kept.
fn strip_tags(html: &str) -> String {
    let mut out = String::new();
    let mut pos = 0;
    let mut from = 0;
    while let Some(lt) = html[from..].find('<').map(|i| i + from) {
        let Some(gt) = html[lt + 1..].find('>').map(|i| i + lt + 1) else {
            break;
        };
        from = gt + 1;
        out.push_str(&html[pos..lt]);
        pos = gt + 1;
    }
    out.push_str(&html[pos..]);
    out
}

/// `text.slice(0, n)` in UTF-16 code units.
fn js_slice_text(text: &str, n: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// `resolveFolder`: `None` when the body leaves the folder alone; otherwise
/// the folder id with its name and path (or name) copied onto the article.
async fn resolve_folder(
    db: &weldsuite_db::PgPool,
    data: &Map<String, Value>,
) -> Result<Option<[(&'static str, Value); 3]>, DbErr> {
    let raw = if data.contains_key("folderId") {
        data.get("folderId")
    } else if data.contains_key("categoryId") {
        data.get("categoryId")
    } else {
        return Ok(None);
    };
    let raw = raw.and_then(Value::as_str).filter(|raw| !raw.is_empty());
    let Some(raw) = raw else {
        return Ok(Some([
            ("categoryId", Value::Null),
            ("categoryName", Value::Null),
            ("category", Value::Null),
        ]));
    };
    let folder: Option<(String, Option<String>)> =
        helpdesk_article_folders::Entity::find_by_id(raw)
            .select_only()
            .column(helpdesk_article_folders::Column::Name)
            .column(helpdesk_article_folders::Column::Path)
            .into_tuple()
            .one(&orm(db))
            .await?;
    let (name, category) = match folder {
        Some((name, path)) => (json!(name.clone()), json!(path.unwrap_or(name))),
        None => (Value::Null, Value::Null),
    };
    Ok(Some([
        ("categoryId", json!(raw)),
        ("categoryName", name),
        ("category", category),
    ]))
}

async fn list_articles(caller: Caller, RawQuery(query): RawQuery) -> Response {
    match fetch(ARTICLE_LISTING, &caller.db, query.as_deref()).await {
        Ok(fetched) => page_list(fetched.rows, fetched.limit, fetched.total),
        Err(error) => error.respond("Failed to list articles"),
    }
}

async fn article_detail(caller: Caller, Path(id): Path<String>) -> Response {
    const MESSAGE: &str = "Failed to fetch article";
    match HELPDESK_ARTICLES.find_live(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found("Article", &id).respond(MESSAGE),
        Err(error) => Refusal::from(error).respond(MESSAGE),
    }
}

#[allow(clippy::too_many_lines)] // the TypeScript route, step by step
async fn create_article(
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to create article";
    let data = match read_article(&headers, &body, false) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let id = generate_id("art");
    let now = now();
    let table = &HELPDESK_ARTICLES;

    let content = pick_content(&data).unwrap_or_default();
    let title = data
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let base = match data.get("slug") {
        Some(Value::String(slug)) if !slug.is_empty() => slugify(slug),
        _ => slugify(&title),
    };
    let slug = if base.is_empty() { id.clone() } else { base };
    let author_id = match data.get("authorId") {
        Some(Value::String(author)) if !author.is_empty() => author.clone(),
        _ => caller.user_id.clone(),
    };
    let status = data
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("draft")
        .to_owned();
    let published = status == "published";
    let excerpt = match data.get("excerpt") {
        Some(Value::String(excerpt)) => excerpt.clone(),
        _ => js_slice_text(&strip_tags(&content), 200),
    };
    let suffix: String = id.chars().skip(4).take(6).collect();

    let mut values = Map::new();
    table.set(&mut values, "id", json!(id));
    table.set(&mut values, "title", json!(title));
    table.set(&mut values, "slug", json!(format!("{slug}-{suffix}")));
    table.set(&mut values, "content", json!(content));
    table.set(&mut values, "excerpt", json!(excerpt));
    table.set(&mut values, "status", json!(status));
    table.set(
        &mut values,
        "visibility",
        data.get("visibility")
            .cloned()
            .unwrap_or_else(|| json!("public")),
    );
    let audience = data.get("audienceCompanyIds").cloned();
    table.set(
        &mut values,
        "audienceCompanyIds",
        audience.unwrap_or_else(|| json!([])),
    );
    let locale = normalize_locale(data.get("locale").and_then(Value::as_str));
    table.set(&mut values, "locale", json!(locale));
    if let Some(tags) = data.get("tags") {
        table.set(&mut values, "tags", tags.clone());
    }
    table.set(&mut values, "authorId", json!(author_id));
    if let Some(author_name) = data.get("authorName") {
        table.set(&mut values, "authorName", author_name.clone());
    }
    table.set(&mut values, "isDraft", json!(!published));
    table.set(
        &mut values,
        "publishedAt",
        if published { json!(now) } else { Value::Null },
    );
    table.set(&mut values, "viewCount", json!(0));
    table.set(&mut values, "helpfulCount", json!(0));
    table.set(&mut values, "notHelpfulCount", json!(0));
    table.set(&mut values, "createdAt", json!(now));
    table.set(&mut values, "updatedAt", json!(now));

    // Outside the route's try: a failure here is the app's 500.
    match resolve_folder(&caller.db, &data).await {
        Ok(Some(folder)) => {
            for (prop, value) in folder {
                table.set(&mut values, prop, value);
            }
        }
        Ok(None) => {}
        Err(error) => {
            tracing::error!(%error, "desk: article folder lookup failed");
            return ApiError::internal().into_response();
        }
    }

    if let Err(error) = table
        .insert(
            &caller.db,
            values,
            &["createdAt", "updatedAt", "publishedAt"],
        )
        .await
    {
        return write_failed(&error, MESSAGE);
    }
    caller.publish(
        &state,
        ev::HELPDESK_ARTICLE_CREATED,
        &id,
        &json!({ "id": id, "title": title, "slug": slug, "status": status, "authorId": author_id }),
    );
    Created(json!({ "id": id })).into_response()
}

async fn update_article(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to update article";
    let data = match read_article(&headers, &body, true) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let table = &HELPDESK_ARTICLES;
    let existing = match table.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Article", &id).respond(MESSAGE),
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };
    let now = now();
    let mut values = Map::new();
    table.set(&mut values, "updatedAt", json!(now));
    for key in [
        "title",
        "slug",
        "excerpt",
        "visibility",
        "audienceCompanyIds",
        "tags",
        "authorName",
    ] {
        if let Some(value) = data.get(key) {
            table.set(&mut values, key, value.clone());
        }
    }
    match locale_change(&caller.db, &id, &existing, &data).await {
        Ok(Some(locale)) => table.set(&mut values, "locale", json!(locale)),
        Ok(None) => {}
        Err(refusal) => return refusal.respond(MESSAGE),
    }
    if let Some(content) = pick_content(&data) {
        table.set(&mut values, "content", json!(content));
    }
    match resolve_folder(&caller.db, &data).await {
        Ok(Some(folder)) => {
            for (prop, value) in folder {
                table.set(&mut values, prop, value);
            }
        }
        Ok(None) => {}
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    }
    let existing_status = existing["status"].as_str().unwrap_or_default().to_owned();
    let mut new_status: Option<String> = None;
    if let Some(status) = data.get("status").and_then(Value::as_str)
        && status != existing_status
    {
        new_status = Some(status.to_owned());
        table.set(&mut values, "status", json!(status));
        let becoming = status == "published";
        let was = existing_status == "published";
        if becoming && !was {
            table.set(&mut values, "publishedAt", json!(now));
            table.set(&mut values, "unpublishedAt", Value::Null);
            table.set(&mut values, "isDraft", json!(false));
        } else if !becoming && was {
            table.set(&mut values, "unpublishedAt", json!(now));
            table.set(&mut values, "isDraft", json!(true));
        }
    }
    if let Err(error) = table
        .patch(
            &caller.db,
            &id,
            values,
            true,
            &["updatedAt", "publishedAt", "unpublishedAt"],
        )
        .await
    {
        return write_failed(&error, MESSAGE);
    }
    let pick = |key: &str| {
        data.get(key)
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| existing[key].clone())
    };
    let event = json!({
        "id": id,
        "title": pick("title"),
        "slug": pick("slug"),
        "status": new_status.map_or_else(|| existing["status"].clone(), Value::String),
    });
    caller.publish(&state, ev::HELPDESK_ARTICLE_UPDATED, &id, &event);
    Data(json!({ "id": id })).into_response()
}

async fn delete_article(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const MESSAGE: &str = "Failed to delete article";
    match HELPDESK_ARTICLES.find_live(&caller.db, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found("Article", &id).respond(MESSAGE),
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    }
    if let Err(error) = soft_delete(&caller.db, &HELPDESK_ARTICLES, &id).await {
        return write_failed(&error, MESSAGE);
    }
    caller.publish(
        &state,
        ev::HELPDESK_ARTICLE_DELETED,
        &id,
        &json!({ "id": id }),
    );
    NoContent.into_response()
}

// ---------------------------------------------------------------------------
// Language versions
// ---------------------------------------------------------------------------

/// `localeConflict(db, article, locale)`: why the article `id` (a version
/// of `translation_of` when set) can't have `locale`, `None` when it can.
async fn locale_conflict(
    db: &weldsuite_db::PgPool,
    id: &str,
    translation_of: Option<&str>,
    locale: Option<&str>,
) -> Result<Option<&'static str>, DbErr> {
    if translation_of.is_some() && locale.is_none() {
        return Ok(Some("A language version needs a language"));
    }
    let Some(locale) = locale else {
        return Ok(None);
    };
    let root = translation_of.unwrap_or(id);
    let taken: Option<String> = helpdesk_articles::Entity::find()
        .select_only()
        .column(Article::Id)
        .filter(Article::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(Article::Id.eq(root))
                .add(Article::TranslationOfId.eq(root)),
        )
        .filter(Article::Id.ne(id))
        .filter(Article::Locale.eq(locale))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(taken.map(|_| "This article already has a version in that language"))
}

/// The locale an update sets (`None` when the body leaves it alone): one
/// version per locale, and a version keeps one (409 otherwise).
async fn locale_change(
    db: &weldsuite_db::PgPool,
    id: &str,
    existing: &Value,
    data: &Map<String, Value>,
) -> Result<Option<Option<String>>, Refusal> {
    if !data.contains_key("locale") {
        return Ok(None);
    }
    let locale = normalize_locale(data.get("locale").and_then(Value::as_str));
    if locale.as_deref() != existing["locale"].as_str() {
        let translation_of = existing["translationOfId"].as_str();
        if let Some(conflict) = locale_conflict(db, id, translation_of, locale.as_deref()).await? {
            return Err(ApiError::conflict(conflict).into());
        }
    }
    Ok(Some(locale))
}

/// `originalOf(db, id)`: the original of the family `id` belongs to, `None`
/// when either is gone.
async fn original_of(db: &weldsuite_db::PgPool, id: &str) -> Result<Option<Value>, sea_orm::DbErr> {
    let Some(found) = HELPDESK_ARTICLES.find_live(db, id).await? else {
        return Ok(None);
    };
    match found["translationOfId"].as_str().filter(|o| !o.is_empty()) {
        Some(original) => HELPDESK_ARTICLES.find_live(db, original).await,
        None => Ok(Some(found)),
    }
}

async fn list_translations(caller: Caller, Path(id): Path<String>) -> Response {
    const MESSAGE: &str = "Failed to list language versions";
    let original = match original_of(&caller.db, &id).await {
        Ok(Some(original)) => original,
        Ok(None) => return Refusal::not_found("Article", &id).respond(MESSAGE),
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };
    let original_id = original["id"].as_str();
    let rows = helpdesk_articles::Entity::find()
        .filter(Article::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(Article::Id.eq(original_id))
                .add(Article::TranslationOfId.eq(original_id)),
        )
        .order_by_asc(sea_orm::ExprTrait::is_not_null(Expr::col(
            Article::TranslationOfId,
        )))
        .order_by_with_nulls(Article::Locale, Order::Asc, NullOrdering::First)
        .order_by_asc(Article::Id)
        .all(&orm(&caller.db))
        .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };
    let data: Vec<Value> = rows
        .into_iter()
        .map(|article| {
            let a = serde_json::to_value(article).unwrap_or(Value::Null);
            json!({
                "id": a["id"], "title": a["title"], "slug": a["slug"], "status": a["status"],
                "visibility": a["visibility"], "locale": a["locale"],
                "translationOfId": a["translationOfId"], "updatedAt": a["updatedAt"],
            })
        })
        .collect();
    Data(data).into_response()
}

/// `createArticleTranslationSchema`.
fn translation_schema(issues: &mut Issues, body: &Map<String, Value>) {
    let opt = Presence::Optional;
    issues.pattern(
        body,
        "locale",
        Presence::Required,
        None,
        None,
        is_locale,
        "Invalid locale",
    );
    issues.text(body, "title", opt, Some(1), Some(500));
    issues.text(body, "content", opt, None, None);
    issues.text(body, "excerpt", opt, None, None);
}

async fn create_translation(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to create the language version";
    let data = match validate(&headers, &body, |issues, fields| {
        translation_schema(issues, fields);
        fields.clone()
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let original = match original_of(&caller.db, &id).await {
        Ok(Some(original)) => original,
        Ok(None) => return Refusal::not_found("Article", &id).respond(MESSAGE),
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };
    let original_id = original["id"].as_str().unwrap_or_default().to_owned();
    let locale = normalize_locale(data.get("locale").and_then(Value::as_str));
    match locale_conflict(&caller.db, "", Some(&original_id), locale.as_deref()).await {
        Ok(Some(conflict)) => return ApiError::conflict(conflict).into_response(),
        Ok(None) => {}
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    }

    let new_id = generate_id("art");
    let now = now();
    let given = |key: &str| data.get(key).filter(|v| v.is_string()).cloned();
    let title = given("title").unwrap_or_else(|| original["title"].clone());
    let base = article_slug(title.as_str().unwrap_or_default());
    let base = if base.is_empty() {
        new_id.clone()
    } else {
        base
    };
    let suffix: String = new_id.chars().skip(4).take(6).collect();
    let slug = format!("{base}-{suffix}");
    let audience = if original["audienceCompanyIds"].is_null() {
        json!([])
    } else {
        original["audienceCompanyIds"].clone()
    };
    let table = &HELPDESK_ARTICLES;
    let mut values = Map::new();
    for (prop, value) in [
        ("id", json!(new_id)),
        ("title", title.clone()),
        ("slug", json!(slug)),
        (
            "content",
            given("content").unwrap_or_else(|| original["content"].clone()),
        ),
        (
            "excerpt",
            given("excerpt").unwrap_or_else(|| original["excerpt"].clone()),
        ),
        ("category", original["category"].clone()),
        ("categoryId", original["categoryId"].clone()),
        ("categoryName", original["categoryName"].clone()),
        ("status", json!("draft")),
        ("visibility", original["visibility"].clone()),
        ("audienceCompanyIds", audience),
        ("locale", json!(locale)),
        ("translationOfId", json!(original_id)),
        ("tags", original["tags"].clone()),
        ("authorId", json!(caller.user_id)),
        ("isDraft", json!(true)),
        ("publishedAt", Value::Null),
        ("viewCount", json!(0)),
        ("helpfulCount", json!(0)),
        ("notHelpfulCount", json!(0)),
        ("createdAt", json!(now)),
        ("updatedAt", json!(now)),
    ] {
        table.set(&mut values, prop, value);
    }
    if let Err(error) = table
        .insert(
            &caller.db,
            values,
            &["createdAt", "updatedAt", "publishedAt"],
        )
        .await
    {
        return write_failed(&error, MESSAGE);
    }
    caller.publish(
        &state,
        ev::HELPDESK_ARTICLE_CREATED,
        &new_id,
        &json!({
            "id": new_id, "title": title, "slug": slug, "status": "draft",
            "authorId": caller.user_id, "translationOfId": original_id, "locale": locale,
        }),
    );
    Created(json!({ "id": new_id })).into_response()
}

// ---------------------------------------------------------------------------
// Canned responses: search, categories, use
// ---------------------------------------------------------------------------

/// `zValidator('query', searchQuerySchema)`: `q` trimmed (max 200, default
/// `''`), `limit` coerced (1..50, default 10).
fn search_query(query: Option<&str>) -> Result<(String, f64), Box<Response>> {
    let values = query_values(query);
    let mut issues = Issues::default();
    let q = issues
        .text_with(
            &values,
            "q",
            Presence::Optional,
            Text::trimmed(None, Some(200)),
        )
        .into_option()
        .unwrap_or_default();
    let limit = issues
        .number(
            &values,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                min: Some(1.0),
                max: Some(50.0),
                ..Number::default()
            },
        )
        .into_option()
        .unwrap_or(10.0);
    issues
        .finish()
        .map_err(|invalid| Box::new(invalid.into_response()))?;
    Ok((q, limit))
}

async fn search_canned(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let (q, limit) = match search_query(query.as_deref()) {
        Ok(read) => read,
        Err(response) => return *response,
    };
    #[allow(clippy::cast_possible_truncation)]
    let limit = limit.round() as i64;
    use helpdesk_canned_responses::Column as Canned;
    let mut select = helpdesk_canned_responses::Entity::find()
        .filter(Canned::DeletedAt.is_null())
        .filter(Canned::IsActive.eq(true));
    if !q.is_empty() {
        let term = format!("%{q}%");
        select = select.filter(
            Condition::any()
                .add(Canned::Name.ilike(&term))
                .add(Canned::Content.ilike(&term))
                .add(Canned::Shortcut.ilike(&term)),
        );
    }
    // A personal response is its owner's only.
    let rows = select
        .filter(
            Condition::any()
                .add(
                    Condition::all()
                        .add(Canned::Scope.eq("personal"))
                        .add(Canned::AgentId.eq(&caller.user_id)),
                )
                .add(Canned::Scope.ne("personal")),
        )
        .order_by_desc(Canned::UsageCount)
        .order_by_asc(Canned::Name)
        .limit(u64::try_from(limit).unwrap_or(0))
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.into_iter()
                .map(|row| serde_json::to_value(row).unwrap_or(Value::Null))
                .collect(),
        ))
        .into_response(),
        Err(error) => Refusal::from(error).respond("Failed to search canned responses"),
    }
}

/// A character's place in ICU's root order: spaces and punctuation, digits,
/// then letters.
fn collation_class(c: char) -> u8 {
    if c.is_alphabetic() {
        2
    } else {
        u8::from(c.is_numeric())
    }
}

/// `a.localeCompare(b)` (ICU root collation), closely enough for category
/// names: letters compare without case first, then lower before upper.
fn locale_compare(a: &str, b: &str) -> Ordering {
    let primary = |s: &str| -> Vec<(u8, String)> {
        s.chars()
            .map(|c| (collation_class(c), c.to_lowercase().collect()))
            .collect()
    };
    primary(a).cmp(&primary(b)).then_with(|| {
        let case = |s: &str| -> Vec<bool> { s.chars().map(char::is_uppercase).collect() };
        case(a).cmp(&case(b))
    })
}

async fn canned_categories(caller: Caller) -> Response {
    use helpdesk_canned_responses::Column as Canned;
    let rows: Result<Vec<String>, DbErr> = helpdesk_canned_responses::Entity::find()
        .select_only()
        .column(Canned::Category)
        .distinct()
        .filter(Canned::DeletedAt.is_null())
        .filter(Canned::Category.is_not_null())
        .into_tuple()
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(mut categories) => {
            categories.sort_by(|a, b| locale_compare(a, b));
            Data(json!(categories)).into_response()
        }
        Err(error) => Refusal::from(error).respond("Failed to fetch categories"),
    }
}

/// `String(number)` for what a JSON body carries.
fn js_number_string(number: f64) -> String {
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() < 1e21 {
        format!("{}", number as i64)
    } else {
        format!("{number}")
    }
}

/// `asText(value)` (`@weldsuite/text`).
fn as_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(n) => js_number_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    as_text(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => value.to_string(),
    }
}

/// `value[part]` on an object or array (`undefined` is `None`).
fn property(value: &Value, part: &str) -> Option<Value> {
    match value {
        Value::Object(map) => map.get(part).cloned(),
        Value::Array(items) => {
            if part == "length" {
                return Some(json!(items.len()));
            }
            let canonical = part
                .parse::<usize>()
                .ok()
                .filter(|i| i.to_string() == part)?;
            items.get(canonical).cloned()
        }
        _ => None,
    }
}

/// One `{{path}}`: its value by dot path, or the placeholder as written.
fn resolve(path: &str, context: &Value) -> String {
    let literal = || format!("{{{{{path}}}}}");
    let mut value = Some(context.clone());
    for part in js_trim(path).split('.') {
        match &value {
            Some(current @ (Value::Object(_) | Value::Array(_))) => {
                value = property(current, part);
            }
            _ => return literal(),
        }
    }
    match value {
        Some(value) if !value.is_null() => as_text(&value),
        _ => literal(),
    }
}

/// `interpolateVariables`: every `{{path}}` (`/\{\{([^{}]+)\}\}/g`) replaced.
fn interpolate(text: &str, context: &Value) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let len = after.find(['{', '}']).unwrap_or(after.len());
        if len > 0 && after[len..].starts_with("}}") {
            out.push_str(&rest[..start]);
            out.push_str(&resolve(&after[..len], context));
            rest = &after[len + 2..];
        } else {
            // No match here: the regex moves on one character.
            let next = start + 1;
            out.push_str(&rest[..next]);
            rest = &rest[next..];
        }
    }
    out.push_str(rest);
    out
}

async fn use_canned(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const MESSAGE: &str = "Failed to use canned response";
    let variables = match validate(&headers, &body, |issues, fields| {
        issues
            .nested(fields, "variables", Presence::Optional, |_, map| {
                map.clone()
            })
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(variables) => Value::Object(variables),
        Err(refusal) => return refusal.respond(MESSAGE),
    };
    let row = match HELPDESK_CANNED_RESPONSES.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Canned response", &id).respond(MESSAGE),
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };
    let content = interpolate(row["content"].as_str().unwrap_or_default(), &variables);
    let subject = match row["subject"].as_str() {
        Some(subject) if !subject.is_empty() => json!(interpolate(subject, &variables)),
        _ => Value::Null,
    };
    use helpdesk_canned_responses::Column as Canned;
    let now = weldsuite_db::utc_now();
    let bumped = helpdesk_canned_responses::Entity::update_many()
        .col_expr(
            Canned::UsageCount,
            sea_orm::ExprTrait::add(
                Expr::from(Func::coalesce([
                    Expr::col(Canned::UsageCount),
                    Expr::val(0),
                ])),
                1,
            ),
        )
        .col_expr(Canned::LastUsedAt, Expr::value(now))
        .col_expr(Canned::UpdatedAt, Expr::value(now))
        .filter(Canned::Id.eq(&id))
        .exec(&orm(&caller.db))
        .await;
    if let Err(error) = bumped {
        return Refusal::from(error).respond(MESSAGE);
    }
    let actions = match &row["actions"] {
        Value::Null => json!([]),
        actions => actions.clone(),
    };
    Data(json!({ "content": content, "subject": subject, "actions": actions })).into_response()
}

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

/// The changelog list's conditions: live entries, `status`, `type` and the
/// search, then (for the page) the cursor, newest release first.
fn changelog_conditions(
    status: Option<&str>,
    kind: Option<&str>,
    search: Option<&str>,
    cursor: Option<&CursorRow>,
) -> Condition {
    use helpdesk_changelog::Column as Entry;
    let mut all = Condition::all().add(Entry::DeletedAt.is_null());
    if let Some(status) = status {
        all = all.add(Entry::Status.eq(status));
    }
    if let Some(kind) = kind {
        all = all.add(Entry::Type.eq(kind));
    }
    if let Some(search) = search {
        all = all.add(
            Condition::any()
                .add(Entry::Title.like(search))
                .add(Entry::Version.like(search))
                .add(Entry::Description.like(search)),
        );
    }
    if let Some((at, id)) = cursor {
        all = all.add(
            Condition::any().add(Entry::ReleaseDate.lt(*at)).add(
                Condition::all()
                    .add(Entry::ReleaseDate.eq(*at))
                    .add(Entry::Id.lt(id.as_str())),
            ),
        );
    }
    all
}

/// `Math.min(Math.max(x, lo), hi)` with JavaScript's NaN.
fn clamp_js(value: f64, lo: f64, hi: f64) -> f64 {
    if value.is_nan() {
        f64::NAN
    } else {
        value.max(lo).min(hi)
    }
}

/// `value ? Number.parseInt(value, 10) : NaN`.
fn parse_int_param(query: Option<&str>, name: &str) -> f64 {
    query_param(query, name)
        .filter(|raw| !raw.is_empty())
        .and_then(|raw| js_parse_int(&raw))
        .unwrap_or(f64::NAN)
}

/// Drizzle's `.limit(n)`: left out when NaN or negative.
fn drizzle_limit(limit: f64) -> Option<i64> {
    #[allow(clippy::cast_possible_truncation)]
    (!limit.is_nan() && limit >= 0.0).then_some(limit as i64)
}

/// A finite number as JSON, NaN as `null` (`JSON.stringify`).
fn js_json_number(number: f64) -> Value {
    if !number.is_finite() {
        return Value::Null;
    }
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() < 9e15 {
        json!(number as i64)
    } else {
        json!(number)
    }
}

async fn list_changelog(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    const MESSAGE: &str = "Failed to list changelog entries";
    let query = raw.as_deref();
    let limit = clamp_js(
        match query_param(query, "limit").filter(|raw| !raw.is_empty()) {
            None => 25.0,
            Some(raw) => js_parse_int(&raw).unwrap_or(f64::NAN),
        },
        1.0,
        100.0,
    );
    let raw_page = parse_int_param(query, "page");
    let raw_page_size = parse_int_param(query, "pageSize");
    let cursor = query_param(query, "cursor");
    let use_cursor = cursor.is_some() || raw_page.is_nan();
    let page = if raw_page.is_nan() {
        1.0
    } else {
        raw_page.max(1.0)
    };
    let page_size = if raw_page_size.is_nan() {
        limit
    } else {
        raw_page_size.clamp(1.0, 100.0)
    };

    let filter = |name: &str| query_param(query, name).filter(|v| !v.is_empty() && v != "all");
    let status = filter("status");
    let kind = filter("type");
    let search = query_param(query, "search")
        .filter(|v| !v.is_empty())
        .map(|v| format!("%{v}%"));

    let cursor_row = match cursor.as_deref().filter(|c| use_cursor && !c.is_empty()) {
        Some(cursor) => match changelog_cursor(&caller.db, cursor).await {
            Ok(row) => row,
            Err(error) => {
                tracing::error!(%error, "desk: changelog cursor lookup failed");
                return ApiError::internal().into_response();
            }
        },
        None => None,
    };

    let fetch_limit = if use_cursor { limit + 1.0 } else { page_size };
    let offset = if use_cursor {
        0.0
    } else {
        (page - 1.0) * page_size
    };
    #[allow(clippy::cast_possible_truncation)]
    let sql_offset = (!offset.is_nan() && offset > 0.0).then_some(offset as i64);

    let (status, kind, search) = (status.as_deref(), kind.as_deref(), search.as_deref());
    let db = orm(&caller.db);
    let listed = async {
        use helpdesk_changelog::Column as Entry;
        let mut select = helpdesk_changelog::Entity::find()
            .filter(changelog_conditions(
                status,
                kind,
                search,
                cursor_row.as_ref(),
            ))
            .order_by_desc(Entry::ReleaseDate)
            .order_by_desc(Entry::Id);
        if let Some(limit) = drizzle_limit(fetch_limit) {
            select = select.limit(u64::try_from(limit).unwrap_or(0));
        }
        if let Some(offset) = sql_offset {
            select = select.offset(u64::try_from(offset).unwrap_or(0));
        }
        let rows = select
            .all(&db)
            .await?
            .into_iter()
            .map(|row| serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string())))
            .collect::<Result<Vec<Value>, DbErr>>()?;
        let total = helpdesk_changelog::Entity::find()
            .filter(changelog_conditions(status, kind, search, None))
            .count(&db)
            .await?;
        Ok::<_, DbErr>((rows, i64::try_from(total).unwrap_or(i64::MAX)))
    };
    let (rows, total) = match listed.await {
        Ok(listed) => listed,
        Err(error) => return Refusal::from(error).respond(MESSAGE),
    };

    if use_cursor {
        return page_list(rows, limit, total);
    }
    offset_page(&rows, total, offset, page, page_size)
}

/// The cursor row's release date (as JavaScript read it) and id.
async fn changelog_cursor(db: &weldsuite_db::PgPool, id: &str) -> Result<Option<CursorRow>, DbErr> {
    use helpdesk_changelog::Column as Entry;
    let row: Option<(PrimitiveDateTime, String)> = helpdesk_changelog::Entity::find_by_id(id)
        .select_only()
        .column(Entry::ReleaseDate)
        .column(Entry::Id)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.map(|(release_date, id)| {
        // JavaScript reads the stamp to the millisecond.
        (weldsuite_db::utc_timestamp(release_date.assume_utc()), id)
    }))
}

/// `list(c, rows, offsetMeta(rows, totalCount, offset, page, pageSize))`.
fn offset_page(rows: &[Value], total: i64, offset: f64, page: f64, page_size: f64) -> Response {
    #[allow(clippy::cast_precision_loss)]
    let has_more = offset + (rows.len() as f64) < total as f64;
    let cursor = if has_more {
        rows.last()
            .and_then(|row| row["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    #[allow(clippy::cast_precision_loss)]
    let total_pages = (total as f64 / page_size).ceil();
    Json(json!({
        "data": rows,
        "pagination": {
            "totalCount": total,
            "hasMore": has_more,
            "cursor": cursor,
            "page": js_json_number(page),
            "pageSize": js_json_number(page_size),
            "totalPages": js_json_number(total_pages),
        },
    }))
    .into_response()
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

async fn helpdesk_stats(caller: Caller) -> Response {
    use helpdesk_tickets::Column as Ticket;
    type Counts = (i64, i64, i64, i64, i64, i64, i64, i64);
    // `count(*) filter (where …)`.
    let counted =
        |condition: sea_orm::sea_query::Expr| Expr::from(Func::count(Expr::case(condition, 1)));
    let row: Result<Option<Counts>, DbErr> = helpdesk_tickets::Entity::find()
        .select_only()
        .column_as(Ticket::Id.count(), "total")
        .column_as(counted(Ticket::Status.eq("open")), "open")
        .column_as(counted(Ticket::Status.eq("pending")), "pending")
        .column_as(counted(Ticket::Status.eq("resolved")), "resolved")
        .column_as(counted(Ticket::Status.eq("closed")), "closed")
        .column_as(counted(Ticket::Status.eq("new")), "new")
        .column_as(counted(Ticket::Priority.eq("urgent")), "urgent")
        .column_as(counted(Ticket::Priority.eq("high")), "high")
        .filter(Ticket::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
        .await;
    let row = row.map(Option::unwrap_or_default);
    match row {
        Ok((total, open, pending, resolved, closed, new, urgent, high)) => Data(json!({
            "totalTickets": total,
            "openTickets": open,
            "pendingTickets": pending,
            "resolvedTickets": resolved,
            "closedTickets": closed,
            "newTickets": new,
            "urgentTickets": urgent,
            "highPriorityTickets": high,
        }))
        .into_response(),
        Err(error) => Refusal::from(error).respond("Failed to fetch helpdesk stats"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_like_the_route() {
        assert_eq!(slugify("  Custom Article Slug!! "), "custom-article-slug");
        assert_eq!(slugify("***"), "");
        assert_eq!(
            slugify("How to start using WeldSuite"),
            "how-to-start-using-weldsuite"
        );
    }

    #[test]
    fn strips_tags() {
        assert_eq!(strip_tags("<p>Hello <b>world</b></p>"), "Hello world");
        assert_eq!(strip_tags("1 < 2"), "1 < 2");
    }

    #[test]
    fn interpolates_like_the_route() {
        let vars = json!({
            "customer": { "name": "Ada", "tier": "gold" },
            "order": { "id": 42 },
            "tags": ["a", null, "b"],
            "count": 0,
            "flag": false,
            "nil": null,
            "price": 12.5,
        });
        let template = "Hi {{customer.name}}, order {{ order.id }} ({{order.missing}}) {{customer.name.first}} {{customer}} \
                        [{{tags}}] {{count}} {{flag}} {{nil}} {{ }} {{}} {{{customer.name}}} {{price}} {{ unknown.path }}";
        assert_eq!(
            interpolate(template, &vars),
            "Hi Ada, order 42 ({{order.missing}}) {{customer.name.first}} {\"name\":\"Ada\",\"tier\":\"gold\"} \
             [a,,b] 0 false {{nil}} {{ }} {{}} {Ada} 12.5 {{ unknown.path }}"
        );
    }

    #[test]
    fn categories_sort_like_locale_compare() {
        let mut categories = vec![
            "shipping",
            "Billing",
            "accounts",
            "",
            "General",
            "inactive-cat",
            "Crud",
        ];
        categories.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(
            categories,
            vec![
                "",
                "accounts",
                "Billing",
                "Crud",
                "General",
                "inactive-cat",
                "shipping"
            ]
        );
    }
}
