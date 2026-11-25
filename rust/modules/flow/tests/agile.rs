//! Agile delivery in WeldFlow (ADRs FLOW-023 and FLOW-024) through the flow
//! routers: the delivery settings, the sprint lifecycle (start, complete with
//! carry-over, the report), epics and features, and sprint retro cards. The
//! routers run with the permission gate, the session and tenant layers a
//! request carries in the server, and a recording event bus.
//!
//! The permission checks run without a database. The rest runs on the real
//! tenant schema when `WELDSUITE_TEST_TENANT_URL` is set and returns early
//! otherwise. The database is shared: every row is created with fresh ids
//! and nothing is truncated or assumed empty.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode};
use serde_json::{Value, json};
use time::OffsetDateTime;
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_flow::FlowState;
use weldsuite_flow::calendar::{CalendarFuture, ScheduledSlot, TaskCalendar, TaskEvent};
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};
use weldsuite_ports::{DynEventBus, RecordingEventBus};

const USER: &str = "user_agile_test";

const ALL: &[&str] = &[
    "projects:read",
    "projects:create",
    "projects:update",
    "projects:delete",
    "projects:scope:all",
    "tasks:read",
    "tasks:create",
    "tasks:update",
    "tasks:delete",
];

struct NoQueries;

impl PermissionQueries for NoQueries {
    type Error = String;

    fn get_member(
        &self,
        _user_id: &str,
    ) -> impl Future<Output = Result<Option<MemberRow>, Self::Error>> + Send {
        std::future::ready(Ok(None))
    }

    fn get_role_permissions(
        &self,
        _role_id: &str,
    ) -> impl Future<Output = Result<Option<Vec<String>>, Self::Error>> + Send {
        std::future::ready(Ok(None))
    }

    fn get_team_permissions(
        &self,
        _member_id: &str,
    ) -> impl Future<Output = Result<Vec<Vec<String>>, Self::Error>> + Send {
        std::future::ready(Ok(Vec::new()))
    }
}

/// A calendar that places nothing: the tasks here have no blocks.
struct NoCalendar;

impl TaskCalendar for NoCalendar {
    fn create_for_task<'a>(
        &'a self,
        _db: &'a PgPool,
        _event: &'a TaskEvent,
    ) -> CalendarFuture<'a, Option<String>> {
        Box::pin(async { Ok(None) })
    }

    fn reschedule<'a>(
        &'a self,
        _db: &'a PgPool,
        _calendar_event_id: &'a str,
        _event: &'a TaskEvent,
    ) -> CalendarFuture<'a, Option<String>> {
        Box::pin(async { Ok(None) })
    }

    fn cancel<'a>(&'a self, _db: &'a PgPool, _id: &'a str) -> CalendarFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn confirm<'a>(&'a self, _db: &'a PgPool, _id: &'a str) -> CalendarFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn scheduled_slots<'a>(
        &'a self,
        _db: &'a PgPool,
        _task_ids: &'a [String],
    ) -> CalendarFuture<'a, HashMap<String, ScheduledSlot>> {
        Box::pin(async { Ok(HashMap::new()) })
    }

    fn next_replan_at<'a>(&'a self, _db: &'a PgPool) -> CalendarFuture<'a, Option<OffsetDateTime>> {
        Box::pin(async { Ok(None) })
    }
}

struct Harness {
    app: Router,
    bus: Arc<RecordingEventBus>,
    tracker: TaskTracker,
}

fn harness(db: PgPool, permissions: &[&str]) -> Harness {
    let bus = Arc::new(RecordingEventBus::new());
    let tracker = TaskTracker::new();
    let state = FlowState {
        events: EntityEventPublisher::new(
            Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
            tracker.clone(),
        ),
        files: None,
        master: None,
        jobs: None,
        public_files_url: None,
        calendar: Arc::new(NoCalendar),
        realtime: None,
        http: None,
        github_outbound: None,
        system_mail: None,
        project_portal_url: None,
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let mut api = Router::new();
    for (prefix, router) in weldsuite_flow::routers(&state, &gate) {
        api = api.nest(prefix, router);
    }
    let resolved = ResolvedPermissions {
        permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
        ..ResolvedPermissions::default()
    };
    let app = Router::new()
        .nest("/api", api)
        .layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: Some("org_agile".to_owned()),
                    session_id: "sess_agile".to_owned(),
                    factor_verification_age: None,
                });
                request.extensions_mut().insert(Tenant {
                    workspace_id: "ws_agile_test".to_owned(),
                    clerk_org_id: Some("org_agile".to_owned()),
                    db: db.clone(),
                    suspended: false,
                    restrictions: WorkspaceRestrictions::default(),
                });
                request.extensions_mut().insert(Permissions::new(
                    resolved.clone(),
                    None,
                    false,
                    USER.to_owned(),
                ));
                next.run(request)
            },
        ));
    Harness { app, bus, tracker }
}

