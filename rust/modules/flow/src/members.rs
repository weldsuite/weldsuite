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
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, QueryFilter, QuerySelect,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    PROJECT_MEMBER_ADDED, PROJECT_MEMBER_REMOVED, PROJECT_MEMBER_UPDATED,
};
use weldsuite_catalogs::permission_keys::{PROJECTS_DELETE, PROJECTS_READ, PROJECTS_UPDATE};
use weldsuite_db::record::JsonTable;
use weldsuite_db::{PgPool, is_unique_violation, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence, js_trim};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{project_members, projects, workspace_members};

use crate::{Caller, FlowState, Query, Refusal, Reply, now, outside, reply, row_json, validate};

/// `project_members`, inserted from a row object: Postgres converts each
/// value (the amounts from their text) as the casts did.
const MEMBERS: JsonTable = JsonTable::of::<project_members::Entity>();

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

/// A member row with its workspace profile (`leftJoin(workspaceMembers)`).
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemberWithUser {
    id: String,
    project_id: String,
    user_id: String,
    role: String,
    permissions: Option<Value>,
    is_active: bool,
    #[serde(serialize_with = "weldsuite_schema::js::timestamp::serialize")]
    joined_at: PrimitiveDateTime,
    #[serde(serialize_with = "weldsuite_schema::js::timestamp::option::serialize")]
    left_at: Option<PrimitiveDateTime>,
    #[serde(serialize_with = "weldsuite_schema::js::Numeric::<2>::serialize_option")]
    allocation_percentage: Option<BigDecimal>,
    #[serde(serialize_with = "weldsuite_schema::js::Numeric::<2>::serialize_option")]
    hourly_rate: Option<BigDecimal>,
    #[serde(serialize_with = "weldsuite_schema::js::timestamp::serialize")]
    created_at: PrimitiveDateTime,
    #[serde(serialize_with = "weldsuite_schema::js::timestamp::serialize")]
    updated_at: PrimitiveDateTime,
    #[serde(skip)]
    wm_user_id: Option<String>,
    #[serde(skip)]
    wm_name: Option<String>,
    #[serde(skip)]
    wm_email: Option<String>,
}

impl MemberWithUser {
    /// The member rows joined to their workspace member (`pm`, `wm`).
    fn query() -> sea_orm::Select<project_members::Entity> {
        use project_members::Column;
        let profile = project_members::Entity::belongs_to(workspace_members::Entity)
            .from(Column::UserId)
            .to(workspace_members::Column::UserId)
            .into();
        project_members::Entity::find()
            .select_only()
            .columns([
                Column::Id,
                Column::ProjectId,
                Column::UserId,
                Column::Role,
                Column::Permissions,
                Column::IsActive,
                Column::JoinedAt,
                Column::LeftAt,
                Column::AllocationPercentage,
                Column::HourlyRate,
                Column::CreatedAt,
                Column::UpdatedAt,
            ])
            .column_as(workspace_members::Column::UserId, "wm_user_id")
            .column_as(workspace_members::Column::Name, "wm_name")
            .column_as(workspace_members::Column::Email, "wm_email")
            .join(JoinType::LeftJoin, profile)
    }

    /// The row, with `user`: the member's workspace profile, `null` without
    /// a workspace member row (Drizzle nullifies a left-joined object whose
    /// fields are all null). The `avatar` is filled in afterwards from the
    /// account ([`with_user_avatars`]).
    fn to_json(&self) -> Result<Value, DbErr> {
        let mut row = crate::row_json(self)?;
        let user = if self.wm_user_id.is_none() && self.wm_name.is_none() && self.wm_email.is_none()
        {
            Value::Null
        } else {
            json!({ "id": self.wm_user_id, "name": self.wm_name, "email": self.wm_email, "avatar": null })
        };
        if let Value::Object(fields) = &mut row {
            fields.insert("user".to_owned(), user);
        }
        Ok(row)
    }
}

/// Each row's `user.avatar`: the account picture of `user.id`, not the
/// member row's copy.
async fn with_user_avatars(master: Option<&PgPool>, rows: &mut [Value]) {
    let ids: Vec<&str> = rows
        .iter()
        .filter_map(|row| row["user"]["id"].as_str())
        .collect();
    let pictures = weldsuite_db::AccountPictures::load(master, ids).await;
    for row in rows {
        if let Some(user) = row.get_mut("user").filter(|user| user.is_object()) {
            pictures.apply(user, "id", "avatar");
        }
    }
}

/// The members' user ids, active and live (`getActiveMemberIds`).
async fn active_member_ids(db: &PgPool, project_id: &str) -> Result<Vec<String>, DbErr> {
    use project_members::Column;
    project_members::Entity::find()
        .select_only()
        .column(Column::UserId)
        .filter(Column::ProjectId.eq(project_id))
        .filter(Column::IsActive.eq(true))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await
}

