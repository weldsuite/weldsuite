//! `/api/project-stakeholders` (`routes/project-stakeholders/index.ts`): the
//! stakeholder register, the RACI, the communication plan and the portal
//! access (ADR FLOW-020).
//!
//! ```text
//! GET    /                    the register of a project (projectId required, cursor)
//! GET    /raci/:projectId     the RACI matrix
//! PUT    /raci/:projectId     replace every assignment of one subject
//! GET    /settings/:projectId the communication plan
//! PUT    /settings/:projectId replace the communication plan
//! GET    /:id                 one stakeholder
//! POST   /                    add a member or a CRM contact
//! PATCH  /:id                 edit
//! DELETE /:id                 remove, with RACI cells and portal access
//! POST   /:id/portal-invite   give a contact portal access and email the invitation
//! DELETE /:id/portal-access   take the portal access away
//! ```
//!
//! The checks run in TypeScript's order: permission, the object (404), project
//! access (403), the body (400), then the business rules.

#![allow(
    clippy::too_many_lines,
    clippy::type_complexity,
    clippy::similar_names,
    clippy::single_match_else
)]

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PROJECT_STAKEHOLDER_CREATED, PROJECT_STAKEHOLDER_DELETED,
    PROJECT_STAKEHOLDER_UPDATED,
};
use weldsuite_db::js_row;
use weldsuite_flow_domain::js::{js_date, parse_int};
use weldsuite_flow_domain::stakeholders::{
    ALREADY_STAKEHOLDER, Assignment, CONTACT_NOT_FOUND, CONTACT_WITHOUT_EMAIL,
    DELIVERABLE_NOT_FOUND, MEMBER_NOT_FOUND, NOT_A_CONTACT, STAKEHOLDER_NOT_IN_PROJECT,
    changed_stakeholders, event_data, identity_error, present_stakeholder, raci_assignments_error,
    raci_subject_error, sort_assignments,
};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::project_status_reports::publish_project_updated;
use crate::raid_body::parse_body;
use crate::raid_store::live_project_exists;
use crate::reporting_body::{
    read_create_stakeholder, read_put_plan, read_put_raci, read_update_stakeholder,
    stakeholder_list_query,
};
use crate::reporting_notify::{NotifyContext, send_portal_invitation};
use crate::reporting_store::{
    contact_exists, find_stakeholder, identities_of, load_report_project, member_exists,
    member_identities, stakeholders_of_project,
};
use crate::{
    Caller, FlowState, Refusal, Reply, keyset_cursor, now_ms, outside, page, paged, reply,
};

const PROJECT_DENIED: &str = "You are not a member of this project";
const PROJECT_WRITE_DENIED: &str = "You do not have write access to this project";
const PROJECT_MANAGE_DENIED: &str = "You do not have manage access to this project";
const LABEL: &str = "Stakeholder";

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("projects:read")))
        .route("/", post(create).route_layer(need("projects:update")))
        .route(
            "/raci/{projectId}",
            get(get_raci).route_layer(need("projects:read")),
        )
        .route(
            "/raci/{projectId}",
            put(put_raci).route_layer(need("projects:update")),
        )
        .route(
            "/settings/{projectId}",
            get(get_plan).route_layer(need("projects:read")),
        )
        .route(
            "/settings/{projectId}",
            put(put_plan).route_layer(need("projects:update")),
        )
        .route("/{id}", get(detail).route_layer(need("projects:read")))
        .route("/{id}", patch(update).route_layer(need("projects:update")))
        .route("/{id}", delete(remove).route_layer(need("projects:update")))
        .route(
            "/{id}/portal-invite",
            post(portal_invite).route_layer(need("projects:update")),
        )
        .route(
            "/{id}/portal-access",
            delete(portal_revoke).route_layer(need("projects:update")),
        )
        .with_state(state)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

fn iso(ms: i64) -> String {
    weldsuite_flow_domain::js::iso_from_millis(ms).unwrap_or_default()
}

