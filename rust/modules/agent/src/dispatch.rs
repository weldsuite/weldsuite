//! Entity events start agents: the `weldagent` hub subscriber
//! (`apps/workers/agent-api/src/queue/entity-agents-consumer.ts`) and the
//! dispatch it calls (`services/weldagent/dispatch.ts`,
//! `registerWeldAgentEventRunner`).
//!
//! Each entity event starts the active agents subscribed to it, and the event
//! routines listening for it, once per event id (the hub redelivers). Events an
//! agent caused (`triggeredByAgentId` in their data) never start agents again,
//! otherwise an agent subscribed to `ticket.created` that creates tickets would
//! loop forever.
//!
//! `weldsuite consume` builds the subscriber only when the install has AI
//! (AI-011 kept it out until then).

use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_ports::{BatchHandler, BoxFuture, Delivery, Disposition};
use weldsuite_subscribers::{HubEvent, Tenants};

use crate::access::{AgentAccess, agent_viewer_for, can_access_agent};
use crate::agents::get_agent;
use crate::launch::RunLauncher;
use crate::routines::{
    create_routine_run, find_event_routines, has_routine_run_for_trigger, mark_routine_scheduled,
};
use crate::run::{RunEnv, RunParams, TriggerType};
use crate::runs::{create_agent_run, find_agents_for_event, has_existing_agent_run_for_event};

/// Key stamped into entity-event `data` by agent tools (`AGENT_ORIGIN_KEY`).
pub const AGENT_ORIGIN_KEY: &str = "triggeredByAgentId";

/// The event a member assigns a WeldMerge issue to an agent with
/// (`MERGE_AGENT_ASSIGNED`).
pub const MERGE_AGENT_ASSIGNED: (&str, &str) = ("merge_issue", "agent_assigned");

/// `WeldAgentDispatchMessage`.
#[derive(Debug, Clone)]
pub struct DispatchMessage {
    pub workspace_id: String,
    pub user_id: String,
    pub entity_type: String,
    pub action: String,
    pub entity_id: String,
    pub data: Value,
    /// Entity-event id (`evt_…`) for hub-retry idempotency.
    pub event_id: Option<String>,
}

/// What an assignment (instead of a subscription) tells the agent to do.
struct AgentTask {
    user_message: String,
    extra_system: String,
}

/// What every run scheduled for one entity event has in common.
struct EventContext<'a> {
    db: &'a PgPool,
    launcher: &'a RunLauncher,
    message: &'a DispatchMessage,
    event_key: String,
    event_prompt: String,
    base_trigger: Value,
}

