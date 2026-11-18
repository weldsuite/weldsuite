//! The monitoring services against the real schema: the tests of
//! `scheduled.test.ts`, `services/schedule.test.ts` (the registry),
//! `services/alerts.test.ts` (`runAlertCheck`), `services/exports.test.ts`
//! (`runExport`) and `services/delivery.test.ts` (`deliver`), on databases
//! built from the journaled migrations (`scripts/rust-test-db.ts`). They run
//! when `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL` are set;
//! otherwise each returns early. They share the databases, so they take
//! turns ([`LOCK`]).

// Each test walks one scenario through, step by step, as its TypeScript
// `describe` block does; `assert!(… .is_empty())` reads like the `toEqual([])` it ports.
#![allow(clippy::too_many_lines, clippy::similar_names, clippy::assert_is_empty)]

use std::io::Read as _;
use std::sync::{Arc, LazyLock, Mutex};

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_emails::EmailLocale;
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::query::export::PANEL_EXPORT_PAGE_SIZE;
use weldsuite_panel_domain::query::{PanelQueryContext, PanelSqlQuery, spec_cache_key};
use weldsuite_ports::{
    BoxFuture, Cache as _, DynOutboundHttp, HttpRequest, HttpResponse, MemoryCache, OutboundHttp,
    PortError, RecordingEventBus, RecordingSystemMail,
};

use super::alerts::{self, CheckPorts, Outcome};
use super::delivery::{
    self, Delivered, Delivery, Message, Recipient, SendOutcome, Senders, Target,
};
use super::exports::{self, ExportPorts};
use super::schedule::{
    LOCK_MS, claim_due, delete_schedule, next_runs_of, release_schedule, upsert_schedule,
};
use super::scheduled::{
    DefaultItems, ItemRunner, RETRY_MS, ScheduleDeps, ScheduleTenants, WorkspaceHandle,
    run_scheduled_with,
};
use super::{ScheduleRow, secrets};

static LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

fn databases() -> Option<(PgPool, PgPool)> {
    let master = std::env::var("WELDSUITE_TEST_MASTER_URL").ok()?;
    let tenant = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
    Some((
        weldsuite_db::master_pool(&master, 4).expect("master pool"),
        weldsuite_db::master_pool(&tenant, 4).expect("tenant pool"),
    ))
}

fn at(iso: &str) -> i64 {
    js::parse_iso(iso).expect("iso")
}

fn iso(millis: i64) -> String {
    js::iso_string(millis)
}

async fn exec(db: &PgPool, sql: &str) {
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned()))
        .execute(db)
        .await
        .expect("sql");
}

async fn registry(master: &PgPool) -> Vec<Value> {
    let rows: Vec<Value> = sqlx::query_scalar("select to_jsonb(r) from panel_schedule_registry r")
        .fetch_all(master)
        .await
        .expect("registry");
    rows.into_iter().map(weldsuite_db::js_row).collect()
}

const PROJECT: &str = "insert into panel_projects (id, name, token, settings, created_by_user_id)
    values ('pnp_a', 'Shop', 'wpk_a', '{}', 'user_alice') on conflict do nothing";

// ---------------------------------------------------------------------------
// The registry (`schedule.test.ts`)
// ---------------------------------------------------------------------------

async fn due(
    master: &PgPool,
    object_id: &str,
    minutes_ago: i64,
    now: i64,
    workspace: &str,
    kind: &str,
) {
    upsert_schedule(
        master,
        workspace,
        kind,
        object_id,
        Some(now - minutes_ago * 60_000),
    )
    .await
    .expect("upsert");
}

#[tokio::test]
async fn registry_upserts_claims_releases_and_deletes() {
    let Some((master, _)) = databases() else {
        eprintln!("test databases not set; skipping");
        return;
    };
    let _turn = LOCK.lock().await;
    let now = at("2026-11-16T10:00:00Z");

    // Upserts one row per object, and removes it for a null next run.
    exec(&master, "delete from panel_schedule_registry").await;
    due(&master, "pnal_1", 5, now, "ws_a", "alert").await;
    upsert_schedule(
        &master,
        "ws_a",
        "alert",
        "pnal_1",
        Some(at("2026-11-17T00:00:00Z")),
    )
    .await
    .expect("upsert");
    let rows = registry(&master).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["nextRunAt"], json!("2026-11-17T00:00:00.000Z"));
    assert_eq!(
        next_runs_of(&master, "alert", &["pnal_1".to_owned()])
            .await
            .expect("next"),
        vec![("pnal_1".to_owned(), "2026-11-17T00:00:00.000Z".to_owned())]
    );
    upsert_schedule(&master, "ws_a", "alert", "pnal_1", None)
        .await
        .expect("remove");
    assert!(registry(&master).await.is_empty());

    // Claims due rows oldest first, at most the limit, and only once.
    due(&master, "pnal_1", 30, now, "ws_a", "alert").await;
    due(&master, "pnal_2", 10, now, "ws_a", "alert").await;
    due(&master, "pnal_3", 20, now, "ws_a", "alert").await;
    upsert_schedule(&master, "ws_a", "alert", "pnal_future", Some(now + 60_000))
        .await
        .expect("upsert");
    let first = claim_due(&master, now, 2).await.expect("claim");
    let mut ids: Vec<&str> = first.iter().map(|r| r.object_id.as_str()).collect();
    ids.sort_unstable();
    assert_eq!(ids, ["pnal_1", "pnal_3"]);
    assert!(first.iter().all(|r| r.locked_until == Some(now + LOCK_MS)));
    let second = claim_due(&master, now, 50).await.expect("claim");
    assert_eq!(
        second
            .iter()
            .map(|r| r.object_id.as_str())
            .collect::<Vec<_>>(),
        ["pnal_2"]
    );
    assert!(claim_due(&master, now, 50).await.expect("claim").is_empty());

    // Takes a row again once its lock ran out (a run that died).
    exec(&master, "delete from panel_schedule_registry").await;
    due(&master, "pnal_1", 5, now, "ws_a", "alert").await;
    assert_eq!(claim_due(&master, now, 50).await.expect("claim").len(), 1);
    assert!(
        claim_due(&master, now + LOCK_MS - 1, 50)
            .await
            .expect("claim")
            .is_empty()
    );
    assert_eq!(
        claim_due(&master, now + LOCK_MS + 1, 50)
            .await
            .expect("claim")
            .len(),
        1
    );

    // Releases with the next run while the lock is held, and not after someone else took it.
    exec(&master, "delete from panel_schedule_registry").await;
    due(&master, "pnal_1", 5, now, "ws_a", "alert").await;
    let row = claim_due(&master, now, 50).await.expect("claim").remove(0);
    release_schedule(&master, &row, Some(at("2026-11-16T11:05:00Z")))
        .await
        .expect("release");
    let after = registry(&master).await;
    assert_eq!(after[0]["lockedUntil"], Value::Null);
    assert_eq!(after[0]["nextRunAt"], json!("2026-11-16T11:05:00.000Z"));
    due(&master, "pnal_2", 5, now, "ws_a", "alert").await;
    let stale = claim_due(&master, now, 50)
        .await
        .expect("claim")
        .into_iter()
        .find(|r| r.object_id == "pnal_2")
        .expect("pnal_2");
    claim_due(&master, now + LOCK_MS + 60_000, 50)
        .await
        .expect("claim");
    release_schedule(&master, &stale, None)
        .await
        .expect("release");
    assert!(
        registry(&master)
            .await
            .iter()
            .any(|r| r["objectId"] == "pnal_2")
    );

    // Deletes a row.
    exec(&master, "delete from panel_schedule_registry").await;
    due(&master, "pnsb_1", 5, now, "ws_a", "subscription").await;
    delete_schedule(&master, "subscription", "pnsb_1")
        .await
        .expect("delete");
    assert!(registry(&master).await.is_empty());
}

