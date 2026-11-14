//! WeldAgent platform tools (`packages/domains/agent/src/tools.ts` and its
//! `*-tools.ts` siblings): the registry, who may use which tool, and the
//! executor.
//!
//! Each tool wraps tenant database calls in this process. A tool declares
//! `required_permissions`; the executor only offers (and only runs) tools
//! whose requirements the agent's grants cover, narrowed to the person who
//! drives the turn ([`effective_agent_permissions`], `tools.ts`
//! `effectiveAgentPermissions`). An agent never lets a person act beyond their
//! own role.
//!
//! What the EU registry has and has not ported is listed in [`PORTED`] and
//! [`LEFT_OUT`]. A tool whose module is not in Rust is not in the catalog, so
//! the builder never offers a tool that can't work. The sandbox and web tools
//! (`sandbox_tools`, `weldsuite-sandbox`) are registered behind their grants
//! (`computer:use`, `browser:use`), which are grantable only when the install
//! has a sandbox (`agent-sandbox`); they run through [`execute_tool_with`].

mod agent_tools;
mod chat_tools;
mod data_tools;
mod sandbox_tools;
mod ticket_tools;
pub mod schema;

pub use sandbox_tools::{
    SandboxAccess, is_sandbox_tool, model_can_use_computer, tool_result_messages,
};
pub use weldsuite_sandbox::ToolOutput;

use std::sync::LazyLock;

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_ai::ToolDef;
use weldsuite_events::{EntityEventPublisher, EventContext};
use weldsuite_permissions::{PermissionSubject, has_app_permission, has_permission};

/// Tools that change the agent itself (`AGENT_EDIT_TOOL_IDS`). Their routes
/// are owner-only, so a teammate chatting with the agent gets none of these.
pub const AGENT_EDIT_TOOL_IDS: [&str; 5] = [
    "agent.save_setup",
    "agent.save_skill",
    "agent.remember",
    "agent.create_routine",
    "agent.update_routine",
];

/// Tools every agent has, whatever its grants (`alwaysOn` in
/// `resolveAgentTools`).
const ALWAYS_ON: [&str; 7] = [
    "agent.ask_user",
    "agent.save_setup",
    "agent.save_skill",
    "agent.remember",
    "agent.create_routine",
    "agent.list_routines",
    "agent.update_routine",
];

/// What a tool answers a person who may not change the agent.
pub(crate) fn not_editor() -> Value {
    json!({ "error": "Only this agent's owner can change it." })
}

/// Tool ids ported to Rust.
pub const PORTED: [&str; 16] = [
    "agent.save_setup",
    "agent.ask_user",
    "agent.list_routines",
    "agent.update_routine",
    "agent.save_skill",
    "agent.remember",
    "agent.create_routine",
    "people.list",
    "people.get",
    "people.create",
    "tasks.list",
    "tasks.create",
    "projects.list",
    "projects.get",
    "chat.message_agent",
    "chat.create_agent_group",
];

/// Tool ids not in the EU registry yet, and why. The sandbox, web and browser
/// tools are not listed: the in-cluster sandbox crate registers them.
pub const LEFT_OUT: [(&str, &str); 3] = [
    (
        "tickets.list",
        "needs the WeldDesk inbox filters, not yet exposed by desk-domain",
    ),
    (
        "tickets.create",
        "needs desk-domain's inbox deps (routing, events) built outside a request",
    ),
    (
        "sheets.*, boards.*, merge.*",
        "the module crates expose routes, not a library surface",
    ),
];

/// One platform tool: its definition. Execution is [`execute_tool`].
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub id: &'static str,
    /// The model-facing name.
    pub name: &'static str,
    pub description: &'static str,
    pub required_permissions: &'static [&'static str],
    /// JSON Schema of the arguments.
    pub parameters: Value,
}

/// `PLATFORM_TOOLS`: every tool this edition can run, in catalog order.
pub fn platform_tools() -> &'static [ToolSpec] {
    static TOOLS: LazyLock<Vec<ToolSpec>> = LazyLock::new(|| {
        let mut tools = agent_tools::specs();
        tools.extend(data_tools::specs());
        tools.extend(ticket_tools::specs());
        tools.extend(chat_tools::specs());
        tools.extend(sandbox_tools::specs());
        tools
    });
    &TOOLS
}

