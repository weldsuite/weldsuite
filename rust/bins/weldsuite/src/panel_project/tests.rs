//! The adapters against throwaway services (skipped without them): the
//! tenant schema (`WELDSUITE_TEST_TENANT_URL`; each test keeps to projects
//! of its own) and Valkey (`WELDSUITE_TEST_VALKEY_URL`) for the live view
//! and the collector's lists.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use serde_json::{Map, Value, json};
use weldsuite_panel::project_state::{
    DeleteGroupInput, EraseInput, GroupOp, GroupOpsInput, IdentifyInput, ListGroupsInput,
    ListPeopleInput, LiveTouch, PeopleOp, PeopleOpsInput,
};
use weldsuite_panel::{PanelProjectState, ProjectRef};
use weldsuite_ports::{BoxFuture, DynEventBus, PortError, RecordingEventBus};

use super::rows::RowSink;
use super::rules::{LIVE_MINUTES, iso, iso_millis};
use super::{Clock, PanelValkey, TenantPools, TenantProjectState};
use crate::panel_test_support::{ScratchTenant, unique};

/// One database for every workspace but `ws_gone`.
pub(crate) struct OnePool(pub(crate) sqlx::PgPool);

impl TenantPools for OnePool {
    fn pool<'a>(
        &'a self,
        workspace_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<sqlx::PgPool>, PortError>> {
        let pool = (workspace_id != "ws_gone").then(|| self.0.clone());
        Box::pin(std::future::ready(Ok(pool)))
    }
}

/// A clock the test moves.
pub(crate) fn clock(at: &Arc<AtomicI64>) -> Clock {
    let at = Arc::clone(at);
    Arc::new(move || at.load(Ordering::SeqCst))
}

const T0: &str = "2026-11-18T10:00:00.000Z";

fn start() -> Arc<AtomicI64> {
    Arc::new(AtomicI64::new(iso_millis(T0).expect("a time")))
}

fn props(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => panic!("an object"),
    }
}

fn state(
    pool: &sqlx::PgPool,
    bus: &Arc<RecordingEventBus>,
    now: &Arc<AtomicI64>,
) -> TenantProjectState {
    TenantProjectState {
        pools: Arc::new(OnePool(pool.clone())),
        rows: RowSink::new(Some(Arc::clone(bus) as Arc<dyn DynEventBus>)),
        valkey: None,
        clock: clock(now),
    }
}

fn identify(project: ProjectRef<'_>, anon: &str, user: &str) -> IdentifyInput {
    IdentifyInput {
        workspace_id: project.workspace_id.to_owned(),
        project_id: project.project_id.to_owned(),
        anon_id: anon.to_owned(),
        user_id: user.to_owned(),
        ts: T0.to_owned(),
    }
}

fn people(project: ProjectRef<'_>, ops: Vec<PeopleOp>) -> PeopleOpsInput {
    PeopleOpsInput {
        workspace_id: project.workspace_id.to_owned(),
        project_id: project.project_id.to_owned(),
        ops,
    }
}

fn set(user: &str, values: Value) -> PeopleOp {
    PeopleOp::Set {
        user_id: user.to_owned(),
        ts: T0.to_owned(),
        props: props(values),
    }
}

