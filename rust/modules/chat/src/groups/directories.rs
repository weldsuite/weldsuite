//! `/api/chat-directories` (`routes/chat-directories/index.ts`) and
//! `/api/chat-search` (`routes/chat-search/index.ts`): browsing the channels
//! the caller can see, and searching the messages of those channels.

use std::sync::Arc;

use axum::Router;
use axum::extract::RawQuery;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::{Map, Value, json};
use weldsuite_chat_domain::unreadable_record_chat_ids;
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Format, Number, Presence, Text, js_date_iso};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::ChatState;
use crate::access::{Caller, answer, validate_query};
use crate::groups::channels::context_or_none;

pub(crate) fn directories_router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<ChatState>
where
    Q: PermissionQueries + 'static,
{
    Router::new().route(
        "/channels",
        get(directory_channels).route_layer(gate.require(["channels:read"])),
    )
}

pub(crate) fn search_router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<ChatState>
where
    Q: PermissionQueries + 'static,
{
    Router::new().route("/", get(search).route_layer(gate.require(["messages:read"])))
}

/// `GET /api/chat-directories/channels`: live, unarchived channels the
/// caller can see, by name.
async fn directory_channels(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let search = match validate_query(raw.as_deref(), |issues, values| {
        issues.string(values, "search", false, None, None)
    }) {
        Ok(search) => search.filter(|s| !s.is_empty()).map(|s| format!("%{s}%")),
        Err(error) => return error.respond(""),
    };
    let result = async {
        let rows: Vec<(String, String, Option<String>, i32, String, bool)> = sqlx::query_as(
            // `isJoined` as chat-api computes it: Drizzle writes the select's
            // columns unqualified, so inside the subquery `id` is the member
            // row's own id and the test never holds (it answers false). Kept
            // as is for parity; reported as a TypeScript bug.
            "select c.id, c.name, c.description, c.member_count, c.type,
                    exists (select 1 from chat_channel_members
                            where channel_id = id and user_id = $1)
             from chat_channels c
             where c.deleted_at is null and c.is_archived = false
               and (c.type = 'public' or exists (select 1 from chat_channel_members m
                    where m.channel_id = c.id and m.user_id = $1))
               and ($2::text is null or c.name ilike $2)
             order by c.name",
        )
        .bind(&caller.user_id)
        .bind(&search)
        .fetch_all(&caller.db)
        .await?;
        let entity_ids: Vec<String> = rows
            .iter()
            .filter(|r| r.4 == "entity")
            .map(|r| r.0.clone())
            .collect();
        let context = caller.context_can();
        let can = context_or_none(&context);
        let unreadable =
            unreadable_record_chat_ids(&caller.db, &caller.user_id, &entity_ids, Some(&can)).await?;
        let channels: Vec<Value> = rows
            .into_iter()
            .filter(|r| !unreadable.contains(&r.0))
            .map(|(id, name, description, members, kind, joined)| {
                let kind = if kind == "public" || kind == "private" { kind } else { "public".to_owned() };
                json!({
                    "id": id,
                    "name": name,
                    "description": description,
                    "memberCount": members,
                    "isJoined": joined,
                    "type": kind,
                })
            })
            .collect();
        Ok(Data(channels).into_response())
    }
    .await;
    answer(result, "Failed to fetch directory channels")
}

struct SearchQuery {
    q: String,
    channel_id: Option<String>,
    author_id: Option<String>,
    before: Option<String>,
    after: Option<String>,
    has_file: Option<bool>,
    is_pinned: Option<bool>,
    limit: i64,
}