/// `listToolCatalog()`: the catalog the builder shows.
pub fn list_tool_catalog() -> Value {
    Value::Array(
        platform_tools()
            .iter()
            .map(|tool| {
                json!({
                    "id": tool.id,
                    "name": tool.name,
                    "description": tool.description,
                    "requiredPermissions": tool.required_permissions,
                })
            })
            .collect(),
    )
}

/// `listToolPermissions()`: every permission key some platform tool needs. A
/// grant that is not in this list gives the agent no platform tool.
pub fn list_tool_permissions() -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for key in platform_tools().iter().flat_map(|t| t.required_permissions) {
        if !key.is_empty() && !keys.iter().any(|k| k == key) {
            keys.push((*key).to_owned());
        }
    }
    keys
}

/// `explicitToolAllowList(enabledTools)`: `enabledTools` also carries
/// non-tool flags (`agent.auto_review`). Only real tool ids count toward the
/// allow-list, otherwise turning on a flag would strip every tool.
pub fn explicit_tool_allow_list(enabled_tools: &[String]) -> Vec<&str> {
    let known = platform_tools();
    enabled_tools
        .iter()
        .map(String::as_str)
        .filter(|id| known.iter().any(|tool| tool.id == *id))
        .collect()
}

/// Plain grants, without denies.
struct Plain<'a>(&'a [String]);

impl PermissionSubject for Plain<'_> {
    fn permissions(&self) -> &[String] {
        self.0
    }
    fn denies(&self) -> &[String] {
        &[]
    }
}

/// `agentHasGrants(agentPermissions, required)`: an agent works across apps,
/// so an app-scoped grant counts when ANY app gives it (`weldcrm:people:read`
/// satisfies `people:read`).
pub fn agent_has_grants(agent_permissions: &[String], required: &[&str]) -> bool {
    let subject = Plain(agent_permissions);
    required.iter().all(|req| {
        has_permission(agent_permissions, req) || has_app_permission(&subject, req, None)
    })
}

/// `effectiveAgentPermissions(agentPermissions, actorPermissions)`: narrow an
/// agent's grants to what the human driving the turn may do. Unattended runs
/// (`None`) use the agent's grants as they are.
pub fn effective_agent_permissions(
    agent_permissions: &[String],
    actor_permissions: Option<&[String]>,
) -> Vec<String> {
    let Some(actor) = actor_permissions else {
        return agent_permissions.to_vec();
    };
    // Each side matched plainly or in any app; keep the narrower side of each
    // overlap so wildcards intersect (agent `people:*` and user `people:read`
    // give `people:read`).
    let holds = |grants: &[String], key: &str| {
        has_permission(grants, key) || has_app_permission(&Plain(grants), key, None)
    };
    let mut out: Vec<String> = Vec::new();
    for perm in agent_permissions.iter().filter(|p| holds(actor, p)) {
        if !out.contains(perm) {
            out.push(perm.clone());
        }
    }
    for perm in actor.iter().filter(|p| holds(agent_permissions, p)) {
        if !out.contains(perm) {
            out.push(perm.clone());
        }
    }
    out
}

/// `resolveAgentTools(agentPermissions, enabledTools, canEdit)`: the registry
/// filtered to what the agent may use. `agent.save_setup` is always available
/// so unfinished agents can finish onboarding, and `agent.ask_user` so any
/// agent can put a question to the user.
pub fn resolve_agent_tools(
    agent_permissions: &[String],
    enabled_tools: &[String],
    can_edit: bool,
) -> Vec<&'static ToolSpec> {
    let allow = explicit_tool_allow_list(enabled_tools);
    platform_tools()
        .iter()
        .filter(|tool| {
            if !can_edit && AGENT_EDIT_TOOL_IDS.contains(&tool.id) {
                return false;
            }
            // The desktop depends on the turn's model: `offered_tools` adds it.
            if sandbox_tools::is_computer_use(tool.id) {
                return false;
            }
            if ALWAYS_ON.contains(&tool.id) {
                return true;
            }
            if !allow.is_empty() && !allow.contains(&tool.id) {
                return false;
            }
            agent_has_grants(agent_permissions, tool.required_permissions)
        })
        .collect()
}

