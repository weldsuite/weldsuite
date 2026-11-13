//! The tools that work on the agent itself: setup, questions, routines
//! (read), skills and memory (`tools.ts`, `agent.*`).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};
use weldsuite_kit::generate_id;
use weldsuite_permissions::Grants;

use super::{ToolContext, ToolError, ToolSpec, not_editor};
use crate::agents::{UpdateAgent, get_agent, update_agent};
use crate::grants::split_grantable;
use crate::subscriptions::{
    extract_event_subscriptions, has_explicit_triggers, normalize_explicit_triggers,
    with_explicit_triggers_flag,
};

pub(super) fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            id: "agent.save_setup",
            name: "save_agent_setup",
            description: "Save purpose + routines + display name AFTER interviewing the user. \
                Do not call this after only a preset click — you must have clarified routines first. \
                Never claim you are active unless activate=true and the user asked for that. \
                Only pass triggers the user asked for (events that should start you by themselves); an agent that works when asked in chat has none.",
            required_permissions: &[],
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "minLength": 2, "maxLength": 80,
                        "description": "Short display name for this agent based on its purpose (e.g. \"Lead Qualifier\", \"Support Digest\")." },
                    "systemPrompt": { "type": "string", "minLength": 20, "maxLength": 10000,
                        "description": "Lasting instructions: purpose, when to act, and what steps to take." },
                    "description": { "type": "string", "maxLength": 500,
                        "description": "Short one-line summary of what this agent does." },
                    "permissions": { "type": "array", "maxItems": 40,
                        "items": { "type": "string", "minLength": 3, "maxLength": 100 },
                        "description": "Workspace permissions the job needs, as object:action keys (e.g. \"tasks:read\", \"tickets:read\", \"people:create\"). Only ask for what the instructions use. Ones the user does not hold are skipped." },
                    "activate": { "type": "boolean",
                        "description": "Set true ONLY if the user explicitly asked to activate / go live. Otherwise omit or set false: the agent keeps its current status (a draft stays a draft, an active agent stays active)." },
                    "triggers": { "type": "array", "maxItems": 20,
                        "items": { "type": "string", "minLength": 3, "maxLength": 100 },
                        "description": "Events that should start this agent by themselves, as entity.event keys (e.g. \"ticket.created\", \"person.created\", \"project_task.completed\"). Pass ONLY triggers the user explicitly asked for (\"when a new ticket arrives, triage it\"). For an agent that only works when someone asks it in chat, omit this or pass an empty list. Omitted: no event is guessed from your instructions unless they clearly describe one." },
                },
                "required": ["name", "systemPrompt"],
            }),
        },
        ToolSpec {
            id: "agent.ask_user",
            name: "ask_user",
            description: "Ask the user ONE multiple-choice question when you need a decision or detail from them. \
                The question is shown as a card with your options; the user can also type their own answer. \
                After calling this, end your turn without further text: their answer arrives as the next user message. \
                Never ask the same question twice, and never use it for questions you can answer yourself.",
            required_permissions: &[],
            parameters: json!({
                "type": "object",
                "properties": {
                    "question": { "type": "string", "minLength": 3, "maxLength": 300,
                        "description": "One focused question, phrased the way you would say it." },
                    "options": { "type": "array", "minItems": 2, "maxItems": 4,
                        "items": { "type": "object", "properties": {
                            "label": { "type": "string", "minLength": 1, "maxLength": 80,
                                "description": "Short answer the user can pick, e.g. \"Every morning at 8\"." },
                            "description": { "type": "string", "maxLength": 160,
                                "description": "Optional one-line detail shown under the label." },
                        }, "required": ["label"] },
                        "description": "2 to 4 likely answers. The user can always type their own answer instead." },
                    "multiSelect": { "type": "boolean", "description": "True when the user may pick more than one option." },
                },
                "required": ["question", "options"],
            }),
        },
        ToolSpec {
            id: "agent.list_routines",
            name: "list_routines",
            description: "List this agent's routines with their schedule, timezone, next run and whether they are on.",
            required_permissions: &[],
            parameters: json!({ "type": "object", "properties": {} }),
        },
        ToolSpec {
            id: "agent.save_skill",
            name: "save_skill",
            description: "Save the current process as a reusable skill (steps, rules, safety boundaries). Enable it for this agent.",
            required_permissions: &[],
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "minLength": 2, "maxLength": 255 },
                    "instructions": { "type": "string", "minLength": 20, "maxLength": 20000 },
                    "description": { "type": "string", "maxLength": 2000 },
                    "activate": { "type": "boolean" },
                },
                "required": ["name", "instructions"],
            }),
        },
        ToolSpec {
            id: "agent.remember",
            name: "remember",
            description: "Store a lasting preference, fact, or correction about how this agent should work.",
            required_permissions: &[],
            parameters: json!({
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["preference", "fact", "summary", "correction"], "default": "preference" },
                    "content": { "type": "string", "minLength": 1, "maxLength": 5000 },
                },
                "required": ["content"],
            }),
        },
    ]
}

