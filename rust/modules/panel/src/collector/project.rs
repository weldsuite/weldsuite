//! What the collector tells the project's `PanelProject` state
//! ([`PanelProjectState`]), as panel-ingest's `lib/groups.ts`,
//! `lib/profiles.ts` and `lib/live.ts` call the Durable Object:
//!
//! - **groups:** a batch's group profile operations, then the project's group
//!   types, which decide the events' `$group_<type>` properties (at most
//!   [`MAX_GROUP_TYPES`]; a type takes a slot the first time data names it,
//!   while slots are free). The types are remembered per process for a few
//!   minutes, so a batch asks only when it names a type not known yet and
//!   slots may be free. Without the state, or when the call fails, the
//!   properties stay as sent: the limit protects the reports, it must not
//!   lose data on a hiccup;
//! - **people:** `$identify` links and profile operations, personal data
//!   applied only from a consenting browser batch (the server API has no
//!   browser, so no consent to wait for);
//! - **the live view:** the sessions a batch shows, collected per process
//!   and sent at most every few seconds per project.
//!
//! A failing call is logged with ids only and never fails the request.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::Value;

use super::rows::{correct_timestamp, iso_millis};
use super::wire::EventBatch;
use super::{log_failure_for, warn_once};
use crate::js::Js;
use crate::project_state::{
    GroupOp, GroupOpsInput, IdentifyInput, LiveTouch, PanelProjectState, PeopleOp, PeopleOpsInput,
    ProjectRef,
};

/// Group types one project collects (`MAX_GROUP_TYPES` in `wire.ts`).
pub(crate) const MAX_GROUP_TYPES: usize = 5;
/// How long a project's group types are believed (`TYPES_TTL_MS`).
const TYPES_TTL_MS: i64 = 5 * 60 * 1000;
/// Projects one process remembers group types and live sends for; more and
/// it starts over (`MAX_REMEMBERED_PROJECTS`).
const MAX_REMEMBERED_PROJECTS: usize = 2000;

/// `LIVE_FLUSH_INTERVAL_MS`: a project's touches go out at most this often.
pub(crate) const LIVE_FLUSH_INTERVAL_MS: i64 = 5 * 1000;
/// Per project: more pending sessions than this and the oldest is dropped.
const MAX_PENDING_SESSIONS: usize = 1000;
/// Per session: page path changes kept between two sends.
const MAX_PATH_CHANGES: usize = 5;
/// Events that don't show a visitor on a page: the leave beacon, the app
/// going to the background, web vitals (sent without the visitor's ids).
const LEAVING: &[&str] = &["$pageleave", "$app_backgrounded", "$webvitals"];

/// What one process keeps between requests for the project state (an
/// isolate's module state on Global).
#[derive(Default)]
pub(crate) struct ProjectCaches {
    group_types: Mutex<HashMap<String, (Vec<String>, i64)>>,
    live: Mutex<LiveState>,
}

impl ProjectCaches {
    /// `remember(projectId, types, now)`.
    fn remember(&self, project_id: &str, types: &[String], now: i64) {
        let mut known = self
            .group_types
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if known.len() >= MAX_REMEMBERED_PROJECTS {
            known.clear();
        }
        known.insert(project_id.to_owned(), (types.to_vec(), now));
    }

    /// The project's types remembered less than [`TYPES_TTL_MS`] ago.
    fn fresh_types(&self, project_id: &str, now: i64) -> Option<Vec<String>> {
        self.group_types
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(project_id)
            .filter(|(_, at)| now - at < TYPES_TTL_MS)
            .map(|(types, _)| types.clone())
    }
}