impl Harness {
    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        let body = match body {
            Some(body) => {
                request = request.header("content-type", "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = self
            .app
            .clone()
            .oneshot(request.body(body).expect("request"))
            .await
            .expect("response");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let json = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
        (status, json)
    }

    /// The events since the last call, as `type:action:id`.
    async fn events(&self) -> Vec<String> {
        self.tracker.close();
        self.tracker.wait().await;
        self.tracker.reopen();
        let events = self
            .bus
            .payloads()
            .into_iter()
            .map(|payload| {
                let text = |key: &str| payload[key].as_str().unwrap_or_default().to_owned();
                format!(
                    "{}:{}:{}",
                    text("entityType"),
                    text("action"),
                    text("entityId")
                )
            })
            .collect();
        self.bus.clear();
        events
    }
}

fn lazy_pool() -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect_lazy("postgres://nobody@127.0.0.1:1/none")
        .expect("lazy pool")
}

fn tenant() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    Some(master_pool(&url, 4).expect("tenant pool"))
}

fn message(body: &Value) -> &str {
    body["error"]["message"].as_str().unwrap_or_default()
}

fn code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or_default()
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/// Rows with fresh ids: `<key>_<tag>`, within `varchar(30)`.
struct Fx {
    db: PgPool,
    tag: String,
}

/// A task fixture's columns.
#[derive(Default)]
struct T<'a> {
    status: &'a str,
    points: Option<i32>,
    sprint: Option<&'a str>,
    parent: Option<&'a str>,
    kind: Option<&'a str>,
    epic: Option<&'a str>,
    position: i32,
    completed: bool,
}

impl Fx {
    fn new(db: &PgPool) -> Self {
        Self {
            db: db.clone(),
            tag: weldsuite_kit::generate_id("").replace('_', ""),
        }
    }

    fn id(&self, key: &str) -> String {
        let id = format!("{key}_{}", self.tag);
        id.chars().take(30).collect()
    }

    async fn project(&self, key: &str) -> String {
        let id = self.id(key);
        // `projects` has no default for its timestamps (Drizzle set them).
        sqlx::query(
            "insert into projects (id, name, created_at, updated_at) values ($1, $2, now(), now())",
        )
        .bind(&id)
        .bind(format!("Project {key}"))
        .execute(&self.db)
        .await
        .expect("project");
        id
    }

    async fn sprint(&self, key: &str, project: &str, name: &str, status: &str) -> String {
        let id = self.id(key);
        sqlx::query(
            "insert into sprints (id, project_id, name, status, start_date, end_date) \
             values ($1, $2, $3, $4, '2026-11-02', '2026-11-13')",
        )
        .bind(&id)
        .bind(project)
        .bind(name)
        .bind(status)
        .execute(&self.db)
        .await
        .expect("sprint");
        id
    }

    async fn task(&self, key: &str, project: &str, t: T<'_>) -> String {
        let id = self.id(key);
        sqlx::query(
            "insert into tasks (id, project_id, title, status, story_points, sprint_id, \
             parent_task_id, type, epic_id, position, completed_date) \
             values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, 'task'), $9, $10, \
             case when $11 then '2026-11-04 10:00:00'::timestamp end)",
        )
        .bind(&id)
        .bind(project)
        .bind(format!("Task {key}"))
        .bind(if t.status.is_empty() {
            "todo"
        } else {
            t.status
        })
        .bind(t.points)
        .bind(t.sprint)
        .bind(t.parent)
        .bind(t.kind)
        .bind(t.epic)
        .bind(t.position)
        .bind(t.completed)
        .execute(&self.db)
        .await
        .expect("task");
        id
    }