fn parse_limit(raw: Option<&str>, fallback: i64, max: i64) -> i64 {
    match raw.and_then(parse_int) {
        Some(parsed) if parsed >= 1 => parsed.min(max),
        _ => fallback,
    }
}

fn publish_stakeholder(
    state: &FlowState,
    caller: &Caller,
    event: EventName,
    row: &Value,
    extra: Option<Value>,
) {
    let mut data = event_data(row);
    if let (Value::Object(data), Some(Value::Object(extra))) = (&mut data, extra) {
        data.extend(extra);
    }
    caller.publish(state, event, text(row, "id").unwrap_or_default(), &data);
}

/// The stakeholder as every route answers it.
async fn present_one(caller: &Caller, row: &Value) -> Result<Value, sqlx::Error> {
    let identities = identities_of(&caller.db, std::slice::from_ref(row)).await?;
    let (name, email) = identities
        .get(text(row, "id").unwrap_or_default())
        .cloned()
        .unwrap_or((None, None));
    Ok(present_stakeholder(row, name.as_deref(), email.as_deref()))
}

/// A merge write of one `projects.settings` key, with the `project.updated` event.
async fn write_settings_key(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
    key: &str,
    value: Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update projects set settings = (coalesce(settings, '{}'::jsonb) || $3::jsonb),
             updated_at = $2::timestamptz where id = $1 and deleted_at is null",
    )
    .bind(project_id)
    .bind(iso(now_ms()))
    .bind(json!({ key: value }))
    .execute(&caller.db)
    .await?;
    publish_project_updated(state, caller, project_id, "").await
}

fn assignments_of(value: &Value) -> Vec<Assignment> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .map(|a| Assignment {
                    stakeholder_id: text(a, "stakeholderId").unwrap_or_default().to_owned(),
                    letter: text(a, "letter").unwrap_or_default().to_owned(),
                })
                .collect()
        })
        .unwrap_or_default()
}

// ── Communication plan ──────────────────────────────────────────────────────