/// The state, or `None` with one warning per process (`projectObject(env)`).
fn project_object<'a>(
    state: Option<&'a Arc<dyn PanelProjectState>>,
    what: &str,
) -> Option<&'a Arc<dyn PanelProjectState>> {
    if state.is_none() {
        warn_once(
            "binding:PANEL_PROJECT",
            &format!("PANEL_PROJECT is not bound: the live view, identities{what} are off"),
        );
    }
    state
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/// `groupTypeOfProperty(key)`: the type a `$group_<type>` property names
/// (`/^\$group_([a-z][a-z0-9_]{0,31})$/`).
pub(crate) fn group_type_of_property(key: &str) -> Option<&str> {
    let kind = key.strip_prefix("$group_")?;
    let mut bytes = kind.bytes();
    let first = bytes.next()?;
    (first.is_ascii_lowercase()
        && kind.len() <= 32
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'))
    .then_some(kind)
}

/// An event's properties, as the batch holds them.
pub(crate) type EventProps = Option<Vec<(String, Js)>>;

/// `namedGroupTypes(events)`: the types the events' `$group_<type>`
/// properties name, in the order they first appear.
fn named_group_types(events: &[&mut EventProps]) -> Vec<String> {
    let mut types: Vec<String> = Vec::new();
    for props in events {
        for (key, _) in props.as_deref().unwrap_or_default() {
            if let Some(kind) = group_type_of_property(key)
                && !types.iter().any(|known| known == kind)
            {
                types.push(kind.to_owned());
            }
        }
    }
    types
}

/// `keepGroupProps(events, allowed)`: drops the `$group_<type>` properties
/// of types not in `allowed`; answers how many it dropped.
fn keep_group_props(events: &mut [&mut EventProps], allowed: &[String]) -> usize {
    let mut dropped = 0;
    for props in events {
        let Some(props) = props.as_mut() else {
            continue;
        };
        props.retain(|(key, _)| {
            let keep = group_type_of_property(key)
                .is_none_or(|kind| allowed.iter().any(|allowed| allowed == kind));
            if !keep {
                dropped += 1;
            }
            keep
        });
    }
    dropped
}

/// `settleGroupTypes(env, project, ops, named, now)`: applies the batch's
/// group operations (when there are any) and answers the project's group
/// types, asking only when needed; `None` when the types can't be known (no
/// state, or the call failed).
async fn settle_group_types(
    state: Option<&Arc<dyn PanelProjectState>>,
    project: ProjectRef<'_>,
    ops: &[GroupOp],
    named: &[String],
    now: i64,
    caches: &ProjectCaches,
) -> Option<Vec<String>> {
    if ops.is_empty() && named.is_empty() {
        return Some(Vec::new());
    }
    let state = project_object(state, ", people and groups")?;
    let mut types: Option<Vec<String>> = None;
    if !ops.is_empty() {
        let input = GroupOpsInput {
            workspace_id: project.workspace_id.to_owned(),
            project_id: project.project_id.to_owned(),
            ops: ops.to_vec(),
        };
        match state.apply_group_ops(project, &input).await {
            Ok(result) => {
                caches.remember(project.project_id, &result.types, now);
                if result.dropped > 0 {
                    warn_once(
                        &format!("groups:ops:{}", project.project_id),
                        &format!(
                            "Project {}: {} group operation(s) dropped (a type past its {MAX_GROUP_TYPES}, or too large)",
                            project.project_id, result.dropped
                        ),
                    );
                }
                types = Some(result.types);
            }
            Err(error) => log_failure_for("Group update", project.project_id, &error),
        }
    }
    if named.is_empty() {
        return types;
    }
    let known = types.or_else(|| caches.fresh_types(project.project_id, now));
    if let Some(known) = &known
        && (named.iter().all(|kind| known.contains(kind)) || known.len() >= MAX_GROUP_TYPES)
    {
        return Some(known.clone());
    }
    match state.ensure_group_types(project, named).await {
        Ok(taken) => {
            caches.remember(project.project_id, &taken, now);
            Some(taken)
        }
        Err(error) => {
            log_failure_for("Group types lookup", project.project_id, &error);
            known
        }
    }
}

/// `limitGroups(env, project, events, ops, now)`: the events' properties
/// limited to the project's group types, after the batch's group operations.
pub(crate) async fn limit_groups(
    state: Option<&Arc<dyn PanelProjectState>>,
    project: ProjectRef<'_>,
    mut events: Vec<&mut EventProps>,
    ops: &[GroupOp],
    now: i64,
    caches: &ProjectCaches,
) {
    let named = named_group_types(&events);
    let allowed = settle_group_types(state, project, ops, &named, now, caches).await;
    let Some(allowed) = allowed.filter(|_| !named.is_empty()) else {
        return;
    };
    let dropped = keep_group_props(&mut events, &allowed);
    if dropped > 0 {
        warn_once(
            &format!("groups:props:{}", project.project_id),
            &format!(
                "Project {}: $group_ properties of a type past its {MAX_GROUP_TYPES} dropped ({dropped} in this batch)",
                project.project_id
            ),
        );
    }
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/// `applyBatchPeople(env, project, batch, receivedAt)`: the `$identify`
/// links and profile operations of a consented browser batch.
pub(crate) async fn apply_batch_people(
    state: Option<&Arc<dyn PanelProjectState>>,
    project: ProjectRef<'_>,
    batch: &EventBatch,
    received_at: i64,
) {
    if !batch.consent {
        return;
    }
    let identifies: Vec<_> = batch
        .events
        .iter()
        .filter(|event| {
            event.name == "$identify"
                && filled(event.anon_id.as_deref())
                && filled(event.user_id.as_deref())
        })
        .collect();
    if identifies.is_empty() && batch.people.is_empty() {
        return;
    }
    let Some(state) = project_object(state, " and people") else {
        return;
    };
    for event in identifies {
        let Some(at) = correct_timestamp(&event.ts, &batch.sent_at, received_at) else {
            log_failure_for("Identify", project.project_id, &"an unreadable time");
            continue;
        };
        identify(
            state,
            project,
            event.anon_id.as_deref().unwrap_or_default(),
            event.user_id.as_deref().unwrap_or_default(),
            at,
        )
        .await;
    }
    apply_people(state, project, &batch.people).await;
}

/// A JavaScript-truthy id: present and not empty.
pub(crate) fn filled(id: Option<&str>) -> bool {
    id.is_some_and(|id| !id.is_empty())
}

/// `stub.identify({ ... })`, a failure logged.
pub(crate) async fn identify(
    state: &Arc<dyn PanelProjectState>,
    project: ProjectRef<'_>,
    anon_id: &str,
    user_id: &str,
    at: i64,
) {
    let input = IdentifyInput {
        workspace_id: project.workspace_id.to_owned(),
        project_id: project.project_id.to_owned(),
        anon_id: anon_id.to_owned(),
        user_id: user_id.to_owned(),
        ts: iso_millis(at),
    };
    if let Err(error) = state.identify(project, &input).await {
        log_failure_for("Identify", project.project_id, &error);
    }
}

/// `stub.applyPeopleOps({ ... })` when there are operations, a failure logged.
pub(crate) async fn apply_people(
    state: &Arc<dyn PanelProjectState>,
    project: ProjectRef<'_>,
    ops: &[PeopleOp],
) {
    if ops.is_empty() {
        return;
    }
    let input = PeopleOpsInput {
        workspace_id: project.workspace_id.to_owned(),
        project_id: project.project_id.to_owned(),
        ops: ops.to_vec(),
    };
    if let Err(error) = state.apply_people_ops(project, &input).await {
        log_failure_for("People update", project.project_id, &error);
    }
}

/// [`project_object`] for the server API's people work.
pub(crate) fn people_object(
    state: Option<&Arc<dyn PanelProjectState>>,
) -> Option<&Arc<dyn PanelProjectState>> {
    project_object(state, " and people")
}

// ---------------------------------------------------------------------------
// The live view
// ---------------------------------------------------------------------------

/// The touches waiting to be sent and when each project last sent.
#[derive(Default)]
struct LiveState {
    pending: HashMap<String, Sessions>,
    last_flush: HashMap<String, i64>,
}

/// One project's pending sessions, the most recently seen last.
#[derive(Default)]
struct Sessions {
    next: u64,
    order: BTreeMap<u64, String>,
    paths: HashMap<String, (u64, Vec<LiveTouch>)>,
}

impl Sessions {
    /// `add(projectId, touch)`: a new path is appended (at most
    /// [`MAX_PATH_CHANGES`] kept), the same path replaces the last touch; the
    /// session moves to the end, and the oldest goes past
    /// [`MAX_PENDING_SESSIONS`].
    fn add(&mut self, touch: LiveTouch) {
        let mut path = match self.paths.remove(&touch.session_id) {
            Some((seq, path)) => {
                self.order.remove(&seq);
                path
            }
            None => Vec::new(),
        };
        let session_id = touch.session_id.clone();
        match path.last_mut() {
            Some(last) if last.path == touch.path => *last = touch,
            _ => {
                path.push(touch);
                if path.len() > MAX_PATH_CHANGES {
                    path.remove(0);
                }
            }
        }
        let seq = self.next;
        self.next += 1;
        self.order.insert(seq, session_id.clone());
        self.paths.insert(session_id, (seq, path));
        if self.paths.len() > MAX_PENDING_SESSIONS
            && let Some((_, oldest)) = self.order.pop_first()
        {
            self.paths.remove(&oldest);
        }
    }

    fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    /// Every pending touch, session by session in the order they were seen.
    fn into_touches(mut self) -> Vec<LiveTouch> {
        let order = std::mem::take(&mut self.order);
        order
            .into_values()
            .filter_map(|session| self.paths.remove(&session))
            .flat_map(|(_, path)| path)
            .collect()
    }
}

fn row_text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `toTouch(row)`: page-bound events only, not the leave beacon or the app
/// going to the background, not server events, and not web vitals.
fn to_touch(row: &Value) -> Option<LiveTouch> {
    let name = row_text(row, "name").unwrap_or_default();
    let path = row_text(row, "path").unwrap_or_default();
    if row_text(row, "lib") == Some("server") || LEAVING.contains(&name) || path.is_empty() {
        return None;
    }
    let text = |key: &str| row_text(row, key).unwrap_or_default().to_owned();
    let nullable = |key: &str| row_text(row, key).map(str::to_owned);
    Some(LiveTouch {
        session_id: row_text(row, "session_id")
            .or_else(|| row_text(row, "anon_id"))
            .unwrap_or_default()
            .to_owned(),
        distinct_id: text("distinct_id"),
        path: path.to_owned(),
        title: nullable("title"),
        country: nullable("country"),
        device_type: nullable("device_type"),
        ts: text("ts"),
    })
}

/// `trackLive(env, projectId, rows, now)`: notes the rows' sessions and sends
/// what is pending when the interval has passed.
pub(crate) async fn track_live(
    state: Option<&Arc<dyn PanelProjectState>>,
    project: ProjectRef<'_>,
    rows: &[Value],
    now: i64,
    caches: &ProjectCaches,
) {
    let Some(state) = project_object(state, " and people") else {
        return;
    };
    let touches = {
        let mut live = caches.live.lock().unwrap_or_else(PoisonError::into_inner);
        let touches: Vec<LiveTouch> = rows.iter().filter_map(to_touch).collect();
        if !touches.is_empty() {
            let sessions = live
                .pending
                .entry(project.project_id.to_owned())
                .or_default();
            for touch in touches {
                sessions.add(touch);
            }
        }
        if live
            .pending
            .get(project.project_id)
            .is_none_or(Sessions::is_empty)
        {
            return;
        }
        if live
            .last_flush
            .get(project.project_id)
            .is_some_and(|last| now - last < LIVE_FLUSH_INTERVAL_MS)
        {
            return;
        }
        let sessions = live.pending.remove(project.project_id).unwrap_or_default();
        if live.last_flush.len() >= MAX_REMEMBERED_PROJECTS {
            live.last_flush.clear();
        }
        live.last_flush.insert(project.project_id.to_owned(), now);
        sessions.into_touches()
    };
    if let Err(error) = state.touch_live(project, &touches).await {
        tracing::error!(
            project = %project.project_id,
            "[panel-ingest] Live view update failed for project {}: {error}",
            project.project_id
        );
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn props(entries: &[(&str, &str)]) -> Vec<(String, Js)> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), Js::String((*value).to_owned())))
            .collect()
    }

    #[test]
    fn reads_the_group_type_of_a_property() {
        assert_eq!(group_type_of_property("$group_company"), Some("company"));
        assert_eq!(group_type_of_property("$group_a1_b"), Some("a1_b"));
        for key in [
            "$group_",
            "$group_Company",
            "$group_1st",
            "group_company",
            "$group_abcdefghijklmnopqrstuvwxyz0123456",
        ] {
            assert_eq!(group_type_of_property(key), None, "{key}");
        }
    }

    #[test]
    fn keeps_only_the_allowed_group_properties_in_order() {
        let mut first = Some(props(&[
            ("$group_a", "k"),
            ("plan", "pro"),
            ("$group_f", "k"),
        ]));
        let mut second = Some(props(&[("$group_f", "x"), ("$group_b", "y")]));
        let mut none: EventProps = None;
        let mut events = vec![&mut first, &mut second, &mut none];
        assert_eq!(named_group_types(&events), ["a", "f", "b"]);
        let allowed = vec!["a".to_owned(), "b".to_owned()];
        assert_eq!(keep_group_props(&mut events, &allowed), 2);
        let keys = |props: &EventProps| {
            props
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|(key, _)| key.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(keys(&first), ["$group_a", "plan"]);
        assert_eq!(keys(&second), ["$group_b"]);
        assert!(none.is_none());
    }

    fn row(name: &str, session: Option<&str>, path: &str) -> Value {
        json!({
            "name": name, "lib": "web", "session_id": session, "anon_id": "a-1", "distinct_id": "a-1",
            "path": path, "title": null, "country": "NL", "device_type": "desktop",
            "ts": "2026-10-27T12:00:00.000Z",
        })
    }

    #[test]
    fn touches_only_page_bound_events() {
        let touch = to_touch(&row("$pageview", None, "/pricing")).expect("a touch");
        assert_eq!(touch.session_id, "a-1");
        assert_eq!(touch.title, None);
        assert_eq!(
            to_touch(&row("$pageview", Some("s-1"), "/")).map(|t| t.session_id),
            Some("s-1".to_owned())
        );
        for name in ["$pageleave", "$app_backgrounded", "$webvitals"] {
            assert!(to_touch(&row(name, Some("s-1"), "/")).is_none(), "{name}");
        }
        assert!(to_touch(&row("$pageview", Some("s-1"), "")).is_none());
        let mut server = row("Order placed", None, "/thanks");
        server["lib"] = json!("server");
        assert!(to_touch(&server).is_none());
    }

    fn touch(session: &str, path: &str) -> LiveTouch {
        to_touch(&row("$pageview", Some(session), path)).expect("a touch")
    }

    #[test]
    fn keeps_a_session_path_changes_in_order_and_the_latest_session_last() {
        let mut sessions = Sessions::default();
        for path in ["/", "/", "/a", "/b", "/c", "/d", "/e"] {
            sessions.add(touch("s-1", path));
        }
        sessions.add(touch("s-2", "/x"));
        sessions.add(touch("s-1", "/e"));
        let paths: Vec<(String, String)> = sessions
            .into_touches()
            .into_iter()
            .map(|t| (t.session_id, t.path))
            .collect();
        let expected: Vec<(String, String)> = [
            ("s-2", "/x"),
            ("s-1", "/a"),
            ("s-1", "/b"),
            ("s-1", "/c"),
            ("s-1", "/d"),
            ("s-1", "/e"),
        ]
        .iter()
        .map(|(s, p)| ((*s).to_owned(), (*p).to_owned()))
        .collect();
        assert_eq!(paths, expected);
    }

    #[test]
    fn drops_the_oldest_session_past_the_limit() {
        let mut sessions = Sessions::default();
        for n in 0..=MAX_PENDING_SESSIONS {
            sessions.add(touch(&format!("s-{n}"), "/"));
        }
        let touches = sessions.into_touches();
        assert_eq!(touches.len(), MAX_PENDING_SESSIONS);
        assert_eq!(touches[0].session_id, "s-1");
    }
}