/// The subjects and payloads published so far, then forgotten.
fn drain(bus: &RecordingEventBus) -> Vec<(String, Value)> {
    let out = bus
        .messages()
        .into_iter()
        .map(|message| {
            let subject = message.subject.clone();
            (subject, message.payload_json().expect("json"))
        })
        .collect();
    bus.clear();
    out
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one project's people, in order
async fn people_identities_and_pages_follow_the_object() {
    let Some(tenant) = ScratchTenant::new().await else {
        return;
    };
    let bus = Arc::new(RecordingEventBus::default());
    let now = start();
    let state = state(&tenant.pool, &bus, &now);
    let project_id = unique("pnp_people");
    let p = ProjectRef {
        workspace_id: "ws_1",
        project_id: &project_id,
    };

    // A new link makes the person: an identities_v1 and a people_v1 row.
    let linked = state
        .identify(p, &identify(p, "a-1", "u-1"))
        .await
        .expect("identify");
    assert!(linked.linked);
    let rows = drain(&bus);
    assert_eq!(rows[0].0, "panel.identities.v1.ws_1");
    assert_eq!(
        rows[0].1,
        json!({ "workspace_id": "ws_1", "project_id": project_id.as_str(), "anon_id": "a-1", "user_id": "u-1", "ts": T0 })
    );
    assert_eq!(rows[1].0, "panel.people.v1.ws_1");
    assert_eq!(rows[1].1["version"], 1);
    assert_eq!(rows[1].1["properties"], format!(r#"{{"$created":"{T0}"}}"#));
    // The first link wins; the same link again changes nothing but the time.
    assert!(
        !state
            .identify(p, &identify(p, "a-1", "u-2"))
            .await
            .expect("identify")
            .linked
    );
    assert!(
        state
            .identify(p, &identify(p, "a-1", "u-1"))
            .await
            .expect("identify")
            .linked
    );
    assert_eq!(drain(&bus), []);
    assert!(
        !state
            .identify(p, &identify(p, "", "u-1"))
            .await
            .expect("identify")
            .linked
    );
    now.fetch_add(1_000, Ordering::SeqCst);
    assert!(
        state
            .identify(p, &identify(p, "a-0", "u-1"))
            .await
            .expect("identify")
            .linked
    );
    assert_eq!(drain(&bus).len(), 1, "only the link: the person exists");

    // Profile operations: one row per changed profile, the last state.
    state
        .apply_people_ops(
            p,
            &people(
                p,
                vec![
                    set(
                        "u-1",
                        json!({ "$email": " Ann@Example.com ", "$name": "Ann", "plan": "pro" }),
                    ),
                    PeopleOp::Increment {
                        user_id: "u-1".into(),
                        ts: T0.into(),
                        props: props(json!({ "logins": 2 })),
                    },
                    set("u-2", json!({ "$email": "bob@example.com" })),
                ],
            ),
        )
        .await
        .expect("people ops");
    let rows = drain(&bus);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].1["user_id"], "u-1");
    assert_eq!(rows[0].1["version"], 3, "the counter moves per change");
    let ann: Value =
        serde_json::from_str(rows[0].1["properties"].as_str().expect("text")).expect("json");
    assert_eq!(ann["$email"], "ann@example.com");
    assert_eq!(ann["logins"], 2);
    // An operation that changes nothing writes no row.
    state
        .apply_people_ops(p, &people(p, vec![set("u-1", json!({ "plan": "pro" }))]))
        .await
        .expect("people ops");
    assert_eq!(drain(&bus), []);

    let by_anon = state
        .get_person(p, "a-1")
        .await
        .expect("a person")
        .expect("found");
    assert_eq!(by_anon.user_id, "u-1");
    assert_eq!(by_anon.email.as_deref(), Some("ann@example.com"));
    assert_eq!(by_anon.name.as_deref(), Some("Ann"));
    assert_eq!(by_anon.anon_ids, ["a-0", "a-1"], "by link time, then id");
    assert!(
        state
            .get_person(p, "nobody")
            .await
            .expect("a person")
            .is_none()
    );
    let found = state
        .find_by_email(p, "  ANN@example.COM")
        .await
        .expect("found");
    assert_eq!(found.len(), 1);
    // Another project of the workspace sees none of it.
    let other_id = unique("pnp_other");
    let other = ProjectRef {
        workspace_id: "ws_1",
        project_id: &other_id,
    };
    assert!(
        state
            .get_person(other, "u-1")
            .await
            .expect("a person")
            .is_none()
    );
    assert!(!state.has_identified_users(other).await.expect("flag"));
    assert!(state.has_identified_users(p).await.expect("flag"));

    // Pages: most recently seen first, the user id breaking ties (bytes).
    for (n, user) in ["c-3", "c-1", "C-2", "c-0"].iter().enumerate() {
        now.fetch_add(if n == 2 { 0 } else { 1_000 }, Ordering::SeqCst);
        state
            .apply_people_ops(p, &people(p, vec![set(user, json!({ "n": n }))]))
            .await
            .expect("people ops");
    }
    let page = |cursor: Option<Option<String>>, search: Option<&str>| ListPeopleInput {
        search: search.map(str::to_owned),
        cursor,
        limit: 2,
    };
    let first = state
        .list_people(p, &page(None, None))
        .await
        .expect("a page");
    assert_eq!(first.total_count, 6);
    let ids = |page: &weldsuite_panel::project_state::PeoplePage| -> Vec<String> {
        page.people
            .iter()
            .map(|person| person.user_id.clone())
            .collect()
    };
    assert_eq!(ids(&first), ["c-0", "c-1"]);
    let second = state
        .list_people(p, &page(Some(first.cursor.clone()), None))
        .await
        .expect("a page");
    assert_eq!(
        ids(&second),
        ["C-2", "c-3"],
        "the tie at one time goes on in byte order"
    );
    let third = state
        .list_people(p, &page(Some(second.cursor.clone()), None))
        .await
        .expect("a page");
    assert_eq!(ids(&third), ["u-2", "u-1"]);
    assert_eq!(third.cursor, None);
    // Search: user id, email or name, ASCII case folded, wildcards literal.
    let search = state
        .list_people(p, &page(None, Some(" c-")))
        .await
        .expect("a page");
    assert_eq!(search.total_count, 4);
    let search = state
        .list_people(p, &page(None, Some("EXAMPLE")))
        .await
        .expect("a page");
    assert_eq!(search.total_count, 2);
    let search = state
        .list_people(p, &page(None, Some("%")))
        .await
        .expect("a page");
    assert_eq!(search.total_count, 0);
    // A cursor that isn't one starts from the top.
    let garbage = state
        .list_people(p, &page(Some(Some("not a cursor".into())), None))
        .await
        .expect("a page");
    assert_eq!(ids(&garbage), ["c-0", "c-1"]);
    tenant.finish().await;
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one project's groups, in order
async fn group_slots_operations_and_pages_follow_the_object() {
    let Some(tenant) = ScratchTenant::new().await else {
        return;
    };
    let bus = Arc::new(RecordingEventBus::default());
    let now = start();
    let state = state(&tenant.pool, &bus, &now);
    let project_id = unique("pnp_groups");
    let p = ProjectRef {
        workspace_id: "ws_1",
        project_id: &project_id,
    };
    let types = |list: &[&str]| -> Vec<String> { list.iter().map(|t| (*t).to_owned()).collect() };

    assert_eq!(
        state
            .ensure_group_types(p, &types(&["company", "Bad", "team"]))
            .await
            .expect("types"),
        ["company", "team"]
    );
    let op = |group_type: &str, key: &str, values: Value| GroupOp::Set {
        group_type: group_type.to_owned(),
        group_key: key.to_owned(),
        props: props(values),
    };
    let input = GroupOpsInput {
        workspace_id: "ws_1".into(),
        project_id: project_id.clone(),
        ops: vec![
            op(
                "company",
                "acme",
                json!({ "$name": "Acme Inc", "plan": "pro" }),
            ),
            op("org", "o1", json!({ "name": "Org One" })),
            op("a", "x", json!({})),
            op("b", "y", json!({ "flag": true })),
            op("c", "z", json!({})),
            op("company", "", json!({})),
            op("company", "acme", json!({ "seats": 3 })),
        ],
    };
    let result = state.apply_group_ops(p, &input).await.expect("group ops");
    // `c` finds no slot; the empty key is dropped.
    assert_eq!(result.types, ["company", "team", "org", "a", "b"]);
    assert_eq!((result.applied, result.dropped), (5, 2));
    let rows = drain(&bus);
    assert_eq!(rows.len(), 4, "one row per changed group");
    assert!(
        rows.iter()
            .all(|(subject, _)| subject == "panel.groups.v1.ws_1")
    );
    let acme: Value =
        serde_json::from_str(rows[0].1["properties"].as_str().expect("text")).expect("json");
    assert_eq!(
        acme,
        json!({ "$name": "Acme Inc", "plan": "pro", "seats": 3 })
    );
    assert_eq!(state.group_types(p).await.expect("types"), result.types);

    // A released slot goes; the type comes back last when taken again.
    state.release_group_type(p, "team").await.expect("release");
    assert_eq!(
        state
            .ensure_group_types(p, &types(&["team", "c"]))
            .await
            .expect("types"),
        ["company", "org", "a", "b", "team"]
    );

    // Pages and search on the key and the `$name` / `name` property.
    now.fetch_add(1_000, Ordering::SeqCst);
    let more = GroupOpsInput {
        ops: vec![
            op("company", "globex", json!({ "name": "Globex" })),
            op("company", "initech", json!({ "$name": true })),
        ],
        ..input.clone()
    };
    state.apply_group_ops(p, &more).await.expect("group ops");
    let list = |search: Option<&str>, cursor: Option<Option<String>>| ListGroupsInput {
        group_type: "company".into(),
        search: search.map(str::to_owned),
        cursor,
        limit: 1,
    };
    let first = state
        .list_groups(p, &list(None, None))
        .await
        .expect("a page");
    assert_eq!(first.total_count, 3);
    assert_eq!(first.groups[0].group_key, "initech");
    let second = state
        .list_groups(p, &list(None, Some(first.cursor.clone())))
        .await
        .expect("a page");
    assert_eq!(second.groups[0].group_key, "globex");
    let third = state
        .list_groups(p, &list(None, Some(second.cursor.clone())))
        .await
        .expect("a page");
    assert_eq!(third.groups[0].group_key, "acme");
    assert_eq!(third.cursor, None);
    for (search, count) in [("ACME", 1), ("globe", 1), ("inc", 1), ("1", 1), ("zzz", 0)] {
        let page = state
            .list_groups(p, &list(Some(search), None))
            .await
            .expect("a page");
        assert_eq!(page.total_count, count, "{search}");
    }
    let acme = state
        .get_group(p, "company", "acme")
        .await
        .expect("a group")
        .expect("found");
    assert_eq!(acme.properties["seats"], 3);

    drain(&bus);
    let delete = DeleteGroupInput {
        workspace_id: "ws_1".into(),
        project_id: project_id.clone(),
        group_type: "company".into(),
        group_key: "acme".into(),
    };
    assert!(state.delete_group(p, &delete).await.expect("delete"));
    let rows = drain(&bus);
    assert_eq!(rows[0].1["deleted"], true);
    assert_eq!(rows[0].1["properties"], "{}");
    assert!(!state.delete_group(p, &delete).await.expect("delete"));
    assert!(
        state
            .get_group(p, "company", "acme")
            .await
            .expect("a group")
            .is_none()
    );
    tenant.finish().await;
}

#[tokio::test]
async fn an_erasure_excludes_at_once_and_is_released_later() {
    let Some(tenant) = ScratchTenant::new().await else {
        return;
    };
    let bus = Arc::new(RecordingEventBus::default());
    let now = start();
    let state = state(&tenant.pool, &bus, &now);
    let project_id = unique("pnp_erase");
    let p = ProjectRef {
        workspace_id: "ws_1",
        project_id: &project_id,
    };
    for anon in ["a-1", "a-2"] {
        state
            .identify(p, &identify(p, anon, "u-1"))
            .await
            .expect("identify");
    }
    state
        .identify(p, &identify(p, "a-9", "u-9"))
        .await
        .expect("identify");
    drain(&bus);

    let erase = |id: &str| EraseInput {
        workspace_id: "ws_1".into(),
        project_id: project_id.clone(),
        user_id_or_anon_id: id.to_owned(),
    };
    // An anonymous id resolves to its user, and takes the user's links along.
    let erasure = state.erase(p, &erase("a-2")).await.expect("erase");
    assert_eq!(erasure.user_id.as_deref(), Some("u-1"));
    assert_eq!(erasure.erased_ids, ["a-2", "u-1", "a-1"]);
    let rows = drain(&bus);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1["deleted"], true);
    assert!(
        state
            .get_person(p, "u-1")
            .await
            .expect("a person")
            .is_none()
    );
    assert_eq!(
        state.erased_ids(p).await.expect("ids"),
        ["a-1", "a-2", "u-1"]
    );
    // Erased ids never link again, and their operations are skipped.
    assert!(
        !state
            .identify(p, &identify(p, "a-3", "u-1"))
            .await
            .expect("identify")
            .linked
    );
    state
        .apply_people_ops(p, &people(p, vec![set("u-1", json!({ "x": 1 }))]))
        .await
        .expect("people ops");
    assert!(
        state
            .get_person(p, "u-1")
            .await
            .expect("a person")
            .is_none()
    );
    // An id nobody knows is still erased.
    let unknown = state.erase(p, &erase("ghost")).await.expect("erase");
    assert_eq!(unknown.user_id, None);
    assert_eq!(unknown.erased_ids, ["ghost"]);
    // Erasing again changes nothing: the profile and links are gone already.
    let again = state.erase(p, &erase("a-2")).await.expect("erase");
    assert_eq!(again.user_id, None);
    assert_eq!(again.erased_ids, ["a-2"]);
    assert_eq!(drain(&bus), []);
    // The other user is untouched.
    assert!(
        state
            .get_person(p, "a-9")
            .await
            .expect("a person")
            .is_some()
    );

    // The rewrite done, the ids stop being excluded.
    state
        .clear_erased(p, &["a-1".to_owned(), "ghost".to_owned()])
        .await
        .expect("clear");
    assert_eq!(state.erased_ids(p).await.expect("ids"), ["a-2", "u-1"]);
    // A deleted workspace has no database.
    let gone = ProjectRef {
        workspace_id: "ws_gone",
        project_id: &project_id,
    };
    assert!(state.erased_ids(gone).await.is_err());
    tenant.finish().await;
}

/// Valkey under a prefix of its own, or `None` (the test skips).
pub(crate) async fn scratch_valkey() -> Option<PanelValkey> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_VALKEY_URL") else {
        eprintln!("skipped: WELDSUITE_TEST_VALKEY_URL is not set");
        return None;
    };
    let connection = weldsuite_adapters_oss::connect_valkey(&url)
        .await
        .expect("valkey");
    Some(PanelValkey::new(
        connection,
        format!("test:{}:", unique("panel")),
    ))
}

