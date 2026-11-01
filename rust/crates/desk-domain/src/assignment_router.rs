//! `helpdesk-workflow-worker`'s `AssignmentRouter` Durable Object
//! (`src/durable-objects/assignment-router.ts`) and the pick rule it runs
//! (`pickDeskAssignee` in `@weldsuite/db/lib/desk-assignment`).
//!
//! On Global the object keeps, per workspace, the rotation pointer and the
//! picks of the last 30 seconds, and one instance answers at a time, so two
//! conversations started together don't land on the same teammate (ADR
//! DESK-005). Here that state is a record in a [`LedgerStore`] (Valkey across
//! pods, or this process without it), changed with a compare-and-set commit:
//! a pick reads the record, decides, and commits only if no other pick
//! committed meanwhile, else it reads again. The round-robin pointer and the
//! recent-pick counts therefore stay right with any number of pods.
//!
//! The object also holds the older per-department router (`/assign`,
//! `/release`, `/sync-agents`): agents with capacities, round robin or least
//! busy. Nothing in the repository calls it any more; it is ported with the
//! object, under its own records.
//!
//! The router is keyed by `workspaces.id` (TypeScript keys the object by the
//! Clerk org id its callers pass; the state is per backend either way).

use std::cmp::Ordering;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use weldsuite_core_domain::js::number_value;
use weldsuite_ports::{LedgerChanges, LedgerStore, PortError};

use crate::assignment::locale_compare;

/// `RECENT_PICK_WINDOW_MS`: picks this recent count towards a teammate's load.
pub const RECENT_PICK_WINDOW_MS: i64 = 30_000;

/// A router record lives this long after its last change (a Durable Object
/// keeps its storage for good; a workspace idle for a year starts its
/// rotation over).
const RECORD_TTL: Duration = Duration::from_hours(365 * 24);

/// Commits tried before a pick gives up (and the caller picks locally).
const MAX_ATTEMPTS: usize = 32;

/// `DeskPickRequest['mode']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickMode {
    RoundRobin,
    Balanced,
}

impl PickMode {
    /// `round_robin` or `balanced`; `None` for anything else (`off`).
    pub fn parse(mode: &str) -> Option<Self> {
        match mode {
            "round_robin" => Some(Self::RoundRobin),
            "balanced" => Some(Self::Balanced),
            _ => None,
        }
    }
}

/// `DeskAssignmentCandidate`: a teammate and the open conversations they own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickCandidate {
    pub user_id: String,
    pub open: i64,
}

/// `DeskPickRequest`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickRequest {
    pub mode: PickMode,
    pub candidates: Vec<PickCandidate>,
    pub max_open: Option<i64>,
}

/// One pick of the last 30 seconds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentPick {
    pub user_id: String,
    pub at: i64,
}

/// `DeskPickerState`: what the router keeps per workspace between picks.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerState {
    pub last_user_id: Option<String>,
    pub recent: Vec<RecentPick>,
}

/// `rotation(candidates, lastUserId)`: the candidates in a stable order,
/// starting after the last pick and wrapping round.
fn rotation<'a>(candidates: &[&'a PickCandidate], last: Option<&str>) -> Vec<&'a PickCandidate> {
    let mut sorted: Vec<&PickCandidate> = candidates.to_vec();
    sorted.sort_by(|a, b| locale_compare(&a.user_id, &b.user_id));
    let Some(last) = last.filter(|last| !last.is_empty()) else {
        return sorted;
    };
    match sorted
        .iter()
        .position(|c| locale_compare(&c.user_id, last) == Ordering::Greater)
    {
        Some(after) if after > 0 => {
            let mut rotated = sorted[after..].to_vec();
            rotated.extend_from_slice(&sorted[..after]);
            rotated
        }
        _ => sorted,
    }
}