// ---------------------------------------------------------------------------
// The cron (`scheduled.test.ts`)
// ---------------------------------------------------------------------------

struct Opener {
    tenant: PgPool,
    opened: Mutex<Vec<String>>,
    suspended: Vec<&'static str>,
}

impl ScheduleTenants for Opener {
    fn open<'a>(&'a self, workspace_id: &'a str) -> BoxFuture<'a, Result<WorkspaceHandle, String>> {
        self.opened
            .lock()
            .expect("lock")
            .push(workspace_id.to_owned());
        let handle = WorkspaceHandle {
            db: self.tenant.clone(),
            workspace_id: workspace_id.to_owned(),
            clerk_org_id: format!("org_{workspace_id}"),
            suspended: self.suspended.contains(&workspace_id),
        };
        Box::pin(async move { Ok(handle) })
    }
}

fn deps(
    master: &PgPool,
    tenant: &PgPool,
    bus: &Arc<RecordingEventBus>,
    tracker: &TaskTracker,
    suspended: Vec<&'static str>,
) -> (ScheduleDeps, Arc<Opener>) {
    let opener = Arc::new(Opener {
        tenant: tenant.clone(),
        opened: Mutex::default(),
        suspended,
    });
    let deps = ScheduleDeps {
        master: master.clone(),
        tenants: opener.clone(),
        events: EntityEventPublisher::new(Some(bus.clone()), tracker.clone()),
        mail: None,
        http: None,
        realtime: None,
        cache: None,
        sql: None,
        project_state: None,
        domains: None,
        keyring: weldsuite_db::Keyring::default(),
        platform_url: None,
    };
    (deps, opener)
}

type RunFn = dyn Fn(&WorkspaceHandle, &ScheduleRow) -> BoxFuture<'static, Result<Option<i64>, String>>
    + Send
    + Sync;

struct Items(Box<RunFn>);

impl ItemRunner for Items {
    fn run<'a>(
        &'a self,
        ws: &'a WorkspaceHandle,
        row: &'a ScheduleRow,
        _now: i64,
        _deadline: i64,
    ) -> BoxFuture<'a, Result<Option<i64>, String>> {
        (self.0)(ws, row)
    }
}