/// `toolsForAgentTurn`: the platform tools the agent may run this turn.
/// During onboarding only `ask_user`, plus `save_agent_setup` once the user
/// has answered at least one follow-up, so the interview cannot invent
/// workspace mutations.
pub fn tools_for_agent_turn(
    permissions: &[String],
    enabled_tools: &[String],
    system_prompt: &str,
    user_message_count: usize,
    actor_permissions: Option<&[String]>,
    can_edit: bool,
) -> Vec<&'static ToolSpec> {
    if system_prompt.trim().is_empty() {
        let setup: Vec<&ToolSpec> = resolve_agent_tools(&[], &[], can_edit)
            .into_iter()
            .filter(|t| t.id == "agent.ask_user" || t.id == "agent.save_setup")
            .collect();
        return if user_message_count < 2 {
            setup
                .into_iter()
                .filter(|t| t.id == "agent.ask_user")
                .collect()
        } else {
            setup
        };
    }
    resolve_agent_tools(
        &effective_agent_permissions(permissions, actor_permissions),
        enabled_tools,
        can_edit,
    )
}

/// The tools as the model sees them (`weldsuite_ai::ToolDef`).
pub fn tool_defs(tools: &[&ToolSpec]) -> Vec<ToolDef> {
    tools
        .iter()
        .map(|tool| ToolDef {
            name: tool.name.to_owned(),
            description: tool.description.to_owned(),
            parameters: tool.parameters.clone(),
        })
        .collect()
}

/// Where a tool's entity events go.
#[derive(Debug, Clone)]
pub struct EventSink {
    pub publisher: EntityEventPublisher,
    pub context: EventContext,
}

/// The row-level boundary of the person the tools act for (`ToolRowScope`).
/// Set where tools run on a person's own behalf (the default WeldAgent), so a
/// read tool never shows what that person could not open themselves.
#[derive(Debug, Clone)]
pub struct ToolRowScope {
    pub user_id: String,
    /// Holds `people:scope:all`; otherwise only the people they own are visible.
    pub all_people: bool,
    /// Holds `projects:scope:all`; otherwise only projects they manage or
    /// belong to are visible.
    pub all_projects: bool,
}

/// `ToolContext`.
#[derive(Clone)]
pub struct ToolContext {
    pub db: PgPool,
    /// Agent principal id (audit and ownership attribution).
    pub agent_id: String,
    /// The human who triggered the run (chat user or event actor).
    pub actor_user_id: String,
    pub workspace_id: String,
    /// The agent's grants and `enabledTools`: what the executor checks a call
    /// against.
    pub agent_permissions: Vec<String>,
    pub enabled_tools: Vec<String>,
    /// The chatting user's IANA timezone; routines and due dates default to it.
    pub user_timezone: Option<String>,
    /// The chatting user's permissions: setup may grant the agent only what
    /// they hold. `None` for unattended runs.
    pub actor_permissions: Option<Vec<String>>,
    /// `false` when the person driving this turn may not change the agent: the
    /// setup, routine, skill and memory tools refuse. `None` for unattended
    /// runs, which keep maintaining their own agent.
    pub actor_can_edit: Option<bool>,
    pub row_scope: Option<ToolRowScope>,
    pub events: Option<EventSink>,
    /// The sandbox and web grants exist (false on the Kubernetes editions).
    pub sandbox: bool,
    /// When running inside a WeldChat room reply.
    pub channel_id: Option<String>,
    /// When running inside a WeldAgent conversation.
    pub conversation_id: Option<String>,
    /// The room hop this reply is at, and the room's limit.
    pub agent_hop: u32,
    pub max_agent_hops: u32,
    /// The master database and the realtime publisher, for tools that post.
    pub master: Option<PgPool>,
    pub realtime: Option<std::sync::Arc<dyn weldsuite_ports::DynRealtimePublisher>>,
    /// The AI, for tools that start other agents (`create_agent_group_chat`).
    pub ai: Option<weldsuite_ai::Ai>,
}

impl std::fmt::Debug for ToolContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolContext")
            .field("agent_id", &self.agent_id)
            .field("workspace_id", &self.workspace_id)
            .finish_non_exhaustive()
    }
}

/// Why a tool did not run. The model gets the message as a tool error.
#[derive(Debug)]
pub enum ToolError {
    /// The model asked for a tool the agent does not have.
    UnknownTool(String),
    /// The arguments do not match the tool's schema.
    InvalidArguments(String),
    /// The tenant database failed.
    Database(sqlx::Error),
    /// The tool could not do what was asked, in words for the model.
    Failed(String),
}

