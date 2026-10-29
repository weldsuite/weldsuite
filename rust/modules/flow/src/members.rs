//! `/api/project-members` (`routes/project-members/index.ts`): a project's
//! members with their workspace profile, the workspace users not on it yet,
//! and adding, changing and removing members by `(projectId, userId)`.
//!
//! Roles are a closed set (owner | admin | member | viewer). Granting or
//! revoking `owner` is reserved for owners (and the project manager /
//! scope:all holders), and a project always keeps an owner. The hourly rate
//! is pay data: only project admins and the member themselves get it back.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PROJECT_MEMBER_ADDED, PROJECT_MEMBER_REMOVED, PROJECT_MEMBER_UPDATED,
};
use weldsuite_catalogs::permission_keys::{PROJECTS_DELETE, PROJECTS_READ, PROJECTS_UPDATE};
use weldsuite_db::{PgPool, is_unique_violation, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence, js_trim};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Caller, FlowState, Query, Refusal, Reply, now, outside, reply, validate};

const MANAGE_MEMBERS_DENIED: &str =
    "You must be a project owner, admin, or manager to manage its members";
const PROJECT_DENIED: &str = "You are not a member of this project";
const OWNER_CHANGE_DENIED: &str = "Only a project owner can grant or revoke the owner role";
const LAST_OWNER: &str = "A project needs at least one owner";
const NOT_A_WORKSPACE_MEMBER: &str = "User is not an active member of this workspace";
const ALREADY_MEMBER: &str = "User is already a member of this project";

const ROLES: [&str; 4] = ["owner", "admin", "member", "viewer"];

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need(PROJECTS_READ)))
        .route(
            "/",
            axum::routing::post(add).route_layer(need(PROJECTS_UPDATE)),
        )
        .route(
            "/available",
            get(available).route_layer(need(PROJECTS_READ)),
        )
        .route(
            "/by-user/{project_id}/{user_id}",
            get(by_user).route_layer(need(PROJECTS_READ)),
        )
        .route(
            "/by-user/{project_id}/{user_id}",
            axum::routing::patch(update).route_layer(need(PROJECTS_UPDATE)),
        )
        .route(
            "/by-user/{project_id}/{user_id}",
            axum::routing::delete(remove).route_layer(need(PROJECTS_DELETE)),
        )
        .route(
            "/by-user/{project_id}/{user_id}/stats",
            get(stats).route_layer(need(PROJECTS_READ)),
        )
        .route("/{id}", get(detail).route_layer(need(PROJECTS_READ)))
        .with_state(state)
}

/// The member's workspace profile, `null` without a workspace member row
/// (Drizzle nullifies a left-joined object whose fields are all null).
macro_rules! member_user {
    () => {
        "case when wm.user_id is null and wm.name is null and wm.email is null and wm.picture is null
              then null
              else jsonb_build_object('id', wm.user_id, 'name', wm.name, 'email', wm.email,
                                      'avatar', wm.picture) end"
    };
}

/// The members' user ids, active and live (`getActiveMemberIds`).
async fn active_member_ids(db: &PgPool, project_id: &str) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select user_id from project_members
         where project_id = $1 and is_active = true and deleted_at is null",
    )
    .bind(project_id)
    .fetch_all(db)
    .await
}

/// `redactRate`: project admins and the member themselves see the rate.
fn redact(mut row: Value, viewer: &str, is_admin: bool) -> Value {
    if !is_admin && row["userId"].as_str() != Some(viewer) {
        row["hourlyRate"] = Value::Null;
    }
    row
}

