//! The live inbox for writers outside it (`@weldsuite/desk-domain/inbox`):
//! WeldConnect's workflows, and the public API and the MCP server when they
//! are ported (`/v1/conversations`, `POST /v1/tickets`).
//!
//! The rows are written by [`crate::webchat`] (the single writer, ADR
//! DESK-001). This adds what the widget and email paths do after a customer
//! message lands: auto-assignment ([`crate::assignment`]), a notification
//! for the assignee or else the team, and the `desk_conversation` /
//! `desk_message` events that update every agent's inbox and start
//! workflows, through the caller's [`InboxEmitter`]. Each writer brings its
//! database, realtime, notifier and emitter in [`InboxDeps`].
//!
//! Notifications are awaited, as TypeScript does when the caller has no
//! `waitUntil` (the workflow engine); a failed one is logged.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Field, js_trim};
use weldsuite_notifications::{NewNotification, Notifier, create_and_deliver};
use weldsuite_ports::{BoxFuture, DynRealtimePublisher, RealtimeMessage};

use crate::assignment::{Picker, auto_assign_with};
use crate::attributes::{self, Update, UpdateError, Updated};
use crate::notify::{self, EntityKind, HelpdeskNotification, PREVIEW_MAX};
use crate::table::WriteError;
use crate::webchat::{
    self, Append, AppendError, Appended, DESK_CONVERSATIONS, VisitorInput, now, preview_of,
};

/// `NOTIFY_BATCH`: team notifications go out this many at a time.
const NOTIFY_BATCH: usize = 10;
/// `MAX_RECIPIENTS`: at most this many teammates hear about a conversation.
const MAX_RECIPIENTS: i64 = 200;
/// `EXTERNAL_ID_INDEX`: the unique index on `desk_conversations.external_id`.
const EXTERNAL_ID_INDEX: &str = "desk_conversations_external_id_uidx";
/// `REPLYABLE_CHANNELS`: replies reach customers on these channels from
/// outside the inbox; email and phone go out from it.
const REPLYABLE_CHANNELS: &[&str] = &["api", "messenger"];

// ── errors ───────────────────────────────────────────────────────────────────

/// Why an inbox write stopped.
#[derive(Debug)]
pub enum InboxError {
    /// `DeskConversationNotFoundError`.
    NotFound(String),
    /// `DeskAttributeRejectedError`: a field the caller gave was refused
    /// (`field` is the input's name).
    Rejected {
        field: &'static str,
        message: String,
    },
    /// `DeskReplyChannelError`: a reply that could not reach the customer.
    ReplyChannel(String),
    /// `DeskEmptyUpdateError`.
    EmptyUpdate,
    /// A statement failed.
    Failed(String),
}

impl std::fmt::Display for InboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(id) => write!(f, "Conversation '{id}' not found"),
            Self::Rejected { message, .. } | Self::Failed(message) => f.write_str(message),
            Self::ReplyChannel(channel) => write!(
                f,
                "Replies to {channel} conversations are sent from the WeldDesk inbox; add a note instead"
            ),
            Self::EmptyUpdate => {
                f.write_str("Give a state, an assigneeId or a ticket field to change")
            }
        }
    }
}

impl std::error::Error for InboxError {}

impl From<sqlx::Error> for InboxError {
    fn from(error: sqlx::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<WriteError> for InboxError {
    fn from(error: WriteError) -> Self {
        Self::Failed(error.to_string())
    }
}

fn append_error(error: AppendError, conversation_id: &str) -> InboxError {
    match error {
        AppendError::NotFound => InboxError::NotFound(conversation_id.to_owned()),
        AppendError::Write(error) => InboxError::Failed(error.to_string()),
    }
}

fn update_error(error: UpdateError, conversation_id: &str) -> InboxError {
    match error {
        UpdateError::NotFound => InboxError::NotFound(conversation_id.to_owned()),
        UpdateError::Rejected { field, message } => InboxError::Rejected { field, message },
        UpdateError::Failed(message) => InboxError::Failed(message),
    }
}

// ── who and where ────────────────────────────────────────────────────────────

/// `DeskInboxActor`: who acts on a conversation from outside the inbox.
#[derive(Debug, Clone, Copy)]
pub struct Actor<'a> {
    /// `agent` for a person (personal API key, MCP), `bot` for an
    /// integration, the AI or a workflow, or `system`.
    pub author_type: &'a str,
    /// The member's user id for `agent`; the key, agent or workflow run's id
    /// otherwise.
    pub author_id: Option<&'a str>,
}

const SYSTEM: Actor<'static> = Actor {
    author_type: "system",
    author_id: None,
};

/// `DeskInboxEvent`: one entity event (`desk_conversation` created,
/// updated, `state_changed` or assigned; `desk_message` created).
#[derive(Debug, Clone)]
pub struct InboxEvent {
    pub entity_type: &'static str,
    pub action: &'static str,
    pub entity_id: String,
    pub data: Value,
}

/// `DeskInboxDeps.emit`: publish one entity event with the writer's own
/// publisher.
pub trait InboxEmitter: Send + Sync {
    fn emit<'a>(&'a self, event: &'a InboxEvent) -> BoxFuture<'a, Result<(), String>>;
}

