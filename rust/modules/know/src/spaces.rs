//! Teamspaces, the caller's private space, and teamspace members.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, SimpleExpr};
use sea_orm::{ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter, QuerySelect, UpdateMany};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    KNOWLEDGE_SPACE_CREATED, KNOWLEDGE_SPACE_DELETED, KNOWLEDGE_SPACE_MEMBER_ADDED,
    KNOWLEDGE_SPACE_MEMBER_REMOVED, KNOWLEDGE_SPACE_MEMBER_UPDATED, KNOWLEDGE_SPACE_UPDATED,
};
use weldsuite_catalogs::permission_keys::KNOWLEDGE_CREATE;
use weldsuite_db::orm;
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::{knowledge_pages as pages, knowledge_spaces as spaces};

use crate::access::{self, SpaceAccess, text};
use crate::{Caller, KnowError, KnowState, Refusal, all, now, row, validate};

const VISIBILITIES: [&str; 3] = ["open", "closed", "private"];
const ROLES: [&str; 3] = ["owner", "editor", "viewer"];

/// The `:id` space, resolved for this caller (`spaceFor`).
async fn space_for(caller: &Caller, id: &str) -> Result<SpaceAccess, KnowError> {
    access::require_space(&caller.db, &caller.user_id, id, caller.can_manage_all()).await
}

/// `{ spaceId, userId, role }`, the body of the member routes.
fn membership(space_id: &str, user_id: &str, role: &str) -> Value {
    json!({ "spaceId": space_id, "userId": user_id, "role": role })
}

// ── GET /spaces ─────────────────────────────────────────────────────────────

/// Every space the caller can see, with what they may do in each. Creates
/// their personal space on first use and adds them to default teamspaces they
/// have never been in.
pub(crate) async fn list(caller: Caller) -> Response {
    let result = async {
        let now = now();
        if caller.can(KNOWLEDGE_CREATE) {
            access::ensure_personal_space(&caller.db, &caller.user_id, now).await?;
        }
        access::join_default_spaces(&caller.db, &caller.user_id, now).await?;
        access::list_spaces(&caller.db, &caller.user_id, caller.can_manage_all()).await
    }
    .await;
    match result {
        Ok(rows) => all(rows),
        Err(error) => error.respond("Failed to list spaces"),
    }
}

// ── POST /spaces, PATCH /spaces/:id ────────────────────────────────────────

/// `createKnowledgeSpaceSchema`, or its `.partial()`.
struct SpaceInput {
    name: Field<String>,
    description: Field<String>,
    icon: Field<String>,
    color: Field<String>,
    visibility: Field<String>,
    is_default: Field<bool>,
    sort_order: Field<i64>,
}

fn space_input(headers: &HeaderMap, body: &Bytes, partial: bool) -> Result<SpaceInput, Refusal> {
    validate(headers, body, |issues, fields| {
        let name_presence = if partial {
            Presence::Optional
        } else {
            Presence::Required
        };
        SpaceInput {
            name: issues.text(fields, "name", name_presence, Some(1), Some(255)),
            description: issues.text(fields, "description", Presence::Optional, None, None),
            icon: issues.text(fields, "icon", Presence::Nullish, None, Some(100)),
            color: issues.text(fields, "color", Presence::Nullish, None, Some(50)),
            visibility: issues.choice(fields, "visibility", Presence::Optional, &VISIBILITIES),
            is_default: issues.boolean(fields, "isDefault", Presence::Optional),
            sort_order: issues.integer(fields, "sortOrder", Presence::Optional, None),
        }
    })
}

pub(crate) async fn create(
    State(state): State<KnowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match space_input(&headers, &body, false) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let is_default = input.is_default.as_set() == Some(&true);
    if is_default && !caller.can_manage_all() {
        return ApiError::forbidden()
            .with_message("Only workspace admins can make a teamspace default.")
            .into_response();
    }
    match create_space(&state, &caller, input, is_default).await {
        Ok(row) => Created(row).into_response(),
        Err(error) => error.respond("Failed to create space"),
    }
}