async fn dispatch_to_agent(ctx: &EventContext<'_>, agent: &Value, task: Option<AgentTask>) {
    let agent_id = agent["id"].as_str().unwrap_or_default();
    let result = async {
        if let Some(event_id) = &ctx.message.event_id
            && has_existing_agent_run_for_event(ctx.db, agent_id, event_id).await?
        {
            tracing::info!(
                "[weldagent/dispatch] Skipping duplicate event {event_id} for agent {agent_id}"
            );
            return Ok::<_, sqlx::Error>(());
        }
        let mut stored = ctx.base_trigger.clone();
        if let Some(map) = stored.as_object_mut() {
            map.insert("data".into(), ctx.message.data.clone());
        }
        let run_id =
            create_agent_run(ctx.db, agent_id, Some("queued"), "event", Some(&stored)).await?;
        let actor = if ctx.message.user_id.is_empty() {
            agent["createdBy"].as_str().unwrap_or("system").to_owned()
        } else {
            ctx.message.user_id.clone()
        };
        let (user_message, extra_system) = match task {
            Some(task) => (task.user_message, task.extra_system),
            None => (
                format!(
                    "{}Follow your instructions and use tools if needed.",
                    ctx.event_prompt
                ),
                format!("Triggered by entity event {}.", ctx.event_key),
            ),
        };
        let params = RunParams {
            db: ctx.db.clone(),
            workspace_id: ctx.message.workspace_id.clone(),
            actor_user_id: actor,
            agent_id: agent_id.to_owned(),
            trigger_type: TriggerType::Event,
            trigger_data: Some(ctx.base_trigger.clone()),
            user_message,
            extra_system: Some(extra_system),
            run_id: Some(run_id),
            routine_run_id: None,
            skip_approvals: false,
            notify: true,
            actor_permissions: None,
            events: None,
            env: RunEnv::default(),
        };
        let outcome = ctx.launcher.start(params, None).await;
        if let Err(error) = outcome {
            tracing::warn!(
                ?error,
                "[weldagent/dispatch] agent {agent_id} could not run"
            );
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        tracing::error!(%error, "[weldagent/dispatch] agent {agent_id} failed");
    }
}

async fn dispatch_to_routine(ctx: &EventContext<'_>, routine: &Value) {
    let routine_id = routine["id"].as_str().unwrap_or_default();
    let result = async {
        // Hub retries re-deliver the same evt_ id: key the run on it so a
        // redelivery never starts the routine twice.
        let trigger = ctx.message.event_id.as_ref().map_or_else(
            || format!("event:{}", ctx.event_key),
            |id| format!("evt:{id}"),
        );
        if ctx.message.event_id.is_some()
            && has_routine_run_for_trigger(ctx.db, routine_id, &trigger).await?
        {
            return Ok::<_, sqlx::Error>(());
        }
        let agent_id = routine["agentId"].as_str().unwrap_or_default();
        let routine_run_id = create_routine_run(ctx.db, routine_id, agent_id, &trigger).await?;
        mark_routine_scheduled(ctx.db, routine, now_ms()).await?;
        let actor = if ctx.message.user_id.is_empty() {
            routine["createdBy"].as_str().unwrap_or("system").to_owned()
        } else {
            ctx.message.user_id.clone()
        };
        let mut trigger_data = ctx.base_trigger.clone();
        if let Some(map) = trigger_data.as_object_mut() {
            map.insert("routineId".into(), json!(routine_id));
        }
        let params = RunParams {
            db: ctx.db.clone(),
            workspace_id: ctx.message.workspace_id.clone(),
            actor_user_id: actor,
            agent_id: agent_id.to_owned(),
            trigger_type: TriggerType::Event,
            trigger_data: Some(trigger_data),
            user_message: format!(
                "{}Follow routine \"{}\":\n{}",
                ctx.event_prompt,
                routine["name"].as_str().unwrap_or_default(),
                routine["instructions"].as_str().unwrap_or_default()
            ),
            extra_system: None,
            run_id: None,
            routine_run_id: Some(routine_run_id),
            skip_approvals: routine["requireApproval"] != json!(true),
            notify: true,
            actor_permissions: None,
            events: None,
            env: RunEnv::default(),
        };
        let outcome = ctx.launcher.start(params, None).await;
        if let Err(error) = outcome {
            tracing::warn!(
                ?error,
                "[weldagent/dispatch] routine {routine_id} could not run"
            );
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        tracing::error!(%error, "[weldagent/dispatch] routine {routine_id} failed");
    }
}

fn now_ms() -> i64 {
    i64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .unwrap_or_default()
}

/// `memberCanUseAgent(db, agent, userId)`: whether a member, with their
/// permissions as they are now, may run the agent the way the chat does: an
/// active member holding `weldagent:use` (their denies apply) who can access
/// the agent.
async fn member_can_use_agent(db: &PgPool, agent: &Value, user_id: &str) -> bool {
    if user_id.is_empty() || user_id == "system" {
        return false;
    }
    let queries = weldsuite_db::TenantPermissionQueries::new(db.clone());
    let Ok(resolved) =
        weldsuite_permissions::resolve_effective_permissions(&queries, user_id).await
    else {
        return false;
    };
    if resolved.role.is_empty()
        || !weldsuite_permissions::has_app_permission(&resolved, "weldagent:use", None)
    {
        return false;
    }
    let viewer = agent_viewer_for(user_id, Some(&resolved));
    can_access_agent(
        db,
        &AgentAccess {
            id: agent["id"].as_str().unwrap_or_default(),
            owner_id: agent["ownerId"].as_str(),
            visibility: agent["visibility"].as_str().unwrap_or("workspace"),
        },
        &viewer,
    )
    .await
    .unwrap_or(false)
}

/// An issue assigned to an agent: that agent, whether or not it subscribes to
/// the event, runs with the issue as its task. The member who assigned it must
/// be able to use that agent themselves, otherwise the run is dropped, so
/// assigning an issue never runs an agent the assigner could not.
async fn dispatch_assigned_issue(ctx: &EventContext<'_>) {
    let Some(agent_id) = ctx.message.data["agentId"].as_str() else {
        return;
    };
    let Ok(Some(agent)) = get_agent(ctx.db, agent_id).await else {
        return;
    };
    if agent["status"] != "active" {
        return;
    }
    if !member_can_use_agent(ctx.db, &agent, &ctx.message.user_id).await {
        tracing::warn!(
            "[weldagent/dispatch] Dropped the assignment of {} to agent {agent_id}: the member who assigned it cannot use that agent",
            ctx.message.entity_id
        );
        return;
    }
    let key = ctx.message.data["key"]
        .as_str()
        .unwrap_or(&ctx.message.entity_id)
        .to_owned();
    let title = ctx.message.data["title"]
        .as_str()
        .filter(|t| !t.is_empty())
        .map_or_else(String::new, |t| format!(" \"{t}\""));
    let user_message = format!(
        "A WeldMerge issue has been assigned to you: {key}{title} (issue id {}).\n\
         Read it with merge_get_issue, do the work it asks for with your tools, and report what you did with \
         merge_comment_on_issue. Move it to in_review or done with merge_update_issue when you are finished.",
        ctx.message.entity_id
    );
    dispatch_to_agent(
        ctx,
        &agent,
        Some(AgentTask {
            user_message,
            extra_system: format!(
                "You were assigned WeldMerge issue {key}. Triggered by entity event merge_issue.agent_assigned."
            ),
        }),
    )
    .await;
}

/// `dispatchWeldAgentsForEvent(env, db, message)`: match active agents (and
/// event routines) for an entity event and run each. Never fails: the hub's
/// ack does not wait on an agent.
pub async fn dispatch_agents_for_event(
    db: &PgPool,
    launcher: &RunLauncher,
    message: &DispatchMessage,
) {
    if message
        .data
        .get(AGENT_ORIGIN_KEY)
        .is_some_and(Value::is_string)
    {
        return;
    }
    let event_key = format!("{}.{}", message.entity_type, message.action);
    let alt_key = format!("{}:{}", message.entity_type, message.action);
    let found = async {
        let mut agents = find_agents_for_event(db, &event_key).await?;
        if agents.is_empty() {
            agents = find_agents_for_event(db, &alt_key).await?;
        }
        let routines = find_event_routines(db, &event_key).await?;
        Ok::<_, sqlx::Error>((agents, routines))
    }
    .await;
    let (agents, routines) = match found {
        Ok(found) => found,
        Err(error) => {
            tracing::error!(%error, "[weldagent/dispatch] find agents failed");
            (Vec::new(), Vec::new())
        }
    };
    let assigned = (message.entity_type.as_str(), message.action.as_str()) == MERGE_AGENT_ASSIGNED;
    if agents.is_empty() && routines.is_empty() && !assigned {
        return;
    }
    let payload = serde_json::to_string_pretty(&message.data).unwrap_or_default();
    let shown: String = if payload.chars().count() > 8000 {
        format!("{}…", payload.chars().take(8000).collect::<String>())
    } else {
        payload
    };
    let event_prompt = format!(
        "A platform event occurred: {event_key} on entity {}.\nPayload:\n{shown}\n\n",
        message.entity_id
    );
    let mut base_trigger = json!({
        "eventKey": event_key,
        "entityType": message.entity_type,
        "action": message.action,
        "entityId": message.entity_id,
    });
    if let (Some(event_id), Some(map)) = (&message.event_id, base_trigger.as_object_mut()) {
        map.insert("eventId".into(), json!(event_id));
    }
    let ctx = EventContext {
        db,
        launcher,
        message,
        event_key,
        event_prompt,
        base_trigger,
    };
    if assigned {
        dispatch_assigned_issue(&ctx).await;
    }
    for agent in &agents {
        dispatch_to_agent(&ctx, agent, None).await;
    }
    for routine in &routines {
        dispatch_to_routine(&ctx, routine).await;
    }
}

/// The `weldagent` hub subscriber (`handleEntityAgentBatch`).
pub struct WeldAgentSubscriber {
    tenants: Arc<dyn Tenants>,
    launcher: RunLauncher,
}

impl std::fmt::Debug for WeldAgentSubscriber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WeldAgentSubscriber")
            .field("launcher", &self.launcher)
            .finish_non_exhaustive()
    }
}