/// The workflow engine's emitter: no entity-event queue, so workflow writes
/// never start workflows again; the inbox moves live through the
/// `WorkspaceHub` (`realtime.publish(workspace, entityType, action, data,
/// 'system')`).
pub struct RealtimeEmitter {
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// The hub's workspace (the Clerk org id).
    pub workspace: String,
}

impl InboxEmitter for RealtimeEmitter {
    fn emit<'a>(&'a self, event: &'a InboxEvent) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let Some(realtime) = &self.realtime else {
                return Ok(());
            };
            let message = RealtimeMessage::workspace(
                &self.workspace,
                event.entity_type,
                event.action,
                event.data.clone(),
                "system",
            );
            realtime
                .publish_boxed(&message)
                .await
                .map_err(|e| e.to_string())
        })
    }
}

/// `DeskInboxDeps`: what the follow-ups use; anything optional may be
/// missing, as a worker's bindings may.
pub struct InboxDeps<'a> {
    pub db: &'a PgPool,
    /// The Clerk org id: what notifications and realtime topics key on.
    pub clerk_org_id: &'a str,
    pub emitter: &'a dyn InboxEmitter,
    /// `publishRoom`: the conversation's room, which the widget listens on.
    /// Without it a visitor sees replies and state changes on their next
    /// fetch.
    pub rooms: Option<Arc<dyn DynRealtimePublisher>>,
    pub notifier: &'a Notifier,
    /// `deskAssignmentRouterPicker(env.HELPDESK_WORKFLOW, …)`.
    pub picker: Picker<'a>,
    /// The master database and `workspaces.id`, for the SLA due index
    /// (`SCHEDULE_INDEX`, kind `desk_sla`); without them it is skipped.
    pub due: Option<(&'a PgPool, &'a str)>,
}

// ── the API channel (`ingestDeskApi`) ───────────────────────────────────────

/// `IngestDeskApiInput` (without `generateId`).
#[derive(Debug, Clone, Default)]
pub struct IngestApi {
    /// `DeskApiSource`: `api`, `mcp`, `agent` or `workflow`; kept on each
    /// message as `metadata.via`.
    pub via: String,
    /// The caller's own key (an alert id, an order number): a second
    /// delivery lands on the same conversation, reopening it when closed.
    pub external_id: Option<String>,
    pub title: Option<String>,
    pub body: String,
    /// The customer, or the system the message comes from.
    pub name: Option<String>,
    pub email: Option<String>,
    pub contact_id: Option<String>,
    pub metadata: Map<String, Value>,
}

/// The conversation before a message landed (`prior`).
#[derive(Debug, Clone)]
pub struct Prior {
    pub state: Value,
    pub waiting_since: Value,
    pub assignee_id: Value,
}

/// `IngestDeskApiResult`.
#[derive(Debug, Clone)]
pub struct IngestedApi {
    pub conversation: Value,
    pub message: Value,
    pub created: bool,
    /// `None` when the conversation is new.
    pub prior: Option<Prior>,
}

/// `input?.trim() || null`.
fn trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(js_trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

fn json_text(value: Option<&str>) -> Value {
    value.map_or(Value::Null, |v| json!(v))
}

/// `findDeskConversationByExternalId(db, externalId)`.
pub async fn find_by_external_id(
    db: &PgPool,
    external_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from desk_conversations t where t.external_id = $1 limit 1",
    )
    .bind(external_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| DESK_CONVERSATIONS.js(row)))
}

/// Whether `error` is a unique violation, of `constraint` when given.
fn unique_violation(error: &WriteError, constraint: Option<&str>) -> bool {
    let WriteError::Database(sqlx::Error::Database(db)) = error else {
        return false;
    };
    db.code().as_deref() == Some("23505") && constraint.is_none_or(|c| db.constraint() == Some(c))
}

/// Why [`create_api_conversation`] stopped.
enum CreateError {
    /// `DeskExternalIdTakenError`.
    ExternalIdTaken(String),
    Other(InboxError),
}

