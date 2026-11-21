//! Issue writes made on behalf of another surface (`services/across-*.ts`,
//! routes `internal/workflow-action.ts` and `internal/agent.ts`), on
//! merge-api's internal router (the `MergeInternal` entrypoint, trusted by
//! topology):
//!
//! ```text
//!   POST /internal/workflow-action → a WeldConnect merge.* action, as the workflow's owner
//!   POST /internal/agent-tool      → a WeldAgent WeldMerge tool call, as the agent's acting member
//! ```
//!
//! Each call names the member it acts for and is checked against that
//! member's permissions as they are now (CONN-004): someone who lost a
//! permission, or left the workspace, stops their workflows and agents from
//! doing what they no longer may. The writes go through the member routes'
//! services ([`crate::issues`]) and publish their entity events as the
//! member (source `api`), with the run's chain depth (workflows) or
//! `triggeredByAgentId` (agents) so what they cause cannot trigger itself
//! forever, and the same hooks run.
//!
//! A refusal is an answer (`{ ok: false, error }`), never an error status:
//! the caller decides whether to retry.
//!
//! [`workflow_action`] is `MergeInternal.workflowAction` in process: what
//! WeldConnect's engine calls for `merge.create_issue`, `merge.update_issue`
//! and `merge.comment_on_issue`.

use axum::body::Bytes;
use axum::extract::{FromRequestParts, State};
use axum::response::IntoResponse;
use http::HeaderMap;
use http::request::Parts;
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, Tenant, TenantPermissionQueries};
use weldsuite_events::{EntityEvent, EventContext, EventSource, EventType};
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{Data, generate_id};
use weldsuite_permissions::{AppCheckMode, check_app_permission, resolve_effective_permissions};

use crate::db::{Row, text};
use crate::hooks::{CommentChange, HookContext};
use crate::issues::{
    CreateFailure, UpdateFailure, create_issue, find_issue_by_id_or_key, hydrate_issues,
    issue_detail, list_issues, read_issue_input, read_list_query, team_key_of, update_issue,
};
use crate::mappers::comment_dto;
use crate::{Answer, MergeError, MergeState, Overrides, PendingEvent, now, validate};

/// The app a member's permissions are checked in.
const MERGE_APP: &str = "weldmerge";

/// The key entity-event `data` carries when an agent caused the event:
/// agents do not run for their own events (agent-api dispatch).
const AGENT_ORIGIN_KEY: &str = "triggeredByAgentId";

/// `MERGE_WORKFLOW_ACTIONS`.
const WORKFLOW_ACTIONS: [&str; 3] = [
    "merge.create_issue",
    "merge.update_issue",
    "merge.comment_on_issue",
];

/// `MERGE_AGENT_TOOLS`.
const AGENT_TOOLS: [&str; 8] = [
    "merge_list_issues",
    "merge_get_issue",
    "merge_create_issue",
    "merge_update_issue",
    "merge_comment_on_issue",
    "merge_list_pull_requests",
    "merge_get_pull_request",
    "merge_open_draft_pull_request",
];

/// Who an internal call acts as (`Actor`).
struct Actor {
    user_id: String,
    /// WeldConnect run depth.
    workflow_depth: Option<u32>,
    /// The agent acting through the member.
    agent_id: Option<String>,
}

/// Where an internal call acts: the workspace and how to reach the world.
struct Scope {
    state: MergeState,
    db: PgPool,
    workspace_id: String,
    clerk_org_id: Option<String>,
    overrides: Overrides,
}

impl Scope {
    fn hook_context(&self, actor: &Actor) -> HookContext {
        HookContext {
            db: self.db.clone(),
            state: self.state.clone(),
            overrides: self.overrides.clone(),
            user_id: actor.user_id.clone(),
            workspace_id: self.workspace_id.clone(),
            clerk_org_id: self.clerk_org_id.clone(),
            events: self.event_context(actor),
        }
    }

    /// `c.get('clerkOrgId') ?? c.get('workspaceId')`, as the actor, source `api`.
    fn event_context(&self, actor: &Actor) -> EventContext {
        EventContext::new(
            self.clerk_org_id
                .clone()
                .unwrap_or_else(|| self.workspace_id.clone()),
            actor.user_id.clone(),
            EventSource::Api,
        )
    }