impl ToolError {
    /// What goes back to the model.
    pub fn message(&self) -> String {
        match self {
            Self::UnknownTool(name) => format!("Unknown tool: {name}"),
            Self::InvalidArguments(message) => format!("Invalid arguments: {message}"),
            Self::Database(_) => "The tool failed; try again.".to_owned(),
            Self::Failed(message) => message.clone(),
        }
    }
}

impl From<sqlx::Error> for ToolError {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(%error, "[weldagent/tools] database error");
        Self::Database(error)
    }
}

/// Run a tool the agent may use: looked up by its model-facing name in the
/// registry filtered to the agent's grants (narrowed to the actor), its
/// arguments validated against its schema first. A name the agent does not
/// have is [`ToolError::UnknownTool`], whatever the model was told.
///
/// # Errors
///
/// [`ToolError`]; a tool's own refusals ("not found", "only the owner")
/// are `Ok` values with an `error` field, as in TypeScript.
pub async fn execute_tool(ctx: &ToolContext, name: &str, args: &Value) -> Result<Value, ToolError> {
    let permissions =
        effective_agent_permissions(&ctx.agent_permissions, ctx.actor_permissions.as_deref());
    let can_edit = ctx.actor_can_edit != Some(false);
    let tool = resolve_agent_tools(&permissions, &ctx.enabled_tools, can_edit)
        .into_iter()
        .find(|tool| tool.name == name)
        .ok_or_else(|| ToolError::UnknownTool(name.to_owned()))?;
    let args = schema::validate(&tool.parameters, args).map_err(ToolError::InvalidArguments)?;
    match tool.id {
        id if id.starts_with("agent.") => agent_tools::execute(ctx, id, &args).await,
        id if id.starts_with("chat.") => chat_tools::execute(ctx, id, &args).await,
        id if id.starts_with("tickets.") => ticket_tools::execute(ctx, id, &args).await,
        // Needs the turn's sandbox: `execute_tool_with`.
        id if sandbox_tools::is_sandbox_tool(id) => Err(sandbox_tools::unavailable()),
        id => data_tools::execute(ctx, id, &args).await,
    }
}

/// The tools to offer the model for a turn: [`resolve_agent_tools`] on the
/// agent's grants narrowed to the actor, without the sandbox and web tools
/// when the turn has no sandbox, and with `computer_use` only when the
/// turn's model can use a computer ([`SandboxAccess::computer_use`]).
pub fn offered_tools(ctx: &ToolContext, sandbox: Option<&SandboxAccess>) -> Vec<&'static ToolSpec> {
    let permissions =
        effective_agent_permissions(&ctx.agent_permissions, ctx.actor_permissions.as_deref());
    let can_edit = ctx.actor_can_edit != Some(false);
    let mut tools: Vec<&'static ToolSpec> =
        resolve_agent_tools(&permissions, &ctx.enabled_tools, can_edit)
            .into_iter()
            .filter(|tool| sandbox.is_some() || !sandbox_tools::is_sandbox_tool(tool.id))
            .collect();
    if sandbox.is_some_and(|access| access.computer_use) {
        let allow = explicit_tool_allow_list(&ctx.enabled_tools);
        tools.extend(platform_tools().iter().filter(|tool| {
            sandbox_tools::is_computer_use(tool.id)
                && (allow.is_empty() || allow.contains(&tool.id))
                && agent_has_grants(&permissions, tool.required_permissions)
        }));
    }
    tools
}