/// `createDeskConversation(db, …)` on the `api` channel: no visitor unless
/// the sender gave an email, a contact and an external id. The first
/// message is the customer's.
async fn create_api_conversation(
    db: &PgPool,
    input: &IngestApi,
    visitor_id: Option<&str>,
    name: Option<&str>,
    email: Option<&str>,
    external_id: Option<&str>,
    metadata: Map<String, Value>,
) -> Result<Appended, CreateError> {
    let id = weldsuite_kit::generate_id("dconv");
    let now = now();
    let preview = preview_of(Some(&input.body));
    let title = trimmed(input.title.as_deref()).or_else(|| preview.clone());
    for attempt in 0.. {
        let number: i64 = sqlx::query_scalar(
            "select (coalesce(max(conversation_number), 0) + 1)::bigint from desk_conversations",
        )
        .fetch_one(db)
        .await
        .map_err(|e| CreateError::Other(e.into()))?;
        let mut values = Map::new();
        values.insert("id".to_owned(), json!(id));
        values.insert("created_at".to_owned(), json!(now));
        values.insert("updated_at".to_owned(), json!(now));
        values.insert("conversation_number".to_owned(), json!(number));
        values.insert("title".to_owned(), json_text(title.as_deref()));
        values.insert("state".to_owned(), json!("open"));
        values.insert("channel".to_owned(), json!("api"));
        values.insert("visitor_id".to_owned(), json_text(visitor_id));
        values.insert("name".to_owned(), json_text(name));
        values.insert("email".to_owned(), json_text(email));
        values.insert(
            "contact_id".to_owned(),
            json_text(input.contact_id.as_deref()),
        );
        values.insert("assignee_id".to_owned(), Value::Null);
        values.insert("ticket_type_id".to_owned(), Value::Null);
        values.insert("priority".to_owned(), Value::Null);
        values.insert("department_id".to_owned(), Value::Null);
        values.insert("waiting_since".to_owned(), json!(now));
        values.insert("last_message_at".to_owned(), json!(now));
        values.insert(
            "last_message_preview".to_owned(),
            json_text(preview.as_deref()),
        );
        values.insert("external_id".to_owned(), json_text(external_id));
        let trusted = ["createdAt", "updatedAt", "waitingSince", "lastMessageAt"];
        match DESK_CONVERSATIONS.insert(db, values, &trusted).await {
            Ok(_) => break,
            Err(error) => {
                if let Some(external) = external_id
                    && unique_violation(&error, Some(EXTERNAL_ID_INDEX))
                {
                    return Err(CreateError::ExternalIdTaken(external.to_owned()));
                }
                if attempt >= 4 || !unique_violation(&error, None) {
                    return Err(CreateError::Other(error.into()));
                }
            }
        }
    }
    webchat::append(
        db,
        Append {
            conversation_id: &id,
            kind: "message",
            author_type: "visitor",
            author_id: visitor_id,
            body: Some(input.body.clone()),
            attachments: None,
            metadata: Some(metadata),
            assignee_id: None,
        },
    )
    .await
    .map_err(|e| CreateError::Other(append_error(e, &id)))
}

/// Add the customer's message to `conversation` (`addTo`).
async fn add_to(
    db: &PgPool,
    conversation: &Value,
    visitor_id: Option<&str>,
    input: &IngestApi,
    metadata: Map<String, Value>,
) -> Result<IngestedApi, InboxError> {
    let id = conversation["id"].as_str().unwrap_or_default();
    let appended = webchat::append(
        db,
        Append {
            conversation_id: id,
            kind: "message",
            author_type: "visitor",
            author_id: visitor_id,
            body: Some(input.body.clone()),
            attachments: None,
            metadata: Some(metadata),
            assignee_id: None,
        },
    )
    .await
    .map_err(|e| append_error(e, id))?;
    Ok(IngestedApi {
        conversation: appended.conversation,
        message: appended.message,
        created: false,
        prior: Some(Prior {
            state: conversation["state"].clone(),
            waiting_since: conversation["waitingSince"].clone(),
            assignee_id: conversation["assigneeId"].clone(),
        }),
    })
}

/// `ingestDeskApi(db, input)`: put a message from outside the inbox (an
/// integration, an alert, the AI, a workflow) in front of the team as a
/// customer message on an `api` conversation: a new one, or the one that
/// already carries `externalId`. With an email the sender is the same desk
/// visitor their emails come from.
pub async fn ingest_desk_api(db: &PgPool, input: &IngestApi) -> Result<IngestedApi, InboxError> {
    let external_id = trimmed(input.external_id.as_deref());
    let email = trimmed(input.email.as_deref()).map(|e| e.to_lowercase());
    let name = trimmed(input.name.as_deref());
    let mut metadata = input.metadata.clone();
    metadata.insert("via".to_owned(), json!(input.via));

    let mut visitor_id: Option<String> = None;
    if let Some(email) = &email {
        let known: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from desk_visitors t where t.email = $1 limit 1",
        )
        .bind(email)
        .fetch_optional(db)
        .await?;
        let id = known
            .as_ref()
            .and_then(|v| v["id"].as_str())
            .map_or_else(|| weldsuite_kit::generate_id("dvis"), str::to_owned);
        let visitor_name = name
            .clone()
            .or_else(|| {
                known
                    .as_ref()
                    .and_then(|v| v["name"].as_str())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| email.clone());
        let visitor = webchat::upsert_visitor(
            db,
            VisitorInput {
                id: &id,
                name: Some(visitor_name),
                email: Some(email.clone()),
                ..VisitorInput::default()
            },
        )
        .await?;
        visitor_id = Some(visitor["id"].as_str().unwrap_or(&id).to_owned());
    }

    if let Some(external) = &external_id
        && let Some(existing) = find_by_external_id(db, external).await?
    {
        return add_to(db, &existing, visitor_id.as_deref(), input, metadata).await;
    }

    let created = create_api_conversation(
        db,
        input,
        visitor_id.as_deref(),
        name.as_deref(),
        email.as_deref(),
        external_id.as_deref(),
        metadata.clone(),
    )
    .await;
    match created {
        Ok(appended) => Ok(IngestedApi {
            conversation: appended.conversation,
            message: appended.message,
            created: true,
            prior: None,
        }),
        // The same alert delivered twice at once: the other delivery created it.
        Err(CreateError::ExternalIdTaken(external)) => {
            match find_by_external_id(db, &external).await? {
                Some(existing) => {
                    add_to(db, &existing, visitor_id.as_deref(), input, metadata).await
                }
                None => Err(InboxError::Failed(format!(
                    "A conversation with external id '{external}' already exists"
                ))),
            }
        }
        Err(CreateError::Other(error)) => Err(error),
    }
}

// ── the follow-ups ───────────────────────────────────────────────────────────

