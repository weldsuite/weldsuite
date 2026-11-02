//! The WeldDesk inbox (`desk_conversations`) for workflows (`desk.ts`):
//! open a conversation (`create_conversation`, and `create_record` for a
//! ticket), and the conversation steps of [`super::helpdesk`] when the
//! conversation is an inbox one. Writes go through
//! `weldsuite_desk_domain::inbox`, the path the public API and WeldAgent
//! take, so the team is notified and the conversation auto-assigned like any
//! other.
//!
//! The engine has no entity-event queue, so workflow writes never start
//! workflows again; the inbox still moves live through the `WorkspaceHub`,
//! and the visitor's widget through the conversation's room. Workflow writes
//! show on the timeline as a bot, traceable to the run
//! (`{ authorType: 'bot', authorId: executionId }`).

use serde_json::{Map, Value, json};
use weldsuite_desk_domain::assignment::Picker;
use weldsuite_desk_domain::attributes::Update;
use weldsuite_desk_domain::inbox::{
    self, Actor, InboxDeps, InboxError, IngestApi, OpenConversation, RealtimeEmitter,
    UpdateConversation,
};
use weldsuite_kit::validation::{Field, js_trim};
use weldsuite_notifications::Notifier;

use super::{ActionCtx, ActionError, ActionResult};
use crate::js::{as_text, js_string};

/// What the inbox calls need beyond the step's context: the emitter, the
/// notifier, and `workspaces.id` (the router's and the due index's key).
struct Inbox {
    emitter: RealtimeEmitter,
    notifier: Notifier,
    workspace_id: Option<String>,
}

impl Inbox {
    async fn new(ctx: &ActionCtx<'_>) -> Self {
        let workspace_id = match &ctx.deps.master {
            Some(master) => sqlx::query_scalar::<_, String>(
                "select id from workspaces where id = $1 or clerk_org_id = $1 limit 1",
            )
            .bind(&ctx.info.workspace_id)
            .fetch_optional(master)
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "[desk-inbox] the workspace could not be resolved");
                None
            }),
            None => None,
        };
        Self {
            emitter: RealtimeEmitter {
                realtime: ctx.deps.realtime.clone(),
                workspace: ctx.info.workspace_id.clone(),
            },
            notifier: Notifier {
                realtime: ctx.deps.realtime.clone(),
                ..Notifier::default()
            },
            workspace_id,
        }
    }

    /// `inboxDeps(ctx)`.
    fn deps<'a>(&'a self, ctx: &'a ActionCtx<'_>) -> InboxDeps<'a> {
        let picker = match (&ctx.deps.assignment, &self.workspace_id) {
            (Some(router), Some(workspace_id)) => Picker::Router {
                router,
                workspace_id,
            },
            _ => Picker::Local,
        };
        InboxDeps {
            db: ctx.db,
            clerk_org_id: &ctx.info.workspace_id,
            emitter: &self.emitter,
            rooms: ctx.deps.realtime.clone(),
            notifier: &self.notifier,
            picker,
            due: match (&ctx.deps.master, &self.workspace_id) {
                (Some(master), Some(workspace_id)) => Some((master, workspace_id.as_str())),
                _ => None,
            },
        }
    }
}

/// `workflowActor(ctx)`.
fn actor<'a>(ctx: &'a ActionCtx<'_>) -> Actor<'a> {
    Actor {
        author_type: "bot",
        author_id: Some(&ctx.info.execution_id),
    }
}

/// A thrown inbox error: retried as the TypeScript `Error` subclasses are.
fn thrown(error: &InboxError) -> ActionError {
    let name = match error {
        InboxError::NotFound(_) => "DeskConversationNotFoundError",
        InboxError::Rejected { .. } => "DeskAttributeRejectedError",
        InboxError::ReplyChannel(_) => "DeskReplyChannelError",
        InboxError::EmptyUpdate => "DeskEmptyUpdateError",
        InboxError::Failed(_) => "Error",
    };
    ActionError {
        name: name.to_owned(),
        ..ActionError::plain(&error.to_string())
    }
}

/// `text(value)`: trimmed text, `None` when empty or missing.
fn text(value: Option<&Value>) -> Option<String> {
    let value = value.filter(|v| !v.is_null())?;
    let text = as_text(Some(value));
    let text = js_trim(&text);
    (!text.is_empty()).then(|| text.to_owned())
}

