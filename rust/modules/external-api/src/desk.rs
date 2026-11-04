//! WeldDesk's objects: `/v1/articles` (`routes/v1/articles/index.ts`), the
//! help center's knowledge-base articles.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    HELPDESK_ARTICLE_CREATED, HELPDESK_ARTICLE_DELETED, HELPDESK_ARTICLE_UPDATED,
};
use weldsuite_kit::id::generate_id;

use crate::ExternalApiState;
use crate::crud::{
    Answer, Caller, created, dates, get_live, like, no_content, now, ok, page, pick, soft_delete,
    table_list_sql, text, with_updated,
};
use crate::schemas::LIST_ARTICLES;
use crate::schemas_gen::{CREATE_ARTICLE, UPDATE_ARTICLE};
use crate::session::{bad_request, not_found};
use crate::simple::scoped;
use crate::tables_gen::HELPDESK_ARTICLES;
use crate::zod;

type S = State<ExternalApiState>;

/// Desk's routes.
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    router
        .route(
            "/articles",
            scoped(get(list_articles), "articles:read")
                .merge(scoped(post(create_article), "articles:write")),
        )
        .route(
            "/articles/{id}",
            scoped(get(get_article), "articles:read").merge(scoped(
                patch(update_article).delete(delete_article),
                "articles:write",
            )),
        )
}

const ARTICLES_LIST: (&str, &str) = table_list_sql!(
    helpdesk_articles,
    "t.deleted_at is null \
     and ($3->>'search' is null or t.title like $3->>'search') \
     and ($3->>'status' is null or t.status = $3->>'status') \
     and ($3->>'authorId' is null or t.author_id = $3->>'authorId')"
);

/// `slugify(title)`: lower case, runs of anything else than `[a-z0-9]` as
/// one `-`, no dash at either end, at most `max` characters.
pub(crate) fn slugify(title: &str, max: usize) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in title.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    out.chars().take(max).collect()
}

/// `content || body || bodyHtml || undefined`.
fn derive_content(body: &Map<String, Value>) -> Option<String> {
    ["content", "body", "bodyHtml"].iter().find_map(|key| {
        body.get(*key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    })
}

async fn list_articles(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_ARTICLES, raw.as_deref())?;
    let filters = json!({
        "search": like(&q, "search"),
        "status": text(&q, "status"),
        "authorId": text(&q, "authorId"),
    });
    page(&caller.db, ARTICLES_LIST, &HELPDESK_ARTICLES, &q, filters).await
}

async fn get_article(caller: Caller, Path(id): Path<String>) -> Answer {
    get_live(&caller.db, &HELPDESK_ARTICLES, "Article", &id).await
}

async fn create_article(
    State(state): S,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_ARTICLE, &headers, &body)?;
    let body = &parsed.body;
    let author = match body.get("authorId") {
        Some(Value::String(author)) => Some(author.clone()),
        _ => caller.session.user_id.clone(),
    };
    let Some(author) = author else {
        return Err(bad_request("authorId is required for workspace API keys").into());
    };
    let stamp = now();
    let id = generate_id("art");
    let slug = body
        .get("slug")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            let title = body
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Some(slugify(title, 500)).filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| id.clone());
    let mut values = body.clone();
    values.insert("id".into(), json!(id));
    values.insert(
        "content".into(),
        json!(derive_content(body).unwrap_or_default()),
    );
    values.insert("slug".into(), json!(slug));
    values.insert("authorId".into(), json!(author));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    let row = HELPDESK_ARTICLES
        .insert(
            &caller.db,
            &values,
            &dates(&parsed, &["createdAt", "updatedAt"]),
        )
        .await?;
    caller.publish(
        &state.events,
        HELPDESK_ARTICLE_CREATED,
        &id,
        pick(&id, &row, &["title", "slug", "status", "authorId"]),
    );
    created(row)
}

async fn update_article(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_ARTICLE, &headers, &body)?;
    let mut update = with_updated(&parsed.body, &now());
    if let Some(content) = derive_content(&parsed.body) {
        update.insert("content".into(), json!(content));
    }
    let row = HELPDESK_ARTICLES
        .patch(
            &caller.db,
            &id,
            &update,
            true,
            &dates(&parsed, &["updatedAt"]),
        )
        .await?
        .ok_or_else(|| not_found("Article", &id))?;
    caller.publish(
        &state.events,
        HELPDESK_ARTICLE_UPDATED,
        &id,
        pick(&id, &row, &["title", "slug", "status"]),
    );
    ok(row)
}

async fn delete_article(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    soft_delete(&caller.db, &HELPDESK_ARTICLES, &id)
        .await?
        .ok_or_else(|| not_found("Article", &id))?;
    caller.publish(
        &state.events,
        HELPDESK_ARTICLE_DELETED,
        &id,
        json!({ "id": id }),
    );
    no_content()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_read_like_the_route() {
        assert_eq!(slugify("  Hello, World! ", 500), "hello-world");
        assert_eq!(slugify("Ünïcode & co", 500), "n-code-co");
        assert_eq!(slugify("abc", 2), "ab");
        assert_eq!(slugify("!!!", 500), "");
    }
}