async fn get_plan(caller: Caller, Path(project_id): Path<String>) -> Response {
    let result: Reply = async {
        if !caller.can_access(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        let Some(project) = load_report_project(&caller.db, &project_id).await? else {
            return Err(Refusal::not_found("Project", &project_id));
        };
        let plan = project
            .settings
            .get("communicationPlan")
            .cloned()
            .unwrap_or_else(|| json!([]));
        Ok(Data(json!({ "projectId": project_id, "communicationPlan": plan })).into_response())
    }
    .await;
    reply(result, "Failed to load the communication plan")
}

async fn put_plan(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        if !live_project_exists(&caller.db, &project_id).await? {
            return Err(Refusal::not_found("Project", &project_id));
        }
        if !caller.can_manage(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        parse_body(&body, read_put_plan)
    }
    .await;
    let input = match checked {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    let plan = input
        .get("communicationPlan")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let result: Reply = async {
        write_settings_key(
            &state,
            &caller,
            &project_id,
            "communicationPlan",
            plan.clone(),
        )
        .await?;
        Ok(Data(json!({ "projectId": project_id, "communicationPlan": plan })).into_response())
    }
    .await;
    reply(result, "Failed to update the communication plan")
}

// ── RACI ────────────────────────────────────────────────────────────────────

async fn raci_rows(
    caller: &Caller,
    project_id: &str,
) -> Result<Vec<(String, Option<String>, String, String)>, sqlx::Error> {
    sqlx::query_as(
        "select subject_type, subject_id, stakeholder_id, letter from project_raci
         where project_id = $1 order by created_at asc, id asc",
    )
    .bind(project_id)
    .fetch_all(&caller.db)
    .await
}

async fn get_raci(caller: Caller, Path(project_id): Path<String>) -> Response {
    let result: Reply = async {
        if !caller.can_access(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        if !live_project_exists(&caller.db, &project_id).await? {
            return Err(Refusal::not_found("Project", &project_id));
        }
        let register = stakeholders_of_project(&caller.db, &project_id).await?;
        let deliverables: Vec<(String, i32, String)> = sqlx::query_as(
            "select id, number, title from project_deliverables
             where project_id = $1 and deleted_at is null order by position asc, number asc",
        )
        .bind(&project_id)
        .fetch_all(&caller.db)
        .await?;
        let rows = raci_rows(&caller, &project_id).await?;
        let order: Vec<String> = register
            .iter()
            .filter_map(|r| text(r, "id").map(str::to_owned))
            .collect();
        let cells = |kind: &str, id: Option<&str>| -> Vec<Value> {
            let list: Vec<Assignment> = rows
                .iter()
                .filter(|r| r.0 == kind && r.1.as_deref() == id)
                .map(|r| Assignment {
                    stakeholder_id: r.2.clone(),
                    letter: r.3.clone(),
                })
                .collect();
            sort_assignments(&list, &order)
                .iter()
                .map(Assignment::to_value)
                .collect()
        };
        let mut subjects: Vec<Value> = deliverables
            .iter()
            .map(|d| {
                json!({
                    "subjectType": "deliverable", "subjectId": d.0, "code": format!("D{}", d.1),
                    "title": d.2, "assignments": cells("deliverable", Some(&d.0)),
                })
            })
            .collect();
        for kind in ["change_requests", "go_live"] {
            subjects.push(json!({
                "subjectType": kind, "subjectId": null, "code": null, "title": null,
                "assignments": cells(kind, None),
            }));
        }
        Ok(Data(json!({ "projectId": project_id, "subjects": subjects })).into_response())
    }
    .await;
    reply(result, "Failed to load the RACI matrix")
}

async fn put_raci(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        if !live_project_exists(&caller.db, &project_id).await? {
            return Err(Refusal::not_found("Project", &project_id));
        }
        if !caller.can_write(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        let input = parse_body(&body, read_put_raci)?;
        let subject_type = text(&Value::Object(input.clone()), "subjectType")
            .unwrap_or_default()
            .to_owned();
        let given = input
            .get("subjectId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(message) = raci_subject_error(&subject_type, given.as_deref()) {
            return Err(Refusal::bad_request(message));
        }
        let assignments = assignments_of(&input["assignments"]);
        if let Some(message) = raci_assignments_error(&assignments) {
            return Err(Refusal::bad_request(message));
        }
        Ok((subject_type, given.filter(|_| true), assignments))
    }
    .await;
    let (subject_type, given, assignments) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    let subject_id = if subject_type == "deliverable" {
        given
    } else {
        None
    };
    reply(
        replace_raci(
            &state,
            &caller,
            &project_id,
            &subject_type,
            subject_id.as_deref(),
            &assignments,
        )
        .await,
        "Failed to update the RACI matrix",
    )
}

async fn replace_raci(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
    subject_type: &str,
    subject_id: Option<&str>,
    assignments: &[Assignment],
) -> Reply {
    let db = &caller.db;
    let mut deliverable: Option<(i32, String)> = None;
    if let Some(subject) = subject_id {
        deliverable = sqlx::query_as(
            "select number, title from project_deliverables
             where id = $1 and project_id = $2 and deleted_at is null limit 1",
        )
        .bind(subject)
        .bind(project_id)
        .fetch_optional(db)
        .await?;
        if deliverable.is_none() {
            return Err(Refusal::bad_request(DELIVERABLE_NOT_FOUND));
        }
    }
    let register = stakeholders_of_project(db, project_id).await?;
    let known = |id: &str| register.iter().find(|r| text(r, "id") == Some(id));
    if assignments
        .iter()
        .any(|a| known(&a.stakeholder_id).is_none())
    {
        return Err(Refusal::bad_request(STAKEHOLDER_NOT_IN_PROJECT));
    }
    let before: Vec<Assignment> = raci_rows(caller, project_id)
        .await?
        .into_iter()
        .filter(|r| r.0 == subject_type && r.1.as_deref() == subject_id)
        .map(|r| Assignment {
            stakeholder_id: r.2,
            letter: r.3,
        })
        .collect();
    let now = iso(now_ms());
    let mut statements = vec![
        sqlx::query(
            "delete from project_raci where project_id = $1 and subject_type = $2
             and subject_id is not distinct from $3::text",
        )
        .bind(project_id.to_owned())
        .bind(subject_type.to_owned())
        .bind(subject_id.map(str::to_owned)),
    ];
    if !assignments.is_empty() {
        let ids: Vec<String> = assignments.iter().map(|_| generate_id("rac")).collect();
        let stakeholders: Vec<String> = assignments
            .iter()
            .map(|a| a.stakeholder_id.clone())
            .collect();
        let letters: Vec<String> = assignments.iter().map(|a| a.letter.clone()).collect();
        statements.push(
            sqlx::query(
                "insert into project_raci (id, project_id, subject_type, subject_id, stakeholder_id, letter,
                     created_by, created_at, updated_at)
                 select u.id, $1, $2, $3, u.sid, u.letter, $4, $5::timestamptz, $5::timestamptz
                 from unnest($6::text[], $7::text[], $8::text[]) as u(id, sid, letter)",
            )
            .bind(project_id.to_owned())
            .bind(subject_type.to_owned())
            .bind(subject_id.map(str::to_owned))
            .bind(caller.user_id.clone())
            .bind(now)
            .bind(ids)
            .bind(stakeholders)
            .bind(letters),
        );
    }
    weldsuite_db::atomically(db, statements).await?;

    // A cell is a relation, not an entity: the stakeholders' events are its trail.
    let order: Vec<String> = register
        .iter()
        .filter_map(|r| text(r, "id").map(str::to_owned))
        .collect();
    for id in changed_stakeholders(&before, assignments) {
        let Some(row) = known(&id) else { continue };
        let letters: Vec<&str> = assignments
            .iter()
            .filter(|a| a.stakeholder_id == id)
            .map(|a| a.letter.as_str())
            .collect();
        publish_stakeholder(
            state,
            caller,
            PROJECT_STAKEHOLDER_UPDATED,
            row,
            Some(
                json!({ "raci": { "subjectType": subject_type, "subjectId": subject_id, "letters": letters } }),
            ),
        );
    }
    Ok(Data(json!({
        "subjectType": subject_type,
        "subjectId": subject_id,
        "code": deliverable.as_ref().map(|d| format!("D{}", d.0)),
        "title": deliverable.as_ref().map(|d| d.1.clone()),
        "assignments": sort_assignments(assignments, &order).iter().map(Assignment::to_value).collect::<Vec<_>>(),
    }))
    .into_response())
}

// ── Register: reads ─────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match stakeholder_list_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let limit = parse_limit(q.limit.as_deref(), 100, 200);
    let checked: Result<Option<(String, String)>, Refusal> = async {
        if !caller.can_access(&q.project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        Ok(match &q.cursor {
            Some(cursor) => {
                keyset_cursor(
                    &caller.db,
                    "select id, to_jsonb(created_at) #>> '{}' from project_stakeholders where id = $1 limit 1",
                    cursor,
                )
                .await?
            }
            None => None,
        })
    }
    .await;
    let cursor = match checked {
        Ok(cursor) => cursor,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        list_register(&caller, &q.project_id, limit, cursor).await,
        "Failed to list stakeholders",
    )
}

async fn list_register(
    caller: &Caller,
    project_id: &str,
    limit: i64,
    cursor: Option<(String, String)>,
) -> Reply {
    let db = &caller.db;
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from project_stakeholders t
         where t.deleted_at is null and t.project_id = $1
           and ($2::timestamptz is null or t.created_at > $2::timestamptz
                or (t.created_at = $2::timestamptz and t.id > $3))
         order by t.created_at asc, t.id asc limit $4",
    )
    .bind(project_id)
    .bind(cursor.as_ref().map(|c| c.0.as_str()))
    .bind(cursor.as_ref().map(|c| c.1.as_str()))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from project_stakeholders t where t.deleted_at is null and t.project_id = $1",
    )
    .bind(project_id)
    .fetch_one(db)
    .await?;
    let (rows, has_more, next) = page(rows.into_iter().map(js_row).collect(), limit);
    let identities = identities_of(db, &rows).await?;
    let items = rows
        .iter()
        .map(|row| {
            let (name, email) = identities
                .get(text(row, "id").unwrap_or_default())
                .cloned()
                .unwrap_or((None, None));
            present_stakeholder(row, name.as_deref(), email.as_deref())
        })
        .collect();
    Ok(paged(items, total, has_more, next))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Reply = async {
        let Some(row) = find_stakeholder(&caller.db, &id).await? else {
            return Err(Refusal::not_found(LABEL, &id));
        };
        if !caller
            .can_access(text(&row, "projectId").unwrap_or_default())
            .await?
        {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        Ok(Data(present_one(&caller, &row).await?).into_response())
    }
    .await;
    reply(result, "Failed to fetch stakeholder")
}

// ── Register: writes ────────────────────────────────────────────────────────

async fn create(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let checked = async {
        let input = parse_body(&body, read_create_stakeholder)?;
        let project_id = text(&Value::Object(input.clone()), "projectId")
            .unwrap_or_default()
            .to_owned();
        if !caller.can_write(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        if !live_project_exists(&caller.db, &project_id).await? {
            return Err(Refusal::not_found("Project", &project_id));
        }
        let member = input
            .get("memberId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let contact = input
            .get("crmContactId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        if let Some(message) = identity_error(member, contact) {
            return Err(Refusal::bad_request(message));
        }
        Ok((project_id, input))
    }
    .await;
    let (project_id, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        add_stakeholder(&state, &caller, &project_id, &input).await,
        "Failed to create stakeholder",
    )
}

async fn add_stakeholder(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
    input: &Map<String, Value>,
) -> Reply {
    let db = &caller.db;
    let member = input
        .get("memberId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let contact = input
        .get("crmContactId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    if let Some(member) = member {
        if !member_exists(db, member).await? {
            return Err(Refusal::bad_request(MEMBER_NOT_FOUND));
        }
    } else if let Some(contact) = contact
        && !contact_exists(db, contact).await?
    {
        return Err(Refusal::bad_request(CONTACT_NOT_FOUND));
    }
    let duplicate: Option<String> = sqlx::query_scalar(
        "select id from project_stakeholders where project_id = $1 and deleted_at is null
           and (($2::text is not null and member_id = $2) or ($3::text is not null and crm_contact_id = $3))
         limit 1",
    )
    .bind(project_id)
    .bind(member)
    .bind(contact)
    .fetch_optional(db)
    .await?;
    if duplicate.is_some() {
        return Err(Refusal::conflict(ALREADY_STAKEHOLDER));
    }
    let now = iso(now_ms());
    let id = generate_id("stk");
    let opt = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
    let scale = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_i64)
            .map_or(3, |n| i16::try_from(n).unwrap_or(3))
    };
    sqlx::query(
        "insert into project_stakeholders (id, project_id, member_id, crm_contact_id, organisation, role,
             influence, interest, attitude, engagement, notes, last_contact_at, created_by, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13, $14::timestamptz, $14::timestamptz)",
    )
    .bind(&id)
    .bind(project_id)
    .bind(member)
    .bind(contact)
    .bind(opt("organisation"))
    .bind(opt("role"))
    .bind(scale("influence"))
    .bind(scale("interest"))
    .bind(opt("attitude").unwrap_or_else(|| "neutral".to_owned()))
    .bind(opt("engagement").unwrap_or_else(|| "neutral".to_owned()))
    .bind(opt("notes"))
    .bind(opt("lastContactAt").and_then(|d| js_date(&d)))
    .bind(&caller.user_id)
    .bind(now)
    .execute(db)
    .await?;
    let Some(row) = find_stakeholder(db, &id).await? else {
        return Err(Refusal::Internal(
            "the new stakeholder is missing".to_owned(),
        ));
    };
    publish_stakeholder(state, caller, PROJECT_STAKEHOLDER_CREATED, &row, None);
    Ok(Created(present_one(caller, &row).await?).into_response())
}

/// A value bound to the dynamic update.
enum Arg {
    Text(Option<String>),
    Int(i16),
}

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(existing) = find_stakeholder(&caller.db, &id).await? else {
            return Err(Refusal::not_found(LABEL, &id));
        };
        if !caller
            .can_write(text(&existing, "projectId").unwrap_or_default())
            .await?
        {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        parse_body(&body, read_update_stakeholder)
    }
    .await;
    let input = match checked {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        update_stakeholder(&state, &caller, &id, &input).await,
        "Failed to update stakeholder",
    )
}