/// The live member row of `user_id` on the project: its id, role and
/// whether it is active.
async fn live_member(
    db: &PgPool,
    project_id: &str,
    user_id: &str,
) -> Result<Option<(String, String, bool)>, DbErr> {
    use project_members::Column;
    project_members::Entity::find()
        .select_only()
        .columns([Column::Id, Column::Role, Column::IsActive])
        .filter(Column::ProjectId.eq(project_id))
        .filter(Column::UserId.eq(user_id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await
}

/// An amount as the `numeric` column takes its text (`$n::numeric`).
fn numeric(amount: Option<&String>) -> Expr {
    sea_orm::ExprTrait::cast_as(Expr::value(amount.cloned()), "numeric")
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
async fn has_other_owner(db: &PgPool, project_id: &str, user_id: &str) -> Result<bool, DbErr> {
    use project_members::Column;
    let manager: Option<Option<String>> = projects::Entity::find_by_id(project_id)
        .select_only()
        .column(projects::Column::ProjectManagerId)
        .into_tuple()
        .one(&orm(db))
        .await?;
    if let Some(Some(manager)) = manager
        && !manager.is_empty()
        && manager != user_id
    {
        return Ok(true);
    }
    let other: Option<String> = project_members::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::ProjectId.eq(project_id))
        .filter(Column::UserId.ne(user_id))
        .filter(sea_orm::ExprTrait::eq(
            Expr::from(Func::lower(Expr::col(Column::Role))),
            "owner",
        ))
        .filter(Column::IsActive.eq(true))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
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
    let rows = async {
        use project_members::Column;
        let profile_live = Condition::any()
            .add(workspace_members::Column::UserId.is_null())
            .add(
                Condition::all()
                    .add(workspace_members::Column::DeletedAt.is_null())
                    .add(workspace_members::Column::Status.eq("ACTIVE")),
            );
        let rows: Vec<MemberWithUser> = MemberWithUser::query()
            .filter(Column::ProjectId.eq(project_id.as_str()))
            .filter(Column::IsActive.eq(true))
            .filter(Column::DeletedAt.is_null())
            .filter(profile_live)
            .into_model()
            .all(&orm(&caller.db))
            .await?;
        rows.iter()
            .map(MemberWithUser::to_json)
            .collect::<Result<Vec<_>, DbErr>>()
    }
    .await;
    match rows {
        Ok(rows) => {
            let mut rows: Vec<Value> = rows
                .into_iter()
                .map(|row| redact(row, &caller.user_id, access.is_admin))
                .collect();
            with_user_avatars(caller.request_master(), &mut rows).await;
            Data(rows).into_response()
        }
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
            use workspace_members::Column;
            let existing = active_member_ids(&caller.db, &project_id).await?;
            let mut users = workspace_members::Entity::find()
                .select_only()
                .columns([Column::UserId, Column::Name, Column::Email])
                .filter(Column::DeletedAt.is_null())
                .filter(Column::Status.eq("ACTIVE"));
            if !existing.is_empty() {
                users = users.filter(Column::UserId.is_not_in(existing));
            }
            let users: Vec<(String, Option<String>, Option<String>)> =
                users.into_tuple().all(&orm(&caller.db)).await?;
            let mut rows: Vec<Value> = users
                .into_iter()
                .map(|(id, name, email)| {
                    json!({ "id": id, "name": name, "email": email, "image": null })
                })
                .collect();
            // Avatars are account pictures, not the member row's copy.
            weldsuite_db::overlay_account_pictures(
                caller.request_master(),
                &mut rows,
                "id",
                "image",
            )
            .await;
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
    let row = async {
        use project_members::Column;
        let row: Option<MemberWithUser> = MemberWithUser::query()
            .filter(Column::ProjectId.eq(project_id.as_str()))
            .filter(Column::UserId.eq(user_id.as_str()))
            .filter(Column::DeletedAt.is_null())
            .into_model()
            .one(&orm(&caller.db))
            .await?;
        // Without `createdAt` and `updatedAt`, as the route selects it.
        row.as_ref()
            .map(|row| {
                let mut json = row.to_json()?;
                if let Value::Object(fields) = &mut json {
                    fields.remove("createdAt");
                    fields.remove("updatedAt");
                }
                Ok::<_, DbErr>(json)
            })
            .transpose()
    }
    .await;
    match row {
        Ok(Some(row)) => {
            let mut rows = [redact(row, &caller.user_id, access.is_admin)];
            with_user_avatars(caller.request_master(), &mut rows).await;
            let [row] = rows;
            Data(row).into_response()
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
    let workspace_member: Option<String> = {
        use workspace_members::Column;
        workspace_members::Entity::find()
            .select_only()
            .column(Column::Id)
            .filter(Column::UserId.eq(input.user_id.as_str()))
            .filter(Column::Status.eq("ACTIVE"))
            .filter(Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(db))
            .await?
    };
    if workspace_member.is_none() {
        return Err(Refusal::bad_request(NOT_A_WORKSPACE_MEMBER));
    }
    let existing: Option<(String, bool, bool)> = {
        use project_members::Column;
        let found: Option<(String, Option<PrimitiveDateTime>, bool)> =
            project_members::Entity::find()
                .select_only()
                .columns([Column::Id, Column::DeletedAt, Column::IsActive])
                .filter(Column::ProjectId.eq(input.project_id.as_str()))
                .filter(Column::UserId.eq(input.user_id.as_str()))
                .into_tuple()
                .one(&orm(db))
                .await?;
        found.map(|(id, deleted_at, active)| (id, deleted_at.is_some(), active))
    };
    let now = now();
    let stamp = utc_now();
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
        {
            use project_members::Column;
            project_members::Entity::update_many()
                .col_expr(Column::IsActive, Expr::value(true))
                .col_expr(
                    Column::DeletedAt,
                    Expr::value(Option::<PrimitiveDateTime>::None),
                )
                .col_expr(Column::Role, Expr::value(input.role.as_str()))
                .col_expr(Column::Permissions, Expr::value(permissions.clone()))
                .col_expr(
                    Column::AllocationPercentage,
                    numeric(input.allocation.as_ref()),
                )
                .col_expr(Column::HourlyRate, numeric(input.hourly_rate.as_ref()))
                .col_expr(Column::JoinedAt, Expr::value(stamp))
                .col_expr(Column::UpdatedAt, Expr::value(stamp))
                .filter(Column::Id.eq(id.as_str()))
                .exec(&orm(db))
                .await?;
        }
        let members = active_member_ids(db, &input.project_id).await?;
        caller.publish_to(state, PROJECT_MEMBER_ADDED, &id, data(&id), members);
        return Ok(Created(json!({ "id": id })).into_response());
    }
    let id = generate_id("pmem");
    let row = json!({
        "id": id, "project_id": input.project_id, "user_id": input.user_id,
        "role": input.role, "permissions": permissions,
        "allocation_percentage": input.allocation, "hourly_rate": input.hourly_rate,
        "is_active": true, "joined_at": now, "created_at": now, "updated_at": now,
    });
    let Value::Object(row) = row else {
        return Err(Refusal::Internal("the row is not an object".to_owned()));
    };
    let inserted = MEMBERS.insert(&orm(db), row).await;
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
    let Some((id, role, active)) = live_member(db, project_id, user_id).await? else {
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
    {
        use project_members::Column;
        // The keys the body sent, as parsed: the role and amounts as text, the
        // permissions as a list, `isActive` as a boolean.
        let text = |key: &str| data.get(key).and_then(Value::as_str).map(str::to_owned);
        let mut update = project_members::Entity::update_many();
        if data.contains_key("role") {
            update = update.col_expr(Column::Role, Expr::value(text("role")));
        }
        if let Some(permissions) = data.get("permissions") {
            update = update.col_expr(Column::Permissions, Expr::value(permissions.clone()));
        }
        if data.contains_key("allocationPercentage") {
            let amount = text("allocationPercentage");
            update = update.col_expr(Column::AllocationPercentage, numeric(amount.as_ref()));
        }
        if data.contains_key("hourlyRate") {
            update = update.col_expr(Column::HourlyRate, numeric(text("hourlyRate").as_ref()));
        }
        if let Some(active) = data.get("isActive") {
            update = update.col_expr(Column::IsActive, Expr::value(active.as_bool()));
        }
        update
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
            .filter(Column::Id.eq(id.as_str()))
            .exec(&orm(db))
            .await?;
    }
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
    let Some((id, role, active)) = live_member(db, project_id, user_id).await? else {
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
    {
        use project_members::Column;
        let now = utc_now();
        project_members::Entity::update_many()
            .col_expr(Column::IsActive, Expr::value(false))
            .col_expr(Column::LeftAt, Expr::value(now))
            .col_expr(Column::DeletedAt, Expr::value(now))
            .col_expr(Column::UpdatedAt, Expr::value(now))
            .filter(Column::Id.eq(id.as_str()))
            .exec(&orm(db))
            .await?;
    }
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
            let row = project_members::Entity::find_by_id(id.as_str())
                .filter(project_members::Column::DeletedAt.is_null())
                .one(&orm(&caller.db))
                .await?;
            let Some(row) = row.map(row_json).transpose()? else {
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
