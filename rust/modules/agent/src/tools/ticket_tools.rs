//! The helpdesk tools (`tools.ts` `tickets.list`, `tickets.create`).
//!
//! Tickets are conversations in the WeldDesk inbox, where the team works; they
//! go through `weldsuite_desk_domain` (`list`, `inbox::open_desk_api_conversation`),
//! the path the public API and workflows take, so the team is notified and the
//! conversation auto-assigned like any other. The events the inbox emits carry
//! `triggeredByAgentId`, so an agent never wakes itself.

use serde_json::{Map, Value, json};
use weldsuite_desk_domain::assignment::Picker;
use weldsuite_desk_domain::attributes::Update;
use weldsuite_desk_domain::inbox::{
    Actor, InboxDeps, InboxEmitter, InboxEvent, IngestApi, OpenConversation,
    open_desk_api_conversation,
};
use weldsuite_desk_domain::list::{ListQuery, list};
use weldsuite_events::{EntityEvent, EventType};
use weldsuite_kit::validation::Field;
use weldsuite_notifications::Notifier;
use weldsuite_ports::BoxFuture;

use super::{ToolContext, ToolError, ToolSpec};

pub(super) fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            id: "tickets.list",
            name: "list_tickets",
            description: "List helpdesk tickets (WeldDesk inbox conversations), newest activity first.",
            required_permissions: &["tickets:read"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "search": { "type": "string", "maxLength": 200, "description": "Customer, subject, message text, or a number like #42" },
                    "state": { "type": "string", "enum": ["open", "closed"] },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
                },
            }),
        },
        ToolSpec {
            id: "tickets.create",
            name: "create_ticket",
            description: "Open a helpdesk ticket in the WeldDesk inbox for the team. With externalId, a repeat adds to the same ticket.",
            required_permissions: &["tickets:create"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "subject": { "type": "string", "minLength": 1, "maxLength": 500 },
                    "description": { "type": "string", "maxLength": 10000, "description": "What the customer needs, in full" },
                    "customerName": { "type": "string", "minLength": 1, "maxLength": 255 },
                    "customerEmail": { "type": "string", "format": "email" },
                    "priority": { "type": "string", "enum": ["low", "medium", "high", "urgent", "critical"] },
                    "externalId": { "type": "string", "minLength": 1, "maxLength": 255,
                        "description": "A key for what this is about (alert id, order number): the same key adds to the same ticket" },
                },
                "required": ["subject"],
            }),
        },
    ]
}

pub(super) async fn execute(ctx: &ToolContext, id: &str, args: &Value) -> Result<Value, ToolError> {
    match id {
        "tickets.list" => tickets_list(ctx, args).await,
        "tickets.create" => tickets_create(ctx, args).await,
        other => Err(ToolError::UnknownTool(other.to_owned())),
    }
}

fn text<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

async fn tickets_list(ctx: &ToolContext, args: &Value) -> Result<Value, ToolError> {
    let query = ListQuery {
        q: text(args, "search").map(str::to_owned),
        state: text(args, "state").map(str::to_owned),
        limit: Some(args.get("limit").and_then(Value::as_f64).unwrap_or(20.0)),
        ..ListQuery::default()
    };
    let (rows, ..) = list(&ctx.db, &query).await?;
    let tickets: Vec<Value> = rows
        .iter()
        .map(|c| {
            json!({
                "id": c["id"], "number": c["conversationNumber"], "subject": c["title"],
                "state": c["state"], "channel": c["channel"], "customerName": c["name"],
                "customerEmail": c["email"], "assigneeId": c["assigneeId"],
            })
        })
        .collect();
    Ok(json!({ "tickets": tickets }))
}

/// `emitAgentInboxEvent`: one of the inbox's own events as the agent's actor.
struct AgentEmitter<'a> {
    ctx: &'a ToolContext,
}

impl InboxEmitter for AgentEmitter<'_> {
    fn emit<'a>(&'a self, event: &'a InboxEvent) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let Some(sink) = &self.ctx.events else {
                return Ok(());
            };
            let kind =
                EventType::catalog(event.entity_type, event.action).map_err(|e| e.to_string())?;
            let mut data = event.data.clone();
            if let Some(map) = data.as_object_mut() {
                map.insert("triggeredByAgentId".into(), json!(self.ctx.agent_id));
            }
            sink.publisher.publish(
                &sink.context,
                EntityEvent::new(kind, event.entity_id.clone(), data),
            );
            Ok(())
        })
    }
}