#[tokio::test]
async fn the_cron_claims_runs_and_releases() {
    let Some((master, tenant)) = databases() else {
        eprintln!("test databases not set; skipping");
        return;
    };
    let _turn = LOCK.lock().await;
    let now = at("2026-11-16T10:20:00Z");
    let bus = Arc::new(RecordingEventBus::new());
    let tracker = TaskTracker::new();
    let next = at("2026-11-17T00:15:00Z");

    // Opens each workspace once, runs every claimed row, and writes the next run.
    exec(&master, "delete from panel_schedule_registry").await;
    due(&master, "pnal_1", 5, now, "ws_a", "alert").await;
    due(&master, "pnal_2", 5, now, "ws_a", "alert").await;
    due(&master, "pnal_3", 5, now, "ws_b", "alert").await;
    let (d, opener) = deps(&master, &tenant, &bus, &tracker, Vec::new());
    let ran = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = ran.clone();
    let items = Items(Box::new(move |ws, row| {
        seen.lock()
            .expect("lock")
            .push(format!("{}/{}", ws.workspace_id, row.object_id));
        Box::pin(async move { Ok(Some(next)) })
    }));
    let summary = run_scheduled_with(&d, &items, now, 60_000)
        .await
        .expect("run");
    assert_eq!(
        (
            summary.claimed,
            summary.ran,
            summary.failed,
            summary.deferred
        ),
        (3, 3, 0, 0)
    );
    let mut opened = opener.opened.lock().expect("lock").clone();
    opened.sort();
    assert_eq!(opened, ["ws_a", "ws_b"]);
    let mut ran = ran.lock().expect("lock").clone();
    ran.sort();
    assert_eq!(ran, ["ws_a/pnal_1", "ws_a/pnal_2", "ws_b/pnal_3"]);
    for row in registry(&master).await {
        assert_eq!(row["lockedUntil"], Value::Null);
        assert_eq!(row["nextRunAt"], json!(iso(next)));
    }
    let again = Items(Box::new(move |_, _| {
        Box::pin(async move { Ok(Some(next)) })
    }));
    assert_eq!(
        run_scheduled_with(&d, &again, now, 60_000)
            .await
            .expect("run")
            .claimed,
        0
    );

    // Never lets a second invocation take a row the first one holds.
    exec(&master, "delete from panel_schedule_registry").await;
    due(&master, "pnal_1", 5, now, "ws_a", "alert").await;
    let second = Arc::new(Mutex::new(None));
    let inner = Arc::new(d.clone());
    let record = second.clone();
    let nested = Items(Box::new(move |_, _| {
        let inner = inner.clone();
        let record = record.clone();
        Box::pin(async move {
            let none = Items(Box::new(|_, _| Box::pin(async { Ok(None) })));
            let summary = run_scheduled_with(&inner, &none, now, 60_000)
                .await
                .expect("run");
            *record.lock().expect("lock") = Some(summary.claimed);
            Ok(Some(at("2026-11-17T00:00:00Z")))
        })
    }));
    run_scheduled_with(&d, &nested, now, 60_000)
        .await
        .expect("run");
    assert_eq!(*second.lock().expect("lock"), Some(0));
    assert_eq!(registry(&master).await.len(), 1);

    // Retries a failing item later and carries on with the others.
    exec(&master, "delete from panel_schedule_registry").await;
    due(&master, "pnal_bad", 5, now, "ws_a", "alert").await;
    due(&master, "pnal_good", 5, now, "ws_a", "alert").await;
    let flaky = Items(Box::new(|_, row| {
        let bad = row.object_id == "pnal_bad";
        Box::pin(async move {
            if bad {
                Err("boom".to_owned())
            } else {
                Ok(Some(at("2026-11-17T00:00:00Z")))
            }
        })
    }));
    let summary = run_scheduled_with(&d, &flaky, now, 60_000)
        .await
        .expect("run");
    assert_eq!((summary.ran, summary.failed), (1, 1));
    let bad = registry(&master)
        .await
        .into_iter()
        .find(|r| r["objectId"] == "pnal_bad")
        .expect("bad");
    assert_eq!(bad["nextRunAt"], json!(iso(now + RETRY_MS)));
    assert_eq!(bad["lockedUntil"], Value::Null);

    // Leaves rows due when out of time, and defers a suspended workspace.
    exec(&master, "delete from panel_schedule_registry").await;
    due(&master, "pnal_1", 5, now, "ws_a", "alert").await;
    due(&master, "pnal_2", 5, now, "ws_frozen", "alert").await;
    let (frozen, _) = deps(&master, &tenant, &bus, &tracker, vec!["ws_frozen"]);
    let ran = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = ran.clone();
    let items = Items(Box::new(move |_, row| {
        seen.lock().expect("lock").push(row.object_id.clone());
        Box::pin(async { Ok(None) })
    }));
    let summary = run_scheduled_with(&frozen, &items, now, -1)
        .await
        .expect("run");
    assert!(ran.lock().expect("lock").is_empty());
    assert_eq!(summary.deferred, 2);
    let rows = registry(&master).await;
    let row = |id: &str| {
        rows.iter()
            .find(|r| r["objectId"] == id)
            .expect("row")
            .clone()
    };
    assert_eq!(row("pnal_1")["nextRunAt"], json!(iso(now - 5 * 60_000)));
    assert_eq!(row("pnal_1")["lockedUntil"], Value::Null);
    assert_eq!(row("pnal_2")["nextRunAt"], json!(iso(now + 60 * 60_000)));
}

/// Records the in-app sends instead of writing notifications.
#[derive(Default)]
struct InApp(Mutex<Vec<Value>>);

impl Senders for InApp {
    fn in_app<'a>(
        &'a self,
        _ctx: &'a Delivery,
        recipients: &'a [Recipient],
        message: &'a Message,
    ) -> BoxFuture<'a, SendOutcome> {
        if let Message::Alert {
            alert, entity_id, ..
        } = message
        {
            self.0.lock().expect("lock").push(json!({
                "entityId": entity_id, "event": alert.event.as_str(), "value": alert.value, "period": alert.period,
            }));
        }
        let sent = recipients.len() as u64;
        Box::pin(async move {
            SendOutcome {
                sent,
                failed: 0,
                error: None,
            }
        })
    }
}

