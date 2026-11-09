//! `routes/desk-knowledge/index.ts`: knowledge inside the inbox, next to the
//! webchat inbox at `/desk/conversations`.
//!
//! - `GET /{id}/article-suggestions?q=&limit=`: with `q` a search, else
//!   articles related to the customer's latest messages; every published
//!   article an agent may share (not internal), versions included, with its
//!   help-center URL when the help center is live.
//! - `POST /{id}/draft-article`: a draft article from the conversation, the
//!   customer's question and the team's public answers (`deskArticleDraftFrom`
//!   of `@weldsuite/db/lib/desk-articles`).

use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_desk_domain::articles::{
    Search, article_slug, article_url, help_center_base_url, matches_sql, rank_sql, related_search,
    typed_search,
};
use weldsuite_kit::validation::{Issues, Number, Presence, Text, js_trim, query_values};
use weldsuite_kit::{Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::crud::write_failed;
use crate::tables::HELPDESK_ARTICLES;
use crate::{Caller, DeskState, Refusal, now};

/// The customer's messages a suggestion reads, newest first.
const RELATED_MESSAGES: i64 = 3;
/// Messages a draft article reads, oldest first.
const DRAFT_MESSAGES: i64 = 200;

/// The routes, relative to `/api`, each with its `requirePermission`s.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/desk/conversations/{id}/article-suggestions",
            get(suggestions)
                .route_layer(need(perm::ARTICLES_READ))
                .route_layer(need(perm::CONVERSATIONS_READ)),
        )
        .route(
            "/desk/conversations/{id}/draft-article",
            post(draft_article)
                .route_layer(need(perm::ARTICLES_CREATE))
                .route_layer(need(perm::CONVERSATIONS_READ)),
        )
}

/// `zValidator('query', deskArticleSuggestionsQuerySchema)`: `q` trimmed
/// (max 200), `limit` coerced to an integer 1..10.
fn suggestions_query(query: Option<&str>) -> Result<(Option<String>, Option<f64>), Box<Response>> {
    let values = query_values(query);
    let mut issues = Issues::default();
    let q = issues
        .text_with(
            &values,
            "q",
            Presence::Optional,
            Text::trimmed(None, Some(200)),
        )
        .into_option();
    let limit = issues
        .number(
            &values,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                int: true,
                min: Some(1.0),
                max: Some(10.0),
            },
        )
        .into_option();
    issues
        .finish()
        .map_err(|invalid| Box::new(invalid.into_response()))?;
    Ok((q, limit))
}

/// `suggestDeskArticles(db, search, limit, baseUrl)`: a version counts only
/// while its original is published and shareable too.
async fn suggest(
    db: &weldsuite_db::PgPool,
    search: &Search,
    limit: i64,
    base: Option<&str>,
) -> Result<Vec<Value>, sqlx::Error> {
    let matches = matches_sql("t", 1, 2);
    let rank = rank_sql("t", 1, 2);
    #[allow(clippy::type_complexity)] // the suggestion's columns
    let rows: Vec<(
        String,
        String,
        String,
        Option<String>,
        String,
        Option<String>,
    )> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select t.id, t.title, t.slug, t.excerpt, t.visibility, t.locale from helpdesk_articles t
             where t.status = 'published' and t.deleted_at is null
               and t.visibility in ('public', 'logged_in', 'groups')
               and (t.translation_of_id is null or exists (select 1 from helpdesk_articles o
                 where o.id = t.translation_of_id and o.status = 'published' and o.deleted_at is null
                   and o.visibility in ('public', 'logged_in', 'groups')))
               and {matches}
             order by {rank} desc, t.updated_at desc, t.id desc limit $3"
    )))
    .bind(search.websearch.as_deref())
    .bind(&search.tsquery)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, title, slug, excerpt, visibility, locale)| {
            let url = article_url(base, &slug);
            json!({
                "id": id, "title": title, "slug": slug, "excerpt": excerpt,
                "visibility": visibility, "locale": locale, "url": url,
            })
        })
        .collect())
}