/// [`execute_tool`] for a turn that may have a sandbox: the tool must be one
/// [`offered_tools`] offers for it, and the sandbox and web tools run in
/// `sandbox`. Screenshots come back as images ([`ToolOutput::images`]); the
/// loop answers the call with [`tool_result_messages`].
///
/// # Errors
///
/// [`ToolError`], as [`execute_tool`].
pub async fn execute_tool_with(
    ctx: &ToolContext,
    sandbox: Option<&SandboxAccess>,
    name: &str,
    args: &Value,
) -> Result<ToolOutput, ToolError> {
    let tool = offered_tools(ctx, sandbox)
        .into_iter()
        .find(|tool| tool.name == name)
        .ok_or_else(|| ToolError::UnknownTool(name.to_owned()))?;
    if !sandbox_tools::is_sandbox_tool(tool.id) {
        let value = execute_tool(ctx, name, args).await?;
        return Ok(ToolOutput {
            value,
            images: Vec::new(),
        });
    }
    let args = schema::validate(&tool.parameters, args).map_err(ToolError::InvalidArguments)?;
    sandbox_tools::execute(sandbox, tool.id, &args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| (*i).to_owned()).collect()
    }

    #[test]
    fn a_tool_is_offered_only_with_its_grants() {
        let none = resolve_agent_tools(&[], &[], true);
        let names: Vec<&str> = none.iter().map(|t| t.name).collect();
        assert!(names.contains(&"ask_user"));
        assert!(names.contains(&"save_agent_setup"));
        assert!(!names.contains(&"list_people"));

        let with = resolve_agent_tools(&s(&["people:read"]), &[], true);
        let names: Vec<&str> = with.iter().map(|t| t.name).collect();
        assert!(names.contains(&"list_people"));
        assert!(names.contains(&"get_person"));
        assert!(!names.contains(&"create_person"));
    }

    #[test]
    fn an_app_scoped_grant_counts_for_any_app() {
        assert!(agent_has_grants(
            &s(&["weldcrm:people:read"]),
            &["people:read"]
        ));
        assert!(!agent_has_grants(
            &s(&["weldcrm:people:read"]),
            &["people:create"]
        ));
    }

    #[test]
    fn a_person_who_cannot_edit_gets_no_agent_edit_tools() {
        let tools = resolve_agent_tools(&[], &[], false);
        assert!(tools.iter().all(|t| !AGENT_EDIT_TOOL_IDS.contains(&t.id)));
        assert!(tools.iter().any(|t| t.id == "agent.ask_user"));
    }

    #[test]
    fn flags_in_enabled_tools_do_not_strip_the_tools() {
        let tools = resolve_agent_tools(&s(&["people:read"]), &s(&["agent.auto_review"]), true);
        assert!(tools.iter().any(|t| t.id == "people.list"));
        let narrowed = resolve_agent_tools(&s(&["people:read"]), &s(&["people.get"]), true);
        assert!(narrowed.iter().any(|t| t.id == "people.get"));
        assert!(!narrowed.iter().any(|t| t.id == "people.list"));
    }

    #[test]
    fn effective_permissions_keep_the_narrower_side() {
        let out = effective_agent_permissions(&s(&["people:*"]), Some(&s(&["people:read"])));
        assert_eq!(out, ["people:read"]);
        assert_eq!(
            effective_agent_permissions(&s(&["people:*"]), None),
            ["people:*"]
        );
        assert_eq!(
            effective_agent_permissions(&s(&["people:read"]), Some(&s(&["tasks:read"]))),
            Vec::<String>::new()
        );
    }

    #[test]
    fn every_tool_has_an_object_schema_and_a_unique_name() {
        let mut names: Vec<&str> = Vec::new();
        for tool in platform_tools() {
            assert_eq!(tool.parameters["type"], "object", "{}", tool.id);
            assert!(!names.contains(&tool.name), "duplicate {}", tool.name);
            names.push(tool.name);
        }
        for id in PORTED {
            assert!(
                platform_tools().iter().any(|t| t.id == id),
                "{id} is not registered"
            );
        }
    }

    #[tokio::test]
    async fn an_unknown_or_ungranted_tool_never_runs() {
        let ctx = ToolContext {
            db: sqlx::PgPool::connect_lazy("postgres://localhost/none").unwrap(),
            agent_id: "agt_1".into(),
            actor_user_id: "u1".into(),
            workspace_id: "ws_1".into(),
            agent_permissions: Vec::new(),
            enabled_tools: Vec::new(),
            user_timezone: None,
            actor_permissions: None,
            actor_can_edit: None,
            row_scope: None,
            events: None,
            sandbox: false,
            channel_id: None,
            conversation_id: None,
            agent_hop: 0,
            max_agent_hops: 2,
            master: None,
            realtime: None,
            ai: None,
        };
        let refused = execute_tool(&ctx, "list_people", &json!({})).await;
        assert!(matches!(refused, Err(ToolError::UnknownTool(_))));
        let bad = execute_tool(&ctx, "ask_user", &json!({ "question": "x" })).await;
        assert!(matches!(bad, Err(ToolError::InvalidArguments(_))));
    }
}