    async fn sprint_of(&self, task: &str) -> Option<String> {
        sqlx::query_scalar("select sprint_id from tasks where id = $1")
            .bind(task)
            .fetch_one(&self.db)
            .await
            .expect("task sprint")
    }

    async fn epic_of(&self, task: &str) -> Option<String> {
        sqlx::query_scalar("select epic_id from tasks where id = $1")
            .bind(task)
            .fetch_one(&self.db)
            .await
            .expect("task epic")
    }
}

// ── Without a database ──────────────────────────────────────────────────────

#[tokio::test]
async fn the_new_routes_check_their_permission_first() {
    let reader = harness(lazy_pool(), &["projects:read", "tasks:create"]);
    for (method, path, body) in [
        ("PUT", "/api/projects/prj_x/delivery", Some(json!({}))),
        ("POST", "/api/sprints/spr_x/start", None),
        ("POST", "/api/sprints/spr_x/complete", None),
    ] {
        let (status, _) = reader.call(method, path, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
    }
    let nobody = harness(lazy_pool(), &[]);
    for path in [
        "/api/sprints/spr_x/report",
        "/api/tasks/epics?projectId=prj_x",
    ] {
        let (status, _) = nobody.call("GET", path, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "GET {path}");
    }
}

// ── Delivery settings ───────────────────────────────────────────────────────

#[tokio::test]
async fn delivery_settings_are_written_with_their_defaults() {
    let Some(db) = tenant() else { return };
    let fx = Fx::new(&db);
    let h = harness(db.clone(), ALL);
    let project = fx.project("prj_dlv").await;

    let (status, body) = h
        .call(
            "PUT",
            &format!("/api/projects/{project}/delivery"),
            Some(json!({ "approach": "scrum", "sprintLengthDays": 10, "wipLimits": { "stg_doing": 3 } })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let expected = json!({
        "approach": "scrum",
        "sprintLengthDays": 10,
        "itemTypes": { "naming": "pbi", "featureLevel": false,
            "enabled": ["epic", "story", "bug", "task", "spike", "subtask"] },
        "wipLimits": { "stg_doing": 3 },
        "definitionOfDone": [],
    });
    assert_eq!(body["data"], expected);
    let stored: Value =
        sqlx::query_scalar("select settings->'delivery' from projects where id = $1")
            .bind(&project)
            .fetch_one(&db)
            .await
            .expect("settings");
    assert_eq!(stored, expected);
    assert_eq!(h.events().await, [format!("project:updated:{project}")]);

    let (status, body) = h
        .call(
            "PUT",
            &format!("/api/projects/{project}/delivery"),
            Some(json!({ "approach": "waterfall" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(message(&body), "Invalid request body");
    assert_eq!(body["error"]["details"][0]["path"], "approach");

    let (status, _) = h
        .call(
            "PUT",
            "/api/projects/prj_missing_dlv/delivery",
            Some(json!({ "approach": "kanban" })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// ── Sprints ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_sprint_starts_once_and_one_at_a_time() {
    let Some(db) = tenant() else { return };
    let fx = Fx::new(&db);
    let h = harness(db.clone(), ALL);
    let project = fx.project("prj_start").await;
    let first = fx.sprint("spr_a", &project, "Sprint 1", "planned").await;
    let second = fx.sprint("spr_b", &project, "Sprint 2", "planned").await;
    fx.task(
        "t_a1",
        &project,
        T {
            points: Some(3),
            sprint: Some(&first),
            ..T::default()
        },
    )
    .await;
    fx.task(
        "t_a2",
        &project,
        T {
            points: Some(5),
            sprint: Some(&first),
            position: 1,
            ..T::default()
        },
    )
    .await;
    fx.task(
        "t_a3",
        &project,
        T {
            status: "cancelled",
            points: Some(8),
            sprint: Some(&first),
            position: 2,
            ..T::default()
        },
    )
    .await;

    let (status, body) = h
        .call(
            "POST",
            &format!("/api/sprints/{first}/start"),
            Some(json!({ "goal": "Ship the board" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let sprint = &body["data"];
    assert_eq!(sprint["status"], "active");
    assert_eq!(sprint["goal"], "Ship the board");
    assert_eq!(sprint["storyPointsCommitted"], 8);
    assert_eq!(sprint["report"]["committed"]["count"], 2);
    assert_eq!(sprint["report"]["committed"]["points"], 8);
    assert!(sprint["startedAt"].is_string());
    assert_eq!(
        h.events().await,
        [
            format!("project_sprint:updated:{first}"),
            format!("project_sprint:started:{first}"),
        ]
    );

    let (status, body) = h
        .call("POST", &format!("/api/sprints/{first}/start"), None)
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(code(&body), "CONFLICT");
    assert_eq!(message(&body), "Only a planned sprint can be started");

    let (status, body) = h
        .call("POST", &format!("/api/sprints/{second}/start"), None)
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        message(&body),
        "Another sprint is already active in this project"
    );

    let (status, body) = h
        .call(
            "POST",
            &format!("/api/sprints/{second}/complete"),
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(message(&body), "Only an active sprint can be completed");

    // The live report of the running sprint.
    let (status, body) = h
        .call("GET", &format!("/api/sprints/{first}/report"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["committed"]["points"], 8);
    assert_eq!(body["data"]["goalMet"], Value::Null);
    // Live: the two open items are what completing would carry over.
    assert_eq!(body["data"]["carriedOver"]["count"], 2);
    assert_eq!(body["data"]["carriedOver"]["points"], 8);
    assert_eq!(
        body["data"]["burndown"]
            .as_array()
            .expect("burndown")
            .first()
            .map(|day| day["date"].clone()),
        Some(json!("2026-11-02"))
    );
}

#[tokio::test]
async fn a_planned_sprint_without_dates_runs_for_the_project_sprint_length() {
    let Some(db) = tenant() else { return };
    let fx = Fx::new(&db);
    let h = harness(db.clone(), ALL);
    let project = fx.project("prj_len").await;
    sqlx::query(
        "update projects set settings = '{\"delivery\": {\"sprintLengthDays\": 7}}' where id = $1",
    )
    .bind(&project)
    .execute(&db)
    .await
    .expect("settings");
    let sprint = fx.id("spr_len");
    sqlx::query("insert into sprints (id, project_id, name) values ($1, $2, 'Sprint 1')")
        .bind(&sprint)
        .bind(&project)
        .execute(&db)
        .await
        .expect("sprint");

    let (status, body) = h
        .call(
            "POST",
            &format!("/api/sprints/{sprint}/start"),
            Some(json!({ "startDate": "2026-12-01" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["startDate"], "2026-12-01T00:00:00.000Z");
    assert_eq!(body["data"]["endDate"], "2026-12-08T00:00:00.000Z");
}

#[tokio::test]
#[allow(clippy::too_many_lines, reason = "one scenario, step by step")]
async fn completing_carries_the_unfinished_items_over() {
    let Some(db) = tenant() else { return };
    let fx = Fx::new(&db);
    let h = harness(db.clone(), ALL);
    let project = fx.project("prj_done").await;
    let sprint = fx.sprint("spr_14", &project, "Sprint 14", "planned").await;
    let done = fx
        .task(
            "t_done",
            &project,
            T {
                status: "done",
                points: Some(5),
                sprint: Some(&sprint),
                completed: true,
                ..T::default()
            },
        )
        .await;
    let open = fx
        .task(
            "t_open",
            &project,
            T {
                points: Some(3),
                sprint: Some(&sprint),
                position: 1,
                ..T::default()
            },
        )
        .await;
    let sub = fx
        .task(
            "t_sub",
            &project,
            T {
                sprint: Some(&sprint),
                parent: Some(&open),
                ..T::default()
            },
        )
        .await;
    let busy = fx
        .task(
            "t_busy",
            &project,
            T {
                status: "in_progress",
                points: Some(2),
                sprint: Some(&sprint),
                position: 2,
                ..T::default()
            },
        )
        .await;
    let (status, body) = h
        .call("POST", &format!("/api/sprints/{sprint}/start"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Added after the start, and done.
    let late = fx
        .task(
            "t_late",
            &project,
            T {
                status: "done",
                points: Some(1),
                sprint: Some(&sprint),
                position: 3,
                completed: true,
                ..T::default()
            },
        )
        .await;
    h.events().await;

    let (status, body) = h
        .call(
            "POST",
            &format!("/api/sprints/{sprint}/complete"),
            Some(json!({ "goalMet": true, "items": [{ "taskId": busy, "moveTo": "backlog" }] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let data = &body["data"];
    let next = data["nextSprintId"]
        .as_str()
        .expect("a next sprint")
        .to_owned();
    assert_eq!(data["sprint"]["status"], "completed");
    assert_eq!(data["sprint"]["velocity"], 6);
    let report = &data["report"];
    assert_eq!(report["committed"]["count"], 3);
    assert_eq!(report["committed"]["points"], 10);
    assert_eq!(report["completed"], json!({ "points": 6, "count": 2 }));
    assert_eq!(report["added"], json!({ "points": 1, "count": 1 }));
    assert_eq!(report["removed"], json!({ "points": 0, "count": 0 }));
    assert_eq!(report["carriedOver"]["points"], 5);
    assert_eq!(report["carriedOver"]["count"], 2);
    assert_eq!(report["carriedOver"]["toSprintId"], next.as_str());
    assert_eq!(report["carriedOver"]["toBacklog"], 1);
    assert_eq!(report["goalMet"], true);
    assert_eq!(
        report["burndown"].as_array().expect("burndown").len(),
        12,
        "2026-11-02 to 2026-11-13"
    );

    let (name, status, start): (String, String, Option<time::PrimitiveDateTime>) =
        sqlx::query_as("select name, status, start_date from sprints where id = $1")
            .bind(&next)
            .fetch_one(&db)
            .await
            .expect("next sprint");
    assert_eq!((name.as_str(), status.as_str()), ("Sprint 15", "planned"));
    assert_eq!(
        start.map(|s| s.date().to_string()).as_deref(),
        Some("2026-11-13")
    );
    assert_eq!(fx.sprint_of(&open).await.as_deref(), Some(next.as_str()));
    assert_eq!(fx.sprint_of(&sub).await.as_deref(), Some(next.as_str()));
    assert_eq!(fx.sprint_of(&busy).await, None);
    assert_eq!(fx.sprint_of(&done).await.as_deref(), Some(sprint.as_str()));
    assert_eq!(fx.sprint_of(&late).await.as_deref(), Some(sprint.as_str()));

    let events = h.events().await;
    assert_eq!(events[0], format!("project_sprint:created:{next}"));
    assert_eq!(events[1], format!("project_sprint:updated:{sprint}"));
    assert_eq!(events[2], format!("project_sprint:completed:{sprint}"));
    for task in [&open, &sub, &busy] {
        assert!(
            events.contains(&format!("project_task:updated:{task}")),
            "{task} in {events:?}"
        );
    }

    // The report is frozen.
    let (status, body) = h
        .call("GET", &format!("/api/sprints/{sprint}/report"), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(&body["data"], report);

    let (status, _) = h
        .call("POST", &format!("/api/sprints/{sprint}/complete"), None)
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // A deleted sprint hands its tasks back to the backlog.
    let (status, _) = h
        .call("DELETE", &format!("/api/sprints/{next}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(fx.sprint_of(&open).await, None);
}

#[tokio::test]
async fn a_next_sprint_must_be_a_planned_one_of_the_project() {
    let Some(db) = tenant() else { return };
    let fx = Fx::new(&db);
    let h = harness(db.clone(), ALL);
    let project = fx.project("prj_nxt").await;
    let other = fx.project("prj_oth").await;
    let sprint = fx.sprint("spr_now", &project, "Now", "planned").await;
    let elsewhere = fx.sprint("spr_else", &other, "Elsewhere", "planned").await;
    let planned = fx.sprint("spr_plan", &project, "Later", "planned").await;
    let open = fx
        .task(
            "t_nxt",
            &project,
            T {
                sprint: Some(&sprint),
                ..T::default()
            },
        )
        .await;
    h.call("POST", &format!("/api/sprints/{sprint}/start"), None)
        .await;

    let (status, body) = h
        .call(
            "POST",
            &format!("/api/sprints/{sprint}/complete"),
            Some(json!({ "nextSprintId": elsewhere })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        message(&body),
        "The next sprint must be a planned sprint of this project"
    );
    let (status, body) = h
        .call(
            "POST",
            &format!("/api/sprints/{sprint}/complete"),
            Some(json!({ "moveTo": "later" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(message(&body), "Invalid request body");

    let (status, body) = h
        .call(
            "POST",
            &format!("/api/sprints/{sprint}/complete"),
            Some(json!({ "nextSprintId": planned })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["nextSprintId"], planned.as_str());
    assert_eq!(fx.sprint_of(&open).await.as_deref(), Some(planned.as_str()));
}

#[tokio::test]
async fn create_next_makes_a_new_sprint_even_with_one_planned() {
    let Some(db) = tenant() else { return };
    let fx = Fx::new(&db);
    let h = harness(db.clone(), ALL);
    let project = fx.project("prj_new").await;
    let sprint = fx.sprint("spr_cur", &project, "Sprint 7", "planned").await;
    let planned = fx.sprint("spr_pln", &project, "Sprint 9", "planned").await;
    let open = fx
        .task(
            "t_new",
            &project,
            T {
                sprint: Some(&sprint),
                ..T::default()
            },
        )
        .await;
    h.call("POST", &format!("/api/sprints/{sprint}/start"), None)
        .await;

    let (status, body) = h
        .call(
            "POST",
            &format!("/api/sprints/{sprint}/complete"),
            Some(json!({ "createNext": true, "nextSprintId": planned })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        message(&body),
        "Send either nextSprintId or createNext, not both"
    );

    let (status, body) = h
        .call(
            "POST",
            &format!("/api/sprints/{sprint}/complete"),
            Some(json!({ "createNext": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let next = body["data"]["nextSprintId"].as_str().expect("a new sprint");
    assert_ne!(next, planned.as_str());
    assert_eq!(fx.sprint_of(&open).await.as_deref(), Some(next));
}

// ── Epics ───────────────────────────────────────────────────────────────────

#[tokio::test]
#[allow(clippy::too_many_lines, reason = "one scenario, step by step")]
async fn epic_links_follow_the_rules() {
    let Some(db) = tenant() else { return };
    let fx = Fx::new(&db);
    let h = harness(db.clone(), ALL);
    let project = fx.project("prj_epic").await;
    let other = fx.project("prj_epic2").await;
    let create = |body: Value| h.call("POST", "/api/tasks", Some(body));

    let (status, body) =
        create(json!({ "title": "Checkout", "projectId": project, "type": "epic" })).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let epic = body["data"]["id"].as_str().expect("epic").to_owned();
    assert!(body["data"].get("epicId").is_none());
    let (status, body) = create(json!({
        "title": "Payments", "projectId": project, "type": "feature", "epicId": epic,
    }))
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let feature = body["data"]["id"].as_str().expect("feature").to_owned();
    assert_eq!(body["data"]["epicId"], epic.as_str());
    let (status, body) = create(json!({
        "title": "Pay by card", "projectId": project, "type": "story", "epicId": feature,
        "storyPoints": 3, "acceptanceCriteria": "Given a card, when I pay, then it is charged",
    }))
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let story = body["data"]["id"].as_str().expect("story").to_owned();
    assert_eq!(
        body["data"]["acceptanceCriteria"],
        "Given a card, when I pay, then it is charged"
    );

    for (body, expected) in [
        (
            json!({ "title": "x", "projectId": project, "type": "feature", "epicId": feature }),
            "A feature can only belong to an epic".to_owned(),
        ),
        (
            json!({ "title": "x", "projectId": project, "type": "epic", "epicId": epic }),
            "An epic cannot belong to another epic".to_owned(),
        ),
        (
            json!({ "title": "x", "projectId": other, "epicId": epic }),
            format!("Epic {epic} not found in this project"),
        ),
        (
            json!({ "title": "x", "projectId": project, "epicId": story }),
            format!("Task {story} is not an epic or a feature"),
        ),
        (
            json!({ "title": "x", "projectId": project, "parentTaskId": story, "epicId": epic }),
            "A subtask cannot belong to an epic".to_owned(),
        ),
    ] {
        let (status, answer) = create(body.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(message(&answer), expected, "{body}");
    }

    let (status, body) = h
        .call(
            "GET",
            &format!("/api/tasks/epics?projectId={project}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rows = body["data"].as_array().expect("epics");
    let row = |id: &str| {
        rows.iter()
            .find(|row| row["id"] == id)
            .unwrap_or_else(|| panic!("{id}"))
            .clone()
    };
    assert_eq!(row(&epic)["items"], 1);
    assert_eq!(row(&epic)["points"], 3);
    assert_eq!(row(&epic)["epicId"], Value::Null);
    assert_eq!(row(&feature)["epicId"], epic.as_str());
    assert_eq!(row(&feature)["items"], 1);
    let (status, _) = h.call("GET", "/api/tasks/epics", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, body) = h
        .call(
            "GET",
            &format!("/api/tasks?projectId={project}&epicId={feature}&enrich=false"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let ids: Vec<&str> = body["data"]
        .as_array()
        .expect("list")
        .iter()
        .filter_map(|row| row["id"].as_str())
        .collect();
    assert_eq!(ids, [story.as_str()]);
    assert_eq!(body["data"][0]["epicId"], feature.as_str());
    // A task without an epic answers without the key, as before.
    let (_, body) = h
        .call(
            "GET",
            &format!("/api/tasks?projectId={project}&type=epic&enrich=false"),
            None,
        )
        .await;
    assert!(body["data"][0].get("epicId").is_none(), "{body}");

    // A feature that becomes a story lets its items go; an epic keeps it.
    let (status, body) = h
        .call(
            "PATCH",
            &format!("/api/tasks/{feature}"),
            Some(json!({ "type": "story" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(fx.epic_of(&story).await, None);
    assert_eq!(fx.epic_of(&feature).await.as_deref(), Some(epic.as_str()));
    // Turning it into an epic drops its own link.
    let (status, body) = h
        .call(
            "PATCH",
            &format!("/api/tasks/{feature}"),
            Some(json!({ "type": "epic" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["epicId"], Value::Null);
    assert_eq!(fx.epic_of(&feature).await, None);

    // Deleting an epic unlinks its items and keeps them.
    let (status, _) = h
        .call(
            "PATCH",
            &format!("/api/tasks/{story}"),
            Some(json!({ "epicId": epic })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fx.epic_of(&story).await.as_deref(), Some(epic.as_str()));
    let (status, _) = h.call("DELETE", &format!("/api/tasks/{epic}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(fx.epic_of(&story).await, None);
    let (status, _) = h.call("GET", &format!("/api/tasks/{story}"), None).await;
    assert_eq!(status, StatusCode::OK);
}

// ── Retros ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn retro_cards_belong_to_their_sprint() {
    let Some(db) = tenant() else { return };
    let fx = Fx::new(&db);
    let h = harness(db.clone(), ALL);
    let project = fx.project("prj_retro").await;
    let other = fx.project("prj_retro2").await;
    let sprint = fx
        .sprint("spr_retro", &project, "Sprint 3", "completed")
        .await;
    let elsewhere = fx
        .sprint("spr_retro2", &other, "Sprint 3", "completed")
        .await;

    let (status, body) = h
        .call(
            "POST",
            "/api/project-lessons",
            Some(
                json!({ "projectId": project, "sprintId": sprint, "category": "action",
                "text": "Pair on the payment flows" }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let card = body["data"]["id"].as_str().expect("card").to_owned();
    assert_eq!(body["data"]["sprintId"], sprint.as_str());
    assert_eq!(body["data"]["category"], "action");

    let (status, body) = h
        .call(
            "POST",
            "/api/project-lessons",
            Some(json!({ "projectId": project, "category": "went_well", "text": "Demo day" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let lesson = body["data"]["id"].as_str().expect("lesson").to_owned();
    assert!(body["data"].get("sprintId").is_none());

    let (status, _) = h
        .call(
            "POST",
            "/api/project-lessons",
            Some(json!({ "projectId": project, "category": "action", "text": "No sprint" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = h
        .call(
            "POST",
            "/api/project-lessons",
            Some(
                json!({ "projectId": project, "sprintId": elsewhere, "category": "went_well",
                "text": "Wrong sprint" }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        message(&body),
        format!("Sprint {elsewhere} not found in this project")
    );
    let (status, _) = h
        .call(
            "PATCH",
            &format!("/api/project-lessons/{lesson}"),
            Some(json!({ "category": "action" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let ids = |body: &Value| -> Vec<String> {
        body["data"]
            .as_array()
            .expect("list")
            .iter()
            .filter_map(|row| row["id"].as_str().map(str::to_owned))
            .collect()
    };
    let (_, body) = h
        .call(
            "GET",
            &format!("/api/project-lessons?projectId={project}"),
            None,
        )
        .await;
    assert_eq!(ids(&body), [lesson]);
    let (_, body) = h
        .call(
            "GET",
            &format!("/api/project-lessons?projectId={project}&sprintId={sprint}"),
            None,
        )
        .await;
    assert_eq!(ids(&body), [card]);
}