#[tokio::test]
async fn the_cron_runs_the_items() {
    let Some((master, tenant)) = databases() else {
        eprintln!("test databases not set; skipping");
        return;
    };
    let _turn = LOCK.lock().await;
    let now = at("2026-11-16T10:20:00Z");
    exec(&master, "delete from panel_schedule_registry").await;
    exec(
        &tenant,
        "delete from panel_alerts; delete from panel_alert_events; delete from panel_subscriptions; delete from panel_projects;",
    )
    .await;
    exec(&tenant, PROJECT).await;
    exec(
        &tenant,
        "delete from workspace_members; insert into workspace_members (id, user_id, email, name, role, status) values ('wm_1', 'user_alice', 'alice@example.com', 'Alice', 'OWNER', 'ACTIVE')",
    )
    .await;
    let spec = json!({ "kind": "trends", "projectId": "pnp_a", "timezone": "UTC", "series": [{ "event": "Signed up", "label": "Signups" }] });
    let insert_alert = |enabled: bool| {
        format!(
            "insert into panel_alerts (id, project_id, name, spec, condition, check_interval, channels, enabled, owner_user_id)
             values ('pnal_1', 'pnp_a', 'Signups', '{spec}', '{{\"type\":\"threshold\",\"operator\":\"above\",\"value\":100}}', 'daily',
               '{{\"emailUserIds\":[],\"inApp\":true,\"slack\":false}}', {enabled}, 'user_alice')"
        )
    };

    // Checks a due alert: fires, publishes `fired`, delivers, and schedules the next check.
    exec(&tenant, &insert_alert(true)).await;
    due(&master, "pnal_1", 5, now, "ws_a", "alert").await;
    let bus = Arc::new(RecordingEventBus::new());
    let tracker = TaskTracker::new();
    let (mut d, _) = deps(&master, &tenant, &bus, &tracker, Vec::new());
    // The query's answer, in the cache under the key of the check's spec
    // (the TypeScript test mocks `runCachedQuery`).
    let cache = Arc::new(MemoryCache::new());
    let parsed = alerts::parse_trends_spec(&spec, "pnp_a").expect("spec");
    let window = alerts::check_window("daily", "threshold", "UTC", now);
    let check = alerts::check_spec(&parsed, &window).expect("check spec");
    let result = json!({ "kind": "trends", "result": {
        "range": { "from": "", "to": "", "timezone": "UTC", "clampedToRetention": false, "previousFrom": null, "previousTo": null },
        "interval": "day",
        "series": [{ "seriesIndex": 0, "label": "Signups", "breakdownValue": null, "total": 500, "points": [{ "bucket": "2026-11-15", "value": 500 }], "previous": null }]
    } });
    cache
        .put(
            &spec_cache_key("ws_a", "pnp_a", &check),
            &json!({ "result": result, "dataAsOf": "2026-11-16T10:00:00.000Z" }).to_string(),
            None,
        )
        .await
        .expect("cache");
    d.cache = Some(cache);
    let senders = Arc::new(InApp::default());
    let items = DefaultItems {
        deps: &d,
        senders: Some(senders.clone()),
    };
    let summary = run_scheduled_with(&d, &items, now, 60_000)
        .await
        .expect("run");
    assert_eq!((summary.claimed, summary.ran, summary.failed), (1, 1, 0));
    assert_eq!(
        senders.0.lock().expect("lock")[0],
        json!({ "entityId": "pnal_1", "event": "fired", "value": 500.0, "period": "2026-11-15" })
    );
    tracker.close();
    tracker.wait().await;
    let fired = bus
        .payloads()
        .into_iter()
        .find(|e| e["action"] == "fired")
        .expect("fired");
    assert_eq!(fired["entityType"], json!("panel_alert"));
    assert_eq!(fired["entityId"], json!("pnal_1"));
    assert_eq!(fired["metadata"]["workspaceId"], json!("org_ws_a"));
    assert_eq!(fired["metadata"]["userId"], json!("user_alice"));
    assert_eq!(fired["metadata"]["source"], json!("system"));
    assert_eq!(
        registry(&master).await[0]["nextRunAt"],
        json!("2026-11-17T00:15:00.000Z")
    );

    // Drops the registry row of an alert that is disabled or gone, and of a missing subscription.
    exec(&master, "delete from panel_schedule_registry").await;
    exec(&tenant, "delete from panel_alerts").await;
    exec(&tenant, &insert_alert(false)).await;
    due(&master, "pnal_1", 5, now, "ws_a", "alert").await;
    due(&master, "pnal_gone", 5, now, "ws_a", "alert").await;
    due(&master, "pnsb_gone", 5, now, "ws_a", "subscription").await;
    let items = DefaultItems {
        deps: &d,
        senders: None,
    };
    assert_eq!(
        run_scheduled_with(&d, &items, now, 60_000)
            .await
            .expect("run")
            .ran,
        3
    );
    assert!(registry(&master).await.is_empty());
}

// ---------------------------------------------------------------------------
// Alert checks (`alerts.test.ts`)
// ---------------------------------------------------------------------------

struct CheckFake {
    value: Result<f64, String>,
    delivered: Mutex<Vec<Value>>,
    published: Mutex<Vec<&'static str>>,
    ran: Mutex<Vec<Value>>,
}

impl CheckFake {
    fn new(value: Result<f64, String>) -> Self {
        Self {
            value,
            delivered: Mutex::default(),
            published: Mutex::default(),
            ran: Mutex::default(),
        }
    }
}

impl CheckPorts for CheckFake {
    fn run(&self, spec: Value) -> BoxFuture<'_, Result<Value, String>> {
        self.ran.lock().expect("lock").push(spec);
        let answer = self.value.clone().map(|value| {
            json!({ "kind": "trends", "result": { "series": [{ "seriesIndex": 0, "label": "Signups", "breakdownValue": null, "total": value, "points": [{ "bucket": "2026-11-17", "value": value }], "previous": null }] } })
        });
        Box::pin(async move { answer })
    }

    fn deliver<'a>(
        &'a self,
        _target: &'a Target,
        message: &'a Message,
    ) -> BoxFuture<'a, Vec<Delivered>> {
        if let Message::Alert {
            alert, entity_id, ..
        } = message
        {
            self.delivered.lock().expect("lock").push(json!({
                "entityId": entity_id, "event": alert.event.as_str(), "metric": alert.metric, "value": alert.value,
                "bound": alert.bound, "period": alert.period, "projectName": alert.project_name,
            }));
        }
        Box::pin(async {
            vec![Delivered {
                channel: "email",
                ok: true,
                recipients: 1,
                error: None,
            }]
        })
    }

    fn publish<'a>(&'a self, _alert: &'a Value, action: &'static str) -> BoxFuture<'a, ()> {
        self.published.lock().expect("lock").push(action);
        Box::pin(async {})
    }
}

async fn alert_row(tenant: &PgPool, set: &str) -> Value {
    exec(tenant, "delete from panel_alerts").await;
    exec(
        tenant,
        &format!(
            "insert into panel_alerts (id, project_id, name, spec, condition, check_interval, channels, owner_user_id)
             values ('pnal_1', 'pnp_a', 'Signups',
               '{{\"kind\":\"trends\",\"projectId\":\"pnp_a\",\"timezone\":\"UTC\",\"series\":[{{\"event\":\"Signed up\",\"label\":\"Signups\"}}]}}',
               '{{\"type\":\"threshold\",\"operator\":\"above\",\"value\":100}}', 'daily',
               '{{\"emailUserIds\":[\"user_alice\"],\"inApp\":false,\"slack\":false}}', 'user_alice');
             update panel_alerts set {set} where id = 'pnal_1';"
        ),
    )
    .await;
    alerts::get_alert(tenant, "pnal_1")
        .await
        .expect("get")
        .expect("alert")
}

async fn alert_events(tenant: &PgPool) -> Vec<Value> {
    let rows: Vec<Value> =
        sqlx::query_scalar("select to_jsonb(e) from panel_alert_events e order by created_at")
            .fetch_all(tenant)
            .await
            .expect("events");
    rows.into_iter().map(weldsuite_db::js_row).collect()
}