/// `handleCreateConversation`: open a conversation in the inbox, or add to
/// the one that carries `externalId` (reopening it). Inputs: title, message
/// (or body), name, email, contactId, externalId.
pub(super) async fn create_conversation(
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let body = ["message", "body", "description", "title"]
        .into_iter()
        .find_map(|key| text(inputs.get(key)));
    let Some(body) = body else {
        return Err(ActionError::fatal("A conversation needs a message"));
    };
    let mut metadata = Map::new();
    metadata.insert("executionId".to_owned(), json!(ctx.info.execution_id));
    let input = OpenConversation {
        ingest: IngestApi {
            via: "workflow".to_owned(),
            external_id: text(inputs.get("externalId")),
            title: text(inputs.get("title")).or_else(|| text(inputs.get("subject"))),
            body,
            name: text(inputs.get("name")).or_else(|| text(inputs.get("customerName"))),
            email: text(inputs.get("email")).or_else(|| text(inputs.get("customerEmail"))),
            contact_id: text(inputs.get("contactId")),
            metadata,
        },
        ..OpenConversation::default()
    };
    let inbox = Inbox::new(ctx).await;
    let result = inbox::open_desk_api_conversation(&inbox.deps(ctx), &input, None)
        .await
        .map_err(|e| thrown(&e))?;
    let conversation = &result.conversation;
    Ok(json!({
        "success": true,
        "created": result.created,
        "conversationId": conversation["id"],
        "conversationNumber": conversation["conversationNumber"],
        "state": conversation["state"],
        "assigneeId": conversation["assigneeId"],
    }))
}

/// `createTicketAsConversation(data, ctx)`: `create_record` for a ticket,
/// its fields mapped onto an inbox conversation.
pub(super) async fn create_ticket(data: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    // `a ?? b`: the first that is neither undefined nor null.
    let pick = |keys: &[&str]| -> Value {
        keys.iter()
            .find_map(|key| data.get(*key).filter(|v| !v.is_null()).cloned())
            .unwrap_or(Value::Null)
    };
    let mut inputs = Map::new();
    inputs.insert("title".to_owned(), pick(&["subject", "title"]));
    inputs.insert(
        "message".to_owned(),
        pick(&["description", "message", "subject"]),
    );
    inputs.insert("name".to_owned(), pick(&["customerName", "name"]));
    inputs.insert("email".to_owned(), pick(&["customerEmail", "email"]));
    inputs.insert("contactId".to_owned(), pick(&["contactId"]));
    inputs.insert("externalId".to_owned(), pick(&["externalId"]));
    create_conversation(&inputs, ctx).await
}

/// `assignDeskConversation(ctx, id, inputs)`: to the named agent, or by the
/// inbox's own assignment rules for any other strategy.
pub(super) async fn assign(
    ctx: &ActionCtx<'_>,
    conversation_id: &str,
    inputs: &Map<String, Value>,
) -> ActionResult {
    let inbox = Inbox::new(ctx).await;
    let deps = inbox.deps(ctx);
    if let Some(agent) = text(inputs.get("agentId")) {
        let input = UpdateConversation {
            conversation_id: conversation_id.to_owned(),
            assignee_id: Field::Set(agent),
            ..UpdateConversation::default()
        };
        let updated = inbox::update_desk_conversation_from_api(&deps, &input, actor(ctx))
            .await
            .map_err(|e| thrown(&e))?;
        return Ok(json!({
            "success": true,
            "conversationId": conversation_id,
            "assigneeId": updated.conversation["assigneeId"],
        }));
    }
    let assigned = inbox::auto_assign_desk_conversation_from_api(&deps, conversation_id)
        .await
        .map_err(|e| thrown(&e))?;
    Ok(match assigned {
        Some(conversation) => json!({
            "success": true,
            "conversationId": conversation_id,
            "assigneeId": conversation["assigneeId"],
        }),
        None => json!({
            "success": false,
            "error": "No available teammate (or it is already assigned)",
        }),
    })
}

/// `changeDeskConversationState(ctx, id, status)`: inbox conversations are
/// open or closed.
pub(super) async fn change_state(
    ctx: &ActionCtx<'_>,
    conversation_id: &str,
    status: &str,
) -> ActionResult {
    let state = match status {
        "closed" | "resolved" | "close" => "closed",
        "open" | "opened" | "reopened" | "active" => "open",
        _ => {
            return Ok(json!({
                "success": false,
                "error": format!("Inbox conversations are open or closed; \"{status}\" does not apply"),
            }));
        }
    };
    let input = UpdateConversation {
        conversation_id: conversation_id.to_owned(),
        state: Some(state.to_owned()),
        ..UpdateConversation::default()
    };
    let inbox = Inbox::new(ctx).await;
    let updated = inbox::update_desk_conversation_from_api(&inbox.deps(ctx), &input, actor(ctx))
        .await
        .map_err(|e| thrown(&e))?;
    Ok(json!({
        "success": true,
        "conversationId": conversation_id,
        "status": updated.conversation["state"],
    }))
}

