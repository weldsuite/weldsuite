//! Workspace AI agents, `/api/weldagent/agents/*`
//! (`apps/workers/agent-api/src/routes/weldagent/agents.ts`).
//!
//! Agents are teammates with an owner: workspace permissions open the door
//! (`weldagent:read` / `use` / `update`), and each agent's owner decides who
//! can see and use it and is the one who changes it. `weldagent:manage` sees
//! and changes every agent ([`crate::access`]).

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde::Deserialize;
use serde_json::{Value, json};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent};
use weldsuite_permissions::has_permission;

use crate::access::{
    AGENT_VISIBILITIES, AgentAccess, AgentViewer, can_access_agent, can_edit_agent,
    list_agent_member_ids, set_agent_members,
};
use crate::agents::{
    CreateAgent, GLOBAL_MODELS, UpdateAgent, check_subagents, create_agent, delete_agent,
    get_agent, get_subagents, list_agent_runs, list_agents, update_agent,
};
use crate::grants::{grantable_agent_permissions, granter_holds};
use crate::run::{RunParams, TriggerType, run_agent};
use crate::subscriptions::{extract_event_subscriptions, has_explicit_triggers};
use crate::tools::{EventSink, list_tool_catalog, list_tool_permissions, resolve_agent_tools};
use crate::{AgentState, Caller, failed, validate};

const CONTEXT: &str = "weldagent/agents";

fn not_found() -> Response {
    ApiError::not_found("Agent not found", None).into_response()
}

fn strings(agent: &Value, key: &str) -> Vec<String> {
    agent[key]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// `withCapabilities(agent, viewer)`.
fn with_capabilities(agent: &Value, viewer: &AgentViewer) -> Value {
    let mut out = agent.clone();
    if let Some(map) = out.as_object_mut() {
        map.insert(
            "capabilities".into(),
            json!({ "canEdit": can_edit_agent(agent["ownerId"].as_str(), viewer) }),
        );
    }
    out
}

/// Whether the viewer may see this agent (`canAccessAgent(db, agent, viewer)`).
async fn accessible(
    caller: &Caller,
    agent: &Value,
    viewer: &AgentViewer,
) -> Result<bool, sqlx::Error> {
    can_access_agent(
        &caller.db,
        &AgentAccess {
            id: agent["id"].as_str().unwrap_or_default(),
            owner_id: agent["ownerId"].as_str(),
            visibility: agent["visibility"].as_str().unwrap_or("workspace"),
        },
        viewer,
    )
    .await
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Access,
    Edit,
}

/// The agent when the caller may see it ([`Mode::Access`]) or change it
/// ([`Mode::Edit`]); otherwise the response to return. An agent the caller
/// can't see is a 404, like any record outside your reach (`resolveAgent`).
async fn resolve_agent(
    caller: &Caller,
    id: &str,
    mode: Mode,
) -> Result<(Value, AgentViewer), Response> {
    let agent = get_agent(&caller.db, id)
        .await
        .map_err(|e| failed(&e, CONTEXT, "Failed to load the agent"))?
        .ok_or_else(not_found)?;
    let viewer = caller.viewer();
    if !accessible(caller, &agent, &viewer)
        .await
        .map_err(|e| failed(&e, CONTEXT, "Failed to load the agent"))?
    {
        return Err(not_found());
    }
    if mode == Mode::Edit && !can_edit_agent(agent["ownerId"].as_str(), &viewer) {
        return Err(ApiError::forbidden()
            .with_message("Only the agent's owner can change it")
            .into_response());
    }
    Ok((agent, viewer))
}

/// Permissions in `requested` that the caller does not hold
/// (`ungrantablePermissions`). Granting an agent more than you have would
/// let you act beyond your role through the agent. Grants the agent already
/// has are left alone so a teammate can still edit it.
fn ungrantable(caller: &Caller, requested: Option<&[String]>, existing: &[String]) -> Vec<String> {
    let Some(requested) = requested else {
        return Vec::new();
    };
    requested
        .iter()
        .filter(|perm| {
            !existing.contains(perm) && !granter_holds(caller.permissions.resolved(), perm)
        })
        .cloned()
        .collect()
}

fn cannot_grant(denied: &[String]) -> Response {
    ApiError::forbidden()
        .with_message(format!(
            "You can't grant permissions you don't have: {}",
            denied.join(", ")
        ))
        .into_response()
}

// ── GET / ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    status: Option<String>,
}