fn read_search(issues: &mut weldsuite_kit::validation::Issues, values: &Map<String, Value>) -> SearchQuery {
    let q = issues.string(values, "q", true, Some(1), None).unwrap_or_default();
    let channel_id = issues.string(values, "channelId", false, None, None);
    let author_id = issues.string(values, "authorId", false, None, None);
    let datetime = Text {
        format: Some(Format::Datetime),
        ..Text::default()
    };
    let before = issues
        .text_with(values, "before", Presence::Optional, datetime)
        .into_option();
    let after = issues
        .text_with(values, "after", Presence::Optional, datetime)
        .into_option();
    let flag = |issues: &mut weldsuite_kit::validation::Issues, key: &str| {
        issues
            .choice(values, key, Presence::Optional, &["true", "false"])
            .into_option()
            .map(|v| v == "true")
    };
    let has_file = flag(issues, "hasFile");
    let is_pinned = flag(issues, "isPinned");
    let limit = issues
        .number(
            values,
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
        .unwrap_or(20.0);
    #[allow(clippy::cast_possible_truncation)]
    let limit = limit.ceil() as i64;
    SearchQuery {
        q,
        channel_id,
        author_id,
        before,
        after,
        has_file,
        is_pinned,
        limit,
    }
}

/// `GET /api/chat-search?q=`: messages of the channels the caller can read.
async fn search(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match validate_query(raw.as_deref(), read_search) {
        Ok(query) => query,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let member: Vec<String> =
            sqlx::query_scalar("select channel_id from chat_channel_members where user_id = $1")
                .bind(&caller.user_id)
                .fetch_all(&caller.db)
                .await?;
        let context = caller.context_can();
        let can = context_or_none(&context);
        let unreadable = unreadable_record_chat_ids(&caller.db, &caller.user_id, &member, Some(&can)).await?;
        let public: Vec<String> = sqlx::query_scalar(
            "select id from chat_channels where type = 'public' and deleted_at is null",
        )
        .fetch_all(&caller.db)
        .await?;
        let mut accessible: Vec<String> = Vec::new();
        for id in member.into_iter().filter(|id| !unreadable.contains(id)).chain(public) {
            if !accessible.contains(&id) {
                accessible.push(id);
            }
        }
        let empty = || Ok(Data(json!({ "messages": [], "total": 0 })).into_response());
        if accessible.is_empty() {
            return empty();
        }
        if let Some(channel) = query.channel_id.as_deref().filter(|c| !c.is_empty())
            && !accessible.iter().any(|a| a == channel)
        {
            return empty();
        }
        let after = query.after.as_deref().and_then(js_date_iso);
        let before = query.before.as_deref().and_then(js_date_iso);
        let rows: Vec<Value> = sqlx::query_scalar(
            "select jsonb_build_object('id', m.id, 'channelId', m.channel_id, 'authorId', m.author_id,
                    'authorName', m.author_name, 'authorAvatar', m.author_avatar,
                    'content', m.content, 'htmlContent', m.html_content, 'type', m.type,
                    'parentId', m.parent_id, 'isPinned', m.is_pinned,
                    'hasAttachments', m.has_attachments, 'attachments', m.attachments,
                    'reactions', m.reactions, 'createdAt', m.created_at)
             from chat_messages m
             where m.deleted_at is null and m.channel_id = any($1) and m.content ilike $2
               and ($3::text is null or m.channel_id = $3)
               and ($4::text is null or m.author_id = $4)
               and ($5::text is null or m.created_at >= $5::timestamp)
               and ($6::text is null or m.created_at <= $6::timestamp)
               and ($7::boolean is null or m.has_attachments = $7)
               and ($8::boolean is null or m.is_pinned = $8)
             order by m.created_at desc limit $9",
        )
        .bind(&accessible)
        .bind(format!("%{}%", query.q))
        .bind(query.channel_id.as_deref().filter(|c| !c.is_empty()))
        .bind(query.author_id.as_deref().filter(|a| !a.is_empty()))
        .bind(&after)
        .bind(&before)
        .bind(query.has_file)
        .bind(query.is_pinned)
        .bind(query.limit)
        .fetch_all(&caller.db)
        .await?;
        let rows: Vec<Value> = rows.into_iter().map(weldsuite_db::js_row).collect();
        let channel_ids: Vec<String> = weldsuite_chat_domain::access::unique_ids(
            &rows
                .iter()
                .filter_map(|r| r["channelId"].as_str().map(str::to_owned))
                .collect::<Vec<_>>(),
        );
        let mut channels: Map<String, Value> = Map::new();
        if !channel_ids.is_empty() {
            let found: Vec<(String, String, String, String)> = sqlx::query_as(
                "select id, name, slug, type from chat_channels where id = any($1)",
            )
            .bind(&channel_ids)
            .fetch_all(&caller.db)
            .await?;
            for (id, name, slug, kind) in found {
                channels.insert(id, json!({ "name": name, "slug": slug, "type": kind }));
            }
        }
        let results: Vec<Value> = rows
            .into_iter()
            .map(|mut row| {
                let channel = row["channelId"]
                    .as_str()
                    .and_then(|id| channels.get(id))
                    .cloned()
                    .unwrap_or(Value::Null);
                row["channel"] = channel;
                row
            })
            .collect();
        let total = results.len();
        Ok(Data(json!({ "messages": results, "total": total })).into_response())
    }
    .await;
    answer(result, "Failed to search messages")
}