    /// `publish(c, actor, events)`: awaited, so the hub send is done before
    /// the internal call answers.
    async fn publish(&self, actor: &Actor, events: Vec<PendingEvent>) {
        let context = self.event_context(actor);
        for event in events {
            let Ok(kind) = EventType::catalog(event.entity_type, event.action) else {
                tracing::error!(
                    entity_type = event.entity_type,
                    action = event.action,
                    "merge: an event outside the catalog"
                );
                continue;
            };
            let mut data = event.data;
            if let (Some(agent), Some(fields)) = (&actor.agent_id, data.as_object_mut()) {
                fields.insert(AGENT_ORIGIN_KEY.to_owned(), json!(agent));
            }
            let mut entity = EntityEvent::new(kind, event.entity_id, data);
            if let Some(changes) = event.changes {
                entity = entity.with_changes(changes);
            }
            if let Some(depth) = actor.workflow_depth {
                entity = entity.with_workflow_depth(depth);
            }
            self.state.events.publish_and_wait(&context, entity).await;
        }
    }
}

// ── Who may ─────────────────────────────────────────────────────────────────

/// `memberAgentAssigner(db, userId)`: the acting member as an agent
/// assigner, with `weldagent:use` and `weldagent:manage` as their
/// permissions are now, in any app. A former member can use no agent.
async fn member_agent_assigner(
    scope: &Scope,
    user_id: &str,
) -> Result<crate::issues::AgentAssigner, MergeError> {
    let queries = TenantPermissionQueries::new(scope.db.clone());
    let resolved = resolve_effective_permissions(&queries, user_id).await?;
    let holds = |permission: &str| {
        !resolved.role.is_empty() && check_app_permission(&resolved, permission, None).allowed
    };
    Ok(crate::issues::AgentAssigner {
        viewer: weldsuite_chat_domain::agents::AgentViewer {
            user_id: user_id.to_owned(),
            can_manage_all: holds("weldagent:manage"),
        },
        can_use: holds("weldagent:use"),
    })
}

/// `authorizeMember(db, env, userId, permission, doing)`: `Err(message)`
/// unless the member holds `permission` (in WeldMerge, or workspace-wide
/// unless app enforcement is on).
async fn authorize_member(
    scope: &Scope,
    user_id: &str,
    permission: &str,
    doing: &str,
) -> Result<Result<(), String>, MergeError> {
    let queries = TenantPermissionQueries::new(scope.db.clone());
    let resolved = resolve_effective_permissions(&queries, user_id).await?;
    if resolved.role.is_empty() {
        return Ok(Err(
            "The member this call acts for is no longer a member of this workspace".to_owned(),
        ));
    }
    let enforce = scope
        .overrides
        .env(&scope.state, "PERMISSIONS_APP_ENFORCE")
        .is_some_and(|v| v == "true");
    let in_app = check_app_permission(&resolved, permission, Some(MERGE_APP));
    let elsewhere = in_app.mode == AppCheckMode::App
        && check_app_permission(&resolved, permission, None).allowed;
    if in_app.allowed || (elsewhere && !enforce) {
        Ok(Ok(()))
    } else {
        Ok(Err(format!(
            "The member this call acts for may not {doing} ({permission})"
        )))
    }
}

