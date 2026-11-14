//! `POST /api/workflows/generate` (`routes/workflows/generate.ts`,
//! `services/workflow-generation.ts`): "Generate with AI". A plain-English
//! prompt in, one workflow draft (trigger + steps) out, for the editor to load
//! for review. Nothing is written: `POST /api/workflows` saves it once the
//! member approves.
//!
//! The model is asked for the draft as JSON against the worker's schema, with
//! its system prompt built from the same catalogs (`rust/catalogs/weldconnect.json`,
//! exported from `static-catalogs.ts`), at `copilot`'s quality tier through
//! `weldsuite-ai` (feature `connect`, ledger op `workflow_generate`). The
//! answer is then post-validated as the worker does: stable ids and names
//! filled in, and anything outside the catalogs flagged in `warnings`, never
//! dropped. The answer carries `meta.ai`, the provider that served it.
//!
//! Without an AI provider the route answers what connect-api answers without
//! its gateway: 503 `AI_NOT_CONFIGURED`.

use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_ai::{Ai, AiCall, AiError, ChatRequest, Feature, Task, Tier};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::Presence;

use crate::js::as_text;
use crate::{Caller, ConnectState, catalog, internal, validate};

/// The ledger's `op` for a generation (`chargeAiUsage({ op })`).
pub(crate) const OP: &str = "workflow_generate";

/// What `assertGatewayConfigured` throws when the worker has no gateway:
/// the route's 503 message.
pub(crate) const NOT_CONFIGURED: &str = "AI gateway is not configured (missing CF_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID) for provider \"cloudflare\"";

/// `workflowDraftSchema`: what the model must answer.
pub(crate) fn draft_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": { "type": "string" },
            "description": { "type": "string" },
            "triggers": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": { "type": "string" },
                        "name": { "type": "string" },
                        "isEnabled": { "type": "boolean" },
                        "config": { "type": "object", "additionalProperties": true },
                    },
                    "required": ["type", "name"],
                    "additionalProperties": false,
                },
            },
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": { "type": "string" },
                        "name": { "type": "string" },
                        "description": { "type": "string" },
                        "config": { "type": "object", "additionalProperties": true },
                    },
                    "required": ["type", "name"],
                    "additionalProperties": false,
                },
            },
        },
        "required": ["name", "triggers", "steps"],
        "additionalProperties": false,
    })
}

/// `BUILTIN_ACTION_CONFIG_FIELDS`: the config field names of the built-in
/// action types. Integration actions carry theirs as `inputs` in the catalog.
const BUILTIN_ACTION_CONFIG_FIELDS: &[(&str, &[&str])] = &[
    ("send_email", &["to", "subject", "body"]),
    ("send_sms", &["to", "body"]),
    ("send_notification", &["title", "userIds"]),
    ("slack_message", &["channel", "text"]),
    ("create_record", &["entityType", "data"]),
    ("update_record", &["entityType", "id", "data"]),
    ("delete_record", &["entityType", "id"]),
    ("query_data", &["entityType", "filters"]),
    ("condition", &["field", "operator", "value"]),
    ("loop", &["items"]),
    ("delay", &["seconds", "minutes", "hours", "days"]),
    ("transform", &["input", "transformation"]),
    ("http_request", &["url", "method", "headers", "body"]),
    ("webhook", &["url", "method", "headers", "body"]),
    (
        "ai_generate",
        &[
            "prompt",
            "systemPrompt",
            "model",
            "temperature",
            "maxTokens",
        ],
    ),
    ("ai_classify", &["text", "categories", "model"]),
    ("set_variable", &["name", "value"]),
    ("log", &["message", "level"]),
    ("manual_step", &["title"]),
    ("assign_conversation", &["strategy", "agentId"]),
    ("tag_conversation", &["tags"]),
    ("change_conversation_status", &["status"]),
    ("change_priority", &["priority"]),
    ("send_reply", &["message"]),
    ("add_internal_note", &["note"]),
    (
        "create_conversation",
        &[
            "title",
            "message",
            "name",
            "email",
            "externalId",
            "priority",
            "tags",
            "teamId",
            "ticketTypeId",
            "state",
        ],
    ),
    ("parse_alert", &["payload", "source", "defaultPriority"]),
    ("send_message", &["message"]),
    ("send_choices", &["question", "choices"]),
    ("collect_input", &["question", "variableName"]),
];