async fn update_stakeholder(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    input: &Map<String, Value>,
) -> Reply {
    let mut sets: Vec<String> = Vec::new();
    let mut args: Vec<Arg> = Vec::new();
    let mut set = |column: &str, cast: &str, arg: Arg| {
        args.push(arg);
        sets.push(format!("{column} = ${}{cast}", args.len() + 2));
    };
    for (key, column) in [
        ("organisation", "organisation"),
        ("role", "role"),
        ("attitude", "attitude"),
        ("engagement", "engagement"),
        ("notes", "notes"),
    ] {
        if let Some(value) = input.get(key) {
            set(column, "", Arg::Text(value.as_str().map(str::to_owned)));
        }
    }
    for key in ["influence", "interest"] {
        if let Some(value) = input.get(key).and_then(Value::as_i64) {
            set(key, "", Arg::Int(i16::try_from(value).unwrap_or(3)));
        }
    }
    if let Some(value) = input.get("lastContactAt") {
        set(
            "last_contact_at",
            "::timestamptz",
            Arg::Text(value.as_str().and_then(js_date)),
        );
    }
    let mut query = sqlx::query(sqlx::AssertSqlSafe(format!(
        "update project_stakeholders set updated_at = $2::timestamptz{}{} where id = $1 and deleted_at is null",
        if sets.is_empty() { "" } else { ", " },
        sets.join(", ")
    )))
    .bind(id.to_owned())
    .bind(iso(now_ms()));
    for arg in args {
        query = match arg {
            Arg::Text(value) => query.bind(value),
            Arg::Int(value) => query.bind(value),
        };
    }
    query.execute(&caller.db).await?;
    let Some(row) = find_stakeholder(&caller.db, id).await? else {
        return Err(Refusal::not_found(LABEL, id));
    };
    publish_stakeholder(state, caller, PROJECT_STAKEHOLDER_UPDATED, &row, None);
    Ok(Data(present_one(caller, &row).await?).into_response())
}

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Reply = async {
        let Some(existing) = find_stakeholder(&caller.db, &id).await? else {
            return Err(Refusal::not_found(LABEL, &id));
        };
        if !caller.can_write(text(&existing, "projectId").unwrap_or_default()).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        // The person leaves the register together with their RACI cells and their portal access.
        let now = iso(now_ms());
        weldsuite_db::atomically(
            &caller.db,
            [
                sqlx::query("delete from project_raci where stakeholder_id = $1").bind(id.clone()),
                sqlx::query(
                    "update project_stakeholders set deleted_at = $2::timestamptz, updated_at = $2::timestamptz,
                         portal_access = false where id = $1 and deleted_at is null",
                )
                .bind(id.clone())
                .bind(now),
            ],
        )
        .await?;
        let mut gone = existing.clone();
        gone["portalAccess"] = Value::Bool(false);
        publish_stakeholder(&state, &caller, PROJECT_STAKEHOLDER_DELETED, &gone, None);
        Ok(NoContent.into_response())
    }
    .await;
    reply(result, "Failed to delete stakeholder")
}