pub(super) async fn execute(ctx: &ToolContext, id: &str, args: &Value) -> Result<Value, ToolError> {
    match id {
        "agent.save_setup" => save_setup(ctx, args).await,
        "agent.ask_user" => Ok(ask_user(args)),
        "agent.list_routines" => list_routines(ctx).await,
        "agent.save_skill" => save_skill(ctx, args).await,
        "agent.remember" => remember(ctx, args).await,
        other => Err(ToolError::UnknownTool(other.to_owned())),
    }
}

fn text<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn strings(args: &Value, key: &str) -> Option<Vec<String>> {
    args.get(key).and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect()
    })
}

fn list_of(value: &Value, key: &str) -> Vec<String> {
    strings(value, key).unwrap_or_default()
}

/// What `save_agent_setup` tells the model to confirm, given the status after
/// saving (`saveSetupHint`).
fn save_setup_hint(status: &str, activated: bool) -> &'static str {
    if status == "paused" {
        return "Setup saved; you are still paused. Confirm briefly; they can turn you back on with the Activate button.";
    }
    if status != "active" {
        return "Setup saved as draft. Confirm briefly; ask if they want you activated.";
    }
    if activated {
        "Setup saved and activated. Confirm briefly with the user."
    } else {
        "Setup saved; you are still active. Confirm briefly with the user."
    }
}

static MENTIONS_ROUTINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(when|whenever|schedule|daily|weekly|ticket|contact|order|chat|trigger|routine|event|listen)\b")
        .expect("static pattern")
});

async fn save_setup(ctx: &ToolContext, args: &Value) -> Result<Value, ToolError> {
    if ctx.actor_can_edit == Some(false) {
        return Ok(not_editor());
    }
    let Some(existing) = get_agent(&ctx.db, &ctx.agent_id).await? else {
        return Ok(json!({ "error": "Agent not found" }));
    };
    let prompt = text(args, "systemPrompt")
        .unwrap_or_default()
        .trim()
        .to_owned();
    // Lightweight guard: lasting instructions must say when and how the agent acts.
    if !MENTIONS_ROUTINE.is_match(&prompt) {
        return Ok(json!({
            "error": "systemPrompt is missing routines (when to act). Ask the user about triggers/routines, then try again."
        }));
    }
    let enabled_tools = list_of(&existing, "enabledTools");
    // What the user asked for beats a reading of the prompt: triggers passed
    // here are used as given (an empty list: chat only), and stay when a later
    // save does not repeat them.
    let explicit = strings(args, "triggers").map(|t| normalize_explicit_triggers(&t));
    let event_subscriptions = match &explicit {
        Some(explicit) => explicit.subscriptions.clone(),
        None if !has_explicit_triggers(&enabled_tools) => extract_event_subscriptions(&prompt),
        None => list_of(&existing, "eventSubscriptions"),
    };
    let holder = Grants {
        permissions: ctx.actor_permissions.clone().unwrap_or_default(),
        denies: Vec::new(),
    };
    let requested = strings(args, "permissions").unwrap_or_default();
    let (granted, refused) = split_grantable(&requested, &holder, ctx.sandbox);
    let mut permissions = list_of(&existing, "permissions");
    for perm in &granted {
        if !permissions.contains(perm) {
            permissions.push(perm.clone());
        }
    }
    let description = text(args, "description")
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(str::to_owned);
    let activate = args.get("activate").and_then(Value::as_bool) == Some(true);
    let update = UpdateAgent {
        name: Some(text(args, "name").unwrap_or_default().trim().to_owned()),
        system_prompt: Some(prompt),
        description: description.map_or(
            match existing["description"].as_str() {
                Some(old) => weldsuite_kit::validation::Field::Set(old.to_owned()),
                None => weldsuite_kit::validation::Field::Absent,
            },
            weldsuite_kit::validation::Field::Set,
        ),
        permissions: Some(permissions),
        event_subscriptions: Some(event_subscriptions),
        enabled_tools: explicit
            .as_ref()
            .map(|_| with_explicit_triggers_flag(&enabled_tools)),
        // Saving only turns an agent on, never off: re-saving the setup of a
        // live agent from its chat must not pause it and stop its routines.
        status: activate.then(|| "active".to_owned()),
        ..UpdateAgent::default()
    };
    let Some(updated) = update_agent(&ctx.db, &ctx.agent_id, update).await? else {
        return Ok(json!({ "error": "Failed to save agent setup" }));
    };
    let status = updated["status"].as_str().unwrap_or("draft").to_owned();
    let mut out = json!({
        "ok": true,
        "agentId": updated["id"],
        "name": updated["name"],
        "status": status,
        "description": updated["description"],
        "eventSubscriptions": updated["eventSubscriptions"],
        "grantedPermissions": granted,
        "hint": save_setup_hint(&status, activate),
    });
    if let (Some(explicit), Some(map)) = (&explicit, out.as_object_mut())
        && !explicit.invalid.is_empty()
    {
        map.insert("unknownTriggers".into(), json!(explicit.invalid));
        map.insert(
            "unknownTriggersHint".into(),
            json!("These triggers are not events WeldSuite knows, so they were not saved. Tell the user and ask what should start you."),
        );
    }
    if !refused.is_empty()
        && let Some(map) = out.as_object_mut()
    {
        map.insert("notGranted".into(), json!(refused));
        map.insert(
            "notGrantedHint".into(),
            json!("Tell the user these were not granted (they lack them or they do not exist); an admin can add them under Settings → Access."),
        );
    }
    Ok(out)
}