/// `hasTicketFields(fields)`.
fn has_ticket_fields(fields: &Update) -> bool {
    !matches!(fields.ticket_type_id, Field::Absent)
        || !matches!(fields.priority, Field::Absent)
        || fields.tags.is_some()
        || !matches!(fields.department_id, Field::Absent)
        || !fields.custom_fields.is_empty()
}

/// `assertUsableReferences(db, fields)`: a ticket type or team that doesn't
/// exist or is inactive is refused before a conversation is opened.
async fn assert_usable_references(db: &PgPool, fields: &Update) -> Result<(), InboxError> {
    let refs: [(&str, &Field<String>, &'static str, &str); 2] = [
        (
            "select is_active, deleted_at is not null from helpdesk_ticket_types where id = $1 limit 1",
            &fields.ticket_type_id,
            "ticketTypeId",
            "Ticket type",
        ),
        (
            "select is_active, deleted_at is not null from helpdesk_departments where id = $1 limit 1",
            &fields.department_id,
            "departmentId",
            "Team",
        ),
    ];
    for (sql, field, input, noun) in refs {
        let Field::Set(id) = field else { continue };
        if id.is_empty() {
            continue;
        }
        let row: Option<(Option<bool>, bool)> =
            sqlx::query_as(sql).bind(id).fetch_optional(db).await?;
        if !matches!(row, Some((active, false)) if active != Some(false)) {
            return Err(InboxError::Rejected {
                field: input,
                message: format!("{noun} '{id}' does not exist or is inactive"),
            });
        }
    }
    Ok(())
}

/// `conversationEvent(action, conversation, extra)`.
fn conversation_event(
    action: &'static str,
    conversation: &Value,
    extra: Option<(&str, Value)>,
) -> InboxEvent {
    let mut data = conversation.clone();
    if let (Some((key, value)), Value::Object(fields)) = (extra, &mut data) {
        fields.insert(key.to_owned(), value);
    }
    InboxEvent {
        entity_type: "desk_conversation",
        action,
        entity_id: conversation["id"].as_str().unwrap_or_default().to_owned(),
        data,
    }
}

/// `messageEvent(message)`.
fn message_event(message: &Value) -> InboxEvent {
    InboxEvent {
        entity_type: "desk_message",
        action: "created",
        entity_id: message["id"].as_str().unwrap_or_default().to_owned(),
        data: message.clone(),
    }
}

/// `markDeskSlaDue(deps)`: copy the workspace's earliest SLA check into the
/// due index. Best effort; skipped without the master database.
async fn mark_sla_due(deps: &InboxDeps<'_>) {
    let Some((master, workspace_id)) = deps.due else {
        return;
    };
    let db = deps.db;
    weldsuite_db::due_index::sync_due(master, crate::sla::DUE_KIND, workspace_id, || async move {
        crate::sla::workspace_next_check_at(db)
            .await
            .map(|at| at.and_then(crate::sla::instant))
    })
    .await;
}

/// `emitAll(deps, events)`: every event, then the conversation rooms. A
/// failure is logged and never fails the write.
async fn emit_all(deps: &InboxDeps<'_>, events: &[InboxEvent]) {
    for event in events {
        if let Err(error) = deps.emitter.emit(event).await {
            tracing::error!(%error, "[desk-inbox] {}.{} event failed", event.entity_type, event.action);
        }
    }
    if let Err(error) = publish_to_rooms(deps, events).await {
        tracing::error!(%error, "[desk-inbox] conversation room publish failed");
    }
}

/// `publishToRooms(deps, events)`: the public messages to their
/// conversation's room, as desk-api's `publishDeskChange` sends them: a
/// reply as `message`, a public timeline event as `system` with the
/// conversation.
async fn publish_to_rooms(deps: &InboxDeps<'_>, events: &[InboxEvent]) -> Result<(), String> {
    let Some(rooms) = &deps.rooms else {
        return Ok(());
    };
    let messages: Vec<&Value> = events
        .iter()
        .filter(|e| e.entity_type == "desk_message")
        .map(|e| &e.data)
        .filter(|m| webchat::is_public(m))
        .collect();
    if messages.is_empty() {
        return Ok(());
    }
    // The latest state of each conversation in this batch.
    let mut conversations: HashMap<&str, &Value> = HashMap::new();
    for event in events {
        if event.entity_type == "desk_conversation" {
            conversations.insert(event.entity_id.as_str(), &event.data);
        }
    }
    let mut ids: Vec<Option<&str>> = messages
        .iter()
        .map(|m| {
            if m["authorType"] == "agent" {
                m["authorId"].as_str()
            } else {
                None
            }
        })
        .collect();
    ids.extend(conversations.values().map(|c| c["assigneeId"].as_str()));
    let authors = webchat::resolve_authors(deps.db, &ids)
        .await
        .map_err(|e| e.to_string())?;

    for message in messages {
        let record = webchat::public_message(message, &authors);
        let conversation_id = message["conversationId"].as_str().unwrap_or_default();
        let payload = if message["kind"] == "message" {
            let mut payload = Map::new();
            payload.insert("type".to_owned(), json!("message"));
            payload.insert("id".to_owned(), message["id"].clone());
            payload.insert(
                "content".to_owned(),
                json!(message["body"].as_str().unwrap_or_default()),
            );
            payload.insert(
                "senderId".to_owned(),
                json!(message["authorId"].as_str().unwrap_or_default()),
            );
            payload.insert(
                "senderName".to_owned(),
                if record["authorName"].is_null() {
                    json!("Support")
                } else {
                    record["authorName"].clone()
                },
            );
            if !record["authorAvatar"].is_null() {
                payload.insert("senderAvatar".to_owned(), record["authorAvatar"].clone());
            }
            payload.insert("senderType".to_owned(), message["authorType"].clone());
            payload.insert("ts".to_owned(), json!(crate::realtime::now_ms()));
            payload.insert("record".to_owned(), record);
            Value::Object(payload)
        } else if let Some(conversation) = conversations.get(conversation_id) {
            let event = if record["eventType"].is_null() {
                json!("event")
            } else {
                record["eventType"].clone()
            };
            json!({
                "type": "system",
                "event": event,
                "data": {
                    "state": conversation["state"],
                    "conversation": webchat::public_conversation(conversation, &authors),
                    "record": record,
                },
                "ts": crate::realtime::now_ms(),
            })
        } else {
            continue;
        };
        rooms
            .publish_boxed(&crate::realtime::conversation_publish(
                conversation_id,
                payload,
            ))
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// `teamRecipients(db)`: active internal teammates who can work the inbox.
async fn team_recipients(db: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<String> = sqlx::query_scalar(
        "select user_id from workspace_members
         where deleted_at is null and upper(status) = 'ACTIVE' and upper(member_type) = 'INTERNAL'
           and upper(coalesce(role, '')) <> 'VIEWER'
         limit $1",
    )
    .bind(MAX_RECIPIENTS)
    .fetch_all(db)
    .await?;
    let mut out: Vec<String> = Vec::new();
    for user_id in rows {
        if !out.contains(&user_id) {
            out.push(user_id);
        }
    }
    Ok(out)
}

/// `createAndDeliverNotification`, a failure logged.
async fn deliver(deps: &InboxDeps<'_>, params: &NewNotification) {
    if let Err(error) = create_and_deliver(deps.db, deps.notifier, params).await {
        tracing::error!(%error, "[desk-inbox] notification failed");
    }
}

/// `notifyTeam(deps, conversation, content)`: the assignee, or else the
/// team, in batches of [`NOTIFY_BATCH`].
async fn notify_team(deps: &InboxDeps<'_>, conversation: &Value, title: &str, body: &str) {
    let recipients = match conversation["assigneeId"]
        .as_str()
        .filter(|a| !a.is_empty())
    {
        Some(assignee) => vec![assignee.to_owned()],
        None => match team_recipients(deps.db).await {
            Ok(team) => team,
            Err(error) => {
                tracing::error!(%error, "[desk-inbox] notification failed");
                return;
            }
        },
    };
    let id = conversation["id"].as_str().unwrap_or_default();
    for batch in recipients.chunks(NOTIFY_BATCH) {
        for user_id in batch {
            let params = NewNotification {
                workspace_id: deps.clerk_org_id.to_owned(),
                user_id: user_id.clone(),
                title: title.to_owned(),
                body: body.to_owned(),
                category: "helpdesk".to_owned(),
                notification_type: "message_received".to_owned(),
                entity_type: "desk_conversation".to_owned(),
                entity_id: id.to_owned(),
                action_url: format!("/welddesk/inbox/{id}"),
                severity: "info".to_owned(),
                actor_type: Some("system".to_owned()),
                actor_id: None,
                data: vec![("conversationId".to_owned(), id.to_owned())],
                ..NewNotification::default()
            };
            deliver(deps, &params).await;
        }
    }
}

/// `sendTicketAssignedNotification` for a conversation.
async fn notify_assigned(
    deps: &InboxDeps<'_>,
    conversation: &Value,
    assignee: &str,
    by: Option<&str>,
) {
    let subject = [
        &conversation["title"],
        &conversation["name"],
        &conversation["email"],
    ]
    .into_iter()
    .find(|v| v.as_str().is_some_and(|s| !s.is_empty()))
    .and_then(Value::as_str);
    let reference = format!("#{}", js_number(&conversation["conversationNumber"]));
    let id = conversation["id"].as_str().unwrap_or_default();
    let notification = notify::ticket_assigned(
        deps.db,
        assignee,
        by,
        EntityKind::Conversation,
        id,
        subject,
        Some(&reference),
    )
    .await;
    match notification {
        Ok(Some(notification)) => deliver(deps, &helpdesk_params(deps, &notification)).await,
        Ok(None) => {}
        Err(error) => tracing::error!(%error, "[desk-inbox] notification failed"),
    }
}

fn helpdesk_params(deps: &InboxDeps<'_>, notification: &HelpdeskNotification) -> NewNotification {
    let data = notification
        .data
        .as_object()
        .map(|fields| {
            fields
                .iter()
                .filter_map(|(key, value)| value.as_str().map(|v| (key.clone(), v.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    NewNotification {
        workspace_id: deps.clerk_org_id.to_owned(),
        user_id: notification.user_id.clone(),
        title: notification.title.clone(),
        body: notification.body.clone(),
        category: notification.category.to_owned(),
        notification_type: notification.notification_type.to_owned(),
        entity_type: notification.entity_type.to_owned(),
        entity_id: notification.entity_id.clone(),
        action_url: notification.action_url.clone(),
        severity: notification.severity.to_owned(),
        actor_type: Some(notification.actor_type.to_owned()),
        actor_id: notification.actor_id.clone(),
        data,
        ..NewNotification::default()
    }
}

/// A number as JavaScript prints it in a template string.
fn js_number(value: &Value) -> String {
    match value {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Null => "null".to_owned(),
        other => other.to_string(),
    }
}

/// `shouldNotifyDeskTeam(result)`: a new conversation, or one where the
/// ball moves back to the team. A repeat while it already waits on the team
/// is one notification, not one per repeat.
pub fn should_notify_desk_team(created: bool, prior: Option<&Prior>) -> bool {
    let Some(prior) = prior.filter(|_| !created) else {
        return true;
    };
    prior.state != "open" || prior.waiting_since.is_null()
}

/// `openedAction(result, conversation)`.
fn opened_action(result: &IngestedApi, conversation: &Value) -> &'static str {
    if result.created {
        return "created";
    }
    let reopened = result.prior.as_ref().is_some_and(|p| p.state == "closed")
        && conversation["state"] == "open";
    if reopened { "state_changed" } else { "updated" }
}

/// `autoAssignOpened(deps, conversation)`: hand an open, unowned
/// conversation out by the workspace's rules; a failed pick leaves it for
/// the team.
async fn auto_assign_opened(deps: &InboxDeps<'_>, conversation: Value) -> (Value, Vec<InboxEvent>) {
    let unowned = conversation["assigneeId"].is_null() || conversation["assigneeId"] == "";
    if !unowned || conversation["state"] != "open" {
        return (conversation, Vec::new());
    }
    let id = conversation["id"].as_str().unwrap_or_default().to_owned();
    match auto_assign_with(deps.db, &id, &deps.picker).await {
        Ok(Some(assigned)) => {
            let events = vec![
                conversation_event("assigned", &assigned.conversation, None),
                message_event(&assigned.message),
            ];
            (assigned.conversation, events)
        }
        Ok(None) => (conversation, Vec::new()),
        Err(error) => {
            tracing::error!(%error, "[desk-inbox] auto-assignment failed for {id}");
            (conversation, Vec::new())
        }
    }
}

/// `assignOpened(deps, conversation, assigneeId, actor)`: the member the
/// caller named, or else the workspace's assignment rules.
async fn assign_opened(
    deps: &InboxDeps<'_>,
    conversation: Value,
    assignee_id: Option<&str>,
    actor: Actor<'_>,
) -> Result<(Value, Vec<InboxEvent>), InboxError> {
    let Some(assignee) = assignee_id.filter(|a| !a.is_empty()) else {
        return Ok(auto_assign_opened(deps, conversation).await);
    };
    if conversation["assigneeId"].as_str() == Some(assignee) {
        return Ok((conversation, Vec::new()));
    }
    let id = conversation["id"].as_str().unwrap_or_default().to_owned();
    let mut metadata = Map::new();
    metadata.insert("eventType".to_owned(), json!("assigned"));
    metadata.insert("assigneeId".to_owned(), json!(assignee));
    let appended = webchat::append(
        deps.db,
        Append {
            conversation_id: &id,
            kind: "event",
            author_type: actor.author_type,
            author_id: actor.author_id,
            body: None,
            attachments: None,
            metadata: Some(metadata),
            assignee_id: Some(Some(assignee.to_owned())),
        },
    )
    .await
    .map_err(|e| append_error(e, &id))?;
    let events = vec![
        conversation_event("assigned", &appended.conversation, None),
        message_event(&appended.message),
    ];
    Ok((appended.conversation, events))
}

/// `OpenDeskApiConversationInput`.
#[derive(Debug, Default)]
pub struct OpenConversation {
    pub ingest: IngestApi,
    /// Type, team, priority and tags (no custom fields); applied on a
    /// repeat too, so an alert can escalate.
    pub fields: Update,
    /// A member to hand it to instead of auto-assignment (on a repeat too).
    pub assignee_id: Option<String>,
}

/// `openDeskApiConversation(deps, input)`: open a conversation in the live
/// inbox, or add to the one that carries `externalId` (reopening it), set
/// its ticket fields, assign it (to `assignee_id`, or by the workspace's
/// rules), notify, and emit the events. A bad ticket type or team is
/// refused before anything is written.
pub async fn open_desk_api_conversation(
    deps: &InboxDeps<'_>,
    input: &OpenConversation,
    actor: Option<Actor<'_>>,
) -> Result<IngestedApi, InboxError> {
    let with_fields = has_ticket_fields(&input.fields);
    if with_fields {
        assert_usable_references(deps.db, &input.fields).await?;
    }
    let actor = actor.unwrap_or(SYSTEM);
    let result = ingest_desk_api(deps.db, &input.ingest).await?;
    let id = result.conversation["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let set = if with_fields {
        Some(
            attributes::update(
                deps.db,
                &id,
                actor.author_type,
                actor.author_id,
                &input.fields,
            )
            .await
            .map_err(|e| update_error(e, &id))?,
        )
    } else {
        None
    };
    let (opened, set_message) = match set {
        Some(Updated {
            conversation,
            message,
            ..
        }) => (conversation, message),
        None => (result.conversation.clone(), None),
    };
    let mut messages = vec![&result.message];
    if let Some(message) = &set_message {
        messages.push(message);
    }

    let (conversation, assign_events) =
        assign_opened(deps, opened.clone(), input.assignee_id.as_deref(), actor).await?;
    mark_sla_due(deps).await;
    let mut events = vec![conversation_event(
        opened_action(&result, &opened),
        &opened,
        None,
    )];
    events.extend(messages.into_iter().map(message_event));
    events.extend(assign_events);
    emit_all(deps, &events).await;

    // A repeat that hands the conversation to someone new tells them, even
    // when the team already had it.
    if should_notify_desk_team(result.created, result.prior.as_ref())
        || conversation["assigneeId"] != opened["assigneeId"]
    {
        let who = [&conversation["name"], &conversation["email"]]
            .into_iter()
            .filter_map(Value::as_str)
            .map(js_trim)
            .find(|s| !s.is_empty())
            .unwrap_or("An integration");
        let title = if result.created {
            format!("New conversation from {who}")
        } else {
            format!("{who} replied")
        };
        let body = [
            notify::preview(Some(&input.ingest.body), PREVIEW_MAX),
            notify::preview(conversation["title"].as_str(), PREVIEW_MAX),
        ]
        .into_iter()
        .find(|p| !p.is_empty())
        .unwrap_or_else(|| format!("#{}", js_number(&conversation["conversationNumber"])));
        notify_team(deps, &conversation, &title, &body).await;
    }

    Ok(IngestedApi {
        conversation,
        ..result
    })
}

/// `autoAssignDeskConversationFromApi(deps, id)`: hand a conversation out
/// by the workspace's rules (a workflow's "assign" without a named agent),
/// mark the SLA due time and emit the `assigned` event. `None` when no one
/// was available or it is already assigned.
pub async fn auto_assign_desk_conversation_from_api(
    deps: &InboxDeps<'_>,
    conversation_id: &str,
) -> Result<Option<Value>, InboxError> {
    let assigned = auto_assign_with(deps.db, conversation_id, &deps.picker)
        .await
        .map_err(|e| append_error(e, conversation_id))?;
    let Some(assigned) = assigned else {
        return Ok(None);
    };
    mark_sla_due(deps).await;
    emit_all(
        deps,
        &[
            conversation_event("assigned", &assigned.conversation, None),
            message_event(&assigned.message),
        ],
    )
    .await;
    Ok(Some(assigned.conversation))
}

/// `UpdateDeskConversationInput`.
#[derive(Debug, Default)]
pub struct UpdateConversation {
    pub conversation_id: String,
    /// `open` or `closed`.
    pub state: Option<String>,
    /// A member's user id, or null to unassign.
    pub assignee_id: Field<String>,
    pub fields: Update,
}

/// What [`update_desk_conversation_from_api`] did.
#[derive(Debug, Clone)]
pub struct UpdatedFromApi {
    pub conversation: Value,
    pub messages: Vec<Value>,
    /// The ticket's custom field values, when ticket fields were given.
    pub custom_fields: Option<Map<String, Value>>,
}

/// `loadConversation(db, id)`.
async fn load_conversation(db: &PgPool, id: &str) -> Result<Value, InboxError> {
    match webchat::get(db, id, false).await? {
        Some((conversation, _)) => Ok(conversation),
        None => Err(InboxError::NotFound(id.to_owned())),
    }
}

/// `updateDeskConversationFromApi(deps, input)`: ticket fields first (a
/// refused one writes nothing at all), then assign or unassign, then close
/// or reopen, each as the timeline event the inbox itself writes. A change
/// to what already holds writes nothing.
pub async fn update_desk_conversation_from_api(
    deps: &InboxDeps<'_>,
    input: &UpdateConversation,
    actor: Actor<'_>,
) -> Result<UpdatedFromApi, InboxError> {
    let with_fields = has_ticket_fields(&input.fields);
    if input.state.is_none() && matches!(input.assignee_id, Field::Absent) && !with_fields {
        return Err(InboxError::EmptyUpdate);
    }
    let id = input.conversation_id.as_str();
    let mut conversation = load_conversation(deps.db, id).await?;
    let mut messages: Vec<Value> = Vec::new();
    let mut events: Vec<InboxEvent> = Vec::new();
    let mut custom_fields = None;

    // applyTicketFields
    if with_fields {
        let set = attributes::update(
            deps.db,
            id,
            actor.author_type,
            actor.author_id,
            &input.fields,
        )
        .await
        .map_err(|e| update_error(e, id))?;
        conversation = set.conversation;
        if let Some(message) = set.message {
            events.push(conversation_event(
                "updated",
                &conversation,
                Some(("customFields", Value::Object(set.custom_fields.clone()))),
            ));
            events.push(message_event(&message));
            messages.push(message);
        }
        custom_fields = Some(set.custom_fields);
    }
    let previous_assignee = conversation["assigneeId"].clone();

    // applyTransitions
    let mut moves: Vec<(&'static str, Option<Option<String>>)> = Vec::new();
    let current_assignee = conversation["assigneeId"].as_str();
    let wanted = match &input.assignee_id {
        Field::Absent => None,
        Field::Null => Some(None),
        Field::Set(assignee) => Some(Some(assignee.as_str())),
    };
    // `input.assigneeId !== conversation.assigneeId`, then
    // `input.assigneeId ? assigned : unassigned`.
    if let Some(wanted) = wanted
        && wanted != current_assignee
    {
        match wanted.filter(|a| !a.is_empty()) {
            Some(assignee) => moves.push(("assigned", Some(Some(assignee.to_owned())))),
            None => moves.push(("unassigned", Some(None))),
        }
    }
    for (event_type, assignee) in moves {
        let appended = transition(deps, &conversation, event_type, assignee, actor).await?;
        conversation = appended.conversation;
        events.push(conversation_event("assigned", &conversation, None));
        events.push(message_event(&appended.message));
        messages.push(appended.message);
    }
    let state_move = match input.state.as_deref() {
        Some("closed") if conversation["state"] != "closed" => Some("closed"),
        Some("open") if conversation["state"] != "open" => Some("reopened"),
        _ => None,
    };
    if let Some(event_type) = state_move {
        let appended = transition(deps, &conversation, event_type, None, actor).await?;
        conversation = appended.conversation;
        events.push(conversation_event("state_changed", &conversation, None));
        events.push(message_event(&appended.message));
        messages.push(appended.message);
    }

    mark_sla_due(deps).await;
    emit_all(deps, &events).await;

    if let Some(assignee) = conversation["assigneeId"]
        .as_str()
        .filter(|a| !a.is_empty())
        && conversation["assigneeId"] != previous_assignee
    {
        let by = if actor.author_type == "agent" {
            actor.author_id
        } else {
            None
        };
        notify_assigned(deps, &conversation, assignee, by).await;
    }

    Ok(UpdatedFromApi {
        conversation,
        messages,
        custom_fields,
    })
}

/// One timeline event of [`update_desk_conversation_from_api`]:
/// `metadata: { eventType, assigneeId: assigneeId ?? null }`.
#[allow(clippy::option_option)] // left out vs null, as `appendDeskMessage` reads it
async fn transition(
    deps: &InboxDeps<'_>,
    conversation: &Value,
    event_type: &str,
    assignee: Option<Option<String>>,
    actor: Actor<'_>,
) -> Result<Appended, InboxError> {
    let id = conversation["id"].as_str().unwrap_or_default();
    let mut metadata = Map::new();
    metadata.insert("eventType".to_owned(), json!(event_type));
    metadata.insert(
        "assigneeId".to_owned(),
        assignee
            .clone()
            .flatten()
            .map_or(Value::Null, Value::String),
    );
    webchat::append(
        deps.db,
        Append {
            conversation_id: id,
            kind: "event",
            author_type: actor.author_type,
            author_id: actor.author_id,
            body: None,
            attachments: None,
            metadata: Some(metadata),
            assignee_id: assignee,
        },
    )
    .await
    .map_err(|e| append_error(e, id))
}

/// `addDeskConversationMessageFromApi(deps, input)`: a reply to the
/// customer (`message`) or an internal note (`note`). Replies are refused
/// on email and phone conversations: from here they would land on the
/// timeline without ever reaching the customer.
pub async fn add_desk_conversation_message_from_api(
    deps: &InboxDeps<'_>,
    conversation_id: &str,
    kind: &str,
    body: &str,
    actor: Actor<'_>,
) -> Result<(Value, Value), InboxError> {
    let current = load_conversation(deps.db, conversation_id).await?;
    let channel = current["channel"].as_str().unwrap_or_default();
    if kind == "message" && !REPLYABLE_CHANNELS.contains(&channel) {
        return Err(InboxError::ReplyChannel(channel.to_owned()));
    }
    let id = current["id"].as_str().unwrap_or(conversation_id);
    let appended = webchat::append(
        deps.db,
        Append {
            conversation_id: id,
            kind,
            author_type: actor.author_type,
            author_id: actor.author_id,
            body: Some(body.to_owned()),
            attachments: None,
            metadata: None,
            assignee_id: None,
        },
    )
    .await
    .map_err(|e| append_error(e, id))?;
    emit_all(
        deps,
        &[
            conversation_event("updated", &appended.conversation, None),
            message_event(&appended.message),
        ],
    )
    .await;
    Ok((appended.conversation, appended.message))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prior(state: &str, waiting: Value) -> Prior {
        Prior {
            state: json!(state),
            waiting_since: waiting,
            assignee_id: Value::Null,
        }
    }

    #[test]
    fn the_team_hears_about_new_conversations_and_the_ball_coming_back() {
        assert!(should_notify_desk_team(true, None));
        assert!(should_notify_desk_team(false, None));
        assert!(should_notify_desk_team(
            false,
            Some(&prior("closed", Value::Null))
        ));
        assert!(should_notify_desk_team(
            false,
            Some(&prior("open", Value::Null))
        ));
        assert!(!should_notify_desk_team(
            false,
            Some(&prior("open", json!("2026-01-01T00:00:00.000Z")))
        ));
    }

    #[test]
    fn ticket_fields_count_when_any_is_given() {
        assert!(!has_ticket_fields(&Update::default()));
        assert!(has_ticket_fields(&Update {
            priority: Field::Null,
            ..Update::default()
        }));
        assert!(has_ticket_fields(&Update {
            tags: Some(Vec::new()),
            ..Update::default()
        }));
    }

    #[test]
    fn a_reply_refusal_names_the_channel() {
        assert_eq!(
            InboxError::ReplyChannel("email".into()).to_string(),
            "Replies to email conversations are sent from the WeldDesk inbox; add a note instead"
        );
    }
}