#[tokio::test]
async fn alert_checks_move_the_state_once_per_change() {
    let Some((_, tenant)) = databases() else {
        eprintln!("test databases not set; skipping");
        return;
    };
    let _turn = LOCK.lock().await;
    let now = at("2026-11-18T10:20:00Z");
    exec(
        &tenant,
        "delete from panel_alert_events; delete from panel_projects;",
    )
    .await;
    exec(&tenant, PROJECT).await;

    // Fires once on the move into firing, and messages the channels.
    let a = alert_row(&tenant, "name = name").await;
    let first = CheckFake::new(Ok(150.0));
    let result = alerts::run_alert_check(&tenant, now, &first, &a)
        .await
        .expect("check");
    assert_eq!(result.outcome, Outcome::Fired);
    assert_eq!(result.delivered.len(), 1);
    assert_eq!(result.alert["state"], json!("firing"));
    assert_eq!(result.alert["lastValue"].as_f64(), Some(150.0));
    assert_eq!(result.alert["lastError"], Value::Null);
    assert_eq!(result.alert["lastFiredAt"], json!(iso(now)));
    assert_eq!(*first.published.lock().expect("lock"), ["fired"]);
    assert_eq!(
        first.delivered.lock().expect("lock")[0],
        json!({ "entityId": "pnal_1", "event": "fired", "metric": "Signups", "value": 150.0, "bound": 100.0, "period": "2026-11-17", "projectName": "Shop" })
    );
    let ran = first.ran.lock().expect("lock")[0].clone();
    assert_eq!(
        ran["dateRange"],
        json!({ "from": "2026-11-17", "to": "2026-11-17" })
    );
    assert_eq!(ran["interval"], json!("day"));
    let events = alert_events(&tenant).await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["kind"], json!("fired"));
    assert_eq!(events[0]["value"].as_f64(), Some(150.0));
    assert_eq!(events[0]["bound"].as_f64(), Some(100.0));
    // Still firing: nothing new.
    let again = CheckFake::new(Ok(170.0));
    assert_eq!(
        alerts::run_alert_check(&tenant, now, &again, &result.alert)
            .await
            .expect("check")
            .outcome,
        Outcome::Firing
    );
    assert!(again.published.lock().expect("lock").is_empty());
    assert!(again.delivered.lock().expect("lock").is_empty());
    assert_eq!(alert_events(&tenant).await.len(), 1);

    // Resolves once on the move back, and an ok alert stays quiet.
    exec(&tenant, "delete from panel_alert_events").await;
    let a = alert_row(
        &tenant,
        "state = 'firing', last_fired_at = '2026-11-17T00:15:00Z'",
    )
    .await;
    let back = CheckFake::new(Ok(20.0));
    let result = alerts::run_alert_check(&tenant, now, &back, &a)
        .await
        .expect("check");
    assert_eq!(result.outcome, Outcome::Resolved);
    assert_eq!(result.alert["state"], json!("ok"));
    assert_eq!(*back.published.lock().expect("lock"), ["resolved"]);
    assert_eq!(
        back.delivered.lock().expect("lock")[0]["event"],
        json!("resolved")
    );
    let quiet = CheckFake::new(Ok(30.0));
    assert_eq!(
        alerts::run_alert_check(&tenant, now, &quiet, &result.alert)
            .await
            .expect("check")
            .outcome,
        Outcome::Ok
    );
    assert!(quiet.delivered.lock().expect("lock").is_empty());

    // Records the transition but sends nothing while snoozed.
    exec(&tenant, "delete from panel_alert_events").await;
    let a = alert_row(&tenant, "snoozed_until = '2026-11-19T00:00:00Z'").await;
    let snoozed = CheckFake::new(Ok(500.0));
    assert_eq!(
        alerts::run_alert_check(&tenant, now, &snoozed, &a)
            .await
            .expect("check")
            .outcome,
        Outcome::Fired
    );
    assert_eq!(*snoozed.published.lock().expect("lock"), ["fired"]);
    assert!(snoozed.delivered.lock().expect("lock").is_empty());
    assert_eq!(alert_events(&tenant).await.len(), 1);

    // Goes to error with the reason, once, and resolves from error when it had fired.
    exec(&tenant, "delete from panel_alert_events").await;
    let a = alert_row(
        &tenant,
        "state = 'firing', last_fired_at = '2026-11-17T00:15:00Z'",
    )
    .await;
    exec(
        &tenant,
        "insert into panel_alert_events (id, alert_id, project_id, kind, value, bound, created_at) values ('pnae_0', 'pnal_1', 'pnp_a', 'fired', 150, 100, '2026-11-17T00:15:00Z')",
    )
    .await;
    let broken = CheckFake::new(Err("R2 SQL API error 500".to_owned()));
    let failed = alerts::run_alert_check(&tenant, now, &broken, &a)
        .await
        .expect("check");
    assert_eq!(failed.outcome, Outcome::Error);
    assert_eq!(failed.alert["state"], json!("error"));
    assert_eq!(failed.alert["lastError"], json!("R2 SQL API error 500"));
    alerts::run_alert_check(&tenant, now, &broken, &failed.alert)
        .await
        .expect("check");
    assert_eq!(
        alert_events(&tenant)
            .await
            .iter()
            .filter(|e| e["kind"] == "error")
            .count(),
        1
    );
    let fixed = CheckFake::new(Ok(10.0));
    let current = alerts::get_alert(&tenant, "pnal_1")
        .await
        .expect("get")
        .expect("alert");
    assert_eq!(
        alerts::run_alert_check(&tenant, now, &fixed, &current)
            .await
            .expect("check")
            .outcome,
        Outcome::Resolved
    );
    assert_eq!(*fixed.published.lock().expect("lock"), ["resolved"]);

    // Errors when its report is gone, and skips an anomaly without history.
    let orphan = alert_row(&tenant, "spec = null, report_id = 'pnr_gone'").await;
    let gone = alerts::run_alert_check(&tenant, now, &CheckFake::new(Ok(1.0)), &orphan)
        .await
        .expect("check");
    assert_eq!(gone.alert["state"], json!("error"));
    assert_eq!(
        gone.alert["lastError"],
        json!("The report this alert watches was deleted")
    );
    let anomaly = alert_row(
        &tenant,
        "condition = '{\"type\":\"anomaly\",\"sensitivity\":\"high\"}'",
    )
    .await;
    let skipped = alerts::run_alert_check(&tenant, now, &CheckFake::new(Ok(5.0)), &anomaly)
        .await
        .expect("check");
    assert_eq!(skipped.outcome, Outcome::Skipped);
    assert_eq!(skipped.alert["state"], json!("pending"));
    assert_eq!(skipped.alert["lastValue"].as_f64(), Some(5.0));
}