fn touch(session: &str, visitor: &str, path: &str, at_ms: i64) -> LiveTouch {
    LiveTouch {
        session_id: session.to_owned(),
        distinct_id: visitor.to_owned(),
        path: path.to_owned(),
        title: None,
        country: Some("NL".to_owned()),
        device_type: Some("desktop".to_owned()),
        ts: iso(at_ms),
    }
}

#[tokio::test]
async fn the_live_view_keeps_thirty_minutes_counts_five_and_drops_erased_visitors() {
    let Some(valkey) = scratch_valkey().await else {
        return;
    };
    let Some(tenant) = ScratchTenant::new().await else {
        return;
    };
    let bus = Arc::new(RecordingEventBus::default());
    let now = start();
    let t0 = now.load(Ordering::SeqCst);
    let state = TenantProjectState {
        valkey: Some(valkey.clone()),
        ..state(&tenant.pool, &bus, &now)
    };
    let project_id = unique("pnp_live");
    let p = ProjectRef {
        workspace_id: "ws_1",
        project_id: &project_id,
    };
    let touches = [
        touch("s-1", "v-1", "/", t0 - 10_000),
        touch("s-1", "v-1", "/", t0 - 5_000),
        touch("s-1", "v-1", "/pricing", t0 - 4_000),
        // An older touch keeps the later time.
        touch("s-1", "v-1", "/pricing", t0 - 9_000),
        touch("s-2", "v-1", "/", t0 - 3_000),
        touch("s-3", "v-3", "/docs", t0 - 2_000),
        // In the 30-minute window, not in the last five.
        touch("s-mid", "v-mid", "/", t0 - 20 * 60_000),
        // Left the window already.
        touch("s-old", "v-old", "/", t0 - 31 * 60_000),
    ];
    state.touch_live(p, &touches).await.expect("touched");
    let live = state.live(p).await.expect("live");
    assert_eq!((live.visitors, live.visitors_30m), (2, 3));
    // v-mid in the minute 20 minutes back, v-1 and v-3 in the last one.
    let mut per_minute = vec![0; LIVE_MINUTES];
    per_minute[10] = 1;
    per_minute[29] = 2;
    assert_eq!(live.per_minute, per_minute);
    let sessions: Vec<(&str, u64, &str)> = live
        .sessions
        .iter()
        .map(|s| {
            (
                s.touch.session_id.as_str(),
                s.pageviews,
                s.touch.path.as_str(),
            )
        })
        .collect();
    assert_eq!(
        sessions,
        [
            ("s-3", 1, "/docs"),
            ("s-2", 1, "/"),
            ("s-1", 2, "/pricing"),
            ("s-mid", 1, "/"),
        ]
    );
    let s1 = &live.sessions[2];
    assert_eq!(s1.started_at, iso(t0 - 10_000));
    assert_eq!(s1.touch.ts, iso(t0 - 4_000));

    // Five minutes on, nobody counts as live now, but the sessions stay.
    now.fetch_add(5 * 60_000, Ordering::SeqCst);
    let later = state.live(p).await.expect("live");
    assert_eq!(
        (later.visitors, later.visitors_30m, later.sessions.len()),
        (0, 3, 4)
    );
    // Half an hour on, they have all left the window.
    now.fetch_add(25 * 60_000, Ordering::SeqCst);
    let gone = state.live(p).await.expect("live");
    assert_eq!(
        (gone.visitors, gone.visitors_30m, gone.sessions.len()),
        (0, 0, 0)
    );
    assert_eq!(gone.per_minute, vec![0; LIVE_MINUTES]);
    now.fetch_sub(30 * 60_000, Ordering::SeqCst);

    // An erasure drops its sessions; once the collector's list is known, a
    // touch of an erased id is refused.
    state
        .identify(p, &identify(p, "v-3", "u-3"))
        .await
        .expect("identify");
    let erase = EraseInput {
        workspace_id: "ws_1".into(),
        project_id: p.project_id.to_owned(),
        user_id_or_anon_id: "u-3".into(),
    };
    state.erase(p, &erase).await.expect("erase");
    assert_eq!(state.live(p).await.expect("live").visitors, 1);
    assert!(
        valkey
            .touch(p.project_id, &[touch("s-4", "v-3", "/", t0)], t0)
            .await
            .expect("touched"),
        "the erased ids were known"
    );
    let live = state.live(p).await.expect("live");
    assert!(live.sessions.iter().all(|s| s.touch.distinct_id != "v-3"));
    tenant.finish().await;
}
