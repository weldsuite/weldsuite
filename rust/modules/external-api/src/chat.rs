//! WeldChat's objects: `/v1/channels`, `/v1/channel-members`,
//! `/v1/chat-messages`, `/v1/chat-bookmarks`, `/v1/chat-drafts` and
//! `/v1/chat-sections` (`routes/v1/<object>/index.ts`). The member,
//! bookmark, draft and section routes publish no events and delete the row.

use axum::Router;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CHAT_CHANNEL_CREATED, CHAT_CHANNEL_DELETED, CHAT_CHANNEL_UPDATED, CHAT_MESSAGE_CREATED,
    CHAT_MESSAGE_DELETED, CHAT_MESSAGE_UPDATED,
};

use crate::ExternalApiState;
use crate::crud::{Caller, Fail, table_list_sql};
use crate::desk::slugify;
use crate::schemas::{
    LIST_CHANNEL_MEMBERS, LIST_CHANNELS, LIST_CHAT_BOOKMARKS, LIST_CHAT_DRAFTS, LIST_CHAT_MESSAGES,
    LIST_CHAT_SECTIONS,
};
use crate::schemas_gen::{
    CREATE_CHANNEL, CREATE_CHANNEL_MEMBER, CREATE_CHAT_BOOKMARK, CREATE_CHAT_DRAFT,
    CREATE_CHAT_MESSAGE, CREATE_CHAT_SECTION, UPDATE_CHANNEL, UPDATE_CHANNEL_MEMBER,
    UPDATE_CHAT_BOOKMARK, UPDATE_CHAT_DRAFT, UPDATE_CHAT_MESSAGE, UPDATE_CHAT_SECTION,
};
use crate::simple::{self, Dates, F, Simple, Stats};
use crate::tables_gen::{
    CHAT_BOOKMARKS, CHAT_CHANNEL_MEMBERS, CHAT_CHANNELS, CHAT_DRAFTS, CHAT_MESSAGES, CHAT_SECTIONS,
};

/// Chat's routes.
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    [
        &CHANNELS,
        &CHANNEL_MEMBERS,
        &MESSAGES,
        &BOOKMARKS,
        &DRAFTS,
        &SECTIONS,
    ]
    .into_iter()
    .fold(router, simple::mount)
}

/// `value ?? fallback` on the values.
fn default_to(values: &mut Map<String, Value>, key: &str, fallback: Value) {
    if matches!(values.get(key), Some(Value::Null) | None) {
        values.insert(key.to_owned(), fallback);
    }
}

/// channels: `slug` is NOT NULL, derived from the name when not sent (the
/// id when that leaves nothing; filled in by the engine's `id`).
fn channel_values(
    _: &Caller,
    values: &mut Map<String, Value>,
    create: bool,
) -> Result<Dates, Fail> {
    if !create {
        return Ok(&[]);
    }
    let sent = values
        .get("slug")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let slug = sent.or_else(|| {
        values
            .get("name")
            .and_then(Value::as_str)
            .map(|name| slugify(name, 255))
            .filter(|s| !s.is_empty())
    });
    match slug {
        Some(slug) => {
            values.insert("slug".into(), json!(slug));
        }
        // The id: the engine writes it as `slug` too.
        None => {
            values.insert("slug".into(), json!(simple::ID_PLACEHOLDER));
        }
    }
    Ok(&[])
}

static CHANNELS: Simple = Simple {
    path: "/channels",
    scope: "channels",
    table: &CHAT_CHANNELS,
    label: "Channel",
    prefix: "ch",
    list: &LIST_CHANNELS,
    create: &CREATE_CHANNEL,
    update: &UPDATE_CHANNEL,
    sql: table_list_sql!(
        chat_channels,
        "t.deleted_at is null \
         and ($3->>'search' is null or t.name like $3->>'search') \
         and ($3->>'type' is null or t.type = $3->>'type')"
    ),
    filters: &[F::Like("search"), F::Eq("type")],
    dates: &[],
    events: Some([
        CHAT_CHANNEL_CREATED,
        CHAT_CHANNEL_UPDATED,
        CHAT_CHANNEL_DELETED,
    ]),
    data: &["name"],
    deleted_data: None,
    prepare: Some(channel_values),
    stats: Stats::None,
    touch: true,
};

static CHANNEL_MEMBERS: Simple = Simple {
    path: "/channel-members",
    scope: "channel_members",
    table: &CHAT_CHANNEL_MEMBERS,
    label: "ChannelMember",
    prefix: "chm",
    list: &LIST_CHANNEL_MEMBERS,
    create: &CREATE_CHANNEL_MEMBER,
    update: &UPDATE_CHANNEL_MEMBER,
    sql: table_list_sql!(
        chat_channel_members,
        "($3->>'channelId' is null or t.channel_id = $3->>'channelId') \
         and ($3->>'userId' is null or t.user_id = $3->>'userId')"
    ),
    filters: &[F::Eq("channelId"), F::Eq("userId")],
    dates: &[],
    events: None,
    data: &[],
    deleted_data: None,
    prepare: None,
    stats: Stats::None,
    touch: true,
};