/// Does the project keep an owner if `user_id` stops being one? The project
/// manager counts (`hasOtherOwner`).
async fn has_other_owner(
    db: &PgPool,
    project_id: &str,
    user_id: &str,
) -> Result<bool, sqlx::Error> {
    let manager: Option<Option<String>> =
        sqlx::query_scalar("select project_manager_id from projects where id = $1 limit 1")
            .bind(project_id)
            .fetch_optional(db)
            .await?;
    if let Some(Some(manager)) = manager
        && !manager.is_empty()
        && manager != user_id
    {
        return Ok(true);
    }
    let other: Option<String> = sqlx::query_scalar(
        "select id from project_members
         where project_id = $1 and user_id <> $2 and lower(role) = 'owner'
           and is_active = true and deleted_at is null
         limit 1",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(other.is_some())
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let Some(project_id) = q.present("projectId").map(str::to_owned) else {
        return ApiError::bad_request("Missing required query param: projectId").into_response();
    };
    let access = match caller.access(&project_id).await {
        Ok(access) => access,
        Err(error) => return outside(Err(error.into())),
    };
    if !access.may_access() {
        return ApiError::forbidden()
            .with_message(PROJECT_DENIED)
            .into_response();
    }
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select jsonb_build_object('id', pm.id, 'projectId', pm.project_id, 'userId', pm.user_id,
                'role', pm.role, 'permissions', pm.permissions, 'isActive', pm.is_active,
                'joinedAt', pm.joined_at, 'leftAt', pm.left_at,
                'allocationPercentage', pm.allocation_percentage::text,
                'hourlyRate', pm.hourly_rate::text, 'createdAt', pm.created_at,
                'updatedAt', pm.updated_at, 'user', ",
        member_user!(),
        ") from project_members pm
         left join workspace_members wm on pm.user_id = wm.user_id
         where pm.project_id = $1 and pm.is_active = true and pm.deleted_at is null
           and (wm.user_id is null or (wm.deleted_at is null and wm.status = 'ACTIVE'))"
    ))
    .bind(&project_id)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(
            rows.into_iter()
                .map(|row| redact(js_row(row), &caller.user_id, access.is_admin))
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(error) => Refusal::from(error).respond("Failed to list project members"),
    }
}

// ── GET /available ──────────────────────────────────────────────────────────

async fn available(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let Some(project_id) = q.present("projectId").map(str::to_owned) else {
        return ApiError::bad_request("Missing required query param: projectId").into_response();
    };
    match caller.can_access(&project_id).await {
        Ok(true) => {}
        Ok(false) => {
            return ApiError::forbidden()
                .with_message(PROJECT_DENIED)
                .into_response();
        }
        Err(error) => return outside(Err(error.into())),
    }
    reply(
        async {
            let existing = active_member_ids(&caller.db, &project_id).await?;
            let rows: Vec<Value> = sqlx::query_scalar(
                "select jsonb_build_object('id', user_id, 'name', name, 'email', email, 'image', picture)
                 from workspace_members
                 where deleted_at is null and status = 'ACTIVE'
                   and (cardinality($1::text[]) = 0 or user_id <> all($1))",
            )
            .bind(&existing)
            .fetch_all(&caller.db)
            .await?;
            Ok(Data(rows).into_response())
        }
        .await,
        "Failed to fetch available users",
    )
}

// ── GET /by-user/:projectId/:userId, /stats ────────────────────────────────

async fn by_user(caller: Caller, Path((project_id, user_id)): Path<(String, String)>) -> Response {
    let access = match caller.access(&project_id).await {
        Ok(access) => access,
        Err(error) => return outside(Err(error.into())),
    };
    if !access.may_access() {
        return ApiError::forbidden()
            .with_message(PROJECT_DENIED)
            .into_response();
    }
    let row: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select jsonb_build_object('id', pm.id, 'projectId', pm.project_id, 'userId', pm.user_id,
                'role', pm.role, 'permissions', pm.permissions, 'isActive', pm.is_active,
                'joinedAt', pm.joined_at, 'leftAt', pm.left_at,
                'allocationPercentage', pm.allocation_percentage::text,
                'hourlyRate', pm.hourly_rate::text, 'user', ",
        member_user!(),
        ") from project_members pm
         left join workspace_members wm on pm.user_id = wm.user_id
         where pm.project_id = $1 and pm.user_id = $2 and pm.deleted_at is null
         limit 1"
    ))
    .bind(&project_id)
    .bind(&user_id)
    .fetch_optional(&caller.db)
    .await;
    match row {
        Ok(Some(row)) => {
            Data(redact(js_row(row), &caller.user_id, access.is_admin)).into_response()
        }
        Ok(None) => ApiError::not_found("Project member", Some(&format!("{project_id}/{user_id}")))
            .into_response(),
        Err(error) => Refusal::from(error).respond("Failed to fetch project member"),
    }
}

async fn stats() -> Response {
    Data(json!({ "tasksAssigned": 0, "tasksCompleted": 0, "hoursLogged": 0, "overdue": 0 }))
        .into_response()
}

// ── POST / ──────────────────────────────────────────────────────────────────