// ---------------------------------------------------------------------------
// Raw exports (`exports.test.ts`)
// ---------------------------------------------------------------------------

const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000002";

fn keyring() -> weldsuite_db::Keyring {
    weldsuite_db::Keyring {
        v1: Some(KEY.to_owned()),
        v2: None,
    }
}

/// The store: answers every request with `status`, keeping what was sent.
struct Store {
    status: u16,
    puts: Mutex<Vec<(String, Vec<u8>)>>,
}

impl DynOutboundHttp for Store {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        self.puts.lock().expect("lock").push((
            request.url.clone(),
            request.body.clone().unwrap_or_default(),
        ));
        let body = if self.status >= 400 {
            "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>"
        } else {
            ""
        };
        let response = HttpResponse::new(self.status, body.as_bytes().to_vec());
        Box::pin(async move { Ok(response) })
    }
}

struct ExportFake {
    store: Arc<Store>,
    two_pages: bool,
    event_calls: Mutex<u32>,
    sent: Mutex<Vec<PanelSqlQuery>>,
    failing_mails: Mutex<u32>,
}

impl ExportFake {
    fn new(status: u16, two_pages: bool) -> Self {
        Self {
            store: Arc::new(Store {
                status,
                puts: Mutex::default(),
            }),
            two_pages,
            event_calls: Mutex::new(0),
            sent: Mutex::default(),
            failing_mails: Mutex::new(0),
        }
    }
}

impl ExportPorts for ExportFake {
    fn context(&self) -> BoxFuture<'_, Result<PanelQueryContext, String>> {
        Box::pin(async {
            Ok(PanelQueryContext {
                workspace_id: "ws_a".to_owned(),
                project_id: "pnp_a".to_owned(),
                retention_days: 365.0,
                erased_ids: vec!["user_erased".to_owned()],
                now: Some(at("2026-11-16T12:00:00Z")),
                ..PanelQueryContext::default()
            })
        })
    }

    fn execute(&self, query: PanelSqlQuery) -> BoxFuture<'_, Result<Vec<Value>, String>> {
        let rows = if query.name == "export_events" {
            let mut calls = self.event_calls.lock().expect("lock");
            *calls += 1;
            if self.two_pages && *calls == 1 {
                (0..PANEL_EXPORT_PAGE_SIZE)
                    .map(|i| json!({ "event_id": format!("evt_{i:05}"), "received_at": "2026-11-16T10:10:00.000001Z", "properties": "{}" }))
                    .collect()
            } else {
                vec![
                    json!({ "event_id": "evt_last", "received_at": "2026-11-16T10:30:00Z", "name": "$pageview", "properties": "{\"plan\":\"pro\"}" }),
                ]
            }
        } else {
            Vec::new()
        };
        self.sent.lock().expect("lock").push(query);
        Box::pin(async move { Ok(rows) })
    }

    fn http(&self) -> Option<OutboundHttp> {
        Some(OutboundHttp(self.store.clone()))
    }

    fn notify_failing<'a>(&'a self, _export: &'a Value, _error: &'a str) -> BoxFuture<'a, ()> {
        *self.failing_mails.lock().expect("lock") += 1;
        Box::pin(async {})
    }
}

async fn export_row(tenant: &PgPool, set: &str) -> Value {
    exec(
        tenant,
        "delete from panel_export_runs; delete from panel_exports;",
    )
    .await;
    let secret = secrets::seal(&keyring(), "secret-1").expect("seal");
    exec(
        tenant,
        &format!(
            "insert into panel_exports (id, project_id, name, destination, secret_ciphertext, tables, frequency, start_at, created_by_user_id)
             values ('pnex_1', 'pnp_a', 'Raw',
               '{{\"provider\":\"s3\",\"endpoint\":null,\"region\":\"eu-west-1\",\"bucket\":\"acme\",\"prefix\":\"weldpanel\",\"accessKeyId\":\"AKIA1\",\"pathStyle\":false}}',
               '{secret}', '[\"events\",\"people\"]', 'hourly', '2026-11-16T10:00:00Z', 'user_alice');
             update panel_exports set {set} where id = 'pnex_1';"
        ),
    )
    .await;
    exports::get_export(tenant, "pnex_1")
        .await
        .expect("get")
        .expect("export")
}

async fn runs(tenant: &PgPool) -> Vec<Value> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from panel_export_runs r order by window_from, table_name",
    )
    .fetch_all(tenant)
    .await
    .expect("runs");
    rows.into_iter().map(weldsuite_db::js_row).collect()
}

fn gunzip(bytes: &[u8]) -> String {
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_string(&mut text)
        .expect("gzip");
    text
}

