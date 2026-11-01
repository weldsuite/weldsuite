//! `/api/reach/inbox` (`routes/inbox`): the unified reply inbox. Replies
//! arrive through the inbound path; this file reads and acts on what it
//! stored. Handing a thread to the CRM goes through the inbox permission.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, json};
use weldsuite_catalogs::entity_events::REACH_REPLY_CLASSIFIED;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Number, Presence, Text};
use weldsuite_kit::{ApiError, Data, List, Pagination};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{BoxFuture, DynFileStore};
use weldsuite_reach_domain::inbox::{self, AccessState, InboxFilter, ReplyStorage};
use weldsuite_reach_domain::outbound::OutboundDeps;
use weldsuite_reach_domain::smtp::{SmtpConfig, SmtpEnvelope, SmtpSendResult, SmtpTransport};
use weldsuite_reach_domain::{EventSink, ReachEvent, text};

use crate::crm::{HandoffError, OpportunityInput, add_thread_to_crm};
use crate::effects::{MessageInput, reply_event_data, update_message};
use crate::{Caller, ReachState, respond, validate, validate_query};

const LABELS: &[&str] = &[
    "interested",
    "meeting_request",
    "not_interested",
    "not_now",
    "out_of_office",
    "wrong_person",
    "unsubscribe",
    "other",
    "unclassified",
];
const KINDS: &[&str] = &["reply", "auto_reply", "bounce"];

pub(crate) fn routes<Q: PermissionQueries + 'static>(gate: &Arc<PermissionGate<Q>>) -> Router<ReachState> {
    let read = || gate.require([perm::REACH_INBOX_READ]);
    let update = || gate.require([perm::REACH_INBOX_UPDATE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/unread-count", get(unread).route_layer(read()))
        .route("/threads/{thread_key}", get(thread).route_layer(read()))
        .route(
            "/threads/{thread_key}/reply",
            post(reply).route_layer(gate.require([perm::REACH_INBOX_REPLY])),
        )
        .route("/messages/{id}", axum::routing::patch(update_one).route_layer(update()))
        .route("/threads/{thread_key}/add-to-crm", post(add_to_crm).route_layer(update()))
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let filter = match validate_query(query.as_deref(), |issues, q| InboxFilter {
        label: issues.choice(q, "label", Presence::Optional, LABELS).into_option(),
        kind: issues.choice(q, "kind", Presence::Optional, KINDS).into_option(),
        campaign_id: issues.text_with(q, "campaignId", Presence::Optional, Text::length(None, Some(30))).into_option(),
        mailbox_id: issues.text_with(q, "mailboxId", Presence::Optional, Text::length(None, Some(30))).into_option(),
        state: issues
            .choice(q, "state", Presence::Optional, &["unread", "open", "handled", "all"])
            .into_option(),
        cursor: issues.text_with(q, "cursor", Presence::Optional, Text::length(None, Some(100))).into_option(),
        limit: issues
            .whole_number(q, "limit", Presence::Optional, Number { coerce: true, int: true, min: Some(1.0), max: Some(100.0) })
            .into_option(),
    }) {
        Ok(filter) => filter,
        Err(response) => return response,
    };
    respond(inbox::list_threads(&caller.db, &filter).await.map(|page| {
        List::new(
            page.threads,
            Pagination::new(u64::try_from(page.total_count).unwrap_or_default(), page.has_more, page.cursor),
        )
        .into_response()
    }))
}

async fn unread(caller: Caller) -> Response {
    respond(
        inbox::count_unread(&caller.db)
            .await
            .map(|count| Data(json!({ "count": count })).into_response()),
    )
}

/// The `STORAGE` bucket as the inbox reads it.
struct Bucket(Arc<dyn DynFileStore>);

impl ReplyStorage for Bucket {
    fn get(&self, key: &str) -> BoxFuture<'_, Result<Option<Vec<u8>>, String>> {
        let key = key.to_owned();
        Box::pin(async move {
            self.0
                .get_boxed(&key)
                .await
                .map(|object| object.map(|o| o.bytes))
                .map_err(|error| error.to_string())
        })
    }
}

async fn thread(State(state): State<ReachState>, caller: Caller, Path(thread_key): Path<String>) -> Response {
    let bucket = caller.storage(&state).map(Bucket);
    respond(
        async {
            match inbox::get_thread(&caller.db, bucket.as_ref().map(|b| b as &dyn ReplyStorage), &thread_key).await? {
                Some((summary, messages)) => Ok(Data(json!({
                    "threadKey": thread_key,
                    "summary": summary,
                    "messages": messages,
                }))
                .into_response()),
                None => Ok(ApiError::not_found("Thread", Some(&thread_key)).into_response()),
            }
        }
        .await,
    )
}

