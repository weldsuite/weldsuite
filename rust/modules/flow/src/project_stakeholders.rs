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
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, TransactionTrait,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, PROJECT_STAKEHOLDER_CREATED, PROJECT_STAKEHOLDER_DELETED,
    PROJECT_STAKEHOLDER_UPDATED,
};
use weldsuite_db::{orm, utc_now};
use weldsuite_flow_domain::js::{js_date, millis_of, parse_int};
use weldsuite_flow_domain::stakeholders::{
    ALREADY_STAKEHOLDER, Assignment, CONTACT_NOT_FOUND, CONTACT_WITHOUT_EMAIL,
    DELIVERABLE_NOT_FOUND, MEMBER_NOT_FOUND, NOT_A_CONTACT, STAKEHOLDER_NOT_IN_PROJECT,
    changed_stakeholders, event_data, identity_error, present_stakeholder, raci_assignments_error,
    raci_subject_error, sort_assignments,
};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    project_deliverables, project_raci, project_stakeholders, projects,
};

use crate::project_status_reports::publish_project_updated;
use crate::project_tabs::merged_settings;
use crate::raid_body::parse_body;
use crate::raid_store::live_project_exists;
use crate::reporting_body::{
    read_create_stakeholder, read_put_plan, read_put_raci, read_update_stakeholder,
    stakeholder_list_query,
};
use crate::reporting_notify::{NotifyContext, send_portal_invitation};
use crate::reporting_store::{
    contact_exists, find_stakeholder, identities_of, instant, load_report_project, member_exists,
    member_identities, stakeholders_of_project,
};
use crate::{
    Caller, FlowState, Refusal, Reply, fetch_limit, json_rows, keyset_cursor_tz, now_ms, outside,
    page, paged, reply,
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

/// `new Date()` as the `timestamptz` columns take it (milliseconds).
fn now_at() -> OffsetDateTime {
    instant(now_ms())
}

/// A `toISOString()` text as the instant it names.
fn at_of(iso: &str) -> Option<OffsetDateTime> {
    millis_of(iso).map(instant)
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
async fn present_one(caller: &Caller, row: &Value) -> Result<Value, DbErr> {
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
) -> Result<(), DbErr> {
    projects::Entity::update_many()
        .col_expr(
            projects::Column::Settings,
            merged_settings(json!({ key: value })),
        )
        .col_expr(projects::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(projects::Column::Id.eq(project_id))
        .filter(projects::Column::DeletedAt.is_null())
        .exec(&orm(&caller.db))
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
) -> Result<Vec<(String, Option<String>, String, String)>, DbErr> {
    use project_raci::Column;
    project_raci::Entity::find()
        .select_only()
        .columns([
            Column::SubjectType,
            Column::SubjectId,
            Column::StakeholderId,
            Column::Letter,
        ])
        .filter(Column::ProjectId.eq(project_id))
        .order_by_asc(Column::CreatedAt)
        .order_by_asc(Column::Id)
        .into_tuple()
        .all(&orm(&caller.db))
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
        let deliverables: Vec<(String, i32, String)> = {
            use project_deliverables::Column;
            project_deliverables::Entity::find()
                .select_only()
                .columns([Column::Id, Column::Number, Column::Title])
                .filter(Column::ProjectId.eq(&project_id))
                .filter(Column::DeletedAt.is_null())
                .order_by_asc(Column::Position)
                .order_by_asc(Column::Number)
                .into_tuple()
                .all(&orm(&caller.db))
                .await?
        };
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

/// The subject's cells replaced in one transaction: the old ones deleted,
/// the new ones inserted.
async fn write_raci(
    caller: &Caller,
    project_id: &str,
    subject_type: &str,
    subject_id: Option<&str>,
    assignments: &[Assignment],
) -> Result<(), DbErr> {
    use project_raci::Column;
    let now = now_at();
    // `subject_id is not distinct from subjectId`.
    let subject = match subject_id {
        Some(id) => Column::SubjectId.eq(id),
        None => Column::SubjectId.is_null(),
    };
    let tx = orm(&caller.db).begin().await?;
    project_raci::Entity::delete_many()
        .filter(Column::ProjectId.eq(project_id))
        .filter(Column::SubjectType.eq(subject_type))
        .filter(subject)
        .exec(&tx)
        .await?;
    if !assignments.is_empty() {
        project_raci::Entity::insert_many(assignments.iter().map(|a| project_raci::ActiveModel {
            id: Set(generate_id("rac")),
            project_id: Set(project_id.to_owned()),
            subject_type: Set(subject_type.to_owned()),
            subject_id: Set(subject_id.map(str::to_owned)),
            stakeholder_id: Set(a.stakeholder_id.clone()),
            letter: Set(a.letter.clone()),
            created_by: Set(caller.user_id.clone()),
            created_at: Set(now),
            updated_at: Set(now),
        }))
        .exec_without_returning(&tx)
        .await?;
    }
    tx.commit().await
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
        use project_deliverables::Column;
        deliverable = project_deliverables::Entity::find()
            .select_only()
            .columns([Column::Number, Column::Title])
            .filter(Column::Id.eq(subject))
            .filter(Column::ProjectId.eq(project_id))
            .filter(Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(db))
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
    write_raci(caller, project_id, subject_type, subject_id, assignments).await?;

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
    let checked: Result<Option<(OffsetDateTime, String)>, Refusal> = async {
        if !caller.can_access(&q.project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        Ok(match &q.cursor {
            Some(cursor) => {
                keyset_cursor_tz(
                    &caller.db,
                    project_stakeholders::Column::Id,
                    project_stakeholders::Column::CreatedAt,
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
    cursor: Option<(OffsetDateTime, String)>,
) -> Reply {
    use project_stakeholders::Column;
    let db = &caller.db;
    let live = || {
        project_stakeholders::Entity::find()
            .filter(Column::DeletedAt.is_null())
            .filter(Column::ProjectId.eq(project_id))
    };
    let mut rows = live();
    if let Some((at, id)) = &cursor {
        // The rows after the cursor in `created_at asc, id asc` order.
        rows = rows.filter(
            Condition::any().add(Column::CreatedAt.gt(*at)).add(
                Condition::all()
                    .add(Column::CreatedAt.eq(*at))
                    .add(Column::Id.gt(id.as_str())),
            ),
        );
    }
    let rows = rows
        .order_by_asc(Column::CreatedAt)
        .order_by_asc(Column::Id)
        .limit(fetch_limit(limit)?)
        .all(&orm(db))
        .await?;
    let total = i64::try_from(live().count(&orm(db)).await?).unwrap_or(i64::MAX);
    let (rows, has_more, next) = page(json_rows(rows)?, limit);
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
    if is_stakeholder(db, project_id, member, contact).await? {
        return Err(Refusal::conflict(ALREADY_STAKEHOLDER));
    }
    let now = now_at();
    let id = generate_id("stk");
    let opt = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
    let scale = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_i64)
            .map_or(3, |n| i16::try_from(n).unwrap_or(3))
    };
    project_stakeholders::Entity::insert(project_stakeholders::ActiveModel {
        id: Set(id.clone()),
        project_id: Set(project_id.to_owned()),
        member_id: Set(member.map(str::to_owned)),
        crm_contact_id: Set(contact.map(str::to_owned)),
        organisation: Set(opt("organisation")),
        role: Set(opt("role")),
        influence: Set(scale("influence")),
        interest: Set(scale("interest")),
        attitude: Set(opt("attitude").unwrap_or_else(|| "neutral".to_owned())),
        engagement: Set(opt("engagement").unwrap_or_else(|| "neutral".to_owned())),
        notes: Set(opt("notes")),
        last_contact_at: Set(opt("lastContactAt")
            .and_then(|d| js_date(&d))
            .and_then(|d| at_of(&d))),
        created_by: Set(caller.user_id.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    let Some(row) = find_stakeholder(db, &id).await? else {
        return Err(Refusal::Internal(
            "the new stakeholder is missing".to_owned(),
        ));
    };
    publish_stakeholder(state, caller, PROJECT_STAKEHOLDER_CREATED, &row, None);
    Ok(Created(present_one(caller, &row).await?).into_response())
}

/// A live stakeholder of the project for the member or the contact.
async fn is_stakeholder(
    db: &weldsuite_db::PgPool,
    project_id: &str,
    member: Option<&str>,
    contact: Option<&str>,
) -> Result<bool, DbErr> {
    use project_stakeholders::Column;
    // `memberId` or `crmContactId`, whichever is set.
    let mut same = Condition::any();
    if let Some(member) = member {
        same = same.add(Column::MemberId.eq(member));
    }
    if let Some(contact) = contact {
        same = same.add(Column::CrmContactId.eq(contact));
    }
    if member.is_none() && contact.is_none() {
        return Ok(false);
    }
    let duplicate: Option<String> = project_stakeholders::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::ProjectId.eq(project_id))
        .filter(Column::DeletedAt.is_null())
        .filter(same)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(duplicate.is_some())
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
    use project_stakeholders::Column;
    let mut update = project_stakeholders::Entity::update_many()
        .col_expr(Column::UpdatedAt, Expr::value(now_at()));
    for (key, column) in [
        ("organisation", Column::Organisation),
        ("role", Column::Role),
        ("attitude", Column::Attitude),
        ("engagement", Column::Engagement),
        ("notes", Column::Notes),
    ] {
        if let Some(value) = input.get(key) {
            update = update.col_expr(column, Expr::value(value.as_str().map(str::to_owned)));
        }
    }
    for (key, column) in [
        ("influence", Column::Influence),
        ("interest", Column::Interest),
    ] {
        if let Some(value) = input.get(key).and_then(Value::as_i64) {
            update = update.col_expr(column, Expr::value(i16::try_from(value).unwrap_or(3)));
        }
    }
    if let Some(value) = input.get("lastContactAt") {
        let at = value.as_str().and_then(js_date).and_then(|d| at_of(&d));
        update = update.col_expr(Column::LastContactAt, Expr::value(at));
    }
    update
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(&caller.db))
        .await?;
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
        if !caller
            .can_write(text(&existing, "projectId").unwrap_or_default())
            .await?
        {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        // The person leaves the register together with their RACI cells and their portal access.
        leave_register(&caller, &id).await?;
        let mut gone = existing.clone();
        gone["portalAccess"] = Value::Bool(false);
        publish_stakeholder(&state, &caller, PROJECT_STAKEHOLDER_DELETED, &gone, None);
        Ok(NoContent.into_response())
    }
    .await;
    reply(result, "Failed to delete stakeholder")
}

/// The RACI cells deleted and the stakeholder soft-deleted without portal
/// access, in one transaction.
async fn leave_register(caller: &Caller, id: &str) -> Result<(), DbErr> {
    use project_stakeholders::Column;
    let now = now_at();
    let tx = orm(&caller.db).begin().await?;
    project_raci::Entity::delete_many()
        .filter(project_raci::Column::StakeholderId.eq(id))
        .exec(&tx)
        .await?;
    project_stakeholders::Entity::update_many()
        .col_expr(Column::DeletedAt, Expr::value(Some(now)))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .col_expr(Column::PortalAccess, Expr::value(false))
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .exec(&tx)
        .await?;
    tx.commit().await
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
    let now = now_at();
    project_stakeholders::Entity::update_many()
        .col_expr(
            project_stakeholders::Column::PortalAccess,
            Expr::value(true),
        )
        .col_expr(
            project_stakeholders::Column::PortalInvitedAt,
            Expr::value(Some(now)),
        )
        .col_expr(project_stakeholders::Column::UpdatedAt, Expr::value(now))
        .filter(project_stakeholders::Column::Id.eq(id))
        .filter(project_stakeholders::Column::DeletedAt.is_null())
        .exec(&orm(db))
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
        project_stakeholders::Entity::update_many()
            .col_expr(
                project_stakeholders::Column::PortalAccess,
                Expr::value(false),
            )
            .col_expr(
                project_stakeholders::Column::UpdatedAt,
                Expr::value(now_at()),
            )
            .filter(project_stakeholders::Column::Id.eq(&id))
            .filter(project_stakeholders::Column::DeletedAt.is_null())
            .exec(&orm(&caller.db))
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