/// The role `z.preprocess` (trimmed, lowercased) then `z.enum(ROLES)`.
fn read_role(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    presence: Presence,
) -> Field<String> {
    let mut view = Map::new();
    if let Some(value) = fields.get("role") {
        let value = match value {
            Value::String(text) => Value::String(js_trim(text).to_lowercase()),
            other => other.clone(),
        };
        view.insert("role".to_owned(), value);
    }
    issues.choice(&view, "role", presence, &ROLES)
}

/// `z.union([z.string(), z.number()]).optional().transform(String)`.
fn read_amount(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> Option<String> {
    match fields.get(key) {
        None => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Number(n)) => Some(weldsuite_flow_domain::js::number_text(
            n.as_f64().unwrap_or(f64::NAN),
        )),
        Some(other) => {
            let received = match other {
                Value::Null => "null",
                Value::Bool(_) => "boolean",
                Value::Array(_) => "array",
                _ => "object",
            };
            let path = issues.path_of(key);
            let option = |expected: &str| {
                json!({
                    "issues": [{
                        "code": "invalid_type",
                        "expected": expected,
                        "received": received,
                        "path": path,
                        "message": format!("Expected {expected}, received {received}"),
                    }],
                    "name": "ZodError",
                })
            };
            let issue = json!({
                "code": "invalid_union",
                "unionErrors": [option("string"), option("number")],
                "message": "Invalid input",
            });
            issues.push_issue(key, issue);
            None
        }
    }
}

/// `z.array(z.string()).optional()`.
fn read_permissions(issues: &mut Issues, fields: &Map<String, Value>) -> Option<Vec<String>> {
    issues
        .list(
            fields,
            "permissions",
            Presence::Optional,
            None,
            None,
            |issues, item| issues.item_text(item, weldsuite_kit::validation::Text::default()),
        )
        .into_option()
}

struct AddMember {
    project_id: String,
    user_id: String,
    role: String,
    permissions: Option<Vec<String>>,
    allocation: Option<String>,
    hourly_rate: Option<String>,
}

async fn add(
    State(state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| {
        let project_id = issues.text(fields, "projectId", Presence::Required, Some(1), None);
        let user_id = issues.text(fields, "userId", Presence::Required, Some(1), None);
        let role = if fields.contains_key("role") {
            read_role(issues, fields, Presence::Required).into_option()
        } else {
            Some("member".to_owned())
        };
        let permissions = read_permissions(issues, fields);
        let allocation = read_amount(issues, fields, "allocationPercentage");
        let hourly_rate = read_amount(issues, fields, "hourlyRate");
        AddMember {
            project_id: project_id.into_option().unwrap_or_default(),
            user_id: user_id.into_option().unwrap_or_default(),
            role: role.unwrap_or_default(),
            permissions,
            allocation,
            hourly_rate,
        }
    }) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let guard = async {
        if !caller.can_manage(&input.project_id).await? {
            return Err(Refusal::forbidden(MANAGE_MEMBERS_DENIED));
        }
        if input.role == "owner" && !caller.can_change_owners(&input.project_id).await? {
            return Err(Refusal::forbidden(OWNER_CHANGE_DENIED));
        }
        Ok(())
    };
    if let Err(refusal) = guard.await {
        return outside(Err(refusal));
    }
    reply(
        add_member(&state, &caller, &input).await,
        "Failed to add project member",
    )
}