impl WeldAgentSubscriber {
    /// The subscriber. Without AI there is nothing to run: build it only when
    /// the install has a provider. `launcher` says where a matched run
    /// starts: on the jobs backend, so `serve` runs it with every tool
    /// ([`RunLauncher::Jobs`]), or inline ([`RunLauncher::Inline`]).
    pub fn new(tenants: Arc<dyn Tenants>, launcher: RunLauncher) -> Self {
        Self { tenants, launcher }
    }

    async fn handle_one(&self, delivery: &Delivery) -> Disposition {
        let event = match HubEvent::parse(&delivery.payload) {
            Ok(event) => event,
            Err(error) => {
                tracing::error!(%error, "[EntityAgents] not an entity event; dropped");
                return Disposition::Ack;
            }
        };
        let workspace_id = event.metadata.workspace_id.clone();
        if workspace_id.is_empty() {
            tracing::warn!(
                event_id = event.id,
                "[EntityAgents] Skipping event: missing workspaceId"
            );
            return Disposition::Ack;
        }
        let tenant = match self.tenants.tenant(&workspace_id).await {
            Ok(tenant) => tenant,
            Err(error) => {
                return Disposition::retry(format!("cannot resolve the workspace: {error}"));
            }
        };
        let message = DispatchMessage {
            workspace_id,
            user_id: event.metadata.user_id.clone().unwrap_or_default(),
            entity_type: event.entity_type.clone(),
            action: event.action.clone(),
            entity_id: event.entity_id.clone(),
            data: event.data_value(),
            event_id: Some(event.id.clone()),
        };
        dispatch_agents_for_event(&tenant.db, &self.launcher, &message).await;
        Disposition::Ack
    }
}

impl BatchHandler for WeldAgentSubscriber {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>> {
        Box::pin(async move {
            let mut out = Vec::with_capacity(batch.len());
            for delivery in batch {
                out.push(self.handle_one(delivery).await);
            }
            out
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_event_an_agent_caused_never_starts_agents() {
        // The database is never touched: the origin marker returns first.
        let db = PgPool::connect_lazy("postgres://localhost/none").unwrap();
        let message = DispatchMessage {
            workspace_id: "ws_1".into(),
            user_id: "u1".into(),
            entity_type: "ticket".into(),
            action: "created".into(),
            entity_id: "t1".into(),
            data: json!({ "triggeredByAgentId": "agt_1" }),
            event_id: Some("evt_1".into()),
        };
        dispatch_agents_for_event(&db, &RunLauncher::inline(None, RunEnv::default()), &message)
            .await;
    }

    #[test]
    fn the_merge_assignment_event_is_named() {
        assert_eq!(MERGE_AGENT_ASSIGNED, ("merge_issue", "agent_assigned"));
    }
}