#[tokio::test]
async fn exports_write_windows_and_keep_the_cursor_on_failure() {
    let Some((_, tenant)) = databases() else {
        eprintln!("test databases not set; skipping");
        return;
    };
    let _turn = LOCK.lock().await;
    let now = at("2026-11-16T12:00:00Z");
    let deadline = || js::now_millis() + 60_000;

    // Writes every table of every window up to now − 15 minutes, and moves the cursor.
    let export = export_row(&tenant, "name = name").await;
    let f = ExportFake::new(200, true);
    let result = exports::run_export(&tenant, now, deadline(), &keyring(), &f, &export)
        .await
        .expect("run");
    assert_eq!(
        (result.windows, result.caught_up, result.error.clone()),
        (2, true, None)
    );
    assert_eq!(
        result.export["exportedUntil"],
        json!("2026-11-16T11:45:00.000Z")
    );
    let all = runs(&tenant).await;
    assert_eq!(all.len(), 4);
    assert!(all.iter().all(|r| r["status"] == "succeeded"));
    let first = all
        .iter()
        .find(|r| r["tableName"] == "events" && r["windowFrom"] == "2026-11-16T10:00:00.000Z")
        .expect("first");
    assert_eq!(first["rows"].as_i64(), Some(PANEL_EXPORT_PAGE_SIZE + 1));
    assert_eq!(first["files"].as_i64(), Some(2));
    let puts = f.store.puts.lock().expect("lock").clone();
    assert_eq!(
        puts.iter().map(|(url, _)| url.as_str()).collect::<Vec<_>>(),
        [
            "https://acme.s3.eu-west-1.amazonaws.com/weldpanel/events/dt%3D2026-11-16/hour%3D10/pnex_1-20261116T100000Z.jsonl.gz",
            "https://acme.s3.eu-west-1.amazonaws.com/weldpanel/events/dt%3D2026-11-16/hour%3D10/pnex_1-20261116T100000Z-1.jsonl.gz",
            "https://acme.s3.eu-west-1.amazonaws.com/weldpanel/events/dt%3D2026-11-16/hour%3D11/pnex_1-20261116T110000Z.jsonl.gz",
        ]
    );
    let line: Value =
        serde_json::from_str(gunzip(&puts[1].1).lines().next().expect("line")).expect("json");
    assert_eq!(line["event_id"], json!("evt_last"));
    assert_eq!(line["properties"], json!({ "plan": "pro" }));
    let sent = f.sent.lock().expect("lock").clone();
    let events: Vec<&PanelSqlQuery> = sent.iter().filter(|q| q.name == "export_events").collect();
    assert!(events[1].sql.contains(
        "received_at = TIMESTAMP '2026-11-16 10:10:00.000001' AND event_id > 'evt_04999'"
    ));
    assert!(
        sent.iter()
            .all(|q| q.sql.contains("workspace_id = 'ws_a'")
                && q.sql.contains("project_id = 'pnp_a'"))
    );
    assert!(
        sent.iter()
            .find(|q| q.name == "export_people")
            .expect("people")
            .sql
            .contains("user_id NOT IN ('user_erased')")
    );

    // Starts no earlier than the plan's retention, and stops at the per-run window limit.
    let export = export_row(
        &tenant,
        "start_at = '2020-01-01T00:00:00Z', tables = '[\"identities\"]'",
    )
    .await;
    let f = ExportFake::new(200, false);
    let result = exports::run_export(&tenant, now, deadline(), &keyring(), &f, &export)
        .await
        .expect("run");
    assert_eq!((result.windows, result.caught_up), (24, false));
    assert_eq!(
        runs(&tenant).await[0]["windowFrom"],
        json!("2025-11-16T12:00:00.000Z")
    );

    // Keeps the cursor on a failure, marks the export failing after three, mails once, and recovers.
    let mut export = export_row(&tenant, "tables = '[\"events\"]'").await;
    for attempt in 1..=4 {
        let f = ExportFake::new(403, false);
        let result = exports::run_export(&tenant, now, deadline(), &keyring(), &f, &export)
            .await
            .expect("run");
        export = result.export;
        assert_eq!(result.error.as_deref(), Some("AccessDenied: Access Denied"));
        assert_eq!(export["exportedUntil"], Value::Null);
        assert_eq!(
            export["status"],
            json!(if attempt >= 3 { "failing" } else { "active" })
        );
        assert_eq!(
            *f.failing_mails.lock().expect("lock"),
            u32::from(attempt == 3)
        );
    }
    let ok = ExportFake::new(200, false);
    let result = exports::run_export(&tenant, now, deadline(), &keyring(), &ok, &export)
        .await
        .expect("run");
    assert_eq!(result.export["status"], json!("active"));
    assert_eq!(result.export["lastError"], Value::Null);
    assert_eq!(
        result.export["exportedUntil"],
        json!("2026-11-16T11:45:00.000Z")
    );

    // Does nothing while paused.
    let export = export_row(&tenant, "status = 'paused'").await;
    let f = ExportFake::new(200, false);
    let result = exports::run_export(&tenant, now, deadline(), &keyring(), &f, &export)
        .await
        .expect("run");
    assert_eq!(result.windows, 0);
    assert!(f.sent.lock().expect("lock").is_empty());
    assert_eq!(
        exports::get_export(&tenant, "pnex_1")
            .await
            .expect("get")
            .expect("export")["lastRunAt"],
        Value::Null
    );
}

// ---------------------------------------------------------------------------
// Delivery (`delivery.test.ts`)
// ---------------------------------------------------------------------------

/// The in-app and WeldChat senders, recorded (the TypeScript test mocks
/// `createAndDeliverNotification` and `postSystemChatMessage`).
#[derive(Default)]
struct Recorded {
    notifications: Mutex<Vec<Value>>,
    chat: Mutex<Vec<String>>,
}

impl Senders for Recorded {
    fn in_app<'a>(
        &'a self,
        _ctx: &'a Delivery,
        recipients: &'a [Recipient],
        message: &'a Message,
    ) -> BoxFuture<'a, SendOutcome> {
        for recipient in recipients {
            self.notifications
                .lock()
                .expect("lock")
                .push(json!({ "userId": recipient.user_id, "entityId": message.entity_id() }));
        }
        let sent = recipients.len() as u64;
        Box::pin(async move {
            SendOutcome {
                sent,
                failed: 0,
                error: None,
            }
        })
    }

    fn weldchat<'a>(
        &'a self,
        ctx: &'a Delivery,
        channel_id: &'a str,
        message: &'a Message,
        locale: EmailLocale,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            if !delivery::chat_channel_exists(&ctx.db, channel_id)
                .await
                .map_err(|e| e.to_string())?
            {
                return Err("The WeldChat channel no longer exists".to_owned());
            }
            self.chat
                .lock()
                .expect("lock")
                .push(delivery::weldchat_content(ctx, message, locale));
            Ok(())
        })
    }
}

