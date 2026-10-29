//! Teamspaces, the caller's private space, and teamspace members.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    KNOWLEDGE_SPACE_CREATED, KNOWLEDGE_SPACE_DELETED, KNOWLEDGE_SPACE_MEMBER_ADDED,
    KNOWLEDGE_SPACE_MEMBER_REMOVED, KNOWLEDGE_SPACE_MEMBER_UPDATED, KNOWLEDGE_SPACE_UPDATED,
};
use weldsuite_catalogs::permission_keys::KNOWLEDGE_CREATE;
use weldsuite_db::js_row;
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};

use crate::access::{self, SpaceAccess, text};
use crate::{Caller, KnowError, KnowState, Refusal, all, now, validate};

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
            access::ensure_personal_space(&caller.db, &caller.user_id, &now).await?;
        }
        access::join_default_spaces(&caller.db, &caller.user_id, &now).await?;
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
        let max: i64 = sqlx::query_scalar(
            "select coalesce(max(sort_order), -1)::bigint from knowledge_spaces
             where deleted_at is null",
        )
        .fetch_one(db)
        .await?;
        max + 1
    };
    let name = input.name.into_option().unwrap_or_default();
    sqlx::query(
        "insert into knowledge_spaces
             (id, name, description, icon, color, kind, visibility, is_default, sort_order,
              created_by, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 'team', $6, $7, $8::int, $9, $10::timestamp, $10::timestamp)",
    )
    .bind(&id)
    .bind(&name)
    .bind(input.description.into_option())
    .bind(input.icon.into_option())
    .bind(input.color.into_option())
    .bind(
        input
            .visibility
            .into_option()
            .unwrap_or_else(|| "open".to_owned()),
    )
    .bind(is_default)
    .bind(sort_order)
    .bind(&caller.user_id)
    .bind(&now)
    .execute(db)
    .await?;
    // The creator is the teamspace's first owner.
    access::add_space_member(db, &id, &caller.user_id, "owner", &caller.user_id, &now).await?;
    if is_default {
        access::add_everyone_to_space(db, &id, &caller.user_id, &now).await?;
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
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(s) from knowledge_spaces s where id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map_or(Value::Null, js_row))
}

/// `(set, value)` for an `update … set col = case when set then value …`:
/// a field the body left out keeps the column.
fn change<T: Clone>(field: &Field<T>) -> (bool, Option<T>) {
    match field {
        Field::Absent => (false, None),
        Field::Null => (true, None),
        Field::Set(value) => (true, Some(value.clone())),
    }
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
    let (set_name, name) = change(&input.name);
    let (set_description, description) = change(&input.description);
    let (set_icon, icon) = change(&input.icon);
    let (set_color, color) = change(&input.color);
    let (set_visibility, visibility) = change(&input.visibility);
    let (set_default, default) = change(&input.is_default);
    let (set_order, order) = change(&input.sort_order);
    sqlx::query(
        "update knowledge_spaces set
             name = case when $2 then $3 else name end,
             description = case when $4 then $5 else description end,
             icon = case when $6 then $7 else icon end,
             color = case when $8 then $9 else color end,
             visibility = case when $10 then $11 else visibility end,
             is_default = case when $12 then $13 else is_default end,
             sort_order = case when $14 then $15::int else sort_order end,
             updated_at = $16::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(set_name)
    .bind(&name)
    .bind(set_description)
    .bind(description)
    .bind(set_icon)
    .bind(icon)
    .bind(set_color)
    .bind(color)
    .bind(set_visibility)
    .bind(visibility)
    .bind(set_default)
    .bind(default)
    .bind(set_order)
    .bind(order)
    .bind(&now)
    .execute(db)
    .await?;
    if turns_default_on {
        access::add_everyone_to_space(db, id, &caller.user_id, &now).await?;
    }

    let name = name.unwrap_or_else(|| text(&access.space, "name").to_owned());
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
        sqlx::query(
            "update knowledge_spaces set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(&now)
        .execute(&caller.db)
        .await?;
        // Soft-delete every live page in the space so they surface in trash.
        sqlx::query(
            "update knowledge_pages set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where space_id = $1 and deleted_at is null",
        )
        .bind(&id)
        .bind(&now)
        .execute(&caller.db)
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
    match access::list_teammates(&caller.db).await {
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
        access::list_space_members(&caller.db, &id).await
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
            access::add_space_member(&caller.db, &id, &user_id, &role, &caller.user_id, &now())
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
        access::set_space_member_role(&caller.db, &id, &member_id, &role, &now()).await?;
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
        access::remove_space_member(&caller.db, &id, &member_id, &now()).await?;
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
        access::join_space(&caller.db, &access, &caller.user_id, &now()).await?;
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
        access::remove_space_member(&caller.db, &id, &caller.user_id, &now()).await?;
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