/// The question card is the tool call itself; the answer comes back as the
/// next user message.
fn ask_user(args: &Value) -> Value {
    let options: Vec<Value> = args["options"]
        .as_array()
        .map(|options| options.iter().map(|o| o["label"].clone()).collect())
        .unwrap_or_default();
    json!({
        "ok": true,
        "shownToUser": true,
        "question": args["question"],
        "options": options,
        "hint": "The question is on screen. End your turn now and wait for the answer.",
    })
}

async fn list_routines(ctx: &ToolContext) -> Result<Value, ToolError> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from weldagent_routines r where r.deleted_at is null and r.agent_id = $1
         order by r.updated_at desc",
    )
    .bind(&ctx.agent_id)
    .fetch_all(&ctx.db)
    .await?;
    Ok(Value::Array(
        rows.into_iter()
            .map(weldsuite_db::js_row)
            .map(|r| {
                json!({
                    "routineId": r["id"],
                    "name": r["name"],
                    "scheduleKind": r["scheduleKind"],
                    "cronExpr": r["cronExpr"],
                    "timezone": r["timezone"],
                    "eventKey": r["eventKey"],
                    "enabled": r["enabled"],
                    "nextRunAt": r["nextRunAt"],
                })
            })
            .collect(),
    ))
}

async fn save_skill(ctx: &ToolContext, args: &Value) -> Result<Value, ToolError> {
    if ctx.actor_can_edit == Some(false) {
        return Ok(not_editor());
    }
    let skill_id = generate_id("skl");
    let status = if args.get("activate").and_then(Value::as_bool) == Some(false) {
        "draft"
    } else {
        "active"
    };
    let name = text(args, "name").unwrap_or_default().trim().to_owned();
    sqlx::query(
        "insert into weldagent_skills (id, name, description, instructions, steps, status, created_by, source_agent_id)
         values ($1, $2, $3, $4, '[]'::jsonb, $5, $6, $7)",
    )
    .bind(&skill_id)
    .bind(&name)
    .bind(text(args, "description"))
    .bind(text(args, "instructions").unwrap_or_default().trim())
    .bind(status)
    .bind(&ctx.actor_user_id)
    .bind(&ctx.agent_id)
    .execute(&ctx.db)
    .await?;
    // enableSkillForAgent: an existing link is switched on, else created.
    let relinked = sqlx::query(
        "update weldagent_agent_skills set enabled = true where agent_id = $1 and skill_id = $2",
    )
    .bind(&ctx.agent_id)
    .bind(&skill_id)
    .execute(&ctx.db)
    .await?;
    if relinked.rows_affected() == 0 {
        sqlx::query("insert into weldagent_agent_skills (id, agent_id, skill_id, enabled) values ($1, $2, $3, true)")
            .bind(generate_id("asl"))
            .bind(&ctx.agent_id)
            .bind(&skill_id)
            .execute(&ctx.db)
            .await?;
    }
    Ok(json!({ "ok": true, "skillId": skill_id, "name": name, "status": status }))
}

async fn remember(ctx: &ToolContext, args: &Value) -> Result<Value, ToolError> {
    if ctx.actor_can_edit == Some(false) {
        return Ok(not_editor());
    }
    let memory_id = generate_id("mem");
    sqlx::query(
        "insert into weldagent_memories (id, agent_id, kind, content, source, created_by)
         values ($1, $2, $3, $4, 'chat', $5)",
    )
    .bind(&memory_id)
    .bind(&ctx.agent_id)
    .bind(text(args, "kind").unwrap_or("preference"))
    .bind(text(args, "content").unwrap_or_default().trim())
    .bind(&ctx.actor_user_id)
    .execute(&ctx.db)
    .await?;
    Ok(json!({ "ok": true, "memoryId": memory_id }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_setup_hint_follows_the_status() {
        assert!(save_setup_hint("paused", false).contains("still paused"));
        assert!(save_setup_hint("draft", true).contains("as draft"));
        assert!(save_setup_hint("active", true).contains("activated"));
        assert!(save_setup_hint("active", false).contains("still active"));
    }

    #[test]
    fn instructions_must_say_when_to_act() {
        assert!(MENTIONS_ROUTINE.is_match("Every ticket gets a reply."));
        assert!(!MENTIONS_ROUTINE.is_match("Be nice and helpful always."));
    }

    #[test]
    fn ask_user_echoes_the_option_labels() {
        let out = ask_user(&json!({
            "question": "When?",
            "options": [{ "label": "Daily" }, { "label": "Weekly", "description": "x" }],
        }));
        assert_eq!(out["options"], json!(["Daily", "Weekly"]));
        assert_eq!(out["shownToUser"], true);
    }
}