/// `pickDeskAssignee(state, request, now)`: round robin takes the next
/// teammate in a stable order; balanced takes whoever has the fewest open
/// conversations, ties going round in that same order. Picks from the last
/// 30 s count towards a teammate's load. Pure: the caller stores the state.
pub fn pick_desk_assignee(
    state: &PickerState,
    request: &PickRequest,
    now: i64,
) -> (Option<String>, PickerState) {
    let recent: Vec<RecentPick> = state
        .recent
        .iter()
        .filter(|r| now - r.at < RECENT_PICK_WINDOW_MS)
        .cloned()
        .collect();
    let load = |c: &PickCandidate| {
        let picks = recent.iter().filter(|r| r.user_id == c.user_id).count();
        c.open + i64::try_from(picks).unwrap_or(i64::MAX)
    };
    let eligible: Vec<&PickCandidate> = request
        .candidates
        .iter()
        .filter(|c| request.max_open.is_none_or(|max| load(c) < max))
        .collect();
    let ordered = rotation(&eligible, state.last_user_id.as_deref());
    let mut picked = ordered.first().copied();
    if let Some(first) = picked
        && request.mode == PickMode::Balanced
    {
        let mut best = first;
        for c in &ordered {
            if load(c) < load(best) {
                best = c;
            }
        }
        picked = Some(best);
    }
    let Some(picked) = picked else {
        return (
            None,
            PickerState {
                last_user_id: state.last_user_id.clone(),
                recent,
            },
        );
    };
    let mut recent = recent;
    recent.push(RecentPick {
        user_id: picked.user_id.clone(),
        at: now,
    });
    (
        Some(picked.user_id.clone()),
        PickerState {
            last_user_id: Some(picked.user_id.clone()),
            recent,
        },
    )
}

// ---------------------------------------------------------------------------
// The department router (`AssignmentState`)
// ---------------------------------------------------------------------------

/// JavaScript's `Number(x)` for the router's counters, as far as its state
/// holds them: numbers, and `NaN` for anything else.
fn num(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Null) => 0.0,
        _ => f64::NAN,
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `getEligibleAgents(state)`: available, online agents under their cap,
/// by name. Indexes into `state.agents`.
fn eligible_agents(agents: &[Value]) -> Vec<usize> {
    let mut eligible: Vec<usize> = agents
        .iter()
        .enumerate()
        .filter(|(_, a)| {
            truthy(a.get("isAvailable"))
                && truthy(a.get("isOnline"))
                && num(a.get("currentActive")) < num(a.get("maxActive"))
        })
        .map(|(i, _)| i)
        .collect();
    let name = |i: usize| agents[i]["name"].as_str().unwrap_or_default().to_owned();
    eligible.sort_by(|a, b| locale_compare(&name(*a), &name(*b)));
    eligible
}

/// `assignConversation(request)` on a loaded state: the agent picked (with
/// the state changed), or `None` (state untouched).
pub fn assign_in(state: &mut Value, mode: &str) -> Option<Value> {
    let agents = state["agents"].as_array().cloned().unwrap_or_default();
    let eligible = eligible_agents(&agents);
    if eligible.is_empty() {
        return None;
    }
    let selected = if mode == "round_robin" {
        let last = num(state.get("lastAssignedIndex"));
        #[allow(clippy::cast_precision_loss)] // a handful of agents
        let next = (last + 1.0) % (eligible.len() as f64);
        state["lastAssignedIndex"] = number_value(next);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let index = if next.is_finite() && next >= 0.0 {
            next as usize
        } else {
            0
        };
        eligible[index.min(eligible.len() - 1)]
    } else {
        let mut best = eligible[0];
        for &i in &eligible {
            if num(agents[i].get("currentActive")) < num(agents[best].get("currentActive")) {
                best = i;
            }
        }
        best
    };
    let mut agent = agents[selected].clone();
    agent["currentActive"] = number_value(num(agent.get("currentActive")) + 1.0);
    let mut list = agents;
    list[selected] = agent.clone();
    state["agents"] = Value::Array(list);
    Some(json!({
        "agentId": agent["agentId"],
        "userId": agent["userId"],
        "name": agent["name"],
    }))
}

/// `releaseConversation(agentId)` on a stored state.
pub fn release_in(state: &mut Value, agent_id: &str) {
    if let Some(agents) = state["agents"].as_array_mut()
        && let Some(agent) = agents
            .iter_mut()
            .find(|a| a["agentId"].as_str() == Some(agent_id))
    {
        let current = num(agent.get("currentActive"));
        if current > 0.0 {
            agent["currentActive"] = number_value(current - 1.0);
        }
    }
}