/// No SMTP transport in this deployment: a send fails as an exception
/// would (`send_threw`), after the message row exists.
struct NoTransport;

impl SmtpTransport for NoTransport {
    fn send(&self, _config: SmtpConfig, _envelope: SmtpEnvelope, _raw: String) -> BoxFuture<'_, Result<SmtpSendResult, String>> {
        Box::pin(std::future::ready(Err("no SMTP transport".to_owned())))
    }
}

async fn reply(State(state): State<ReachState>, caller: Caller, Path(thread_key): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let text_body = match validate(&headers, &body, |issues, body| {
        issues
            .text_with(body, "body", Presence::Required, Text::trimmed(Some(1), Some(20_000)))
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(text) => text,
        Err(response) => return response,
    };
    respond(
        async {
            let access = crate::access_of(&caller)?;
            let access = AccessState {
                status: access.status.clone(),
                billing_status: access.billing_status.clone(),
                billing_status_at: access.billing_status_at.clone(),
            };
            let keyring = caller.keyring(&state);
            let transport = caller.smtp(&state);
            let fixed = caller.env("CONFORMANCE_NOW");
            let clock = move || weldsuite_reach_domain::now_or(fixed.as_deref());
            let deps = OutboundDeps {
                db: &caller.db,
                keyring: &keyring,
                transport: transport.as_deref().unwrap_or(&NoTransport),
                now: &clock,
            };
            let message = inbox::send_reply(
                &deps,
                &access,
                caller.sending_enabled(),
                &thread_key,
                &text_body,
                &caller.user_id,
            )
            .await?;
            Ok((StatusCode::CREATED, Data(message)).into_response())
        }
        .await,
    )
}

async fn update_one(State(state): State<ReachState>, caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, |issues, body| MessageInput {
        label: issues.choice(body, "label", Presence::Optional, LABELS).into_option(),
        read: issues.boolean(body, "read", Presence::Optional).into_option(),
        handled: issues.boolean(body, "handled", Presence::Optional).into_option(),
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    respond(
        async {
            let Some((message, change)) = update_message(&caller.db, &id, &input, &caller.user_id).await? else {
                return Ok(ApiError::not_found("Message", Some(&id)).into_response());
            };
            if let Some((previous, next)) = change {
                let mut event = ReachEvent::new(
                    REACH_REPLY_CLASSIFIED,
                    text(&message, "id").unwrap_or(&id),
                    reply_event_data(&message, &next, "user"),
                );
                if let Some(previous) = previous {
                    let mut changes = Map::new();
                    changes.insert("label".to_owned(), json!({ "old": previous, "new": next }));
                    event.changes = Some(changes);
                }
                caller.sink(&state).emit(event);
            }
            let snippet = message.get("snippet").cloned();
            Ok(Data(inbox::to_message_dto(&message, snippet)).into_response())
        }
        .await,
    )
}

async fn add_to_crm(State(state): State<ReachState>, caller: Caller, Path(thread_key): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let opportunity = match validate(&headers, &body, |issues, body| {
        issues
            .nested(body, "opportunity", Presence::Optional, |issues, o| {
                let pipeline = issues.text_with(o, "pipelineId", Presence::Required, Text::length(Some(1), Some(30))).into_option();
                let stage = issues.text_with(o, "stageId", Presence::Required, Text::length(Some(1), Some(30))).into_option();
                let name = issues.text_with(o, "name", Presence::Optional, Text::trimmed(Some(1), Some(200))).into_option();
                Some(OpportunityInput {
                    pipeline_id: pipeline?,
                    stage_id: stage?,
                    name,
                })
            })
            .into_option()
            .flatten()
    }) {
        Ok(opportunity) => opportunity,
        Err(response) => return response,
    };
    respond(
        async {
            let Some(thread) = inbox::load_thread(&caller.db, &thread_key).await? else {
                return Ok(ApiError::not_found("Thread", Some(&thread_key)).into_response());
            };
            let sink = caller.sink(&state);
            match add_thread_to_crm(
                &caller.db,
                &sink,
                &caller.user_id,
                thread.prospect.as_ref(),
                text(&thread.latest_inbound, "fromEmail").unwrap_or_default(),
                thread.campaign.as_ref(),
                opportunity.as_ref(),
            )
            .await
            {
                Ok((person_id, opportunity_id)) => {
                    Ok(Data(json!({ "personId": person_id, "opportunityId": opportunity_id })).into_response())
                }
                Err(HandoffError::Refused(code, message)) => Ok(ApiError::bad_request(message)
                    .with_details(json!({ "reason": code }))
                    .into_response()),
                Err(HandoffError::Failed(error)) => Err(error),
            }
        }
        .await,
    )
}