/// chat-messages: the schema's `body` is the `content` column; a create
/// fills in the author.
fn message_values(
    caller: &Caller,
    values: &mut Map<String, Value>,
    create: bool,
) -> Result<Dates, Fail> {
    let body = values.remove("body");
    if create {
        values.insert(
            "content".into(),
            body.filter(Value::is_string).unwrap_or_else(|| json!("")),
        );
        default_to(values, "authorId", json!(caller.session.actor()));
        default_to(values, "authorName", json!(""));
    } else if let Some(body) = body {
        values.insert("content".into(), body);
    }
    Ok(&[])
}

static MESSAGES: Simple = Simple {
    path: "/chat-messages",
    scope: "chat_messages",
    table: &CHAT_MESSAGES,
    label: "ChatMessage",
    prefix: "cmsg",
    list: &LIST_CHAT_MESSAGES,
    create: &CREATE_CHAT_MESSAGE,
    update: &UPDATE_CHAT_MESSAGE,
    sql: table_list_sql!(
        chat_messages,
        "t.deleted_at is null \
         and ($3->>'search' is null or t.content like $3->>'search') \
         and ($3->>'channelId' is null or t.channel_id = $3->>'channelId') \
         and ($3->>'parentId' is null or t.parent_id = $3->>'parentId')"
    ),
    filters: &[F::Like("search"), F::Eq("channelId"), F::Eq("parentId")],
    dates: &[],
    events: Some([
        CHAT_MESSAGE_CREATED,
        CHAT_MESSAGE_UPDATED,
        CHAT_MESSAGE_DELETED,
    ]),
    data: &["channelId"],
    deleted_data: None,
    prepare: Some(message_values),
    stats: Stats::None,
    touch: true,
};

/// chat-bookmarks: the caller's, with empty message and channel ids when
/// not sent.
fn bookmark_values(
    caller: &Caller,
    values: &mut Map<String, Value>,
    create: bool,
) -> Result<Dates, Fail> {
    if create {
        default_to(values, "userId", json!(caller.session.actor()));
        default_to(values, "messageId", json!(""));
        default_to(values, "channelId", json!(""));
    }
    Ok(&[])
}

static BOOKMARKS: Simple = Simple {
    path: "/chat-bookmarks",
    scope: "chat_bookmarks",
    table: &CHAT_BOOKMARKS,
    label: "ChatBookmark",
    prefix: "cbk",
    list: &LIST_CHAT_BOOKMARKS,
    create: &CREATE_CHAT_BOOKMARK,
    update: &UPDATE_CHAT_BOOKMARK,
    sql: table_list_sql!(
        chat_bookmarks,
        "($3->>'userId' is null or t.user_id = $3->>'userId') \
         and ($3->>'channelId' is null or t.channel_id = $3->>'channelId')"
    ),
    filters: &[F::Eq("userId"), F::Eq("channelId")],
    dates: &[],
    events: None,
    data: &[],
    deleted_data: None,
    prepare: Some(bookmark_values),
    stats: Stats::None,
    touch: true,
};

/// chat-drafts: `workspace_id` holds the Clerk org id; the schema's `body`
/// is the `content` column.
fn draft_values(
    caller: &Caller,
    values: &mut Map<String, Value>,
    create: bool,
) -> Result<Dates, Fail> {
    if create {
        let workspace = caller
            .session
            .clerk_org_id
            .clone()
            .unwrap_or_else(|| caller.session.workspace_id.clone());
        default_to(values, "workspaceId", json!(workspace));
        default_to(values, "userId", json!(caller.session.actor()));
        let content = match (values.get("body"), values.get("content")) {
            (Some(body), _) if !body.is_null() => body.clone(),
            (_, Some(content)) if !content.is_null() => content.clone(),
            _ => json!(""),
        };
        values.insert("content".into(), content);
    } else if let Some(body) = values.remove("body") {
        values.insert("content".into(), body);
    }
    Ok(&[])
}

static DRAFTS: Simple = Simple {
    path: "/chat-drafts",
    scope: "chat_drafts",
    table: &CHAT_DRAFTS,
    label: "ChatDraft",
    prefix: "cdft",
    list: &LIST_CHAT_DRAFTS,
    create: &CREATE_CHAT_DRAFT,
    update: &UPDATE_CHAT_DRAFT,
    sql: table_list_sql!(
        chat_drafts,
        "($3->>'channelId' is null or t.channel_id = $3->>'channelId') \
         and ($3->>'userId' is null or t.user_id = $3->>'userId')"
    ),
    filters: &[F::Eq("channelId"), F::Eq("userId")],
    dates: &[],
    events: None,
    data: &[],
    deleted_data: None,
    prepare: Some(draft_values),
    stats: Stats::None,
    touch: true,
};

static SECTIONS: Simple = Simple {
    path: "/chat-sections",
    scope: "chat_sections",
    table: &CHAT_SECTIONS,
    label: "ChatSection",
    prefix: "csec",
    list: &LIST_CHAT_SECTIONS,
    create: &CREATE_CHAT_SECTION,
    update: &UPDATE_CHAT_SECTION,
    sql: table_list_sql!(
        chat_sections,
        "($3->>'search' is null or t.name like $3->>'search')"
    ),
    filters: &[F::Like("search")],
    dates: &[],
    events: None,
    data: &[],
    deleted_data: None,
    prepare: None,
    stats: Stats::None,
    touch: true,
};
