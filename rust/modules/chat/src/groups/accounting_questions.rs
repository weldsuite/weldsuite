//! `/api/accounting-questions`: questions on WeldBooks records (ADR BOOKS-015;
//! Rust only, edition feature `books-questions`). A question is the first
//! message of a thread in the record's chat; its state is
//! `metadata.question` (`weldsuite_chat_domain::questions`).
//!
//! - `POST /` `{ recordType, recordId, text, askedTo? }`: the question. The
//!   record's chat is created on the first one, as for any record chat
//!   (ADR CHAT-003); the members in `askedTo` follow it and are mentioned.
//! - `POST /bulk` `{ recordType, recordIds, text, askedTo? }`: one question
//!   per record (a bank line each, from Missing receipts).
//! - `PATCH /:messageId` `{ status }`: resolve, re-open or mark answered.
//! - `GET /?status=&askedTo=me|any&recordType=&cursor=&limit=`: the questions
//!   on the records the caller may see.
//!
//! A reply by someone other than the asker answers the question (the send
//! pipeline), and a receipt on the bank line does (the books routes).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    ACCOUNTING_QUESTION_CREATED, ACCOUNTING_QUESTION_UPDATED, CHAT_CHANNEL_CREATED,
    CHAT_MESSAGE_CREATED,
};
use weldsuite_chat_domain::entity::{self, Provider};
use weldsuite_chat_domain::questions::{self, Filters};
use weldsuite_db::orm;
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{Created, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::workspace_members;

use super::record_chats::{get_or_create, publish_channel_event, resolve_access};
use crate::ChatState;
use crate::access::{Caller, ChatError, ChatResult, answer, validate, validate_query};
use crate::followers::{add_followers, announce_new_followers, default_followers_who_may_open};
use crate::post::{PostError, PostInput, post_chat_message};
use crate::util::list_response;

/// Most members one question can be asked to.
const MAX_ASKED_TO: usize = 20;
/// Most records one bulk request asks about.
const MAX_BULK: usize = 100;
const DEFAULT_LIMIT: usize = 25;
const MAX_LIMIT: usize = 100;

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<ChatState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/", get(list).route_layer(gate.require(["channels:read"])))
        .route(
            "/",
            post(ask).route_layer(gate.require(["messages:create"])),
        )
        .route(
            "/bulk",
            post(ask_many).route_layer(gate.require(["messages:create"])),
        )
        .route(
            "/{message_id}",
            patch(set_status).route_layer(gate.require(["messages:create"])),
        )
}

/// A WeldBooks record type, or the 400.
fn books_provider(record_type: &str) -> ChatResult<Provider> {
    entity::provider(record_type)
        .filter(|p| p.is_books())
        .ok_or_else(|| {
            ChatError::bad_request(format!(
                "Questions can be asked about WeldBooks records only, not {record_type}"
            ))
        })
}

// ── POST / ──────────────────────────────────────────────────────────────────

struct AskInput {
    record_type: String,
    record_ids: Vec<String>,
    text: String,
    asked_to: Vec<String>,
}

fn read_asked_to(issues: &mut Issues, body: &Map<String, Value>) -> Vec<String> {
    let asked = issues
        .list(
            body,
            "askedTo",
            Presence::Optional,
            None,
            None,
            |issues, item| issues.item_text(item, Text::default()),
        )
        .into_option()
        .unwrap_or_default();
    let mut ids: Vec<String> = Vec::new();
    for id in asked {
        if !id.is_empty() && !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

fn read_ask(issues: &mut Issues, body: &Map<String, Value>) -> AskInput {
    let record_type = issues
        .string(body, "recordType", true, Some(1), Some(50))
        .unwrap_or_default();
    let record_id = issues
        .string(body, "recordId", true, Some(1), Some(255))
        .unwrap_or_default();
    let text = issues
        .string(body, "text", true, Some(1), Some(10_000))
        .unwrap_or_default();
    AskInput {
        record_type,
        record_ids: vec![record_id],
        text,
        asked_to: read_asked_to(issues, body),
    }
}

fn read_bulk(issues: &mut Issues, body: &Map<String, Value>) -> AskInput {
    let record_type = issues
        .string(body, "recordType", true, Some(1), Some(50))
        .unwrap_or_default();
    let ids = issues
        .list(
            body,
            "recordIds",
            Presence::Required,
            Some(1),
            Some(MAX_BULK),
            |issues, item| issues.item_text(item, Text::default()),
        )
        .into_option()
        .unwrap_or_default();
    let mut record_ids: Vec<String> = Vec::new();
    for id in ids {
        if !id.is_empty() && !record_ids.contains(&id) {
            record_ids.push(id);
        }
    }
    let text = issues
        .string(body, "text", true, Some(1), Some(10_000))
        .unwrap_or_default();
    AskInput {
        record_type,
        record_ids,
        text,
        asked_to: read_asked_to(issues, body),
    }
}

/// Members the question is for: active members of the workspace who may open
/// the record. The 400 names the first that is not.
async fn check_asked_to(
    caller: &Caller,
    provider: Provider,
    record_id: &str,
    asked_to: &[String],
) -> ChatResult<()> {
    if asked_to.is_empty() {
        return Ok(());
    }
    if asked_to.len() > MAX_ASKED_TO {
        return Err(ChatError::bad_request(format!(
            "A question can be asked to at most {MAX_ASKED_TO} members"
        )));
    }
    let active: Vec<String> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::UserId)
        .filter(workspace_members::Column::UserId.is_in(asked_to.iter().map(String::as_str)))
        .filter(workspace_members::Column::Status.eq("ACTIVE"))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(&caller.db))
        .await?;
    if let Some(unknown) = asked_to.iter().find(|id| !active.contains(id)) {
        return Err(ChatError::bad_request(format!(
            "askedTo holds a member that does not exist: {unknown}"
        )));
    }
    let openable = default_followers_who_may_open(
        &caller.db,
        provider.type_name(),
        record_id,
        &caller.user_id,
        asked_to,
    )
    .await?;
    if let Some(blocked) = asked_to
        .iter()
        .find(|id| **id != caller.user_id && !openable.contains(id))
    {
        return Err(ChatError::bad_request(format!(
            "askedTo holds a member who may not open this record: {blocked}"
        )));
    }
    Ok(())
}