async fn suggestions(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    const MESSAGE: &str = "Failed to suggest articles";
    let (q, limit) = match suggestions_query(query.as_deref()) {
        Ok(read) => read,
        Err(response) => return *response,
    };
    let db = &caller.db;
    let conversation: Option<Option<String>> =
        match sqlx::query_scalar("select title from desk_conversations where id = $1 limit 1")
            .bind(&id)
            .fetch_optional(db)
            .await
        {
            Ok(found) => found,
            Err(error) => return Refusal::Database(error).respond(MESSAGE),
        };
    let Some(title) = conversation else {
        return Refusal::not_found("Conversation", &id).respond(MESSAGE);
    };

    let query_text = q.unwrap_or_default();
    let search = if query_text.is_empty() {
        let recent: Vec<Option<String>> = match sqlx::query_scalar(
            "select body from desk_messages
             where conversation_id = $1 and kind = 'message' and author_type = 'visitor'
             order by created_at desc, id desc limit $2",
        )
        .bind(&id)
        .bind(RELATED_MESSAGES)
        .fetch_all(db)
        .await
        {
            Ok(recent) => recent,
            Err(error) => return Refusal::Database(error).respond(MESSAGE),
        };
        let mut parts: Vec<String> = recent.into_iter().map(Option::unwrap_or_default).collect();
        parts.push(title.unwrap_or_default());
        related_search(&parts.join("\n"))
    } else {
        typed_search(&query_text)
    };

    let base = match help_center_base_url(db).await {
        Ok(base) => base,
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    };
    let found = match &search {
        Some(search) => {
            #[allow(clippy::cast_possible_truncation)]
            let limit = limit.unwrap_or(5.0) as i64;
            match suggest(db, search, limit, base.as_deref()).await {
                Ok(found) => found,
                Err(error) => return Refusal::Database(error).respond(MESSAGE),
            }
        }
        None => Vec::new(),
    };
    Data(json!({ "helpCenterUrl": base, "query": query_text, "articles": found })).into_response()
}

// ── POST /{id}/draft-article ──────────────────────────────────────────────────