async fn add_member(state: &FlowState, caller: &Caller, input: &AddMember) -> Reply {
    let db = &caller.db;
    let workspace_member: Option<String> = sqlx::query_scalar(
        "select id from workspace_members
         where user_id = $1 and status = 'ACTIVE' and deleted_at is null limit 1",
    )
    .bind(&input.user_id)
    .fetch_optional(db)
    .await?;
    if workspace_member.is_none() {
        return Err(Refusal::bad_request(NOT_A_WORKSPACE_MEMBER));
    }
    let existing: Option<(String, bool, bool)> = sqlx::query_as(
        "select id, deleted_at is not null, is_active from project_members
         where project_id = $1 and user_id = $2 limit 1",
    )
    .bind(&input.project_id)
    .bind(&input.user_id)
    .fetch_optional(db)
    .await?;
    let now = now();
    let permissions = input.permissions.as_ref().map(|p| json!(p));
    let data = |id: &str| {
        json!({
            "id": id,
            "projectId": input.project_id,
            "userId": input.user_id,
            "role": input.role,
        })
    };
    if let Some((id, deleted, active)) = existing {
        if !deleted && active {
            return Err(Refusal::bad_request(ALREADY_MEMBER));
        }
        sqlx::query(
            "update project_members set is_active = true, deleted_at = null, role = $2,
                    permissions = $3, allocation_percentage = $4::numeric, hourly_rate = $5::numeric,
                    joined_at = $6::timestamp, updated_at = $6::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(&input.role)
        .bind(&permissions)
        .bind(input.allocation.as_deref())
        .bind(input.hourly_rate.as_deref())
        .bind(&now)
        .execute(db)
        .await?;
        let members = active_member_ids(db, &input.project_id).await?;
        caller.publish_to(state, PROJECT_MEMBER_ADDED, &id, data(&id), members);
        return Ok(Created(json!({ "id": id })).into_response());
    }
    let id = generate_id("pmem");
    let inserted = sqlx::query(
        "insert into project_members
             (id, project_id, user_id, role, permissions, allocation_percentage, hourly_rate,
              is_active, joined_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, true,
                 $8::timestamp, $8::timestamp, $8::timestamp)",
    )
    .bind(&id)
    .bind(&input.project_id)
    .bind(&input.user_id)
    .bind(&input.role)
    .bind(&permissions)
    .bind(input.allocation.as_deref())
    .bind(input.hourly_rate.as_deref())
    .bind(&now)
    .execute(db)
    .await;
    if let Err(error) = inserted {
        // (project_id, user_id) is unique: a concurrent add loses the race.
        if is_unique_violation(&error) {
            return Err(Refusal::bad_request(ALREADY_MEMBER));
        }
        return Err(error.into());
    }
    let members = active_member_ids(db, &input.project_id).await?;
    caller.publish_to(state, PROJECT_MEMBER_ADDED, &id, data(&id), members);
    Ok(Created(json!({ "id": id })).into_response())
}

// ── PATCH /by-user/:projectId/:userId ──────────────────────────────────────

/// `updateMemberSchema`: the present keys, as parsed.
fn read_update(issues: &mut Issues, fields: &Map<String, Value>) -> Map<String, Value> {
    let mut data = Map::new();
    if let Field::Set(role) = read_role(issues, fields, Presence::Optional) {
        data.insert("role".to_owned(), json!(role));
    }
    if let Some(permissions) = read_permissions(issues, fields) {
        data.insert("permissions".to_owned(), json!(permissions));
    }
    if let Some(allocation) = read_amount(issues, fields, "allocationPercentage") {
        data.insert("allocationPercentage".to_owned(), json!(allocation));
    }
    if let Some(rate) = read_amount(issues, fields, "hourlyRate") {
        data.insert("hourlyRate".to_owned(), json!(rate));
    }
    if let Field::Set(active) = issues.boolean(fields, "isActive", Presence::Optional) {
        data.insert("isActive".to_owned(), json!(active));
    }
    data
}

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path((project_id, user_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_update) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    match caller.can_manage(&project_id).await {
        Ok(true) => {}
        Ok(false) => {
            return ApiError::forbidden()
                .with_message(MANAGE_MEMBERS_DENIED)
                .into_response();
        }
        Err(error) => return outside(Err(error.into())),
    }
    reply(
        update_member(&state, &caller, &project_id, &user_id, data).await,
        "Failed to update project member",
    )
}

async fn update_member(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
    user_id: &str,
    data: Map<String, Value>,
) -> Reply {
    let db = &caller.db;
    let existing: Option<(String, String, bool)> = sqlx::query_as(
        "select id, role, is_active from project_members
         where project_id = $1 and user_id = $2 and deleted_at is null limit 1",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let Some((id, role, active)) = existing else {
        return Err(Refusal::not_found(
            "Project member",
            &format!("{project_id}/{user_id}"),
        ));
    };
    // Only owners hand out or take back the owner role; the last owner
    // cannot be demoted or deactivated.
    let current = role.to_lowercase();
    let next = data
        .get("role")
        .and_then(Value::as_str)
        .map_or_else(|| current.clone(), str::to_owned);
    let set_active = data.get("isActive").and_then(Value::as_bool);
    let reactivates_owner = !active && set_active == Some(true) && next == "owner";
    let grants_owner = next == "owner" && (current != "owner" || reactivates_owner);
    let revokes_owner =
        active && current == "owner" && (next != "owner" || set_active == Some(false));
    if (grants_owner || revokes_owner) && !caller.can_change_owners(project_id).await? {
        return Err(Refusal::forbidden(OWNER_CHANGE_DENIED));
    }
    if revokes_owner && !has_other_owner(db, project_id, user_id).await? {
        return Err(Refusal::conflict(LAST_OWNER));
    }
    sqlx::query(
        "update project_members set
             role = case when $2::jsonb ? 'role' then $2::jsonb->>'role' else role end,
             permissions = case when $2::jsonb ? 'permissions' then $2::jsonb->'permissions' else permissions end,
             allocation_percentage = case when $2::jsonb ? 'allocationPercentage'
                 then ($2::jsonb->>'allocationPercentage')::numeric else allocation_percentage end,
             hourly_rate = case when $2::jsonb ? 'hourlyRate'
                 then ($2::jsonb->>'hourlyRate')::numeric else hourly_rate end,
             is_active = case when $2::jsonb ? 'isActive' then ($2::jsonb->>'isActive')::boolean else is_active end,
             updated_at = $3::timestamp
         where id = $1",
    )
    .bind(&id)
    .bind(Value::Object(data.clone()))
    .bind(now())
    .execute(db)
    .await?;
    let members = active_member_ids(db, project_id).await?;
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    event.insert("projectId".to_owned(), json!(project_id));
    event.insert("userId".to_owned(), json!(user_id));
    for (key, value) in &data {
        if key != "hourlyRate" {
            event.insert(key.clone(), value.clone());
        }
    }
    caller.publish_to(
        state,
        PROJECT_MEMBER_UPDATED,
        &id,
        Value::Object(event),
        members,
    );
    let mut out = Map::new();
    out.insert("projectId".to_owned(), json!(project_id));
    out.insert("userId".to_owned(), json!(user_id));
    for (key, value) in data {
        out.insert(key, value);
    }
    Ok(Data(Value::Object(out)).into_response())
}

// ── DELETE /by-user/:projectId/:userId ─────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path((project_id, user_id)): Path<(String, String)>,
) -> Response {
    match caller.can_manage(&project_id).await {
        Ok(true) => {}
        Ok(false) => {
            return ApiError::forbidden()
                .with_message(MANAGE_MEMBERS_DENIED)
                .into_response();
        }
        Err(error) => return outside(Err(error.into())),
    }
    reply(
        remove_member(&state, &caller, &project_id, &user_id).await,
        "Failed to remove project member",
    )
}