struct Slack(u16, &'static str);

impl DynOutboundHttp for Slack {
    fn send(&self, _request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        let response = HttpResponse::new(self.0, self.1.as_bytes().to_vec());
        Box::pin(async move { Ok(response) })
    }
}

#[tokio::test]
async fn delivery_tries_every_channel_on_its_own() {
    let Some((_, tenant)) = databases() else {
        eprintln!("test databases not set; skipping");
        return;
    };
    let _turn = LOCK.lock().await;
    exec(
        &tenant,
        "delete from workspace_members; delete from user_preferences; delete from chat_channels;
         insert into workspace_members (id, user_id, email, name, role, status, deleted_at) values
           ('wm_1', 'user_alice', 'alice@example.com', 'Alice', 'OWNER', 'ACTIVE', null),
           ('wm_2', 'user_bram', 'bram@example.com', 'Bram', 'MEMBER', 'ACTIVE', null),
           ('wm_3', 'user_gone', 'gone@example.com', 'Gone', 'MEMBER', 'ACTIVE', now());
         insert into user_preferences (id, user_id, language) values ('up_1', 'user_bram', 'nl');
         insert into chat_channels (id, name, slug) values ('chc_1', 'growth', 'growth');",
    )
    .await;
    let ring = keyring();
    let slack_url = "https://hooks.slack.com/services/T000/B000/secretsecret";
    let mail = Arc::new(RecordingSystemMail::new());
    let recorded = Arc::new(Recorded::default());
    let ctx = |http: Option<OutboundHttp>, mail: Option<Arc<RecordingSystemMail>>| Delivery {
        db: tenant.clone(),
        clerk_org_id: "org_a".to_owned(),
        actor_user_id: "user_alice".to_owned(),
        platform_url: Some("https://app.weldsuite.org".to_owned()),
        keyring: ring.clone(),
        mail: mail.map(|m| m as Arc<dyn weldsuite_ports::DynSystemMail>),
        http,
        realtime: None,
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        senders: Some(recorded.clone()),
    };
    let message = || Message::Alert {
        entity_id: "pnal_1".to_owned(),
        path: "/weldpanel/alerts?alert=pnal_1".to_owned(),
        alert: weldsuite_emails::panel_monitor::AlertProps {
            alert_name: "Signups <@everyone>".to_owned(),
            project_name: "Shop".to_owned(),
            event: weldsuite_emails::panel_monitor::AlertEvent::Fired,
            metric: "Signups".to_owned(),
            value: Some(150.0),
            bound: Some(100.0),
            condition: weldsuite_emails::panel_monitor::AlertCondition::Threshold {
                operator: "above".to_owned(),
                value: 100.0,
            },
            interval: weldsuite_emails::panel_monitor::AlertInterval::Daily,
            period: Some("2026-11-17".to_owned()),
            url: String::new(),
        },
    };

    // A failing Slack webhook does not stop email, in-app or WeldChat, and its error carries no URL.
    let stored = delivery::store_channels(
        &ring,
        &json!({ "emailUserIds": ["user_alice", "user_bram", "user_gone"], "inApp": true, "slackWebhookUrl": slack_url, "weldchatChannelId": "chc_1" }),
        None,
    )
    .expect("stored");
    let target = Target {
        channels: stored.channels.clone(),
        slack_ciphertext: stored.slack_ciphertext.clone(),
        owner_user_id: "user_alice".to_owned(),
    };
    let slack = OutboundHttp(Arc::new(Slack(403, "invalid_token")));
    let results =
        delivery::deliver(&ctx(Some(slack), Some(mail.clone())), &target, &message()).await;
    assert_eq!(
        results
            .iter()
            .map(|r| (r.channel, r.ok, r.recipients))
            .collect::<Vec<_>>(),
        [
            ("email", true, 2),
            ("in_app", true, 2),
            ("slack", false, 0),
            ("weldchat", true, 1)
        ]
    );
    assert_eq!(
        results[2].error.as_deref(),
        Some("Slack answered 403: invalid_token")
    );
    assert!(!format!("{results:?}").contains("hooks.slack.com"));
    assert_eq!(
        delivery::delivery_error(&results).as_deref(),
        Some("slack: Slack answered 403: invalid_token")
    );
    // Each member in their own language; the removed member gets nothing.
    let sent = mail.sent();
    assert_eq!(
        sent.iter()
            .flat_map(|m| m.to.iter().map(|t| t.email.clone()))
            .collect::<Vec<_>>(),
        ["alice@example.com", "bram@example.com"]
    );
    assert_eq!(sent[0].subject, "Alert: Signups <@everyone>");
    assert_eq!(sent[1].subject, "Melding: Signups <@everyone>");
    assert!(
        sent[0]
            .html
            .contains("https://app.weldsuite.org/w/org_a/weldpanel/alerts?alert=pnal_1")
    );
    // In-app: linked to the alert; WeldChat: the alert's name cannot ping anyone.
    assert_eq!(recorded.notifications.lock().expect("lock").len(), 2);
    assert!(!recorded.chat.lock().expect("lock")[0].contains("<@everyone>"));

    // Reports a WeldChat channel that is gone, and tries only the channels set.
    let gone = Target {
        channels: json!({ "emailUserIds": [], "inApp": false, "slack": false, "weldchatChannelId": "chc_gone" }),
        slack_ciphertext: None,
        owner_user_id: "user_alice".to_owned(),
    };
    let results = delivery::deliver(&ctx(None, Some(mail.clone())), &gone, &message()).await;
    assert_eq!(
        results,
        [Delivered {
            channel: "weldchat",
            ok: false,
            recipients: 0,
            error: Some("The WeldChat channel no longer exists".to_owned())
        }]
    );
    let none = Target {
        channels: json!({ "emailUserIds": [], "inApp": false, "slack": false }),
        slack_ciphertext: None,
        owner_user_id: "user_alice".to_owned(),
    };
    assert!(
        delivery::deliver(&ctx(None, Some(mail.clone())), &none, &message())
            .await
            .is_empty()
    );

    // Says so when email is not configured.
    let email = Target {
        channels: json!({ "emailUserIds": ["user_alice"], "inApp": false, "slack": false }),
        slack_ciphertext: None,
        owner_user_id: "user_alice".to_owned(),
    };
    let results = delivery::deliver(&ctx(None, None), &email, &message()).await;
    assert_eq!(
        (
            results[0].channel,
            results[0].ok,
            results[0].error.as_deref()
        ),
        ("email", false, Some("Email is not configured here"))
    );
}