/// The first `n` characters (code points).
fn first_chars(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// One message as a paragraph: escaped, its lines kept apart.
fn paragraph(body: &str) -> String {
    let text = js_trim(body).replace("\r\n", "\n").replace('\r', "\n");
    format!("<p>{}</p>", escape_html(&text).replace('\n', "<br>"))
}

/// Runs of spaces, tabs and line breaks as one space, trimmed.
fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if matches!(c, '\r' | '\n' | '\t' | ' ') {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    js_trim(&out).to_owned()
}

/// A timeline row: `kind`, `author_type`, `body`.
type TimelineRow = (String, String, Option<String>);

/// `deskArticleDraftFrom(conversation, messages)`: the title, the content
/// (the customer quoted, then the team's public replies) and the excerpt.
fn draft_from(
    title: Option<&str>,
    number: i32,
    messages: &[TimelineRow],
) -> (String, String, Option<String>) {
    let said = |author: &str| -> Vec<&str> {
        messages
            .iter()
            .filter(|(kind, author_type, _)| kind == "message" && author_type == author)
            .filter_map(|(_, _, body)| body.as_deref())
            .filter(|body| !js_trim(body).is_empty())
            .collect()
    };
    let customer = said("visitor");
    let team = said("agent");

    let first_line = customer.first().map_or(String::new(), |body| {
        let first = js_trim(body).split('\n').next().unwrap_or_default();
        js_trim(first).to_owned()
    });
    let own_title = title.map(js_trim).filter(|t| !t.is_empty());
    let chosen = match own_title {
        Some(title) => title.to_owned(),
        None if !first_line.is_empty() => first_line,
        None => format!("#{number}"),
    };
    let title = first_chars(&chosen, 200);

    let mut parts: Vec<String> = Vec::new();
    if !customer.is_empty() {
        let quoted: String = customer.iter().map(|body| paragraph(body)).collect();
        parts.push(format!("<blockquote>{quoted}</blockquote>"));
    }
    parts.extend(team.iter().map(|body| paragraph(body)));
    let content = if parts.is_empty() {
        "<p></p>".to_owned()
    } else {
        parts.concat()
    };

    let excerpt = customer
        .first()
        .map(|body| first_chars(&collapse(body), 200))
        .filter(|excerpt| !excerpt.is_empty());
    (title, content, excerpt)
}

async fn draft_article(
    State(state): State<DeskState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const MESSAGE: &str = "Failed to create the draft article";
    let db = &caller.db;
    let conversation: Option<(Option<String>, i32)> = match sqlx::query_as(
        "select title, conversation_number from desk_conversations where id = $1 limit 1",
    )
    .bind(&id)
    .fetch_optional(db)
    .await
    {
        Ok(found) => found,
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    };
    let Some((title, number)) = conversation else {
        return Refusal::not_found("Conversation", &id).respond(MESSAGE);
    };
    let timeline: Vec<TimelineRow> = match sqlx::query_as(
        "select kind, author_type, body from desk_messages
         where conversation_id = $1 order by created_at asc, id asc limit $2",
    )
    .bind(&id)
    .bind(DRAFT_MESSAGES)
    .fetch_all(db)
    .await
    {
        Ok(rows) => rows,
        Err(error) => return Refusal::Database(error).respond(MESSAGE),
    };
    let (title, content, excerpt) = draft_from(title.as_deref(), number, &timeline);

    let article_id = generate_id("art");
    let base = article_slug(&title);
    let base = if base.is_empty() {
        article_id.clone()
    } else {
        base
    };
    let suffix: String = article_id.chars().skip(4).take(6).collect();
    let slug = format!("{base}-{suffix}");
    let now = now();
    let table = &HELPDESK_ARTICLES;
    let mut values = Map::new();
    for (prop, value) in [
        ("id", json!(article_id)),
        ("title", json!(title)),
        ("slug", json!(slug)),
        ("content", json!(content)),
        ("excerpt", json!(excerpt)),
        ("status", json!("draft")),
        ("visibility", json!("public")),
        ("audienceCompanyIds", json!([])),
        ("authorId", json!(caller.user_id)),
        ("isDraft", json!(true)),
        ("publishedAt", Value::Null),
        ("relatedTickets", json!([id])),
        ("viewCount", json!(0)),
        ("helpfulCount", json!(0)),
        ("notHelpfulCount", json!(0)),
        ("createdAt", json!(now)),
        ("updatedAt", json!(now)),
    ] {
        table.set(&mut values, prop, value);
    }
    let row = match table
        .insert(db, values, &["createdAt", "updatedAt", "publishedAt"])
        .await
    {
        Ok(row) => row,
        Err(error) => return write_failed(&error, MESSAGE),
    };
    caller.publish(
        &state,
        ev::HELPDESK_ARTICLE_CREATED,
        &article_id,
        &json!({
            "id": article_id, "title": title, "slug": slug, "status": "draft",
            "authorId": caller.user_id, "conversationId": id,
        }),
    );
    Created(row).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(author: &str, body: Option<&str>, kind: &str) -> TimelineRow {
        (kind.to_owned(), author.to_owned(), body.map(str::to_owned))
    }

    #[test]
    fn a_draft_quotes_the_customer_then_the_team() {
        let (title, content, excerpt) = draft_from(
            None,
            7,
            &[
                message("visitor", Some(" First line\r\nsecond <line> "), "message"),
                message("agent", Some("internal"), "note"),
                message("agent", Some("Use \"this\" & that"), "message"),
                message("bot", Some("a bot"), "message"),
                message("visitor", Some("   "), "message"),
                message("system", None, "event"),
            ],
        );
        assert_eq!(title, "First line");
        assert_eq!(
            content,
            "<blockquote><p>First line<br>second &lt;line&gt;</p></blockquote><p>Use &quot;this&quot; &amp; that</p>"
        );
        assert_eq!(excerpt.as_deref(), Some("First line second <line>"));
    }

    #[test]
    fn a_draft_title_falls_back_to_the_number() {
        assert_eq!(draft_from(Some(" Billing "), 1, &[]).0, "Billing");
        assert_eq!(
            draft_from(None, 42, &[]),
            ("#42".to_owned(), "<p></p>".to_owned(), None)
        );
        assert_eq!(
            draft_from(Some(&"é".repeat(300)), 1, &[]).0.chars().count(),
            200
        );
    }
}