/// `syncAgents(departmentId, agents)` on a loaded state: the ask
/// replaced, each known agent keeping its live count.
pub fn sync_in(state: &mut Value, incoming: &[Value]) {
    let existing = state["agents"].as_array().cloned().unwrap_or_default();
    let merged: Vec<Value> = incoming
        .iter()
        .map(|agent| {
            let mut out = match agent {
                Value::Object(map) => map.clone(),
                _ => Map::new(),
            };
            let known = existing
                .iter()
                .find(|a| a.get("agentId") == agent.get("agentId"));
            let current = known
                .and_then(|a| a.get("currentActive"))
                .filter(|v| !v.is_null())
                .or_else(|| agent.get("currentActive"))
                .cloned();
            match current {
                Some(current) => {
                    out.insert("currentActive".to_owned(), current);
                }
                None => {
                    out.remove("currentActive");
                }
            }
            Value::Object(out)
        })
        .collect();
    state["agents"] = Value::Array(merged);
}

/// `loadState(departmentId)`'s fresh state.
fn new_department_state(department_id: &str) -> Value {
    json!({ "departmentId": department_id, "lastAssignedIndex": -1, "agents": [] })
}

// ---------------------------------------------------------------------------
// The router over a store
// ---------------------------------------------------------------------------

/// `Date.now()`.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

/// What one decision on a record does: its answer, and the field's new
/// value (`None` writes nothing).
type Decision<T> = (T, Option<String>);

/// The `AssignmentRouter`: one record per workspace (`desk:<workspaces.id>`)
/// and per department (`department:<id>`).
#[derive(Clone)]
pub struct AssignmentRouter {
    store: Arc<dyn LedgerStore>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl std::fmt::Debug for AssignmentRouter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AssignmentRouter")
    }
}

impl AssignmentRouter {
    pub fn new(store: Arc<dyn LedgerStore>) -> Self {
        Self {
            store,
            clock: Arc::new(now_ms),
        }
    }

    /// The same router with its own clock (tests).
    #[must_use]
    pub fn with_clock(mut self, clock: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        self.clock = clock;
        self
    }

    /// Read `field` of the record at `key`, decide, and commit the decision
    /// if nobody committed meanwhile; otherwise read again.
    async fn update<T>(
        &self,
        key: &str,
        field: &str,
        decide: impl Fn(Option<&str>) -> Decision<T>,
    ) -> Result<T, PortError> {
        for _ in 0..MAX_ATTEMPTS {
            let snapshot = self.store.load(key).await?;
            let (answer, next) = decide(snapshot.fields.get(field).map(String::as_str));
            let Some(next) = next else {
                return Ok(answer);
            };
            let changes = LedgerChanges {
                put: vec![(field.to_owned(), next)],
                delete: Vec::new(),
            };
            if self
                .store
                .commit(key, snapshot.version, &changes, RECORD_TTL)
                .await?
            {
                return Ok(answer);
            }
        }
        Err(PortError::backend(format!(
            "assignment router: {key} kept changing under {MAX_ATTEMPTS} attempts"
        )))
    }

    /// `pickDeskAssignee(request)` on the workspace's record.
    pub async fn pick_desk_assignee(
        &self,
        workspace_id: &str,
        request: &PickRequest,
    ) -> Result<Option<String>, PortError> {
        let now = (self.clock)();
        self.update(&format!("desk:{workspace_id}"), "desk", |stored| {
            let state: PickerState = stored
                .and_then(|text| serde_json::from_str(text).ok())
                .unwrap_or_default();
            let (user_id, next) = pick_desk_assignee(&state, request, now);
            (user_id, serde_json::to_string(&next).ok())
        })
        .await
    }

    /// The department's stored state, if it has one.
    pub async fn department_state(&self, department_id: &str) -> Result<Option<Value>, PortError> {
        let snapshot = self.store.load(&department_key(department_id)).await?;
        Ok(snapshot
            .fields
            .get("state")
            .and_then(|text| serde_json::from_str(text).ok()))
    }