/// `setDeskConversationPriority(ctx, id, priority)` (ADR DESK-007); the old
/// model's `critical` is the inbox's `urgent`, `none` clears it.
pub(super) async fn set_priority(
    ctx: &ActionCtx<'_>,
    conversation_id: &str,
    priority: &str,
) -> ActionResult {
    let wanted = if priority == "critical" {
        "urgent"
    } else {
        priority
    };
    if wanted != "none" && !weldsuite_desk_domain::attributes::PRIORITIES.contains(&wanted) {
        return Ok(json!({
            "success": false,
            "error": format!("Inbox priorities are low, medium, high and urgent; \"{priority}\" does not apply"),
        }));
    }
    let input = UpdateConversation {
        conversation_id: conversation_id.to_owned(),
        fields: Update {
            priority: if wanted == "none" {
                Field::Null
            } else {
                Field::Set(wanted.to_owned())
            },
            ..Update::default()
        },
        ..UpdateConversation::default()
    };
    let inbox = Inbox::new(ctx).await;
    let updated = inbox::update_desk_conversation_from_api(&inbox.deps(ctx), &input, actor(ctx))
        .await
        .map_err(|e| thrown(&e))?;
    Ok(json!({
        "success": true,
        "conversationId": conversation_id,
        "priority": updated.conversation["priority"],
    }))
}

/// `tagDeskConversation(ctx, id, mode, tags)`: add, remove or replace.
pub(super) async fn tag(
    ctx: &ActionCtx<'_>,
    conversation_id: &str,
    mode: &str,
    tags: Vec<String>,
) -> ActionResult {
    let current: Option<Value> =
        sqlx::query_scalar("select tags from desk_conversations where id = $1 limit 1")
            .bind(conversation_id)
            .fetch_optional(ctx.db)
            .await
            .map_err(|e| ActionError::plain(&e.to_string()))?;
    let current: Vec<String> = match current {
        Some(Value::Array(items)) => items.iter().map(|t| js_string(Some(t))).collect(),
        _ => Vec::new(),
    };
    let next: Vec<String> = match mode {
        "remove" => {
            let lower: Vec<String> = tags.iter().map(|t| t.to_lowercase()).collect();
            current
                .into_iter()
                .filter(|t| !lower.contains(&t.to_lowercase()))
                .collect()
        }
        "replace" => tags,
        _ => current.into_iter().chain(tags).collect(),
    };
    let input = UpdateConversation {
        conversation_id: conversation_id.to_owned(),
        fields: Update {
            tags: Some(next),
            ..Update::default()
        },
        ..UpdateConversation::default()
    };
    let inbox = Inbox::new(ctx).await;
    let updated = inbox::update_desk_conversation_from_api(&inbox.deps(ctx), &input, actor(ctx))
        .await
        .map_err(|e| thrown(&e))?;
    Ok(json!({
        "success": true,
        "conversationId": conversation_id,
        "mode": mode,
        "tags": updated.conversation["tags"],
    }))
}

/// `addDeskConversationMessage(ctx, id, kind, body)`: a reply (`message`)
/// or an internal note (`note`); a reply the channel can't carry is a
/// failed step result, not an error.
pub(super) async fn add_message(
    ctx: &ActionCtx<'_>,
    conversation_id: &str,
    kind: &str,
    body: &str,
) -> ActionResult {
    if js_trim(body).is_empty() {
        return Ok(json!({ "success": false, "error": "Nothing to send" }));
    }
    let inbox = Inbox::new(ctx).await;
    let added = inbox::add_desk_conversation_message_from_api(
        &inbox.deps(ctx),
        conversation_id,
        kind,
        body,
        actor(ctx),
    )
    .await;
    match added {
        Ok((_, message)) => Ok(json!({
            "success": true,
            "messageId": message["id"],
            "conversationId": conversation_id,
        })),
        Err(error @ InboxError::ReplyChannel(_)) => {
            Ok(json!({ "success": false, "error": error.to_string() }))
        }
        Err(error) => Err(thrown(&error)),
    }
}