/// `TRIGGER_CATEGORY_HELP`.
const TRIGGER_CATEGORY_HELP: &[&str] = &[
    "manual: config = {} (no fields needed).",
    "schedule: config = { cronExpression, timezone }.",
    "entity_event: config = { entityType, eventType } — the pair MUST come from the \"Entity types + events\" list below.",
    "webhook: config = { method }.",
    "integration_event: config = { provider, event } — pick from the \"Integration triggers\" list below.",
    "api: config = {} (no fields needed).",
    "workflow_complete: config = { sourceWorkflowId, triggerOn }.",
];

/// `TRIGGER_CATEGORIES`.
const TRIGGER_CATEGORIES: &[&str] = &[
    "schedule",
    "entity_event",
    "integration_event",
    "webhook",
    "manual",
    "api",
    "workflow_complete",
];

fn text_of<'v>(value: &'v Value, key: &str) -> Option<&'v str> {
    value.get(key).and_then(Value::as_str)
}

/// `buildSystemPrompt()`: the instructions, then the exact catalog the model
/// must pick from.
pub(crate) fn system_prompt() -> String {
    let actions = catalog::action_types()
        .iter()
        .map(|action| {
            let id = text_of(action, "id").unwrap_or_default();
            let fields: Vec<&str> = BUILTIN_ACTION_CONFIG_FIELDS
                .iter()
                .find(|(builtin, _)| *builtin == id)
                .map_or_else(
                    || {
                        crate::js::array(action.get("inputs"))
                            .iter()
                            .filter_map(|input| text_of(input, "key"))
                            .collect()
                    },
                    |(_, fields)| fields.to_vec(),
                );
            let note = if fields.is_empty() {
                String::new()
            } else {
                format!(" (config fields: {})", fields.join(", "))
            };
            format!(
                "- {id}: {}{note}",
                text_of(action, "description").unwrap_or("undefined")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let integration_triggers = catalog::trigger_types()
        .iter()
        .filter_map(|trigger| {
            let provider = text_of(trigger, "provider")?;
            Some(format!(
                "- provider={provider}, event={}: {}",
                text_of(trigger, "id").unwrap_or("undefined"),
                text_of(trigger, "description").unwrap_or("undefined")
            ))
        })
        .collect::<Vec<_>>()
        .join("\n");

    let entity_events = catalog::entity_events()
        .iter()
        .map(|entity| {
            let events = crate::js::array(entity.get("events"))
                .iter()
                .map(|event| text_of(event, "id").unwrap_or("undefined"))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "- entityType={}: eventType ∈ [{events}]",
                text_of(entity, "entityType").unwrap_or("undefined")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let or = |list: String, empty: &str| {
        if list.is_empty() {
            empty.to_owned()
        } else {
            list
        }
    };
    [
        "You are a workflow-automation architect for WeldSuite (WeldConnect), a visual automation builder.".to_owned(),
        "Given a plain-English description of an automation, output a workflow draft as structured data.".to_owned(),
        String::new(),
        "Rules:".to_owned(),
        "- Use ONLY the action types and trigger categories listed below — never invent new ones.".to_owned(),
        "- Every step needs a short, human-readable `name` and a `config` object using the field names shown for its type.".to_owned(),
        "- Every trigger needs a `type` (one of the 7 trigger categories below) and a matching `config`.".to_owned(),
        "- Prefer exactly 1 trigger and 2–6 steps for a typical automation. Keep it directly focused on the prompt.".to_owned(),
        "- Write a short `name` (a few words) and one-sentence `description` for the whole workflow.".to_owned(),
        String::new(),
        "Available action types:".to_owned(),
        actions,
        String::new(),
        "Trigger categories:".to_owned(),
        TRIGGER_CATEGORY_HELP.join("\n"),
        String::new(),
        "Entity types + events (for entity_event triggers):".to_owned(),
        or(entity_events, "(none configured)"),
        String::new(),
        "Integration triggers (for integration_event triggers):".to_owned(),
        or(integration_triggers, "(none connected)"),
    ]
    .join("\n")
}

/// `ValidationCatalog`: the action types and the entity events a draft may
/// use.
pub(crate) struct ValidationCatalog {
    pub(crate) action_type_ids: HashSet<String>,
    pub(crate) entity_events_by_type: HashMap<String, HashSet<String>>,
}

/// `buildValidationCatalog()`: from the static catalogs.
pub(crate) fn validation_catalog() -> ValidationCatalog {
    ValidationCatalog {
        action_type_ids: catalog::action_types()
            .iter()
            .filter_map(|action| text_of(action, "id").map(str::to_owned))
            .collect(),
        entity_events_by_type: catalog::entity_events()
            .iter()
            .filter_map(|entity| {
                let events = crate::js::array(entity.get("events"))
                    .iter()
                    .filter_map(|event| text_of(event, "id").map(str::to_owned))
                    .collect();
                text_of(entity, "entityType").map(|kind| (kind.to_owned(), events))
            })
            .collect(),
    }
}

/// `value?.trim()`: a string field trimmed; anything else is absent.
fn trimmed<'v>(value: &'v Value, key: &str) -> Option<&'v str> {
    text_of(value, key).map(str::trim)
}

/// `value?.trim() || fallback()`.
fn trimmed_or(value: &Value, key: &str, fallback: impl FnOnce() -> String) -> String {
    trimmed(value, key)
        .filter(|text| !text.is_empty())
        .map_or_else(fallback, str::to_owned)
}

/// `x ?? {}`.
fn config_of(value: &Value) -> Value {
    match value.get("config") {
        None | Some(Value::Null) => json!({}),
        Some(config) => config.clone(),
    }
}

/// `postValidateDraft(raw, catalog)`: the draft with stable ids and names,
/// and a warning (never a silent drop) for anything outside the catalog.
/// Answers `(workflow, warnings)`.
pub(crate) fn post_validate_draft(
    raw: &Value,
    catalog: &ValidationCatalog,
) -> (Value, Vec<String>) {
    let mut warnings = Vec::new();

    let steps: Vec<Value> = crate::js::array(raw.get("steps"))
        .iter()
        .enumerate()
        .map(|(i, step)| {
            let id = trimmed_or(step, "id", || generate_id("step"));
            let name = trimmed_or(step, "name", || format!("Step {}", i + 1));
            let kind = trimmed(step, "type").unwrap_or_default().to_owned();
            if kind.is_empty() || !catalog.action_type_ids.contains(&kind) {
                warnings.push(format!(
                    "Step \"{name}\" uses an unknown action type \"{kind}\" — review before publishing."
                ));
            }
            let mut out = Map::new();
            out.insert("id".into(), json!(id));
            out.insert("type".into(), json!(kind));
            out.insert("name".into(), json!(name));
            if let Some(description) = step.get("description") {
                out.insert("description".into(), description.clone());
            }
            out.insert("config".into(), config_of(step));
            Value::Object(out)
        })
        .collect();

    let triggers: Vec<Value> = crate::js::array(raw.get("triggers"))
        .iter()
        .enumerate()
        .map(|(i, trigger)| {
            let id = trimmed_or(trigger, "id", || generate_id("trg"));
            let name = trimmed_or(trigger, "name", || format!("Trigger {}", i + 1));
            let kind = trimmed(trigger, "type").unwrap_or_default().to_owned();
            let config = config_of(trigger);
            if !TRIGGER_CATEGORIES.contains(&kind.as_str()) {
                warnings.push(format!(
                    "Trigger \"{name}\" uses an unknown trigger type \"{kind}\" — review before publishing."
                ));
            } else if kind == "entity_event" {
                let field = |key: &str| match config.get(key) {
                    None | Some(Value::Null) => String::new(),
                    value => as_text(value),
                };
                let entity_type = field("entityType");
                let event_type = field("eventType");
                match catalog.entity_events_by_type.get(&entity_type) {
                    None => warnings.push(format!(
                        "Trigger \"{name}\" references an unknown entity type \"{entity_type}\" — review before publishing."
                    )),
                    Some(events) if event_type.is_empty() || !events.contains(&event_type) => {
                        warnings.push(format!(
                            "Trigger \"{name}\" references an unknown event \"{event_type}\" for entity \"{entity_type}\" — review before publishing."
                        ));
                    }
                    Some(_) => {}
                }
            }
            let is_enabled = match trigger.get("isEnabled") {
                None | Some(Value::Null) => json!(true),
                Some(value) => value.clone(),
            };
            json!({ "id": id, "type": kind, "name": name, "isEnabled": is_enabled, "config": config })
        })
        .collect();

    if steps.is_empty() {
        warnings.push(
            "The generated workflow has no steps — add at least one action before publishing."
                .to_owned(),
        );
    }
    if triggers.is_empty() {
        warnings
            .push("The generated workflow has no trigger — add one before publishing.".to_owned());
    }

    let mut workflow = Map::new();
    workflow.insert(
        "name".into(),
        json!(trimmed_or(raw, "name", || "Untitled workflow".to_owned())),
    );
    if let Some(description) = trimmed(raw, "description") {
        workflow.insert("description".into(), json!(description));
    }
    workflow.insert("triggers".into(), Value::Array(triggers));
    workflow.insert("steps".into(), Value::Array(steps));
    (Value::Object(workflow), warnings)
}

/// Why a generation failed, answered as the worker answers it.
#[derive(Debug)]
pub(crate) enum GenerateError {
    /// No AI provider: 503 `AI_NOT_CONFIGURED`.
    NotConfigured,
    /// The model call failed or its answer was unusable: 502
    /// `AI_REQUEST_FAILED` with the error's message.
    RequestFailed(String),
    /// What `weldsuite-ai` refused before calling (402, 422), as it answers.
    Ai(AiError),
}

impl GenerateError {
    fn from_ai(error: AiError) -> Self {
        match error {
            AiError::Unavailable => Self::NotConfigured,
            AiError::Provider { message, .. } | AiError::Invalid(message) => {
                Self::RequestFailed(message)
            }
            other => Self::Ai(other),
        }
    }

    pub(crate) fn respond(self) -> Response {
        let refusal = |status: StatusCode, code: &str, message: &str| {
            (
                status,
                Json(json!({ "error": { "code": code, "message": message } })),
            )
                .into_response()
        };
        match self {
            Self::NotConfigured => refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "AI_NOT_CONFIGURED",
                NOT_CONFIGURED,
            ),
            Self::RequestFailed(message) => {
                tracing::warn!(%message, "[connect-api/workflows] the AI request failed");
                let message = if message.is_empty() {
                    "AI request failed".to_owned()
                } else {
                    message
                };
                refusal(StatusCode::BAD_GATEWAY, "AI_REQUEST_FAILED", &message)
            }
            Self::Ai(AiError::Database(error)) => internal(&error, "Failed to generate workflow"),
            Self::Ai(error) => error.into_api_error().into_response(),
        }
    }
}

/// A generated draft: `{ workflow, warnings }` and who served it.
#[derive(Debug)]
pub(crate) struct Generated {
    pub(crate) workflow: Value,
    pub(crate) warnings: Vec<String>,
    pub(crate) served: weldsuite_ai::Served,
}

/// `generateWorkflowDraft(env, { prompt }, metering)`: the gate, the model
/// call, then the post-validation. `ai` is `None` without a provider.
pub(crate) async fn generate_draft(
    ai: Option<&Ai>,
    call: &AiCall,
    prompt: &str,
) -> Result<Generated, GenerateError> {
    let ai = ai.ok_or(GenerateError::NotConfigured)?;
    ai.assert_credits(call)
        .await
        .map_err(GenerateError::from_ai)?;
    let request =
        ChatRequest::system_user(system_prompt(), format!("Build a workflow for: {prompt}"))
            .schema("workflow_draft", draft_schema());
    let answer = ai
        .chat(call, request)
        .await
        .map_err(GenerateError::from_ai)?;
    let raw = answer.object.unwrap_or_else(|| json!({}));
    let (workflow, warnings) = post_validate_draft(&raw, &validation_catalog());
    Ok(Generated {
        workflow,
        warnings,
        served: answer.served,
    })
}

/// The `AiCall` of a generation: `copilot` at the quality tier, charged to
/// the member's workspace as `workflow_generate`.
pub(crate) fn generation_call(caller: &Caller, master: Option<weldsuite_db::PgPool>) -> AiCall {
    AiCall::new(
        &caller.workspace_id,
        Feature::Connect,
        Task::Copilot,
        Tier::Quality,
    )
    .user(&caller.user_id)
    .tenant(caller.db.clone())
    .master(master)
    .op(OP)
}

/// `POST /api/workflows/generate` (`workflows:create`).
pub(crate) async fn generate(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let prompt = match validate(&headers, &body, |issues, b| {
        issues
            .text(b, "prompt", Presence::Required, Some(3), Some(2000))
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(prompt) => prompt,
        Err(refusal) => return refusal.respond("Failed to generate workflow"),
    };
    let ai = caller.overrides.ai(&state);
    let call = generation_call(&caller, caller.overrides.master(&state));
    match generate_draft(ai.as_ref(), &call, &prompt).await {
        Ok(generated) => Json(json!({
            "data": { "workflow": generated.workflow, "warnings": generated.warnings },
            "meta": { "ai": generated.served.meta() },
        }))
        .into_response(),
        Err(error) => error.respond(),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use weldsuite_ai::{AiConfig, FakeProvider};

    fn ai(fake: &FakeProvider) -> Ai {
        let mut problems = Vec::new();
        let config = AiConfig::from_lookup(
            &|name: &str| match name {
                "AI_DEFAULT_PROVIDER" => Some("mistral".to_owned()),
                "MISTRAL_API_KEY" => Some("mistral-key".to_owned()),
                _ => None,
            },
            &mut problems,
        );
        assert!(problems.is_empty(), "{problems:?}");
        Ai::fake(config, fake.clone())
    }

    fn call() -> AiCall {
        AiCall::new("ws_1", Feature::Connect, Task::Copilot, Tier::Quality)
            .user("user_1")
            .op(OP)
    }

    fn catalog() -> ValidationCatalog {
        ValidationCatalog {
            action_type_ids: ["send_email", "condition", "ai_generate"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            entity_events_by_type: HashMap::from([
                (
                    "ticket".to_owned(),
                    ["created", "updated", "closed"]
                        .into_iter()
                        .map(str::to_owned)
                        .collect(),
                ),
                (
                    "lead".to_owned(),
                    ["created", "qualified"]
                        .into_iter()
                        .map(str::to_owned)
                        .collect(),
                ),
            ]),
        }
    }

    #[test]
    fn a_well_formed_draft_is_normalised_without_warnings() {
        let (workflow, warnings) = post_validate_draft(
            &json!({
                "name": "Welcome new leads",
                "description": "Email new leads when they arrive",
                "triggers": [{ "type": "entity_event", "name": "Lead created", "config": { "entityType": "lead", "eventType": "created" } }],
                "steps": [{ "type": "send_email", "name": "Send welcome email", "config": { "to": "{{trigger.email}}", "subject": "Hi", "body": "Welcome!" } }],
            }),
            &catalog(),
        );
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(workflow["name"], "Welcome new leads");
        assert_eq!(workflow["description"], "Email new leads when they arrive");
        assert!(
            workflow["triggers"][0]["id"]
                .as_str()
                .unwrap()
                .starts_with("trg_")
        );
        assert_eq!(workflow["triggers"][0]["isEnabled"], true);
        assert!(
            workflow["steps"][0]["id"]
                .as_str()
                .unwrap()
                .starts_with("step_")
        );
        assert!(workflow["steps"][0].get("description").is_none());
    }

    #[test]
    fn missing_ids_and_names_are_filled_in() {
        let (workflow, _) = post_validate_draft(
            &json!({ "name": "X", "triggers": [{ "type": "manual" }], "steps": [{ "type": "log" }] }),
            &catalog(),
        );
        assert_eq!(workflow["triggers"][0]["name"], "Trigger 1");
        assert_eq!(workflow["triggers"][0]["config"], json!({}));
        assert_eq!(workflow["steps"][0]["name"], "Step 1");
    }

    #[test]
    fn anything_outside_the_catalog_is_flagged_not_dropped() {
        let (workflow, warnings) = post_validate_draft(
            &json!({
                "name": "X",
                "triggers": [
                    { "type": "not_a_real_category", "name": "Weird trigger" },
                    { "type": "entity_event", "name": "Bad entity", "config": { "entityType": "unicorn", "eventType": "created" } },
                    { "type": "entity_event", "name": "Bad event", "config": { "entityType": "ticket", "eventType": "teleported" } },
                    { "type": "entity_event", "name": "Ticket closed", "config": { "entityType": "ticket", "eventType": "closed" } },
                ],
                "steps": [{ "type": "totally_made_up_action", "name": "Mystery step" }],
            }),
            &catalog(),
        );
        assert_eq!(workflow["steps"][0]["type"], "totally_made_up_action");
        assert_eq!(
            warnings,
            vec![
                "Step \"Mystery step\" uses an unknown action type \"totally_made_up_action\" — review before publishing.",
                "Trigger \"Weird trigger\" uses an unknown trigger type \"not_a_real_category\" — review before publishing.",
                "Trigger \"Bad entity\" references an unknown entity type \"unicorn\" — review before publishing.",
                "Trigger \"Bad event\" references an unknown event \"teleported\" for entity \"ticket\" — review before publishing.",
            ]
        );
    }

    #[test]
    fn an_empty_draft_warns_and_gets_a_name() {
        let (workflow, warnings) =
            post_validate_draft(&json!({ "triggers": [], "steps": [] }), &catalog());
        assert_eq!(workflow["name"], "Untitled workflow");
        assert!(workflow.get("description").is_none());
        assert_eq!(
            warnings,
            vec![
                "The generated workflow has no steps — add at least one action before publishing.",
                "The generated workflow has no trigger — add one before publishing.",
            ]
        );
    }

    #[test]
    fn the_real_catalog_and_prompt_name_every_choice() {
        let catalog = validation_catalog();
        assert!(catalog.action_type_ids.contains("ai_generate"));
        assert!(catalog.action_type_ids.contains("send_email"));
        assert!(!catalog.entity_events_by_type.is_empty());
        let prompt = system_prompt();
        assert!(prompt.starts_with("You are a workflow-automation architect for WeldSuite"));
        assert!(
            prompt
                .contains("- send_email: Send an email message (config fields: to, subject, body)")
        );
        assert!(prompt.contains("- slack.post_message: "));
        assert!(prompt.contains("- provider=slack, event=slack.message: "));
        assert!(
            prompt.contains(
                "- entityType=company: eventType ∈ [created, updated, deleted, archived]"
            )
        );
    }

    #[tokio::test]
    async fn a_prompt_becomes_a_validated_draft_from_the_quality_copilot_model() {
        let fake = FakeProvider::new().reply_json(&json!({
            "name": " Welcome leads ",
            "description": "Email new leads",
            "triggers": [{ "type": "entity_event", "name": "Lead created", "config": { "entityType": "person", "eventType": "created" } }],
            "steps": [
                { "type": "send_email", "name": "Welcome", "config": { "to": "{{trigger.email}}" } },
                { "type": "teleport", "name": "Beam up" },
            ],
        }));
        let ai = ai(&fake);
        let generated = generate_draft(Some(&ai), &call(), "email new leads")
            .await
            .unwrap();
        assert_eq!(generated.workflow["name"], "Welcome leads");
        assert_eq!(generated.workflow["steps"].as_array().unwrap().len(), 2);
        assert_eq!(
            generated.warnings,
            vec![
                "Step \"Beam up\" uses an unknown action type \"teleport\" — review before publishing."
            ]
        );
        let meta = generated.served.meta();
        assert_eq!(meta["provider"], "mistral");
        assert_eq!(meta["region"], "eu");

        let calls = fake.calls();
        assert_eq!(calls.len(), 1);
        let body = &calls[0].body;
        assert!(calls[0].url.ends_with("/chat/completions"));
        assert!(
            body["model"].as_str().unwrap().starts_with("mistral-large"),
            "copilot at the quality tier: {}",
            body["model"]
        );
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(
            body["response_format"]["json_schema"]["schema"],
            draft_schema()
        );
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], system_prompt());
        assert_eq!(
            messages[1]["content"],
            "Build a workflow for: email new leads"
        );
    }

    #[tokio::test]
    async fn without_a_provider_it_answers_ai_not_configured() {
        let error = generate_draft(None, &call(), "anything").await.unwrap_err();
        let response = error.respond();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            body,
            json!({ "error": { "code": "AI_NOT_CONFIGURED", "message": NOT_CONFIGURED } })
        );
    }

    #[tokio::test]
    async fn a_failing_model_answers_ai_request_failed() {
        let fake = FakeProvider::new()
            .reply_status(400, r#"{"message":"bad schema"}"#)
            .reply_status(400, r#"{"message":"bad schema"}"#);
        let ai = ai(&fake);
        let error = generate_draft(Some(&ai), &call(), "anything")
            .await
            .unwrap_err();
        let response = error.respond();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], "AI_REQUEST_FAILED");
        assert_eq!(body["error"]["message"], "bad schema");
    }

    #[test]
    fn a_wallet_refusal_is_the_standard_402() {
        let response = GenerateError::from_ai(AiError::InsufficientCredits {
            balance: 0,
            required: 1,
        })
        .respond();
        assert_eq!(response.status(), StatusCode::PAYMENT_REQUIRED);
    }
}