async fn remove_member(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
    user_id: &str,
) -> Reply {
    let db = &caller.db;
    let existing: Option<(String, String, bool)> = sqlx::query_as(
        "select id, role, is_active from project_members
         where project_id = $1 and user_id = $2 and deleted_at is null limit 1",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let Some((id, role, active)) = existing else {
        return Err(Refusal::not_found(
            "Project member",
            &format!("{project_id}/{user_id}"),
        ));
    };
    if active && role.to_lowercase() == "owner" {
        if !caller.can_change_owners(project_id).await? {
            return Err(Refusal::forbidden(OWNER_CHANGE_DENIED));
        }
        if !has_other_owner(db, project_id, user_id).await? {
            return Err(Refusal::conflict(LAST_OWNER));
        }
    }
    sqlx::query(
        "update project_members set is_active = false, left_at = $2::timestamp,
                deleted_at = $2::timestamp, updated_at = $2::timestamp
         where id = $1",
    )
    .bind(&id)
    .bind(now())
    .execute(db)
    .await?;
    // The remaining members and the removed user all see the change.
    let mut members = active_member_ids(db, project_id).await?;
    members.push(user_id.to_owned());
    caller.publish_to(
        state,
        PROJECT_MEMBER_REMOVED,
        &id,
        json!({ "id": id, "projectId": project_id, "userId": user_id }),
        members,
    );
    Ok(NoContent.into_response())
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let row: Option<Value> = sqlx::query_scalar(concat!(
                "select ",
                member_json!("pm"),
                " from project_members pm where pm.id = $1 and pm.deleted_at is null limit 1"
            ))
            .bind(&id)
            .fetch_optional(&caller.db)
            .await?;
            let Some(row) = row.map(js_row) else {
                return Err(Refusal::not_found("Project member", &id));
            };
            let project_id = row["projectId"].as_str().unwrap_or_default().to_owned();
            let access = caller.access(&project_id).await?;
            if !access.may_access() {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            Ok(Data(redact(row, &caller.user_id, access.is_admin)).into_response())
        }
        .await,
        "Failed to fetch project member",
    )
}
