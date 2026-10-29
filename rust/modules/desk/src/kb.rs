//! WeldDesk knowledge base: articles, canned responses (search, categories, use), helpdesk changelog and stats.
//!
//! `/api/articles` (`routes/articles/index.ts`): the cursor list and the soft
//! delete are the shared CRUD's; create and update are the route's own
//! (slug, content aliases, excerpt, folder resolution, publish lifecycle).
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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Issues, Number, Presence, Text, js_trim, query_values};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::crud::{Filter, Listing, fetch, page_list, soft_delete, write_failed};
use crate::js::{js_parse_int, query_param};
use crate::library::{ARTICLES, CANNED_RESPONSES, TICKETS};
use crate::tables::{HELPDESK_ARTICLES, HELPDESK_CANNED_RESPONSES, HELPDESK_CHANGELOG};
use crate::{Caller, DeskState, Refusal, now, validate};

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

const ARTICLE_LIST: (&str, &str) = listing!("helpdesk_articles";
    "($2::boolean or t.status = $3::text)", "($4::boolean or t.visibility = $5::text)",
    "($6::boolean or t.category_id = $7::text)", "($8::boolean or t.author_id = $9::text)",
    "($10::boolean or t.title like $11::text)";
    12, 13, 14; "$15");

const ARTICLE_LISTING: Listing = Listing {
    table: &HELPDESK_ARTICLES,
    filters: &[
        Filter::eq("status"),
        Filter::eq("visibility"),
        Filter::eq("folderId"),
        Filter::eq("authorId"),
        Filter::like("search"),
    ],
    list_sql: ARTICLE_LIST.0,
    count_sql: ARTICLE_LIST.1,
    slice_count: true,
};