/// `describeIssues(issues)`: a Zod failure as one readable line.
fn describe_issues(issues: &[Value]) -> String {
    issues
        .iter()
        .map(|issue| {
            let field = issue
                .get("path")
                .and_then(Value::as_array)
                .map(|path| {
                    path.iter()
                        .map(|p| match p {
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        })
                        .collect::<Vec<_>>()
                        .join(".")
                })
                .unwrap_or_default();
            let message = issue
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if field.is_empty() {
                message.to_owned()
            } else {
                format!("{field}: {message}")
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Reads `fields` with `read`; the value, or the issues as one line.
fn parse<T>(
    fields: &Map<String, Value>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, String> {
    let mut issues = Issues::default();
    let value = read(&mut issues, fields);
    match issues.finish() {
        Ok(()) => Ok(value),
        Err(invalid) => Err(describe_issues(invalid.issues())),
    }
}

/// `refMessage(reason)`.
fn create_failure_message(failure: CreateFailure) -> (bool, String) {
    match failure {
        CreateFailure::TeamNotFound => (true, "The team does not exist".to_owned()),
        CreateFailure::Ref(reason) => (false, reason.message().to_owned()),
    }
}

// ── The writes ──────────────────────────────────────────────────────────────

/// `createIssueAs(c, actor, input)`: the issue's DTO, or why not.
async fn create_issue_as(
    scope: &Scope,
    actor: &Actor,
    input: crate::issues::IssueInput,
) -> Result<Result<Value, String>, MergeError> {
    let created = match create_issue(&scope.db, input, &actor.user_id).await? {
        Ok(created) => created,
        Err(failure) => return Ok(Err(create_failure_message(failure).1)),
    };
    scope.publish(actor, created.events()).await;
    crate::hooks::after_issue_created(
        &scope.hook_context(actor),
        &created.issue,
        text(&created.team, "key"),
    )
    .await;
    Ok(Ok(dto(&scope.db, &created.issue).await?))
}

/// `updateIssueAs(c, actor, issueRef, input)`: `issueRef` is an id or a key.
async fn update_issue_as(
    scope: &Scope,
    actor: &Actor,
    issue_ref: &str,
    input: &crate::issues::IssueInput,
) -> Result<Result<Value, String>, MergeError> {
    let not_found = || format!("Issue {issue_ref} was not found");
    let Some(existing) = find_issue_by_id_or_key(&scope.db, issue_ref).await? else {
        return Ok(Err(not_found()));
    };
    // A new agent must be one the acting member could use (the run it starts acts for them).
    let assigner = if input.names_agent() {
        Some(member_agent_assigner(scope, &actor.user_id).await?)
    } else {
        None
    };
    let updated = match update_issue(&scope.db, text(&existing, "id"), input, assigner.as_ref())
        .await?
    {
        Ok(updated) => updated,
        Err(UpdateFailure::NotFound) => return Ok(Err(not_found())),
        Err(UpdateFailure::Ref(reason)) => return Ok(Err(reason.message().to_owned())),
        Err(UpdateFailure::Agent) => {
            return Ok(Err(
                "The agent does not exist, is not active, or the member this call acts for cannot use it"
                    .to_owned(),
            ));
        }
    };
    scope.publish(actor, updated.events()).await;
    crate::hooks::after_issue_updated(
        &scope.hook_context(actor),
        &updated.before,
        &updated.issue,
        &updated.team_key,
    )
    .await;
    Ok(Ok(dto(&scope.db, &updated.issue).await?))
}

/// A comment made through [`comment_on_issue_as`].
struct Commented {
    issue: Row,
    team_key: String,
    comment: Row,
}

/// `commentOnIssueAs(c, actor, issueRef, body)`.
async fn comment_on_issue_as(
    scope: &Scope,
    actor: &Actor,
    issue_ref: &str,
    body: &str,
) -> Result<Result<Commented, String>, MergeError> {
    let Some(issue) = find_issue_by_id_or_key(&scope.db, issue_ref).await? else {
        return Ok(Err(format!("Issue {issue_ref} was not found")));
    };
    let now = now();
    let row: Value = sqlx::query_scalar(
        "insert into merge_comments (id, issue_id, author_user_id, body, created_at, updated_at) \
         values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz) \
         returning to_jsonb(merge_comments.*)",
    )
    .bind(generate_id("mcm"))
    .bind(text(&issue, "id"))
    .bind(&actor.user_id)
    .bind(weldsuite_kit::validation::js_trim(body))
    .bind(&now)
    .fetch_one(&scope.db)
    .await?;
    let comment = weldsuite_db::js_row(row);
    scope
        .publish(
            actor,
            vec![PendingEvent::new(
                "merge_comment",
                "created",
                text(&comment, "id"),
                json!({ "id": comment["id"], "issueId": comment["issueId"], "authorUserId": comment["authorUserId"] }),
            )],
        )
        .await;
    let team_key = team_key_of(&scope.db, text(&issue, "teamId")).await?;
    crate::hooks::after_comment_changed(
        &scope.hook_context(actor),
        CommentChange::Created,
        &comment,
        &issue,
        &team_key,
    )
    .await;
    Ok(Ok(Commented {
        issue,
        team_key,
        comment,
    }))
}

async fn dto(db: &PgPool, issue: &Row) -> Result<Value, sqlx::Error> {
    Ok(hydrate_issues(db, std::slice::from_ref(issue))
        .await?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
}

// ── Inputs ──────────────────────────────────────────────────────────────────

/// `z.object({ issue: z.string().min(1) })`, the left side of the update and
/// comment inputs.
fn read_issue_ref(issues: &mut Issues, fields: &Map<String, Value>) -> String {
    issues
        .text(fields, "issue", Presence::Required, Some(1), None)
        .into_option()
        .unwrap_or_default()
}

/// `createMergeCommentSchema`'s body.
fn read_comment_body(issues: &mut Issues, fields: &Map<String, Value>) -> String {
    issues
        .text_with(
            fields,
            "body",
            Presence::Required,
            Text::trimmed(Some(1), Some(50_000)),
        )
        .into_option()
        .unwrap_or_default()
}

/// `workflowInput(raw)`: a workflow node resolves its fields to text, so
/// blank fields mean "not set", numbers arrive as numeric strings and lists
/// as comma-separated ones.
fn workflow_input(raw: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in raw {
        match value {
            Value::Null => {}
            Value::String(text) if weldsuite_kit::validation::js_trim(text).is_empty() => {}
            other => {
                out.insert(key.clone(), other.clone());
            }
        }
    }
    for key in ["priority", "estimate"] {
        if let Some(Value::String(text)) = out.get(key) {
            let trimmed = weldsuite_kit::validation::js_trim(text);
            let digits = trimmed.strip_prefix('-').unwrap_or(trimmed);
            if !digits.is_empty()
                && digits.bytes().all(|b| b.is_ascii_digit())
                && let Ok(number) = trimmed.parse::<i64>()
            {
                out.insert(key.to_owned(), json!(number));
            }
        }
    }
    if let Some(Value::String(list)) = out.get("labelIds") {
        let ids: Vec<Value> = list
            .split(',')
            .map(|s| weldsuite_kit::validation::js_trim(s).to_owned())
            .filter(|s| !s.is_empty())
            .map(Value::String)
            .collect();
        out.insert("labelIds".to_owned(), Value::Array(ids));
    }
    out
}

// ── POST /internal/workflow-action ──────────────────────────────────────────

/// `MergeWorkflowActionResult`.
fn action_result(
    ok: bool,
    issue_id: Option<&str>,
    issue_key: Option<&str>,
    comment_id: Option<&str>,
    error: Option<String>,
) -> Value {
    let mut out = json!({
        "ok": ok,
        "issueId": issue_id,
        "issueKey": issue_key,
        "commentId": comment_id,
    });
    if let Some(fields) = out.as_object_mut() {
        fields.insert("error".to_owned(), error.map_or(Value::Null, Value::String));
    }
    out
}

fn action_refused(error: String) -> Value {
    action_result(false, None, None, None, Some(error))
}

/// `mergeWorkflowActionEnvelopeSchema`, as validated.
struct ActionEnvelope {
    workspace_id: String,
    user_id: String,
    action: String,
    input: Map<String, Value>,
    chain_depth: Option<u32>,
}

fn read_action_envelope(issues: &mut Issues, fields: &Map<String, Value>) -> ActionEnvelope {
    let workspace_id = issues
        .text(fields, "workspaceId", Presence::Required, Some(1), None)
        .into_option()
        .unwrap_or_default();
    let user_id = issues
        .text(fields, "userId", Presence::Required, Some(1), None)
        .into_option()
        .unwrap_or_default();
    let action = issues
        .choice(fields, "action", Presence::Required, &WORKFLOW_ACTIONS)
        .into_option()
        .unwrap_or_default();
    let input = issues
        .nested(fields, "input", Presence::Required, |_, input| {
            input.clone()
        })
        .into_option()
        .unwrap_or_default();
    let chain_depth = issues
        .whole_number(
            fields,
            "chainDepth",
            Presence::Optional,
            Number {
                min: Some(0.0),
                ..Number::default()
            },
        )
        .into_option()
        .and_then(|depth| u32::try_from(depth).ok());
    ActionEnvelope {
        workspace_id,
        user_id,
        action,
        input,
        chain_depth,
    }
}

/// `run(c, actor, action, raw)`.
async fn run_action(
    scope: &Scope,
    actor: &Actor,
    action: &str,
    raw: &Map<String, Value>,
) -> Result<Value, MergeError> {
    let input = workflow_input(raw);
    match action {
        "merge.create_issue" => {
            let parsed = match parse(&input, |issues, fields| {
                read_issue_input(issues, fields, false)
            }) {
                Ok(parsed) => parsed,
                Err(error) => return Ok(action_refused(error)),
            };
            Ok(match create_issue_as(scope, actor, parsed).await? {
                Ok(issue) => action_result(
                    true,
                    issue.get("id").and_then(Value::as_str),
                    issue.get("key").and_then(Value::as_str),
                    None,
                    None,
                ),
                Err(error) => action_refused(error),
            })
        }
        "merge.update_issue" => {
            let parsed = match parse(&input, |issues, fields| {
                (
                    read_issue_ref(issues, fields),
                    read_issue_input(issues, fields, true),
                )
            }) {
                Ok(parsed) => parsed,
                Err(error) => return Ok(action_refused(error)),
            };
            Ok(
                match update_issue_as(scope, actor, &parsed.0, &parsed.1).await? {
                    Ok(issue) => action_result(
                        true,
                        issue.get("id").and_then(Value::as_str),
                        issue.get("key").and_then(Value::as_str),
                        None,
                        None,
                    ),
                    Err(error) => action_refused(error),
                },
            )
        }
        _ => {
            let parsed = match parse(&input, |issues, fields| {
                (
                    read_issue_ref(issues, fields),
                    read_comment_body(issues, fields),
                )
            }) {
                Ok(parsed) => parsed,
                Err(error) => return Ok(action_refused(error)),
            };
            Ok(
                match comment_on_issue_as(scope, actor, &parsed.0, &parsed.1).await? {
                    Ok(done) => action_result(
                        true,
                        Some(text(&done.issue, "id")),
                        Some(&format!(
                            "{}-{}",
                            done.team_key,
                            done.issue.get("number").cloned().unwrap_or(Value::Null)
                        )),
                        Some(text(&done.comment, "id")),
                        None,
                    ),
                    Err(error) => action_refused(error),
                },
            )
        }
    }
}

/// The permission each action needs and what it is doing.
fn action_permission(action: &str) -> (&'static str, &'static str) {
    match action {
        "merge.create_issue" => ("merge_issues:create", "create issues"),
        "merge.update_issue" => ("merge_issues:update", "change issues"),
        _ => ("merge_issues:update", "comment on issues"),
    }
}

/// `resolveInternalWorkspace(c, workspaceId, userId)`: the tenant a layer
/// opened (conformance), else the workspace by either of its ids. `None`
/// when it does not exist or is suspended.
async fn resolve_workspace(
    state: &MergeState,
    tenant: Option<Tenant>,
    workspace_id: &str,
) -> Option<Tenant> {
    if let Some(tenant) = tenant {
        return Some(tenant);
    }
    let resolver = state.tenants.as_ref()?;
    match resolver(workspace_id.to_owned()).await {
        Ok(tenant) if !tenant.suspended => Some(tenant),
        _ => None,
    }
}

async fn workflow_action_with(
    state: &MergeState,
    tenant: Option<Tenant>,
    overrides: Overrides,
    envelope: ActionEnvelope,
) -> Result<Value, MergeError> {
    let Some(tenant) = resolve_workspace(state, tenant, &envelope.workspace_id).await else {
        return Ok(action_refused(format!(
            "Workspace {} was not found or is suspended",
            envelope.workspace_id
        )));
    };
    let scope = Scope {
        state: state.clone(),
        db: tenant.db.clone(),
        workspace_id: tenant.workspace_id.clone(),
        clerk_org_id: tenant.clerk_org_id.clone(),
        overrides,
    };
    let (permission, doing) = action_permission(&envelope.action);
    if let Err(error) = authorize_member(&scope, &envelope.user_id, permission, doing).await? {
        return Ok(action_refused(error));
    }
    let actor = Actor {
        user_id: envelope.user_id.clone(),
        workflow_depth: Some(envelope.chain_depth.unwrap_or(0)),
        agent_id: None,
    };
    run_action(&scope, &actor, &envelope.action, &envelope.input).await
}

/// `MergeInternal.workflowAction(envelope)` in process, for WeldConnect's
/// engine: a `merge.*` action (`merge.create_issue`, `merge.update_issue`,
/// `merge.comment_on_issue`) run AS THE WORKFLOW'S OWNER, its permissions
/// resolved now, with the run's chain depth on the events it publishes.
///
/// `envelope` is `MergeWorkflowActionEnvelope`: `{ workspaceId (either id),
/// userId (the owner), action, input (the node's resolved fields), chainDepth? }`.
/// The answer is `MergeWorkflowActionResult`, `{ ok, issueId, issueKey,
/// commentId, error }`: a refusal (no permission, unknown issue, bad input,
/// unknown or suspended workspace) is `ok: false` with the reason. `Err`
/// only when the envelope itself is malformed or the database fails (the
/// worker's binding throws `merge-api workflow-action answered <status>`).
/// The workspace is opened through `state.tenants`.
pub async fn workflow_action(state: &MergeState, envelope: Value) -> Result<Value, String> {
    let fields = envelope.as_object().cloned().unwrap_or_default();
    let envelope = parse(&fields, read_action_envelope)
        .map_err(|_| "merge-api workflow-action answered 400".to_owned())?;
    workflow_action_with(state, None, Overrides::default(), envelope)
        .await
        .map_err(|error| {
            tracing::error!(?error, "merge: a workflow action failed");
            "merge-api workflow-action answered 500".to_owned()
        })
}

/// `MergeInternal.agentTool(envelope)` in process, for WeldAgent's EU tools: a
/// `merge_*` tool (`MERGE_AGENT_TOOLS`) run for the member the agent works for,
/// in the workspace whose tenant database is `db`. Each tool is checked
/// against that member's WeldMerge permissions as they are now; the writes
/// publish the member routes' events, marked `triggeredByAgentId`.
///
/// `Ok` is the tool's result; `Err` the refusal the worker's `{ ok: false,
/// error }` answer carries (a bad input, no permission, an unknown issue).
///
/// # Errors
///
/// The refusal message, or a database failure as `Internal server error`.
#[allow(clippy::too_many_arguments)] // the envelope's fields, as the worker takes them
pub async fn agent_tool(
    state: &MergeState,
    db: &PgPool,
    workspace_id: &str,
    clerk_org_id: Option<&str>,
    user_id: &str,
    agent_id: &str,
    tool: &str,
    input: &Value,
) -> Result<Value, String> {
    if !AGENT_TOOLS.contains(&tool) {
        return Err(format!("Unknown WeldMerge tool {tool}"));
    }
    let scope = Scope {
        state: state.clone(),
        db: db.clone(),
        workspace_id: workspace_id.to_owned(),
        clerk_org_id: clerk_org_id.map(str::to_owned),
        overrides: Overrides::default(),
    };
    let internal_error = |error: MergeError| {
        tracing::error!(?error, tool, "merge: an agent tool failed");
        "Internal server error".to_owned()
    };
    for (permission, doing) in tool_permissions(tool) {
        authorize_member(&scope, user_id, permission, doing)
            .await
            .map_err(internal_error)??;
    }
    let actor = Actor {
        user_id: user_id.to_owned(),
        workflow_depth: None,
        agent_id: Some(agent_id.to_owned()).filter(|a| !a.is_empty()),
    };
    let fields = input.as_object().cloned().unwrap_or_default();
    let answer = run_tool(&scope, &actor, tool, &fields)
        .await
        .map_err(internal_error)?;
    if answer["ok"] == Value::Bool(true) {
        Ok(answer["result"].clone())
    } else {
        Err(answer["error"]
            .as_str()
            .unwrap_or("WeldMerge refused the request")
            .to_owned())
    }
}

/// What an internal route reads off its request: the tenant when a layer
/// opened it (conformance), and the overrides.
pub(crate) struct Internal {
    tenant: Option<Tenant>,
    overrides: Overrides,
}

impl<S: Send + Sync> FromRequestParts<S> for Internal {
    type Rejection = std::convert::Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(Ok(Self {
            tenant: parts.extensions.get::<Tenant>().cloned(),
            overrides: Overrides::from_extensions(&parts.extensions),
        }))
    }
}

/// `POST /internal/workflow-action`.
pub(crate) async fn workflow_action_route(
    State(state): State<MergeState>,
    internal: Internal,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let envelope = validate(&headers, &body, read_action_envelope)?;
    let result =
        workflow_action_with(&state, internal.tenant, internal.overrides, envelope).await?;
    Ok(Data(result).into_response())
}

// ── POST /internal/agent-tool ───────────────────────────────────────────────

fn tool_ok(result: Value) -> Value {
    let mut out = Map::new();
    out.insert("ok".to_owned(), Value::Bool(true));
    out.insert("result".to_owned(), result);
    out.insert("error".to_owned(), Value::Null);
    Value::Object(out)
}

fn tool_refused(error: String) -> Value {
    let mut out = Map::new();
    out.insert("ok".to_owned(), Value::Bool(false));
    out.insert("result".to_owned(), Value::Null);
    out.insert("error".to_owned(), Value::String(error));
    Value::Object(out)
}

/// What each tool needs (`PERMISSIONS`).
fn tool_permissions(tool: &str) -> &'static [(&'static str, &'static str)] {
    match tool {
        "merge_list_issues" | "merge_get_issue" => &[("merge_issues:read", "read issues")],
        "merge_create_issue" => &[("merge_issues:create", "create issues")],
        "merge_update_issue" => &[("merge_issues:update", "change issues")],
        "merge_comment_on_issue" => &[("merge_issues:update", "comment on issues")],
        "merge_list_pull_requests" | "merge_get_pull_request" => {
            &[("merge_pull_requests:read", "read pull requests")]
        }
        _ => &[
            ("merge_pull_requests:review", "open pull requests"),
            ("merge_connections:read", "use connected repositories"),
        ],
    }
}

/// `listIssuesInput`: the list query with `status` as one status, a
/// comma-separated list or an array.
fn read_tool_list_query(
    issues: &mut Issues,
    fields: &Map<String, Value>,
) -> crate::issues::ListQuery {
    let mut fields = fields.clone();
    match fields.get("status") {
        Some(Value::Array(items)) => {
            if items.iter().all(Value::is_string) {
                let joined = items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",");
                fields.insert("status".to_owned(), json!(joined));
            } else {
                issues.custom("status", "Invalid input");
                fields.remove("status");
            }
        }
        Some(Value::String(_)) | None => {}
        Some(_) => {
            issues.custom("status", "Invalid input");
            fields.remove("status");
        }
    }
    read_list_query(issues, &fields)
}

async fn run_tool(
    scope: &Scope,
    actor: &Actor,
    tool: &str,
    input: &Map<String, Value>,
) -> Result<Value, MergeError> {
    let db = &scope.db;
    match tool {
        "merge_list_issues" => {
            let query = match parse(input, read_tool_list_query) {
                Ok(query) => query,
                Err(error) => return Ok(tool_refused(error)),
            };
            let found = list_issues(db, &query, &actor.user_id).await?;
            Ok(tool_ok(json!({
                "issues": hydrate_issues(db, &found.rows).await?,
                "hasMore": found.has_more,
                "cursor": found.cursor,
            })))
        }
        "merge_get_issue" => {
            let issue_ref = match parse(input, read_issue_ref) {
                Ok(issue_ref) => issue_ref,
                Err(error) => return Ok(tool_refused(error)),
            };
            let Some(mut detail) = issue_detail(db, &issue_ref).await? else {
                return Ok(tool_refused(format!("Issue {issue_ref} was not found")));
            };
            // A linked record's title only where the acting member may read the record.
            if let Some(links) = detail.get_mut("recordLinks").and_then(Value::as_array_mut) {
                crate::record_links::TitleAccess::for_member(db, &actor.user_id)
                    .hide_titles(links)
                    .await?;
            }
            let comments: Vec<Value> = sqlx::query_scalar(
                "select to_jsonb(c) from merge_comments c where c.issue_id = $1 and c.deleted_at is null \
                 order by c.created_at asc, c.id asc",
            )
            .bind(text(&detail, "id"))
            .fetch_all(db)
            .await?;
            let comments: Vec<Value> = comments
                .into_iter()
                .map(weldsuite_db::js_row)
                .map(|c| comment_dto(&c))
                .collect();
            if let Some(fields) = detail.as_object_mut() {
                fields.insert("comments".to_owned(), Value::Array(comments));
            }
            Ok(tool_ok(detail))
        }
        "merge_create_issue" => {
            let parsed = match parse(input, |issues, fields| {
                read_issue_input(issues, fields, false)
            }) {
                Ok(parsed) => parsed,
                Err(error) => return Ok(tool_refused(error)),
            };
            Ok(match create_issue_as(scope, actor, parsed).await? {
                Ok(issue) => tool_ok(issue),
                Err(error) => tool_refused(error),
            })
        }
        "merge_update_issue" => {
            let parsed = match parse(input, |issues, fields| {
                (
                    read_issue_ref(issues, fields),
                    read_issue_input(issues, fields, true),
                )
            }) {
                Ok(parsed) => parsed,
                Err(error) => return Ok(tool_refused(error)),
            };
            Ok(
                match update_issue_as(scope, actor, &parsed.0, &parsed.1).await? {
                    Ok(issue) => tool_ok(issue),
                    Err(error) => tool_refused(error),
                },
            )
        }
        "merge_comment_on_issue" => {
            let parsed = match parse(input, |issues, fields| {
                (
                    read_issue_ref(issues, fields),
                    read_comment_body(issues, fields),
                )
            }) {
                Ok(parsed) => parsed,
                Err(error) => return Ok(tool_refused(error)),
            };
            Ok(
                match comment_on_issue_as(scope, actor, &parsed.0, &parsed.1).await? {
                    Ok(done) => tool_ok(comment_dto(&done.comment)),
                    Err(error) => tool_refused(error),
                },
            )
        }
        "merge_list_pull_requests" => {
            let query = match parse(input, crate::pull_requests::read_list_query) {
                Ok(query) => query,
                Err(error) => return Ok(tool_refused(error)),
            };
            let (items, has_more, cursor) =
                crate::pull_requests::list_pull_requests(db, query, &actor.user_id).await?;
            Ok(tool_ok(json!({
                "pullRequests": items,
                "hasMore": has_more,
                "cursor": cursor,
            })))
        }
        "merge_get_pull_request" => {
            let id = match parse(input, |issues, fields| {
                issues
                    .text(fields, "pullRequestId", Presence::Required, Some(1), None)
                    .into_option()
                    .unwrap_or_default()
            }) {
                Ok(id) => id,
                Err(error) => return Ok(tool_refused(error)),
            };
            Ok(
                match crate::pull_requests::pull_request_detail(db, &id).await? {
                    Some(detail) => tool_ok(detail),
                    None => tool_refused(format!("Pull request {id} was not found")),
                },
            )
        }
        _ => crate::draft_pull_request::tool(scope_parts(scope), input).await,
    }
}

/// What the draft pull request tool needs of the scope.
fn scope_parts(scope: &Scope) -> crate::draft_pull_request::ToolScope<'_> {
    crate::draft_pull_request::ToolScope {
        state: &scope.state,
        db: &scope.db,
        overrides: &scope.overrides,
    }
}

/// `mergeAgentToolEnvelopeSchema`, as validated.
struct ToolEnvelope {
    workspace_id: String,
    user_id: String,
    agent_id: Option<String>,
    tool: String,
    input: Map<String, Value>,
}

fn read_tool_envelope(issues: &mut Issues, fields: &Map<String, Value>) -> ToolEnvelope {
    let workspace_id = issues
        .text(fields, "workspaceId", Presence::Required, Some(1), None)
        .into_option()
        .unwrap_or_default();
    let user_id = issues
        .text(fields, "userId", Presence::Required, Some(1), None)
        .into_option()
        .unwrap_or_default();
    let agent_id = issues
        .text(fields, "agentId", Presence::Nullish, None, None)
        .into_option();
    let tool = issues
        .choice(fields, "tool", Presence::Required, &AGENT_TOOLS)
        .into_option()
        .unwrap_or_default();
    let input = issues
        .nested(fields, "input", Presence::Required, |_, input| {
            input.clone()
        })
        .into_option()
        .unwrap_or_default();
    ToolEnvelope {
        workspace_id,
        user_id,
        agent_id,
        tool,
        input,
    }
}

/// `POST /internal/agent-tool`.
pub(crate) async fn agent_tool_route(
    State(state): State<MergeState>,
    internal: Internal,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let envelope = validate(&headers, &body, read_tool_envelope)?;
    let Some(tenant) = resolve_workspace(&state, internal.tenant, &envelope.workspace_id).await
    else {
        return Ok(Data(tool_refused(format!(
            "Workspace {} was not found or is suspended",
            envelope.workspace_id
        )))
        .into_response());
    };
    let scope = Scope {
        state: state.clone(),
        db: tenant.db.clone(),
        workspace_id: tenant.workspace_id.clone(),
        clerk_org_id: tenant.clerk_org_id.clone(),
        overrides: internal.overrides,
    };
    for (permission, doing) in tool_permissions(&envelope.tool) {
        if let Err(error) = authorize_member(&scope, &envelope.user_id, permission, doing).await? {
            return Ok(Data(tool_refused(error)).into_response());
        }
    }
    let actor = Actor {
        user_id: envelope.user_id.clone(),
        workflow_depth: None,
        agent_id: envelope.agent_id.clone().filter(|a| !a.is_empty()),
    };
    let result = run_tool(&scope, &actor, &envelope.tool, &envelope.input).await?;
    Ok(Data(result).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workflow_node_drops_blanks_and_reads_numbers_and_lists() {
        let raw = json!({
            "teamId": "mtm_1", "title": "x", "description": "  ", "assigneeUserId": null,
            "priority": " 2 ", "estimate": "-3", "labelIds": "a, b,,c",
        });
        let input = workflow_input(raw.as_object().unwrap_or(&Map::new()));
        assert_eq!(
            Value::Object(input),
            json!({ "teamId": "mtm_1", "title": "x", "priority": 2, "estimate": -3, "labelIds": ["a", "b", "c"] })
        );
    }

    #[test]
    fn issues_read_as_one_line() {
        let issues = [
            json!({ "path": ["title"], "message": "Required" }),
            json!({ "path": ["links", 0, "recordType"], "message": "Invalid" }),
            json!({ "path": [], "message": "Nothing to update" }),
        ];
        assert_eq!(
            describe_issues(&issues),
            "title: Required; links.0.recordType: Invalid; Nothing to update"
        );
    }
}
