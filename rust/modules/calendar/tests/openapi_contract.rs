//! What the native WeldCalendar apps read, held against the file they generate
//! their client from (`apps/mobile-shared/openapi/weldcalendar.yaml`): every
//! operation in it, sent as the file describes it through the router as the
//! server mounts it, on the real tenant schema
//! (`weldsuite_kit::openapi_contract`). A change to these routes that would
//! break the apps fails here; change the file with it, as
//! `apps/mobile-shared/README.md` ("Changing the contract") says.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise returns early. The
//! test has its own users, whose calendars are cleaned at its start.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use serde_json::{Value, json};
use weldsuite_auth::AuthContext;
use weldsuite_calendar::CalendarState;
use weldsuite_catalogs::permission_keys::{
    CALENDARS_CREATE, CALENDARS_READ, EVENTS_CREATE, EVENTS_DELETE, EVENTS_READ, EVENTS_UPDATE,
};
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_kit::openapi_contract::Contract;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};

const USER: &str = "user_openapi_calendar";

/// Someone else's calendar, shared with the test's user for viewing, with an
/// event that gives the nullable and free-text fields their other values: no
/// end, no `allDay`, no priority, a weekly rule, guests who answered, and a
/// task behind it.
const FIXTURES: &str = r#"
delete from calendar_events where calendar_id in
    (select id from calendars where owner_id in ('user_openapi_calendar', 'user_openapi_calendar_other'));
delete from calendar_shares where shared_with_id = 'user_openapi_calendar' or calendar_id in
    (select id from calendars where owner_id in ('user_openapi_calendar', 'user_openapi_calendar_other'));
delete from calendars where owner_id in ('user_openapi_calendar', 'user_openapi_calendar_other');
insert into calendars (id, name, description, color, owner_id, is_default, is_active) values
    ('cal_openapi_shared', 'Team', null, null, 'user_openapi_calendar_other', false, null);
insert into calendar_shares (id, calendar_id, shared_with_id, permission, shared_by_id) values
    ('csh_openapi_calendar', 'cal_openapi_shared', 'user_openapi_calendar', 'view', 'user_openapi_calendar_other');
insert into calendar_events
    (id, title, type, start_time, end_time, all_day, timezone, status, priority, recurrence_rule,
     calendar_id, organizer_id, attendees, source_type, source_id, auto_scheduled)
values
    ('evt_openapi_shared', 'Planning', 'reminder', '2030-03-05 10:00:00', null, null, 'Europe/Amsterdam',
     'confirmed', null, 'RRULE:FREQ=WEEKLY;BYDAY=TU', 'cal_openapi_shared', 'user_openapi_calendar_other',
     '[{"email": "ann@example.test", "name": "Ann", "status": "accepted"},
       {"email": "bob@example.test", "status": "needsAction", "role": "optional"}]'::jsonb,
     'task', 'task_openapi_calendar', true);
"#;

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

/// `/api` with calendar-api's routes behind the session, tenant and
/// permission layers, for a member who may read and write calendars and
/// events. No Google, no mail transport, no master database.
fn app(db: PgPool) -> Router {
    let state = CalendarState {
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        google: None,
        master: None,
        env: Arc::new(HashMap::new()),
        outbound: weldsuite_mail_domain::outbound::OutboundBindings::default(),
        cache: None,
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: [
            CALENDARS_READ,
            CALENDARS_CREATE,
            EVENTS_READ,
            EVENTS_CREATE,
            EVENTS_UPDATE,
            EVENTS_DELETE,
        ]
        .map(str::to_owned)
        .to_vec(),
        ..ResolvedPermissions::default()
    };
    Router::new()
        .nest("/api", weldsuite_calendar::router(state, &gate))
        .layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: Some("org_openapi_calendar".to_owned()),
                    session_id: "sess_openapi_calendar".to_owned(),
                    factor_verification_age: None,
                });
                request.extensions_mut().insert(Tenant {
                    workspace_id: "ws_openapi_calendar".to_owned(),
                    clerk_org_id: Some("org_openapi_calendar".to_owned()),
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
        ))
}

fn tenant() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    Some(master_pool(&url, 2).expect("tenant pool"))
}

fn id(body: &Value) -> String {
    body["data"]["id"].as_str().expect("an id").to_owned()
}