/// `GET /agents`: the workspace agents the caller can see.
pub(crate) async fn list(caller: Caller, Query(query): Query<ListQuery>) -> Response {
    let viewer = caller.viewer();
    let status = query.status.as_deref().filter(|s| !s.is_empty());
    match list_agents(&caller.db, status, &viewer).await {
        Ok(agents) => Data(
            agents
                .iter()
                .map(|a| with_capabilities(a, &viewer))
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(error) => failed(&error, CONTEXT, "Failed to list agents"),
    }
}

/// `GET /agents/tools`: the tool catalog for the builder UI.
pub(crate) async fn tools() -> Response {
    Data(list_tool_catalog()).into_response()
}

/// `GET /agents/grantable-permissions`: platform permissions assignable to an agent.
pub(crate) async fn grantable_permissions(State(state): State<AgentState>) -> Response {
    Data(grantable_agent_permissions(state.sandbox)).into_response()
}

// ── POST / ──────────────────────────────────────────────────────────────────

/// A list of strings (`z.array(z.string())`).
fn string_list(
    issues: &mut Issues,
    fields: &serde_json::Map<String, Value>,
    key: &str,
) -> Option<Vec<String>> {
    issues
        .list(
            fields,
            key,
            Presence::Optional,
            None,
            None,
            |issues, item| issues.item_text(item, Text::default()),
        )
        .into_option()
}

/// `createWorkspaceAgentSchema`, or its `.partial()` plus `status`.
struct AgentInput {
    name: Option<String>,
    description: Field<String>,
    icon: Field<String>,
    system_prompt: Option<String>,
    model_id: Option<String>,
    temperature: Option<String>,
    max_tokens: Option<i64>,
    permissions: Option<Vec<String>>,
    enabled_tools: Option<Vec<String>>,
    event_subscriptions: Option<Vec<String>>,
    max_iterations: Option<i64>,
    max_total_tokens: Option<i64>,
    status: Option<String>,
}

fn agent_input(
    headers: &HeaderMap,
    body: &Bytes,
    state: &AgentState,
    partial: bool,
) -> Result<AgentInput, Response> {
    validate(headers, body, |issues, fields| {
        let required = if partial {
            Presence::Optional
        } else {
            Presence::Required
        };
        let int = |issues: &mut Issues, key: &str, min: f64, max: f64| {
            issues
                .whole_number(
                    fields,
                    key,
                    Presence::Optional,
                    Number {
                        min: Some(min),
                        max: Some(max),
                        ..Number::default()
                    },
                )
                .into_option()
        };
        // Global: the Claude ids (`z.enum(WORKSPACE_AGENT_MODELS)`). The
        // Kubernetes editions take any model id the policy knows, which the
        // loop checks per call, plus the `default` sentinel.
        let model_id = if state.sandbox {
            issues
                .choice(fields, "modelId", Presence::Optional, &GLOBAL_MODELS)
                .into_option()
        } else {
            issues
                .text(fields, "modelId", Presence::Optional, Some(1), Some(100))
                .into_option()
        };
        AgentInput {
            name: issues
                .text(fields, "name", required, Some(1), Some(255))
                .into_option(),
            description: issues.text(fields, "description", Presence::Nullish, None, Some(2000)),
            icon: issues.text(fields, "icon", Presence::Nullish, None, Some(50)),
            system_prompt: issues
                .text(
                    fields,
                    "systemPrompt",
                    Presence::Optional,
                    None,
                    Some(20000),
                )
                .into_option(),
            model_id,
            temperature: issues
                .text(fields, "temperature", Presence::Optional, None, Some(10))
                .into_option(),
            max_tokens: int(issues, "maxTokens", 1.0, 8192.0),
            permissions: string_list(issues, fields, "permissions"),
            enabled_tools: string_list(issues, fields, "enabledTools"),
            event_subscriptions: string_list(issues, fields, "eventSubscriptions"),
            max_iterations: int(issues, "maxIterations", 1.0, 50.0),
            max_total_tokens: int(issues, "maxTotalTokens", 1000.0, 200_000.0),
            status: if partial {
                issues
                    .choice(
                        fields,
                        "status",
                        Presence::Optional,
                        &["draft", "active", "paused"],
                    )
                    .into_option()
            } else {
                None
            },
        }
    })
}

/// `POST /agents`: create a draft agent, owned by the caller.
pub(crate) async fn create(
    State(state): State<AgentState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match agent_input(&headers, &body, &state, false) {
        Ok(data) => data,
        Err(response) => return response,
    };
    let denied = ungrantable(&caller, data.permissions.as_deref(), &[]);
    if !denied.is_empty() {
        return cannot_grant(&denied);
    }
    // Sandbox + web grants on by default, only when the creator holds them.
    // (Not on the Kubernetes editions, where there is no sandbox.)
    let held = &caller.permissions.resolved().permissions;
    let permissions = data.permissions.unwrap_or_else(|| {
        if state.sandbox {
            ["computer:use", "browser:use"]
                .into_iter()
                .filter(|p| has_permission(held, p))
                .map(str::to_owned)
                .collect()
        } else {
            Vec::new()
        }
    });
    let input = CreateAgent {
        name: data.name.unwrap_or_default(),
        description: data.description.into_option(),
        icon: data.icon.into_option(),
        system_prompt: data.system_prompt,
        model_id: data.model_id,
        temperature: data.temperature,
        max_tokens: data.max_tokens,
        permissions,
        enabled_tools: data.enabled_tools,
        event_subscriptions: data.event_subscriptions,
        max_iterations: data.max_iterations,
        max_total_tokens: data.max_total_tokens,
        created_by: Some(caller.user_id.clone()),
        default_model: state.default_model.clone(),
    };
    match create_agent(&caller.db, input).await {
        Ok(agent) => Created(with_capabilities(&agent, &caller.viewer())).into_response(),
        Err(error) => failed(&error, CONTEXT, "Failed to create agent"),
    }
}

// ── GET /:id ────────────────────────────────────────────────────────────────

/// `GET /agents/:id`: the agent plus what the Access tab needs.
pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let (agent, viewer) = match resolve_agent(&caller, &id, Mode::Access).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let available: Vec<Value> = resolve_agent_tools(&strings(&agent, "permissions"), &strings(&agent, "enabledTools"), true)
        .into_iter()
        .map(|t| {
            json!({ "id": t.id, "name": t.name, "description": t.description, "requiredPermissions": t.required_permissions })
        })
        .collect();
    let member_ids = match list_agent_member_ids(&caller.db, &id).await {
        Ok(ids) => ids,
        Err(error) => return failed(&error, CONTEXT, "Failed to load the agent"),
    };
    let mut out = with_capabilities(&agent, &viewer);
    if let Some(map) = out.as_object_mut() {
        map.insert("memberIds".into(), json!(member_ids));
        map.insert("availableTools".into(), json!(available));
        // Permission keys some platform tool needs: a grant outside this list
        // gives the agent no data tool.
        map.insert("toolPermissions".into(), json!(list_tool_permissions()));
    }
    Data(out).into_response()
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

/// `PATCH /agents/:id`.
pub(crate) async fn update(
    State(state): State<AgentState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match agent_input(&headers, &body, &state, true) {
        Ok(data) => data,
        Err(response) => return response,
    };
    let (existing, viewer) = match resolve_agent(&caller, &id, Mode::Edit).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let denied = ungrantable(
        &caller,
        data.permissions.as_deref(),
        &strings(&existing, "permissions"),
    );
    if !denied.is_empty() {
        return cannot_grant(&denied);
    }
    let patch = UpdateAgent {
        name: data.name,
        description: data.description,
        icon: data.icon,
        system_prompt: data.system_prompt,
        model_id: data.model_id,
        temperature: data.temperature,
        max_tokens: data.max_tokens,
        permissions: data.permissions,
        enabled_tools: data.enabled_tools,
        event_subscriptions: data.event_subscriptions,
        max_iterations: data.max_iterations,
        max_total_tokens: data.max_total_tokens,
        status: data.status,
        ..UpdateAgent::default()
    };
    match update_agent(&caller.db, &id, patch).await {
        Ok(Some(agent)) => Data(with_capabilities(&agent, &viewer)).into_response(),
        Ok(None) => not_found(),
        Err(error) => failed(&error, CONTEXT, "Failed to update agent"),
    }
}

// ── PUT /:id/access ─────────────────────────────────────────────────────────

/// `PUT /agents/:id/access`: owner, visibility and members.
pub(crate) async fn set_access(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    struct Input {
        owner_id: Option<String>,
        visibility: Option<String>,
        member_ids: Option<Vec<String>>,
    }
    let data = match validate(&headers, &body, |issues, fields| Input {
        owner_id: issues
            .text(fields, "ownerId", Presence::Optional, Some(1), Some(255))
            .into_option(),
        visibility: issues
            .choice(
                fields,
                "visibility",
                Presence::Optional,
                &AGENT_VISIBILITIES,
            )
            .into_option(),
        member_ids: issues
            .list(
                fields,
                "memberIds",
                Presence::Optional,
                None,
                Some(500),
                |issues, item| issues.item_text(item, Text::length(Some(1), Some(255))),
            )
            .into_option(),
    }) {
        Ok(data) => data,
        Err(response) => return response,
    };
    let (_, viewer) = match resolve_agent(&caller, &id, Mode::Edit).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let result = async {
        if let Some(members) = &data.member_ids {
            set_agent_members(&caller.db, &id, members, &caller.user_id).await?;
        }
        let agent = update_agent(
            &caller.db,
            &id,
            UpdateAgent {
                owner_id: data.owner_id,
                visibility: data.visibility,
                ..UpdateAgent::default()
            },
        )
        .await?;
        let Some(agent) = agent else {
            return Ok(None);
        };
        let member_ids = list_agent_member_ids(&caller.db, &id).await?;
        Ok::<_, sqlx::Error>(Some((agent, member_ids)))
    }
    .await;
    match result {
        Ok(Some((agent, member_ids))) => {
            let mut out = with_capabilities(&agent, &viewer);
            if let Some(map) = out.as_object_mut() {
                map.insert("memberIds".into(), json!(member_ids));
            }
            Data(out).into_response()
        }
        Ok(None) => not_found(),
        Err(error) => failed(&error, CONTEXT, "Failed to update agent access"),
    }
}

// ── PUT /:id/subagents ──────────────────────────────────────────────────────

/// `PUT /agents/:id/subagents`: the agents this agent may hand work to.
pub(crate) async fn set_subagents(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    struct Input {
        subagent_ids: Vec<String>,
        delegate_to_self: bool,
    }
    let data = match validate(&headers, &body, |issues, fields| Input {
        subagent_ids: issues
            .list(
                fields,
                "subagentIds",
                Presence::Required,
                None,
                Some(19),
                |issues, item| issues.item_text(item, Text::length(Some(1), Some(30))),
            )
            .into_option()
            .unwrap_or_default(),
        delegate_to_self: issues
            .boolean(fields, "delegateToSelf", Presence::Required)
            .into_option()
            .unwrap_or(false),
    }) {
        Ok(data) => data,
        Err(response) => return response,
    };
    let (agent, viewer) = match resolve_agent(&caller, &id, Mode::Edit).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let mut requested: Vec<String> = Vec::new();
    for sub in data.subagent_ids {
        if !requested.contains(&sub) {
            requested.push(sub);
        }
    }
    let stored = strings(&agent, "subagentIds");
    let bad =
        |sub: &str| ApiError::bad_request(format!("Sub-agent not found: {sub}")).into_response();
    // You can only add teammates you can reach yourself. Ids already stored
    // (e.g. added by a manager) are not re-checked, so a save that only flips
    // "copies of itself" never fails on them.
    for sub_id in requested.iter().filter(|s| !stored.contains(s)) {
        let sub = match get_agent(&caller.db, sub_id).await {
            Ok(sub) => sub,
            Err(error) => return failed(&error, CONTEXT, "Failed to update sub-agents"),
        };
        let Some(sub) = sub else { return bad(sub_id) };
        match accessible(&caller, &sub, &viewer).await {
            Ok(true) => {}
            Ok(false) => return bad(sub_id),
            Err(error) => return failed(&error, CONTEXT, "Failed to update sub-agents"),
        }
    }
    let result = async {
        // Agents deleted since they were picked drop out of the list.
        let live: Vec<String> = get_subagents(&caller.db, &requested)
            .await?
            .iter()
            .filter_map(|s| s["id"].as_str().map(str::to_owned))
            .collect();
        let subagent_ids: Vec<String> = requested
            .iter()
            .filter(|s| live.contains(s))
            .cloned()
            .collect();
        let name = agent["name"].as_str().unwrap_or_default();
        if let Some(problem) = check_subagents(&caller.db, &id, name, &subagent_ids).await? {
            return Ok::<_, sqlx::Error>(Err(problem));
        }
        let updated = update_agent(
            &caller.db,
            &id,
            UpdateAgent {
                subagent_ids: Some(subagent_ids),
                delegate_to_self: Some(data.delegate_to_self),
                ..UpdateAgent::default()
            },
        )
        .await?;
        Ok(Ok(updated))
    }
    .await;
    match result {
        Ok(Ok(Some(agent))) => Data(with_capabilities(&agent, &viewer)).into_response(),
        Ok(Ok(None)) => not_found(),
        Ok(Err(problem)) => ApiError::bad_request(problem.message()).into_response(),
        Err(error) => failed(&error, CONTEXT, "Failed to update sub-agents"),
    }
}

// ── POST /:id/chat ──────────────────────────────────────────────────────────

/// `POST /agents/:id/chat`: the caller's one continuous chat with the agent.
pub(crate) async fn open_chat(caller: Caller, Path(id): Path<String>) -> Response {
    let (agent, _) = match resolve_agent(&caller, &id, Mode::Access).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let name = agent["name"].as_str().unwrap_or_default();
    match crate::conversations::get_or_create_main(&caller.db, &caller.user_id, &id, name).await {
        Ok(conversation) => Data(crate::conversations::summary(&conversation)).into_response(),
        Err(error) => failed(&error, CONTEXT, "Failed to open the chat"),
    }
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

/// `DELETE /agents/:id`.
pub(crate) async fn remove(caller: Caller, Path(id): Path<String>) -> Response {
    let (agent, _) = match resolve_agent(&caller, &id, Mode::Edit).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let agent_id = agent["id"].as_str().unwrap_or_default();
    match delete_agent(&caller.db, agent_id).await {
        Ok(true) => NoContent.into_response(),
        Ok(false) => not_found(),
        Err(error) => failed(&error, CONTEXT, "Failed to delete agent"),
    }
}

// ── POST /:id/activate, /:id/pause ──────────────────────────────────────────

/// `POST /agents/:id/activate`: set active and settle its event
/// subscriptions: the explicit triggers saved in setup when there are any,
/// else a reading of the instructions.
pub(crate) async fn activate(caller: Caller, Path(id): Path<String>) -> Response {
    let (agent, viewer) = match resolve_agent(&caller, &id, Mode::Edit).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let agent_id = agent["id"].as_str().unwrap_or_default();
    let subscriptions = if has_explicit_triggers(&strings(&agent, "enabledTools")) {
        strings(&agent, "eventSubscriptions")
    } else {
        extract_event_subscriptions(agent["systemPrompt"].as_str().unwrap_or_default())
    };
    let patch = UpdateAgent {
        status: Some("active".to_owned()),
        event_subscriptions: Some(subscriptions),
        ..UpdateAgent::default()
    };
    match update_agent(&caller.db, agent_id, patch).await {
        Ok(Some(updated)) => Data(with_capabilities(&updated, &viewer)).into_response(),
        // `success(c, agent ? … : agent)`: a vanished agent answers `{ data: null }`.
        Ok(None) => Data(Value::Null).into_response(),
        Err(error) => failed(&error, CONTEXT, "Failed to activate agent"),
    }
}

/// `POST /agents/:id/pause`.
pub(crate) async fn pause(caller: Caller, Path(id): Path<String>) -> Response {
    let (agent, viewer) = match resolve_agent(&caller, &id, Mode::Edit).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let agent_id = agent["id"].as_str().unwrap_or_default();
    let patch = UpdateAgent {
        status: Some("paused".to_owned()),
        ..UpdateAgent::default()
    };
    match update_agent(&caller.db, agent_id, patch).await {
        Ok(Some(updated)) => Data(with_capabilities(&updated, &viewer)).into_response(),
        Ok(None) => not_found(),
        Err(error) => failed(&error, CONTEXT, "Failed to pause agent"),
    }
}

// ── GET /:id/runs, POST /:id/run ────────────────────────────────────────────

#[derive(Deserialize)]
pub(crate) struct RunsQuery {
    limit: Option<String>,
}

/// `Number.parseInt(text || '50', 10)`, at most 100.
fn page_limit(text: Option<&str>, default: i64, max: i64) -> i64 {
    let text = text.filter(|t| !t.is_empty());
    let parsed = text.map_or(Some(default), |t| {
        let digits: String = t
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '-')
            .collect();
        digits.parse::<i64>().ok()
    });
    parsed.unwrap_or(default).min(max)
}

/// `GET /agents/:id/runs`.
pub(crate) async fn runs(
    caller: Caller,
    Path(id): Path<String>,
    Query(query): Query<RunsQuery>,
) -> Response {
    let (agent, _) = match resolve_agent(&caller, &id, Mode::Access).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let limit = page_limit(query.limit.as_deref(), 50, 100);
    match list_agent_runs(&caller.db, agent["id"].as_str().unwrap_or_default(), limit).await {
        Ok(runs) => Data(runs).into_response(),
        Err(error) => failed(&error, CONTEXT, "Failed to list runs"),
    }
}

/// `POST /agents/:id/run`: a manual run, through the loop's seam
/// ([`crate::run::run_agent`]).
pub(crate) async fn run(
    State(state): State<AgentState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    struct Input {
        message: Option<String>,
        trigger_data: Option<Value>,
    }
    let body_input = match validate(&headers, &body, |issues, fields| Input {
        message: issues
            .text(fields, "message", Presence::Optional, Some(1), Some(20000))
            .into_option(),
        trigger_data: match fields.get("triggerData") {
            None | Some(Value::Null) => None,
            Some(Value::Object(map)) => Some(Value::Object(map.clone())),
            Some(_) => {
                issues.custom("triggerData", "Expected object");
                None
            }
        },
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let (agent, _) = match resolve_agent(&caller, &id, Mode::Access).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let params = RunParams {
        db: caller.db.clone(),
        workspace_id: caller.workspace_id.clone(),
        actor_user_id: caller.user_id.clone(),
        agent_id: agent["id"].as_str().unwrap_or_default().to_owned(),
        trigger_type: TriggerType::Manual,
        trigger_data: body_input.trigger_data,
        user_message: body_input.message.unwrap_or_else(|| {
            "Run now according to your instructions. Use tools if needed and summarise what you did.".to_owned()
        }),
        extra_system: None,
        run_id: None,
        skip_approvals: false,
        notify: true,
        actor_permissions: Some(caller.permissions.resolved().permissions.clone()),
        events: Some(EventSink {
            publisher: state.events.clone(),
            context: caller.events.clone(),
        }),
    };
    match run_agent(state.ai.as_ref(), params).await {
        Ok(outcome) => Data(outcome.to_json()).into_response(),
        Err(error) => error.into_response_for("run failed"),
    }
}