const ARTICLE_STATUSES: [&str; 5] = ["draft", "review", "published", "archived", "outdated"];
const ARTICLE_VISIBILITIES: [&str; 2] = ["public", "internal"];

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
) -> Result<Option<[(&'static str, Value); 3]>, sqlx::Error> {
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
        sqlx::query_as("select name, path from helpdesk_article_folders where id = $1 limit 1")
            .bind(raw)
            .fetch_optional(db)
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
        Err(error) => Refusal::Database(error).respond(MESSAGE),
    }
}

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
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    };
    let now = now();
    let mut values = Map::new();
    table.set(&mut values, "updatedAt", json!(now));
    for key in [
        "title",
        "slug",
        "excerpt",
        "visibility",
        "tags",
        "authorName",
    ] {
        if let Some(value) = data.get(key) {
            table.set(&mut values, key, value.clone());
        }
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
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
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
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
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
// Canned responses: search, categories, use
// ---------------------------------------------------------------------------

/// `$1` skips the term, `$2` the `%term%`, `$3` the caller, `$4` the limit.
const CANNED_SEARCH: &str = "select to_jsonb(t) from helpdesk_canned_responses t
    where t.deleted_at is null and t.is_active = true
      and ($1::boolean or (t.name ilike $2::text or t.content ilike $2::text or t.shortcut ilike $2::text))
      and ((t.scope = 'personal' and t.agent_id = $3::text) or t.scope != 'personal')
    order by t.usage_count desc, t.name asc limit $4";

/// `zValidator('query', searchQuerySchema)`: `q` trimmed (max 200, default
/// `''`), `limit` coerced (1..50, default 10).
fn search_query(query: Option<&str>) -> Result<(String, f64), Response> {
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
    issues.finish().map_err(IntoResponse::into_response)?;
    Ok((q, limit))
}

async fn search_canned(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let (q, limit) = match search_query(query.as_deref()) {
        Ok(read) => read,
        Err(response) => return response,
    };
    #[allow(clippy::cast_possible_truncation)]
    let limit = limit.round() as i64;
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(CANNED_SEARCH)
        .bind(q.is_empty())
        .bind(format!("%{q}%"))
        .bind(&caller.user_id)
        .bind(limit)
        .fetch_all(&caller.db)
        .await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.into_iter()
                .map(|row| HELPDESK_CANNED_RESPONSES.js(row))
                .collect(),
        ))
        .into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to search canned responses"),
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
    let rows: Result<Vec<String>, sqlx::Error> = sqlx::query_scalar(
        "select distinct category from helpdesk_canned_responses
         where deleted_at is null and category is not null",
    )
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(mut categories) => {
            categories.sort_by(|a, b| locale_compare(a, b));
            Data(json!(categories)).into_response()
        }
        Err(error) => Refusal::Database(error).respond("Failed to fetch categories"),
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
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    };
    let content = interpolate(row["content"].as_str().unwrap_or_default(), &variables);
    let subject = match row["subject"].as_str() {
        Some(subject) if !subject.is_empty() => json!(interpolate(subject, &variables)),
        _ => Value::Null,
    };
    let bumped = sqlx::query(
        "update helpdesk_canned_responses
         set usage_count = coalesce(usage_count, 0) + 1, last_used_at = $2::timestamp, updated_at = $2::timestamp
         where id = $1",
    )
    .bind(&id)
    .bind(now())
    .execute(&caller.db)
    .await;
    if let Err(error) = bumped {
        return Refusal::Database(error).respond(MESSAGE);
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

/// `$1/$2` status, `$3/$4` type, `$5/$6` search, the cursor `$7` skip, `$8`
/// release date, `$9` id; `$10` limit, `$11` offset. Newest release first.
const CHANGELOG_LIST: &str = "select to_jsonb(t) from helpdesk_changelog t
    where t.deleted_at is null
      and ($1::boolean or t.status = $2::text)
      and ($3::boolean or t.type = $4::text)
      and ($5::boolean or (t.title like $6::text or t.version like $6::text or t.description like $6::text))
      and ($7::boolean or (t.release_date < $8::timestamp or (t.release_date = $8::timestamp and t.id < $9::text)))
    order by t.release_date desc, t.id desc limit $10 offset $11";

const CHANGELOG_COUNT: &str = "select count(*) from helpdesk_changelog t
    where t.deleted_at is null
      and ($1::boolean or t.status = $2::text)
      and ($3::boolean or t.type = $4::text)
      and ($5::boolean or (t.title like $6::text or t.version like $6::text or t.description like $6::text))";

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
        raw_page_size.max(1.0).min(100.0)
    };

    let filter = |name: &str| query_param(query, name).filter(|v| !v.is_empty() && v != "all");
    let status = filter("status");
    let kind = filter("type");
    let search = query_param(query, "search")
        .filter(|v| !v.is_empty())
        .map(|v| format!("%{v}%"));

    let cursor_row = match cursor.as_deref().filter(|c| use_cursor && !c.is_empty()) {
        Some(cursor) => {
            let row: Result<Option<(Option<String>, String)>, sqlx::Error> = sqlx::query_as(
                "select to_jsonb(release_date)#>>'{}', id from helpdesk_changelog where id = $1 limit 1",
            )
            .bind(cursor)
            .fetch_optional(&caller.db)
            .await;
            match row {
                Ok(row) => row.and_then(|(stamp, id)| {
                    stamp
                        .and_then(|stamp| weldsuite_db::js_timestamp(&stamp))
                        .map(|stamp| (stamp, id))
                }),
                Err(error) => {
                    tracing::error!(%error, "desk: changelog cursor lookup failed");
                    return ApiError::internal().into_response();
                }
            }
        }
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

    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(CHANGELOG_LIST)
        .bind(status.is_none())
        .bind(status.as_deref())
        .bind(kind.is_none())
        .bind(kind.as_deref())
        .bind(search.is_none())
        .bind(search.as_deref())
        .bind(cursor_row.is_none())
        .bind(cursor_row.as_ref().map(|(stamp, _)| stamp.as_str()))
        .bind(cursor_row.as_ref().map(|(_, id)| id.as_str()))
        .bind(drizzle_limit(fetch_limit))
        .bind(sql_offset)
        .fetch_all(&caller.db)
        .await;
    let total: Result<i64, sqlx::Error> = sqlx::query_scalar(CHANGELOG_COUNT)
        .bind(status.is_none())
        .bind(status.as_deref())
        .bind(kind.is_none())
        .bind(kind.as_deref())
        .bind(search.is_none())
        .bind(search.as_deref())
        .fetch_one(&caller.db)
        .await;
    let (rows, total) = match (rows, total) {
        (Ok(rows), Ok(total)) => (rows, total),
        (Err(error), _) | (_, Err(error)) => return Refusal::Database(error).respond(MESSAGE),
    };
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|row| HELPDESK_CHANGELOG.js(row))
        .collect();

    if use_cursor {
        return page_list(rows, limit, total);
    }
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
    type Counts = (i32, i32, i32, i32, i32, i32, i32, i32);
    let row: Result<Counts, sqlx::Error> = sqlx::query_as(
        "select count(*)::int,
                (count(*) filter (where status = 'open'))::int,
                (count(*) filter (where status = 'pending'))::int,
                (count(*) filter (where status = 'resolved'))::int,
                (count(*) filter (where status = 'closed'))::int,
                (count(*) filter (where status = 'new'))::int,
                (count(*) filter (where priority = 'urgent'))::int,
                (count(*) filter (where priority = 'high'))::int
         from helpdesk_tickets where deleted_at is null",
    )
    .fetch_one(&caller.db)
    .await;
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
        Err(error) => Refusal::Database(error).respond("Failed to fetch helpdesk stats"),
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