/// Ask one question; the question as the list returns it, with whether its
/// record's chat was created by it.
async fn ask_one(
    state: &ChatState,
    caller: &Caller,
    org: &str,
    provider: Provider,
    record_id: &str,
    text: &str,
    asked_to: &[String],
) -> ChatResult<(Value, bool)> {
    resolve_access(caller, provider.type_name(), record_id).await?;
    check_asked_to(caller, provider, record_id, asked_to).await?;
    let got = get_or_create(caller, provider, record_id).await?;
    let channel_id = got.channel["id"].as_str().unwrap_or_default().to_owned();
    // Those asked follow the chat (it puts it in their sidebar and notifies them).
    let added = add_followers(&caller.db, &channel_id, asked_to, None).await?;
    let message = match post_chat_message(
        caller,
        state,
        org,
        &channel_id,
        PostInput {
            content: text.to_owned(),
            metadata: Some(questions::new_metadata(asked_to)),
            mentions: (!asked_to.is_empty()).then(|| asked_to.to_vec()),
            ..PostInput::default()
        },
    )
    .await
    {
        Ok(message) => message,
        Err(PostError::Feature(404, _)) => {
            return Err(ChatError::not_found("Channel", Some(&channel_id)));
        }
        Err(PostError::Feature(403, message)) => return Err(ChatError::forbidden(message)),
        Err(PostError::Feature(_, message)) => return Err(ChatError::bad_request(message)),
        Err(PostError::Database(error)) => return Err(ChatError::from(error)),
    };
    let message_id = message["id"].as_str().unwrap_or_default().to_owned();
    let name = got.channel["name"].as_str().unwrap_or_default().to_owned();
    let mut announced = got.new_followers.clone();
    for user in added {
        if !announced.contains(&user) {
            announced.push(user);
        }
    }
    announce_new_followers(
        &Caller::realtime(state),
        org,
        &channel_id,
        &name,
        &announced,
    )
    .await;
    if got.created {
        publish_channel_event(state, caller, CHAT_CHANNEL_CREATED, &got.channel);
    }
    caller.publish(
        state,
        CHAT_MESSAGE_CREATED,
        &message_id,
        &json!({ "id": message_id, "channelId": channel_id, "authorId": caller.user_id }),
    );
    let item = questions::get(&caller.db, &message_id)
        .await?
        .map_or(Value::Null, |question| question.json());
    caller.publish(
        state,
        ACCOUNTING_QUESTION_CREATED,
        &message_id,
        &json!({
            "id": message_id,
            "channelId": channel_id,
            "recordType": provider.type_name(),
            "recordId": record_id,
            "recordTitle": item["recordTitle"],
            "entityId": item["entityId"],
            "askedBy": caller.user_id,
            "askedTo": asked_to,
            "status": "open",
        }),
    );
    Ok((item, got.created))
}

async fn ask(
    State(state): State<ChatState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_ask) {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let result: ChatResult<Response> = async {
        let org = caller.org()?.to_owned();
        if input.text.trim().is_empty() {
            return Err(ChatError::bad_request("text is required"));
        }
        let provider = books_provider(&input.record_type)?;
        let record_id = input.record_ids.first().cloned().unwrap_or_default();
        let (mut item, created) = ask_one(
            &state,
            &caller,
            &org,
            provider,
            &record_id,
            &input.text,
            &input.asked_to,
        )
        .await?;
        item["createdChannel"] = json!(created);
        Ok(Created(item).into_response())
    }
    .await;
    answer(result, "Failed to ask the question")
}

// ── POST /bulk ──────────────────────────────────────────────────────────────

