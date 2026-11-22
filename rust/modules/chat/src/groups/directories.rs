//! `/api/chat-directories` (`routes/chat-directories/index.ts`) and
//! `/api/chat-search` (`routes/chat-search/index.ts`): browsing the channels
//! the caller can see, and searching the messages of those channels.

use std::sync::Arc;

use axum::Router;
use axum::extract::RawQuery;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use sea_orm::sea_query::{Expr, Query};
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, FromQueryResult, QueryFilter, QueryOrder, QuerySelect,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_chat_domain::unreadable_record_chat_ids;
use weldsuite_db::orm;
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Format, Number, Presence, Text, js_date_iso};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{chat_channel_members as members, chat_channels, chat_messages};

use crate::ChatState;
use crate::access::{Caller, answer, validate_query};
use crate::groups::channels::{js, member_exists, timestamp_of};

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
    Router::new().route(
        "/",
        get(search).route_layer(gate.require(["messages:read"])),
    )
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
        // `isJoined` as chat-api computes it: Drizzle writes the select's
        // columns unqualified, so inside the subquery `id` is the member
        // row's own id and the test never holds (it answers false). Kept
        // as is for parity; reported as a TypeScript bug.
        let is_joined = Expr::exists(
            Query::select()
                .expr(Expr::val(1))
                .from(members::Entity)
                .and_where(sea_orm::ExprTrait::equals(
                    Expr::col((members::Entity, members::Column::ChannelId)),
                    (members::Entity, members::Column::Id),
                ))
                .and_where(members::Column::UserId.eq(&caller.user_id))
                .to_owned(),
        );
        let mut query = chat_channels::Entity::find()
            .select_only()
            .columns([
                chat_channels::Column::Id,
                chat_channels::Column::Name,
                chat_channels::Column::Description,
                chat_channels::Column::MemberCount,
                chat_channels::Column::Type,
            ])
            .expr(is_joined)
            .filter(chat_channels::Column::DeletedAt.is_null())
            .filter(chat_channels::Column::IsArchived.eq(false))
            .filter(
                Condition::any()
                    .add(chat_channels::Column::Type.eq("public"))
                    .add(member_exists(&caller.user_id)),
            );
        if let Some(search) = &search {
            query = query.filter(chat_channels::Column::Name.ilike(search.as_str()));
        }
        let rows: Vec<(String, String, Option<String>, i32, String, bool)> = query
            .order_by_asc(chat_channels::Column::Name)
            .into_tuple()
            .all(&orm(&caller.db))
            .await?;
        let entity_ids: Vec<String> = rows
            .iter()
            .filter(|r| r.4 == "entity")
            .map(|r| r.0.clone())
            .collect();
        let can = caller.context_can();
        let unreadable =
            unreadable_record_chat_ids(&caller.db, &caller.user_id, &entity_ids, Some(&can))
                .await?;
        let channels: Vec<Value> = rows
            .into_iter()
            .filter(|r| !unreadable.contains(&r.0))
            .map(|(id, name, description, members, kind, joined)| {
                let kind = if kind == "public" || kind == "private" {
                    kind
                } else {
                    "public".to_owned()
                };
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

/// A search hit (`jsonb_build_object` of the message's columns).
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct Hit {
    id: String,
    channel_id: String,
    author_id: String,
    author_name: String,
    author_avatar: Option<String>,
    content: String,
    html_content: Option<String>,
    #[serde(rename = "type")]
    kind: String,
    parent_id: Option<String>,
    is_pinned: bool,
    has_attachments: bool,
    attachments: Option<Value>,
    reactions: Option<Value>,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    created_at: PrimitiveDateTime,
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

fn read_search(
    issues: &mut weldsuite_kit::validation::Issues,
    values: &Map<String, Value>,
) -> SearchQuery {
    let q = issues
        .string(values, "q", true, Some(1), None)
        .unwrap_or_default();
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
        use chat_messages::Column;
        let db = orm(&caller.db);
        let member: Vec<String> = members::Entity::find()
            .select_only()
            .column(members::Column::ChannelId)
            .filter(members::Column::UserId.eq(&caller.user_id))
            .into_tuple()
            .all(&db)
            .await?;
        let can = caller.context_can();
        let unreadable = unreadable_record_chat_ids(&caller.db, &caller.user_id, &member, Some(&can)).await?;
        let public: Vec<String> = chat_channels::Entity::find()
            .select_only()
            .column(chat_channels::Column::Id)
            .filter(chat_channels::Column::Type.eq("public"))
            .filter(chat_channels::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&db)
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
        let mut hits = chat_messages::Entity::find()
            .select_only()
            .columns([
                Column::Id,
                Column::ChannelId,
                Column::AuthorId,
                Column::AuthorName,
                Column::AuthorAvatar,
                Column::Content,
                Column::HtmlContent,
            ])
            .column_as(Column::Type, "kind")
            .columns([
                Column::ParentId,
                Column::IsPinned,
                Column::HasAttachments,
                Column::Attachments,
                Column::Reactions,
                Column::CreatedAt,
            ])
            .filter(Column::DeletedAt.is_null())
            .filter(Column::ChannelId.is_in(accessible.iter().map(String::as_str)))
            .filter(Column::Content.ilike(format!("%{}%", query.q)));
        if let Some(channel) = query.channel_id.as_deref().filter(|c| !c.is_empty()) {
            hits = hits.filter(Column::ChannelId.eq(channel));
        }
        if let Some(author) = query.author_id.as_deref().filter(|a| !a.is_empty()) {
            hits = hits.filter(Column::AuthorId.eq(author));
        }
        if let Some(after) = after.as_deref() {
            hits = hits.filter(Column::CreatedAt.gte(timestamp_of(after)?));
        }
        if let Some(before) = before.as_deref() {
            hits = hits.filter(Column::CreatedAt.lte(timestamp_of(before)?));
        }
        if let Some(has_file) = query.has_file {
            hits = hits.filter(Column::HasAttachments.eq(has_file));
        }
        if let Some(is_pinned) = query.is_pinned {
            hits = hits.filter(Column::IsPinned.eq(is_pinned));
        }
        let rows = hits
            .order_by_desc(Column::CreatedAt)
            .limit(u64::try_from(query.limit).unwrap_or(0))
            .into_model::<Hit>()
            .all(&db)
            .await?;
        let rows: Vec<Value> = rows.into_iter().map(js).collect::<Result<_, _>>()?;
        let channel_ids: Vec<String> = weldsuite_chat_domain::access::unique_ids(
            &rows
                .iter()
                .filter_map(|r| r["channelId"].as_str().map(str::to_owned))
                .collect::<Vec<_>>(),
        );
        let mut channels: Map<String, Value> = Map::new();
        if !channel_ids.is_empty() {
            let found: Vec<(String, String, String, String)> = chat_channels::Entity::find()
                .select_only()
                .columns([
                    chat_channels::Column::Id,
                    chat_channels::Column::Name,
                    chat_channels::Column::Slug,
                    chat_channels::Column::Type,
                ])
                .filter(chat_channels::Column::Id.is_in(channel_ids.iter().map(String::as_str)))
                .into_tuple()
                .all(&db)
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