// ── Portal access ───────────────────────────────────────────────────────────

async fn portal_invite(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let checked = async {
        let Some(existing) = find_stakeholder(&caller.db, &id).await? else {
            return Err(Refusal::not_found(LABEL, &id));
        };
        if !caller
            .can_manage(text(&existing, "projectId").unwrap_or_default())
            .await?
        {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        if text(&existing, "crmContactId").is_none() {
            return Err(Refusal::bad_request(NOT_A_CONTACT));
        }
        Ok(existing)
    }
    .await;
    let existing = match checked {
        Ok(existing) => existing,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        invite(&state, &caller, &id, &existing).await,
        "Failed to invite the contact to the portal",
    )
}

async fn invite(state: &FlowState, caller: &Caller, id: &str, existing: &Value) -> Reply {
    let db = &caller.db;
    let identities = identities_of(db, std::slice::from_ref(existing)).await?;
    let (name, email) = identities.get(id).cloned().unwrap_or((None, None));
    let Some(email) = email.filter(|e| !e.is_empty()) else {
        return Err(Refusal::bad_request(CONTACT_WITHOUT_EMAIL));
    };
    let now = iso(now_ms());
    sqlx::query(
        "update project_stakeholders set portal_access = true, portal_invited_at = $2::timestamptz,
             updated_at = $2::timestamptz where id = $1 and deleted_at is null",
    )
    .bind(id.to_owned())
    .bind(now)
    .execute(db)
    .await?;
    let Some(row) = find_stakeholder(db, id).await? else {
        return Err(Refusal::not_found(LABEL, id));
    };
    publish_stakeholder(state, caller, PROJECT_STAKEHOLDER_UPDATED, &row, None);
    if let Some(project) =
        load_report_project(db, text(&row, "projectId").unwrap_or_default()).await?
    {
        let inviter = member_identities(db, std::slice::from_ref(&caller.user_id))
            .await?
            .remove(&caller.user_id)
            .and_then(|(name, _)| name);
        let context = NotifyContext::of(state, caller);
        let contact_id = text(existing, "crmContactId")
            .unwrap_or_default()
            .to_owned();
        let (contact_name, contact_email) = (name.clone(), email.clone());
        state.events.tracker().spawn(async move {
            send_portal_invitation(
                &context,
                &project,
                &contact_id,
                contact_name,
                &contact_email,
                inviter,
            )
            .await;
        });
    }
    Ok(Data(present_stakeholder(&row, name.as_deref(), Some(&email))).into_response())
}

async fn portal_revoke(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Reply = async {
        let Some(existing) = find_stakeholder(&caller.db, &id).await? else {
            return Err(Refusal::not_found(LABEL, &id));
        };
        if !caller
            .can_manage(text(&existing, "projectId").unwrap_or_default())
            .await?
        {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        sqlx::query(
            "update project_stakeholders set portal_access = false, updated_at = $2::timestamptz
             where id = $1 and deleted_at is null",
        )
        .bind(id.clone())
        .bind(iso(now_ms()))
        .execute(&caller.db)
        .await?;
        let Some(row) = find_stakeholder(&caller.db, &id).await? else {
            return Err(Refusal::not_found(LABEL, &id));
        };
        publish_stakeholder(&state, &caller, PROJECT_STAKEHOLDER_UPDATED, &row, None);
        Ok(Data(present_one(&caller, &row).await?).into_response())
    }
    .await;
    reply(result, "Failed to remove the portal access")
}