/// Every operation of weldcalendar.yaml, as the apps send it: the default
/// calendar provisioned (created, then found), a calendar added, events
/// created (timed with every field the form writes, and all day), read in a
/// window and one by one (the shared fixture's too), changed with the
/// attendees told, and deleted.
#[tokio::test]
#[allow(clippy::too_many_lines)] // one flow, operation by operation
async fn weldcalendar_answers_what_the_native_apps_read() {
    let Some(db) = tenant() else {
        return;
    };
    sqlx::raw_sql(FIXTURES)
        .execute(&db)
        .await
        .expect("fixtures");
    let app = app(db);
    let contract = Contract::load("weldcalendar");

    // The first visit to the Calendars tab provisions "My Calendar" (201),
    // a later one finds it (200).
    let created = contract
        .success(&app, "ensureDefaultCalendar", &[], &[], None)
        .await;
    let default_calendar = id(&created);
    let found = contract
        .success(&app, "ensureDefaultCalendar", &[], &[], None)
        .await;
    assert_eq!(id(&found), default_calendar);

    let work = id(&contract
        .success(
            &app,
            "createCalendar",
            &[],
            &[],
            Some(&json!({ "name": "Work", "description": "Client meetings", "color": "#3b82f6" })),
        )
        .await);
    contract
        .success(
            &app,
            "createCalendar",
            &[],
            &[],
            Some(&json!({ "name": "Side project" })),
        )
        .await;

    let calendars = contract
        .success(&app, "listCalendars", &[], &[], None)
        .await;
    let listed: Vec<(&str, &Value, &Value)> = calendars["data"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|calendar| {
            (
                calendar["id"].as_str().unwrap_or_default(),
                &calendar["isOwn"],
                &calendar["permission"],
            )
        })
        .collect();
    assert_eq!(listed.len(), 4, "{calendars}");
    assert_eq!(listed[0].0, default_calendar, "the default calendar first");
    assert!(
        listed
            .iter()
            .any(|(id, own, permission)| *id == "cal_openapi_shared"
                && own.as_bool() == Some(false)
                && *permission == "view"),
        "the shared calendar, view only: {calendars}"
    );

    // A timed event with every field the form writes, and an all-day one.
    let timed = id(&contract
        .success(
            &app,
            "createEvent",
            &[],
            &[],
            Some(&json!({
                "calendarId": default_calendar,
                "title": "Quarterly review",
                "description": "Numbers first",
                "type": "meeting",
                "startTime": "2030-03-04T09:00:00.000Z",
                "endTime": "2030-03-04T10:30:00.000Z",
                "allDay": false,
                "timezone": "Europe/Amsterdam",
                "location": "Room 4",
                "isVirtual": true,
                "meetingUrl": "https://meet.example.test/review",
                "status": "tentative",
                "priority": "high",
                "recurrenceRule": "RRULE:FREQ=MONTHLY",
                "attendees": [
                    { "email": "ann@example.test", "name": "Ann" },
                    { "email": "bob@example.test" },
                ],
                "notes": "Bring the deck",
            })),
        )
        .await);
    let all_day = id(&contract
        .success(
            &app,
            "createEvent",
            &[],
            &[],
            Some(&json!({
                "calendarId": work,
                "title": "Offsite",
                "startTime": "2030-03-10T23:00:00.000Z",
                "endTime": "2030-03-11T22:59:59.999Z",
                "allDay": true,
            })),
        )
        .await);

    // The month grid's window (whole days, which need no encoding), then one
    // calendar of it.
    let window = contract
        .success(
            &app,
            "listEventsInRange",
            &[],
            &[("startDate", "2030-02-24"), ("endDate", "2030-04-06")],
            None,
        )
        .await;
    assert_eq!(window["data"].as_array().map(Vec::len), Some(3), "{window}");
    let one = contract
        .success(
            &app,
            "listEventsInRange",
            &[],
            &[
                ("startDate", "2030-02-24"),
                ("endDate", "2030-04-06"),
                ("calendarIds", work.as_str()),
            ],
            None,
        )
        .await;
    assert_eq!(one["data"].as_array().map(Vec::len), Some(1), "{one}");

    for event in [timed.as_str(), all_day.as_str(), "evt_openapi_shared"] {
        contract
            .success(&app, "getEvent", &[("eventId", event)], &[], None)
            .await;
    }

    // An edit that moves it, clears the description and the rule, and
    // swaps a guest, with the guests told.
    contract
        .success(
            &app,
            "updateEvent",
            &[("eventId", timed.as_str())],
            &[("sendNotification", "true")],
            Some(&json!({
                "title": "Quarterly review (moved)",
                "type": "call",
                "startTime": "2030-03-05T09:00:00.000Z",
                "endTime": "2030-03-05T10:00:00.000Z",
                "allDay": false,
                "timezone": "Europe/Amsterdam",
                "description": "",
                "location": "",
                "meetingUrl": "",
                "isVirtual": false,
                "status": "confirmed",
                "priority": "normal",
                "recurrenceRule": "",
                "attendees": [
                    { "email": "ann@example.test", "name": "Ann", "status": "accepted" },
                    { "email": "cy@example.test" },
                ],
            })),
        )
        .await;
    let moved = contract
        .success(&app, "getEvent", &[("eventId", timed.as_str())], &[], None)
        .await;
    assert_eq!(moved["data"]["title"], "Quarterly review (moved)");
    assert_eq!(moved["data"]["meetingUrl"], Value::Null);

    contract
        .success(
            &app,
            "deleteEvent",
            &[("eventId", all_day.as_str())],
            &[("sendNotification", "false")],
            None,
        )
        .await;
    contract
        .success(
            &app,
            "deleteEvent",
            &[("eventId", timed.as_str())],
            &[],
            None,
        )
        .await;

    // Refusals decode as the file's error: a body that fails validation, an
    // event on a calendar the caller can't see, a missing event, a calendar
    // without a name.
    let invalid = contract
        .failure(&app, "createEvent", &[], Some(&json!({})))
        .await;
    assert_eq!(invalid.status, 400);
    let elsewhere = contract
        .failure(
            &app,
            "createEvent",
            &[],
            Some(&json!({
                "calendarId": "cal_openapi_elsewhere",
                "title": "Not mine",
                "startTime": "2030-03-04T09:00:00.000Z",
            })),
        )
        .await;
    assert_eq!(elsewhere.status, 403);
    let missing = contract
        .failure(
            &app,
            "getEvent",
            &[("eventId", "evt_openapi_missing")],
            None,
        )
        .await;
    assert_eq!(missing.status, 404);
    assert!(
        missing
            .body
            .is_some_and(|body| body["error"]["code"].is_string())
    );
    let nameless = contract
        .failure(&app, "createCalendar", &[], Some(&json!({ "name": "" })))
        .await;
    assert_eq!(nameless.status, 400);

    contract.finish();
}