    /// `assignConversation({ departmentId, mode })`: the agent, or `None`
    /// when nobody can take it (`/assign` then answers
    /// `{ error: 'no_agents_available' }`).
    pub async fn assign_conversation(
        &self,
        department_id: &str,
        mode: &str,
    ) -> Result<Option<Value>, PortError> {
        self.update(&department_key(department_id), "state", |stored| {
            let mut state = stored
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .unwrap_or_else(|| new_department_state(department_id));
            match assign_in(&mut state, mode) {
                Some(agent) => (Some(agent), serde_json::to_string(&state).ok()),
                None => (None, None),
            }
        })
        .await
    }

    /// `releaseConversation(agentId)`.
    pub async fn release_conversation(
        &self,
        department_id: &str,
        agent_id: &str,
    ) -> Result<(), PortError> {
        self.update(&department_key(department_id), "state", |stored| {
            let Some(mut state) = stored.and_then(|text| serde_json::from_str::<Value>(text).ok())
            else {
                return ((), None);
            };
            release_in(&mut state, agent_id);
            ((), serde_json::to_string(&state).ok())
        })
        .await
    }

    /// `syncAgents(departmentId, agents)`.
    pub async fn sync_agents(
        &self,
        department_id: &str,
        agents: &[Value],
    ) -> Result<(), PortError> {
        self.update(&department_key(department_id), "state", |stored| {
            let mut state = stored
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .unwrap_or_else(|| new_department_state(department_id));
            sync_in(&mut state, agents);
            ((), serde_json::to_string(&state).ok())
        })
        .await
    }
}

fn department_key(department_id: &str) -> String {
    format!("department:{department_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use weldsuite_ports::MemoryLedgerStore;

    fn request(mode: PickMode, candidates: &[(&str, i64)], max_open: Option<i64>) -> PickRequest {
        PickRequest {
            mode,
            candidates: candidates
                .iter()
                .map(|(user_id, open)| PickCandidate {
                    user_id: (*user_id).to_owned(),
                    open: *open,
                })
                .collect(),
            max_open,
        }
    }

    #[tokio::test]
    async fn concurrent_picks_never_share_a_slot() {
        let router = AssignmentRouter::new(Arc::new(MemoryLedgerStore::new()));
        let ask = request(
            PickMode::Balanced,
            &[("user_a", 0), ("user_b", 0), ("user_c", 0)],
            Some(1),
        );
        let picks = futures_join(&router, &ask, 5).await;
        let mut taken: Vec<String> = picks.into_iter().flatten().collect();
        taken.sort();
        assert_eq!(taken, ["user_a", "user_b", "user_c"]);
    }

    async fn futures_join(
        router: &AssignmentRouter,
        ask: &PickRequest,
        n: usize,
    ) -> Vec<Option<String>> {
        let mut handles = Vec::new();
        for _ in 0..n {
            let router = router.clone();
            let ask = ask.clone();
            handles.push(tokio::spawn(async move {
                router
                    .pick_desk_assignee("ws_1", &ask)
                    .await
                    .expect("a pick")
            }));
        }
        let mut out = Vec::new();
        for handle in handles {
            out.push(handle.await.expect("the task ran"));
        }
        out
    }

    #[tokio::test]
    async fn workspaces_rotate_on_their_own() {
        let router = AssignmentRouter::new(Arc::new(MemoryLedgerStore::new()));
        let ask = request(PickMode::RoundRobin, &[("user_b", 0), ("user_a", 0)], None);
        let pick = |ws: &'static str| {
            let router = router.clone();
            let ask = ask.clone();
            async move { router.pick_desk_assignee(ws, &ask).await.expect("a pick") }
        };
        assert_eq!(pick("ws_1").await.as_deref(), Some("user_a"));
        assert_eq!(pick("ws_1").await.as_deref(), Some("user_b"));
        assert_eq!(pick("ws_2").await.as_deref(), Some("user_a"));
        assert_eq!(pick("ws_1").await.as_deref(), Some("user_a"));
    }
}