/// `workspaces.id` and the Clerk org id of the context's workspace (either id
/// may be what the run carries).
async fn workspace_ids(ctx: &ToolContext) -> (String, String) {
    if let Some(master) = &ctx.master {
        let row: Option<(String, Option<String>)> = sqlx::query_as(
            "select id, clerk_org_id from workspaces where id = $1 or clerk_org_id = $1 limit 1",
        )
        .bind(&ctx.workspace_id)
        .fetch_optional(master)
        .await
        .unwrap_or(None);
        if let Some((id, org)) = row {
            return (id, org.unwrap_or_else(|| ctx.workspace_id.clone()));
        }
    }
    (ctx.workspace_id.clone(), ctx.workspace_id.clone())
}

async fn tickets_create(ctx: &ToolContext, args: &Value) -> Result<Value, ToolError> {
    let subject = text(args, "subject").unwrap_or_default();
    let body = text(args, "description")
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .unwrap_or(subject);
    let mut metadata = Map::new();
    metadata.insert("agentId".into(), json!(ctx.agent_id));
    // The inbox's top priority is urgent.
    let priority = text(args, "priority")
        .map(|p| if p == "critical" { "urgent" } else { p })
        .map_or(Field::Absent, |p| Field::Set(p.to_owned()));
    let input = OpenConversation {
        ingest: IngestApi {
            via: "agent".to_owned(),
            external_id: text(args, "externalId").map(|e| e.trim().to_owned()),
            title: Some(subject.to_owned()),
            body: body.to_owned(),
            name: text(args, "customerName").map(str::to_owned),
            email: text(args, "customerEmail").map(str::to_owned),
            metadata,
            ..IngestApi::default()
        },
        fields: Update {
            priority,
            ..Update::default()
        },
        assignee_id: None,
    };
    let (workspace_id, clerk_org_id) = workspace_ids(ctx).await;
    let emitter = AgentEmitter { ctx };
    let notifier = Notifier {
        realtime: ctx.realtime.clone(),
        ..Notifier::default()
    };
    let deps = InboxDeps {
        db: &ctx.db,
        clerk_org_id: &clerk_org_id,
        emitter: &emitter,
        rooms: ctx.realtime.clone(),
        notifier: &notifier,
        picker: Picker::Local,
        due: ctx
            .master
            .as_ref()
            .map(|master| (master, workspace_id.as_str())),
    };
    let actor = Actor {
        author_type: "bot",
        author_id: Some(&ctx.agent_id),
    };
    let result = open_desk_api_conversation(&deps, &input, Some(actor))
        .await
        .map_err(|e| ToolError::Failed(format!("Could not open the ticket: {e}")))?;
    let c = &result.conversation;
    Ok(json!({
        "id": c["id"], "number": c["conversationNumber"], "subject": c["title"],
        "state": c["state"], "created": result.created,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{agent_has_grants, resolve_agent_tools, schema};

    #[test]
    fn the_schemas_match_the_typescript_tools() {
        let create = &specs()[1];
        let ok = schema::validate(
            &create.parameters,
            &json!({ "subject": "Printer", "priority": "critical", "customerEmail": "a@b.co" }),
        )
        .unwrap();
        assert_eq!(ok["priority"], "critical");
        assert!(schema::validate(&create.parameters, &json!({})).is_err());
        assert!(
            schema::validate(
                &create.parameters,
                &json!({ "subject": "x", "priority": "p9" })
            )
            .is_err()
        );
        let list = &specs()[0];
        assert!(schema::validate(&list.parameters, &json!({ "state": "pending" })).is_err());
        assert!(schema::validate(&list.parameters, &json!({ "limit": 51 })).is_err());
    }

    #[test]
    fn grants_decide_who_gets_the_tickets() {
        let names = |grants: &[&str]| -> Vec<&'static str> {
            let grants: Vec<String> = grants.iter().map(|g| (*g).to_owned()).collect();
            resolve_agent_tools(&grants, &[], true)
                .iter()
                .map(|t| t.name)
                .collect()
        };
        assert!(names(&["tickets:read"]).contains(&"list_tickets"));
        assert!(!names(&["tickets:read"]).contains(&"create_ticket"));
        assert!(names(&["tickets:create"]).contains(&"create_ticket"));
        assert!(!names(&[]).contains(&"list_tickets"));
        assert!(agent_has_grants(
            &["tickets:*".to_owned()],
            &["tickets:create"]
        ));
    }
}