async fn create_space(
    state: &KnowState,
    caller: &Caller,
    input: SpaceInput,
    is_default: bool,
) -> Result<Value, KnowError> {
    let db = &caller.db;
    let id = generate_id("kspc");
    let now = now();
    let sort_order = if let Field::Set(order) = input.sort_order {
        order
    } else {
        let max: Option<Option<i32>> = spaces::Entity::find()
            .select_only()
            .column_as(spaces::Column::SortOrder.max(), "max")
            .filter(spaces::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(db))
            .await?;
        max.flatten().map_or(-1, i64::from) + 1
    };
    let name = input.name.into_option().unwrap_or_default();
    spaces::Entity::insert(spaces::ActiveModel {
        id: Set(id.clone()),
        name: Set(name.clone()),
        description: Set(input.description.into_option()),
        icon: Set(input.icon.into_option()),
        color: Set(input.color.into_option()),
        kind: Set("team".to_owned()),
        visibility: Set(input
            .visibility
            .into_option()
            .unwrap_or_else(|| "open".to_owned())),
        is_default: Set(is_default),
        sort_order: Set(int(sort_order)),
        created_by: Set(Some(caller.user_id.clone())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    // The creator is the teamspace's first owner.
    access::add_space_member(db, &id, &caller.user_id, "owner", &caller.user_id, now).await?;
    if is_default {
        access::add_everyone_to_space(db, &id, &caller.user_id, now).await?;
    }
    caller.publish(
        state,
        KNOWLEDGE_SPACE_CREATED,
        &id,
        &json!({ "id": id, "name": name }),
    );
    space_row(db, &id).await
}

async fn space_row(db: &weldsuite_db::PgPool, id: &str) -> Result<Value, KnowError> {
    let space = spaces::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    Ok(space.map_or(Value::Null, row))
}

/// An `integer` column's value.
fn int(value: i64) -> i32 {
    i32::try_from(value).unwrap_or(if value < 0 { i32::MIN } else { i32::MAX })
}

/// `set col = value` for a field the body sent (`null` included); a field
/// it left out keeps the column.
fn change<T>(
    update: UpdateMany<spaces::Entity>,
    column: spaces::Column,
    field: &Field<T>,
) -> UpdateMany<spaces::Entity>
where
    T: Clone + Into<sea_orm::Value>,
    Option<T>: Into<sea_orm::Value>,
{
    let value: SimpleExpr = match field {
        Field::Absent => return update,
        Field::Null => Expr::value(None::<T>),
        Field::Set(value) => Expr::value(value.clone()),
    };
    update.col_expr(column, value)
}

pub(crate) async fn update(
    State(state): State<KnowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match space_input(&headers, &body, true) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    match update_space(&state, &caller, &id, &input).await {
        Ok(row) => Data(row).into_response(),
        Err(refusal) => refusal.respond("Failed to update space"),
    }
}

async fn update_space(
    state: &KnowState,
    caller: &Caller,
    id: &str,
    input: &SpaceInput,
) -> Result<Value, Refusal> {
    let db = &caller.db;
    let access = space_for(caller, id).await?;
    access::assert_can_manage(&access)?;
    let was_default = access.space["isDefault"] == true;
    let wants_default = input.is_default.as_set().copied();
    let turns_default_on = wants_default == Some(true) && !was_default;
    if wants_default.is_some_and(|flag| flag != was_default) && !caller.can_manage_all() {
        return Err(Refusal::forbidden(
            "Only workspace admins can change which teamspaces are default.",
        ));
    }

    let now = now();
    let sort_order: Field<i32> = match &input.sort_order {
        Field::Absent => Field::Absent,
        Field::Null => Field::Null,
        Field::Set(order) => Field::Set(int(*order)),
    };
    let mut update = spaces::Entity::update_many();
    update = change(update, spaces::Column::Name, &input.name);
    update = change(update, spaces::Column::Description, &input.description);
    update = change(update, spaces::Column::Icon, &input.icon);
    update = change(update, spaces::Column::Color, &input.color);
    update = change(update, spaces::Column::Visibility, &input.visibility);
    update = change(update, spaces::Column::IsDefault, &input.is_default);
    update = change(update, spaces::Column::SortOrder, &sort_order);
    update
        .col_expr(spaces::Column::UpdatedAt, Expr::value(now))
        .filter(spaces::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    if turns_default_on {
        access::add_everyone_to_space(db, id, &caller.user_id, now).await?;
    }

    let name = input
        .name
        .as_set()
        .cloned()
        .unwrap_or_else(|| text(&access.space, "name").to_owned());
    caller.publish(
        state,
        KNOWLEDGE_SPACE_UPDATED,
        id,
        &json!({ "id": id, "name": name }),
    );
    Ok(space_row(db, id).await?)
}

// ── DELETE /spaces/:id ─────────────────────────────────────────────────────

pub(crate) async fn remove(
    State(state): State<KnowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let access = space_for(&caller, &id).await?;
        access::assert_can_manage(&access)?;
        let now = now();
        let db = orm(&caller.db);
        spaces::Entity::update_many()
            .col_expr(spaces::Column::DeletedAt, Expr::value(now))
            .col_expr(spaces::Column::UpdatedAt, Expr::value(now))
            .filter(spaces::Column::Id.eq(&id))
            .exec(&db)
            .await?;
        // Soft-delete every live page in the space so they surface in trash.
        pages::Entity::update_many()
            .col_expr(pages::Column::DeletedAt, Expr::value(now))
            .col_expr(pages::Column::UpdatedAt, Expr::value(now))
            .filter(pages::Column::SpaceId.eq(&id))
            .filter(pages::Column::DeletedAt.is_null())
            .exec(&db)
            .await?;
        caller.publish(&state, KNOWLEDGE_SPACE_DELETED, &id, &json!({ "id": id }));
        Ok::<_, KnowError>(())
    }
    .await;
    match result {
        Ok(()) => NoContent.into_response(),
        Err(error) => error.respond("Failed to delete space"),
    }
}

// ── Members ────────────────────────────────────────────────────────────────

/// People a teamspace can be shared with.
pub(crate) async fn teammates(caller: Caller) -> Response {
    match access::list_teammates(&caller.db, caller.master.as_ref()).await {
        Ok(rows) => all(rows),
        Err(error) => error.respond("Failed to list teammates"),
    }
}

/// Anyone who can see a teamspace can see who is in it, and so who to ask.
pub(crate) async fn members(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let access = space_for(&caller, &id).await?;
        if access.is_personal() {
            return Ok(Vec::new());
        }
        access::list_space_members(&caller.db, caller.master.as_ref(), &id).await
    }
    .await;
    match result {
        Ok(rows) => all(rows),
        Err(error) => error.respond("Failed to list members"),
    }
}

/// Add a teammate, or change their role if they are already in. Owners only.
pub(crate) async fn add_member(
    State(state): State<KnowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, fields| {
        (
            issues.text(fields, "userId", Presence::Required, Some(1), None),
            issues.choice(fields, "role", Presence::Required, &ROLES),
        )
    });
    let (user_id, role) = match input {
        Ok((user_id, role)) => (
            user_id.into_option().unwrap_or_default(),
            role.into_option().unwrap_or_default(),
        ),
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let result = async {
        let access = space_for(&caller, &id).await?;
        access::assert_can_manage(&access)?;
        let created =
            access::add_space_member(&caller.db, &id, &user_id, &role, &caller.user_id, now())
                .await?;
        let event = if created {
            KNOWLEDGE_SPACE_MEMBER_ADDED
        } else {
            KNOWLEDGE_SPACE_MEMBER_UPDATED
        };
        let body = membership(&id, &user_id, &role);
        caller.publish(&state, event, &id, &body);
        Ok::<_, KnowError>((created, body))
    }
    .await;
    match result {
        Ok((true, body)) => Created(body).into_response(),
        Ok((false, body)) => Data(body).into_response(),
        Err(error) => error.respond("Failed to add member"),
    }
}

pub(crate) async fn set_member_role(
    State(state): State<KnowState>,
    caller: Caller,
    Path((id, member_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let role = match validate(&headers, &body, |issues, fields| {
        issues.choice(fields, "role", Presence::Required, &ROLES)
    }) {
        Ok(role) => role.into_option().unwrap_or_default(),
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let result = async {
        let access = space_for(&caller, &id).await?;
        access::assert_can_manage(&access)?;
        access::set_space_member_role(&caller.db, &id, &member_id, &role, now()).await?;
        let body = membership(&id, &member_id, &role);
        caller.publish(&state, KNOWLEDGE_SPACE_MEMBER_UPDATED, &id, &body);
        Ok::<_, KnowError>(body)
    }
    .await;
    match result {
        Ok(body) => Data(body).into_response(),
        Err(error) => error.respond("Failed to change member role"),
    }
}

/// Remove a member. Owners (and admins) remove anyone; anyone may remove
/// themselves.
pub(crate) async fn remove_member(
    State(state): State<KnowState>,
    caller: Caller,
    Path((id, member_id)): Path<(String, String)>,
) -> Response {
    let result = async {
        let access = space_for(&caller, &id).await?;
        if member_id != caller.user_id {
            access::assert_can_manage(&access)?;
        }
        access::remove_space_member(&caller.db, &id, &member_id, now()).await?;
        caller.publish(
            &state,
            KNOWLEDGE_SPACE_MEMBER_REMOVED,
            &id,
            &json!({ "spaceId": id, "userId": member_id }),
        );
        Ok::<_, KnowError>(())
    }
    .await;
    match result {
        Ok(()) => NoContent.into_response(),
        Err(error) => error.respond("Failed to remove member"),
    }
}

/// Join an open teamspace as an editor. Admins holding `knowledge:manage` may
/// join any teamspace.
pub(crate) async fn join(
    State(state): State<KnowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let access = space_for(&caller, &id).await?;
        if let Some(role) = &access.role {
            return Ok(membership(&id, &caller.user_id, role));
        }
        access::join_space(&caller.db, &access, &caller.user_id, now()).await?;
        let body = membership(&id, &caller.user_id, "editor");
        caller.publish(&state, KNOWLEDGE_SPACE_MEMBER_ADDED, &id, &body);
        Ok::<_, KnowError>(body)
    }
    .await;
    match result {
        Ok(body) => Data(body).into_response(),
        Err(error) => error.respond("Failed to join teamspace"),
    }
}

/// Leave a teamspace. The last owner has to hand over first.
pub(crate) async fn leave(
    State(state): State<KnowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        space_for(&caller, &id).await?;
        access::remove_space_member(&caller.db, &id, &caller.user_id, now()).await?;
        caller.publish(
            &state,
            KNOWLEDGE_SPACE_MEMBER_REMOVED,
            &id,
            &json!({ "spaceId": id, "userId": caller.user_id }),
        );
        Ok::<_, KnowError>(())
    }
    .await;
    match result {
        Ok(()) => NoContent.into_response(),
        Err(error) => error.respond("Failed to leave teamspace"),
    }
}