/// One question per record. A record that can't be asked about (gone, hidden
/// from the caller, a member who may not open it) is reported and the rest go
/// on: `{ created: [question…], failed: [{ recordId, error }] }`.
async fn ask_many(
    State(state): State<ChatState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_bulk) {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let result: ChatResult<Response> = async {
        let org = caller.org()?.to_owned();
        if input.text.trim().is_empty() {
            return Err(ChatError::bad_request("text is required"));
        }
        let provider = books_provider(&input.record_type)?;
        let mut created: Vec<Value> = Vec::new();
        let mut failed: Vec<Value> = Vec::new();
        for record_id in &input.record_ids {
            match ask_one(
                &state,
                &caller,
                &org,
                provider,
                record_id,
                &input.text,
                &input.asked_to,
            )
            .await
            {
                Ok((item, _)) => created.push(item),
                Err(ChatError::Database(error)) => return Err(ChatError::Database(error)),
                Err(error) => {
                    let response = error.respond("");
                    let status = response.status().as_u16();
                    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
                        .await
                        .unwrap_or_default();
                    let message = serde_json::from_slice::<Value>(&bytes)
                        .ok()
                        .and_then(|body| body["error"]["message"].as_str().map(str::to_owned))
                        .unwrap_or_default();
                    failed
                        .push(json!({ "recordId": record_id, "status": status, "error": message }));
                }
            }
        }
        Ok(Created(json!({ "created": created, "failed": failed })).into_response())
    }
    .await;
    answer(result, "Failed to ask the questions")
}

// ── PATCH /:messageId ───────────────────────────────────────────────────────

fn read_status(issues: &mut Issues, body: &Map<String, Value>) -> String {
    issues
        .choice(body, "status", Presence::Required, &questions::STATUSES)
        .into_option()
        .unwrap_or_default()
}

async fn set_status(
    State(state): State<ChatState>,
    caller: Caller,
    Path(message_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let status = match validate(&headers, &body, read_status) {
        Ok(status) => status,
        Err(error) => return error.respond(""),
    };
    let result: ChatResult<Response> = async {
        let Some(question) = questions::find(&caller.db, &message_id).await? else {
            return Err(ChatError::not_found("Question", Some(&message_id)));
        };
        // Whoever may read the record's chat may resolve or re-open its questions.
        resolve_access(&caller, &question.record_type, &question.record_id).await?;
        let changed = questions::set_status(&caller.db, &message_id, &status)
            .await?
            .ok_or_else(|| ChatError::not_found("Question", Some(&message_id)))?;
        if changed.from != changed.to {
            caller.publish(
                &state,
                ACCOUNTING_QUESTION_UPDATED,
                &message_id,
                &questions::changed_json(&changed),
            );
        }
        let item = questions::get(&caller.db, &message_id)
            .await?
            .map_or(Value::Null, |question| question.json());
        Ok(Data(item).into_response())
    }
    .await;
    answer(result, "Failed to update the question")
}

// ── GET / ───────────────────────────────────────────────────────────────────

struct ListQuery {
    status: Option<String>,
    mine: bool,
    record_type: Option<String>,
    cursor: Option<String>,
    limit: usize,
}

fn read_list(issues: &mut Issues, values: &Map<String, Value>) -> ListQuery {
    let status = issues
        .choice(values, "status", Presence::Optional, &questions::STATUSES)
        .into_option();
    let asked_to = issues
        .choice(values, "askedTo", Presence::Optional, &["me", "any"])
        .into_option();
    let record_type = issues.string(values, "recordType", false, Some(1), Some(50));
    let cursor = issues.string(values, "cursor", false, None, Some(30));
    let limit = issues
        .whole_number(
            values,
            "limit",
            Presence::Optional,
            weldsuite_kit::validation::Number {
                coerce: true,
                min: Some(1.0),
                max: Some(100.0),
                ..weldsuite_kit::validation::Number::default()
            },
        )
        .into_option()
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(DEFAULT_LIMIT)
        .min(MAX_LIMIT);
    ListQuery {
        status,
        mine: asked_to.as_deref() == Some("me"),
        record_type,
        cursor,
        limit,
    }
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match validate_query(raw.as_deref(), read_list) {
        Ok(query) => query,
        Err(error) => return error.respond(""),
    };
    let result: ChatResult<Response> = async {
        if let Some(kind) = query.record_type.as_deref() {
            books_provider(kind)?;
        }
        let can = caller.context_can();
        let page = questions::list(
            &caller.db,
            &caller.user_id,
            &can,
            &Filters {
                status: query.status.as_deref(),
                asked_to: query.mine.then_some(caller.user_id.as_str()),
                record_type: query.record_type.as_deref(),
                message_id: None,
            },
            query.cursor.as_deref().filter(|c| !c.is_empty()),
            query.limit,
        )
        .await?;
        Ok(list_response(
            page.items.iter().map(questions::Question::json).collect(),
            i64::try_from(page.total).unwrap_or(i64::MAX),
            page.has_more,
            page.cursor,
        ))
    }
    .await;
    answer(result, "Failed to list the questions")
}
