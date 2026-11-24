//! The managing half of `/api/team-members`
//! (`app-api/src/routes/team-members/index.ts`), keeping the tenant DB and the
//! identity provider's organization in step:
//!
//! - `POST /sync` (`team:read`): soft-delete members and invitations the
//!   provider no longer has; removed members' personal API keys are revoked.
//! - `POST /invite` (`team:create`, `team:invite_external` for a guest): an
//!   invitation (the provider emails it) and a PENDING row, or a guest with an
//!   account added straight away; checked against the seat limit and the
//!   grant ceiling first.
//! - `PATCH /:id` (`team:update`): role (provider + DB), name, extras,
//!   denies, hours.
//! - `DELETE /:id` (`team:delete`): out of the provider and soft-deleted.
//! - `POST /:id/resend-invite` (`team:update`).
//!
//! The provider sends the invitation email itself, so no mail port is
//! involved. No entity events: the TypeScript routes publish none.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, patch, post};
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::permissions;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{
    PermissionGate, PermissionQueries, can_grant_permission, check_permission_grants,
    role_row_permissions,
};
use weldsuite_ports::{Identity, IdentityError, ListPage, NewInvitation, NewMembership};
use weldsuite_schema::master::api_key_registry;
use weldsuite_schema::tenant::{api_keys, roles, workspace_members as members};

use crate::groups::seats::{self, SeatLimit, align_cap_with_plan, make_room_for_guest};
use crate::{Caller, CoreTeamState, TeamError, TeamResult, answer};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/sync", post(sync).route_layer(need("team:read")))
        // Checks `team:create` or `team:invite_external` inside, by member type.
        .route("/invite", post(invite).route_layer(gate.resolve()))
        .route("/{id}", patch(update).route_layer(need("team:update")))
        .route("/{id}", delete(remove).route_layer(need("team:delete")))
        .route(
            "/{id}/resend-invite",
            post(resend_invite).route_layer(need("team:update")),
        )
}

/// Permissions a fresh `EXTERNAL_GUEST` member gets.
const GUEST_DEFAULT_PERMISSIONS: [&str; 3] = [
    "channels:read",
    "channels:create_message",
    "channels:update_own",
];

fn invalid_body() -> TeamError {
    TeamError::api(ApiError::bad_request("Invalid request body"))
}

fn forbidden(message: impl Into<String>) -> TeamError {
    TeamError::api(ApiError::forbidden().with_message(message))
}

fn internal(message: impl Into<String>) -> TeamError {
    TeamError::api(ApiError::internal().with_message(message))
}

/// `schema.parse(await c.req.json())` in a `try`: any body that isn't JSON or
/// fails the schema is one 400.
fn parse_body<T>(
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> Option<T>,
) -> TeamResult<T> {
    let value: Value = serde_json::from_slice(body).map_err(|_| invalid_body())?;
    let mut issues = Issues::default();
    let read = issues
        .object(&value)
        .and_then(|fields| read(&mut issues, fields));
    if issues.finish().is_err() {
        return Err(invalid_body());
    }
    read.ok_or_else(invalid_body)
}

/// `mapRoleToClerk`.
fn provider_role(role: &str) -> &'static str {
    if role.eq_ignore_ascii_case("ADMIN") {
        "org:admin"
    } else {
        "org:member"
    }
}

/// `invitationRedirectUrl`: the platform's `/invite?org_id=…`. The platform
/// URL is `PUBLIC_APP_URL`, else per `ENVIRONMENT` (the request's values in
/// conformance mode, the process's otherwise).
fn invitation_redirect_url(caller: &Caller, org_id: &str) -> String {
    let setting = |name: &str| {
        caller
            .env(name)
            .map(str::to_owned)
            .or_else(|| std::env::var(name).ok())
    };
    let configured = setting("PUBLIC_APP_URL")
        .map(|url| url.trim().trim_end_matches('/').to_owned())
        .filter(|url| !url.is_empty());
    let base = configured.unwrap_or_else(|| {
        match setting("ENVIRONMENT").as_deref() {
            Some("test") => "https://app-test.weldsuite.org",
            Some("production") => "https://app.weldsuite.org",
            _ => "http://localhost:3000",
        }
        .to_owned()
    });
    // `new URL('/invite', base)`: the base's origin with the path replaced.
    let origin = base
        .find("://")
        .and_then(|scheme| {
            base[scheme + 3..]
                .find('/')
                .map(|path| &base[..scheme + 3 + path])
        })
        .unwrap_or(&base);
    let org: String = form_urlencoded(org_id);
    format!("{origin}/invite?org_id={org}")
}

/// `URLSearchParams` encoding of one value.
fn form_urlencoded(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(char::from(byte));
            }
            b' ' => out.push('+'),
            _ => {
                use std::fmt::Write as _;
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

fn org_of(caller: &Caller) -> TeamResult<String> {
    caller
        .org_id
        .clone()
        .ok_or_else(|| TeamError::api(ApiError::org_required()))
}

/// `new Date()` as Drizzle writes it to a `timestamptz` column: UTC, to the
/// millisecond.
fn stamp() -> OffsetDateTime {
    utc_now().assume_utc()
}

/// A live member row by id.
async fn live_member(db: &PgPool, id: &str) -> TeamResult<Option<members::Model>> {
    Ok(members::Entity::find_by_id(id)
        .filter(members::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?)
}

/// An optional text column, `''` without a value.
fn text(value: Option<&String>) -> &str {
    value.map_or("", String::as_str)
}

/// A JSON column's strings (`permissions`, `permissionDenies`).
fn json_strings(value: Option<&Value>) -> Vec<String> {
    value.map(strings).unwrap_or_default()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// A non-deleted role's id and name.
async fn lookup_role(db: &PgPool, role_id: &str) -> TeamResult<Option<String>> {
    Ok(roles::Entity::find_by_id(role_id)
        .select_only()
        .column(roles::Column::Name)
        .filter(roles::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?)
}

/// `rolePermissionsFor`: what assigning `tier` / custom role `role_id` grants.
async fn role_permissions_for(
    db: &PgPool,
    tier: &str,
    role_id: Option<&str>,
) -> TeamResult<Vec<String>> {
    let Some(role_id) = role_id else {
        return Ok(permissions()
            .system_roles
            .get(tier)
            .map(|role| role.permissions.clone())
            .unwrap_or_default());
    };
    let row: Option<(Option<Value>, bool, String)> = roles::Entity::find_by_id(role_id)
        .select_only()
        .columns([
            roles::Column::Permissions,
            roles::Column::IsSystem,
            roles::Column::Name,
        ])
        .filter(roles::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.map_or_else(Vec::new, |(stored, is_system, name)| {
        let stored = stored.as_ref().map(strings);
        role_row_permissions(is_system, &name, stored.as_deref())
    }))
}

/// `refuseUngrantable`: the grant ceiling.
fn refuse_ungrantable(caller: &Caller, keys: &[String], already: &[String]) -> TeamResult<()> {
    let Some(grantor) = caller.permissions.as_ref() else {
        return Err(TeamError::api(ApiError::unauthorized()));
    };
    if check_permission_grants(grantor.resolved(), keys, already).ok {
        Ok(())
    } else {
        Err(forbidden(
            "You cannot grant permissions you do not hold yourself",
        ))
    }
}

/// `refuseUnliftableDenies`: lifting a deny hands the key back, so every
/// deny removed must be one the caller holds.
fn refuse_unliftable_denies(
    caller: &Caller,
    current: &[String],
    next: &[String],
) -> TeamResult<()> {
    let lifted: Vec<&String> = current.iter().filter(|key| !next.contains(key)).collect();
    if lifted.is_empty() {
        return Ok(());
    }
    let Some(grantor) = caller.permissions.as_ref() else {
        return Err(TeamError::api(ApiError::unauthorized()));
    };
    if lifted
        .iter()
        .all(|key| can_grant_permission(grantor.resolved(), key))
    {
        Ok(())
    } else {
        Err(forbidden(
            "You cannot lift a deny on a permission you do not hold yourself",
        ))
    }
}

/// `releaseRemovedMemberUserId`: free a `user_id` a removed row still holds
/// (`user_id = 'removed_' || id`).
async fn release_removed_user_id(db: &PgPool, user_id: &str) -> Result<(), DbErr> {
    let removed = sea_orm::sea_query::extension::postgres::PgExpr::concat(
        Expr::val("removed_"),
        Expr::col(members::Column::Id),
    );
    members::Entity::update_many()
        .col_expr(members::Column::UserId, removed)
        .filter(members::Column::UserId.eq(user_id))
        .filter(members::Column::DeletedAt.is_not_null())
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `revokeRemovedMemberKeys`: a removed member's personal API keys, with
/// their master registry entries. Best effort: logged, never surfaced.
async fn revoke_member_keys(caller: &Caller, state: &CoreTeamState, user_id: &str) {
    let stamp = stamp();
    let revoked = api_keys::Entity::update_many()
        .col_expr(api_keys::Column::DeletedAt, Expr::value(stamp))
        .col_expr(api_keys::Column::UpdatedAt, Expr::value(stamp))
        .filter(api_keys::Column::UserId.eq(user_id))
        .filter(api_keys::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(&caller.db))
        .await;
    let revoked = match revoked {
        Ok(keys) => keys,
        Err(error) => {
            tracing::error!(%error, "team members: failed to revoke API keys of a removed member");
            return;
        }
    };
    let master = orm(&caller.master(state));
    for key in revoked {
        if let Err(error) = api_key_registry::Entity::delete_many()
            .filter(api_key_registry::Column::TenantKeyId.eq(key.id))
            .exec(&master)
            .await
        {
            tracing::error!(%error, "team members: failed to remove a key from the master registry");
        }
    }
}

// ── POST /sync ──────────────────────────────────────────────────────────────

async fn sync(State(state): State<CoreTeamState>, caller: Caller) -> Response {
    answer(sync_team(&state, &caller).await)
}

async fn sync_team(state: &CoreTeamState, caller: &Caller) -> TeamResult<Response> {
    let org = org_of(caller)?;
    let idp = seats::identity(caller, state);
    // Both lists are asked for, as `Promise.all` does.
    let memberships = idp.memberships(&org, ListPage::limit(500)).await;
    let invitations = idp
        .invitations(&org, Some("pending"), ListPage::limit(500))
        .await;
    let (memberships, invitations) = match (memberships, invitations) {
        (Ok(m), Ok(i)) => (m, i),
        (Err(IdentityError::Unavailable(error)), _)
        | (_, Err(IdentityError::Unavailable(error))) => {
            return Err(TeamError::internal("Failed to sync team from Clerk", error));
        }
        (Err(error), _) | (_, Err(error)) => {
            return Err(TeamError::internal(
                "Failed to fetch data from Clerk",
                error,
            ));
        }
    };
    let membership_ids: Vec<String> = memberships.data.into_iter().map(|m| m.id).collect();
    let invitation_ids: Vec<String> = invitations.data.into_iter().map(|i| i.id).collect();
    let db = orm(&caller.db);
    let result: Result<(), DbErr> = async {
        if !membership_ids.is_empty() {
            let departed = soft_delete_members()
                .filter(members::Column::Status.eq("ACTIVE"))
                .filter(members::Column::DeletedAt.is_null())
                .filter(members::Column::ClerkMembershipId.is_not_null())
                .filter(members::Column::ClerkMembershipId.is_not_in(membership_ids))
                .exec_with_returning(&db)
                .await?;
            for member in departed {
                revoke_member_keys(caller, state, &member.user_id).await;
            }
        }
        let mut pending = soft_delete_members()
            .filter(members::Column::Status.eq("PENDING"))
            .filter(members::Column::DeletedAt.is_null())
            .filter(members::Column::ClerkInvitationId.is_not_null());
        // `cardinality(ids) = 0 or clerk_invitation_id <> all(ids)`.
        if !invitation_ids.is_empty() {
            pending = pending.filter(members::Column::ClerkInvitationId.is_not_in(invitation_ids));
        }
        pending.exec(&db).await?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => Ok(Data(json!({ "synced": true })).into_response()),
        Err(error) => Err(TeamError::internal("Failed to sync team from Clerk", error)),
    }
}

/// `set deleted_at = now, updated_at = now` on the member rows a filter
/// picks.
fn soft_delete_members() -> sea_orm::UpdateMany<members::Entity> {
    let stamp = stamp();
    members::Entity::update_many()
        .col_expr(members::Column::DeletedAt, Expr::value(stamp))
        .col_expr(members::Column::UpdatedAt, Expr::value(stamp))
}

// ── POST /invite ────────────────────────────────────────────────────────────

struct InviteBody {
    email: String,
    name: String,
    role_id: Option<String>,
    member_type: String,
}

fn read_invite(issues: &mut Issues, fields: &Map<String, Value>) -> Option<InviteBody> {
    let email = issues.text_with(
        fields,
        "email",
        Presence::Required,
        Text {
            format: Some(Format::Email),
            ..Text::default()
        },
    );
    let name = issues.text(fields, "name", Presence::Required, Some(1), None);
    let role_id = issues.text(fields, "roleId", Presence::Nullish, None, None);
    let member_type = issues.choice(
        fields,
        "memberType",
        Presence::Optional,
        &["INTERNAL", "EXTERNAL_GUEST", "EMPLOYEE"],
    );
    Some(InviteBody {
        email: email.into_option()?,
        name: name.into_option()?,
        role_id: role_id.into_option(),
        member_type: member_type
            .into_option()
            .unwrap_or_else(|| "INTERNAL".to_owned()),
    })
}

async fn invite(State(state): State<CoreTeamState>, caller: Caller, body: Bytes) -> Response {
    answer(invite_member(&state, &caller, &body).await)
}

/// The role an invite writes: `None` when the requested role doesn't exist.
async fn resolve_invite_role(
    db: &PgPool,
    member_type: &str,
    role_id: Option<&str>,
) -> TeamResult<Option<(String, Option<String>)>> {
    if member_type != "INTERNAL" {
        return Ok(Some(("VIEWER".to_owned(), None)));
    }
    let Some(role_id) = role_id.filter(|id| !id.is_empty()) else {
        return Ok(Some(("MEMBER".to_owned(), None)));
    };
    Ok(lookup_role(db, role_id)
        .await?
        .map(|name| (name.to_uppercase(), Some(role_id.to_owned()))))
}

/// `getExistingMemberConflict`.
async fn existing_member_conflict(db: &PgPool, email: &str) -> TeamResult<Option<&'static str>> {
    let status: Option<String> = members::Entity::find()
        .select_only()
        .column(members::Column::Status)
        .filter(members::Column::Email.eq(email.to_lowercase()))
        .filter(members::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(match status.as_deref() {
        Some("ACTIVE") => Some("This email address is already a member of this workspace."),
        Some("PENDING") => Some("An invitation has already been sent to this email address."),
        _ => None,
    })
}

/// `checkSeatsForInvite`: the refusal when the workspace is full; with room,
/// the provider's cap is raised to the plan first. A failed lookup never
/// blocks (the provider is the hard gate behind this).
async fn check_seats(
    state: &CoreTeamState,
    caller: &Caller,
    idp: &dyn Identity,
    org: &str,
) -> Option<String> {
    let seats: SeatLimit = match seats::workspace_seat_limit(caller, state, org).await {
        Ok(Some(seats)) => seats,
        Ok(None) => return None,
        Err(error) => {
            tracing::error!(%error, "team members: seat-limit check failed, continuing");
            return None;
        }
    };
    if seats.at_limit {
        let limit = seats.limit.unwrap_or_default();
        let noun = if limit == 1 { "member" } else { "members" };
        return Some(match &seats.managed_by {
            Some(partner) => {
                format!("Your licence includes {limit} {noun}. Ask {partner} to add more seats.")
            }
            None => format!(
                "Your {} plan includes {limit} {noun}. Upgrade your plan to invite more people.",
                seats.plan_name
            ),
        });
    }
    align_cap_with_plan(idp, org, seats.limit).await;
    None
}

const QUOTA_CODES: [&str; 2] = [
    "organization_membership_quota_exceeded",
    "max_allowed_memberships",
];

/// `describeGuestAddFailure`.
fn guest_add_failure(error: &IdentityError) -> TeamError {
    let (code, message) = match error {
        IdentityError::Rejected { code, message, .. } => {
            (code.as_deref().unwrap_or_default(), message.as_deref())
        }
        IdentityError::Unavailable(_) => ("", None),
    };
    if QUOTA_CODES.iter().any(|known| code.contains(known)) {
        return forbidden(
            "This workspace's member limit prevents adding this guest. Upgrade your plan or remove a member or pending invitation, then try again.",
        );
    }
    if code == "already_a_member_in_organization" {
        return TeamError::api(ApiError::conflict(
            "This person is already a member of this workspace.",
        ));
    }
    let base = "Failed to add guest to Clerk organization";
    internal(message.map_or_else(|| base.to_owned(), |message| format!("{base}: {message}")))
}

/// `describeClerkInvitationFailure`.
fn invitation_failure(error: &IdentityError) -> TeamError {
    let code = error.code().unwrap_or_default();
    if code.contains("quota") || code.contains("max_allowed_memberships") {
        return forbidden(
            "Your plan has no seats left. Upgrade your plan, or remove a member or pending invitation, then try again.",
        );
    }
    if code == "duplicate_record" || error.status() == Some(422) {
        return TeamError::api(ApiError::conflict(
            "An invitation for this email already exists in Clerk.",
        ));
    }
    tracing::error!(%error, "team members: invitation error");
    internal("Failed to create Clerk invitation")
}

async fn invite_member(
    state: &CoreTeamState,
    caller: &Caller,
    body: &Bytes,
) -> TeamResult<Response> {
    let org = org_of(caller)?;
    let body = parse_body(body, read_invite)?;
    let is_guest = body.member_type == "EXTERNAL_GUEST";
    let required = if is_guest {
        "team:invite_external"
    } else {
        "team:create"
    };
    if !caller.can(required) {
        return Err(forbidden(format!(
            "Missing required permission: {required}"
        )));
    }

    let Some((role_name, role_id)) =
        resolve_invite_role(&caller.db, &body.member_type, body.role_id.as_deref()).await?
    else {
        return Err(TeamError::api(ApiError::not_found(
            "Role",
            Some(body.role_id.as_deref().unwrap_or_default()),
        )));
    };
    if body.member_type == "INTERNAL" {
        let grants = role_permissions_for(&caller.db, &role_name, role_id.as_deref()).await?;
        refuse_ungrantable(caller, &grants, &[])?;
    }
    let clerk_role = provider_role(&role_name);

    if let Some(conflict) = existing_member_conflict(&caller.db, &body.email).await? {
        return Err(TeamError::api(ApiError::conflict(conflict)));
    }

    let idp = seats::identity(caller, state);
    if is_guest {
        make_room_for_guest(&*idp, &org).await;
    } else if let Some(refusal) = check_seats(state, caller, &*idp, &org).await {
        return Err(forbidden(refusal));
    }

    if is_guest
        && let Some(response) = add_existing_guest(caller, &*idp, &org, &body, clerk_role).await?
    {
        return Ok(response);
    }

    let invitation = idp
        .invite(
            &org,
            &NewInvitation {
                email_address: body.email.clone(),
                role: clerk_role.to_owned(),
                redirect_url: Some(invitation_redirect_url(caller, &org)),
                public_metadata: is_guest.then(|| json!({ "member_type": "EXTERNAL_GUEST" })),
                inviter_user_id: None,
                invited_by: Some(caller.user_id.clone()),
            },
        )
        .await
        .map_err(|error| invitation_failure(&error))?;

    match insert_pending_member(
        caller,
        &body,
        &role_name,
        role_id.as_deref(),
        &invitation.id,
    )
    .await
    {
        Ok(member_id) => Ok(Created(json!({
            "memberId": member_id,
            "memberType": body.member_type,
            "activated": false,
        }))
        .into_response()),
        Err(error) => {
            tracing::error!(%error, "team members: pending member insert failed, revoking the invitation");
            if let Err(error) = idp.revoke_invitation(&org, &invitation.id).await
                && !error.is_not_found()
            {
                tracing::error!(%error, "team members: invitation rollback failed");
            }
            Err(internal("Failed to create invitation"))
        }
    }
}

/// `addExistingClerkUserAsGuest`: a guest who already has an account joins
/// the organization directly. `None` when they have none (or several).
async fn add_existing_guest(
    caller: &Caller,
    idp: &dyn Identity,
    org: &str,
    body: &InviteBody,
    clerk_role: &str,
) -> TeamResult<Option<Response>> {
    // `findClerkUserIdByEmail`: a refusal is "no user".
    let user_id = match idp.users_by_email(&body.email, 2).await {
        Ok(users) if users.len() == 1 => users[0].id.clone(),
        Ok(_) | Err(IdentityError::Rejected { .. }) => return Ok(None),
        Err(error) => return Err(TeamError::internal("Internal server error", error)),
    };
    if user_id.is_empty() {
        return Ok(None);
    }
    let membership = idp
        .add_membership(
            org,
            &NewMembership {
                user_id: user_id.clone(),
                role: clerk_role.to_owned(),
                public_metadata: Some(json!({ "member_type": "EXTERNAL_GUEST" })),
            },
        )
        .await
        .map_err(|error| {
            tracing::error!(%error, "team members: guest membership error");
            guest_add_failure(&error)
        })?;

    let member_id = generate_id("mbr");
    release_removed_user_id(&caller.db, &user_id).await?;
    let stamp = stamp();
    let row = members::ActiveModel {
        id: Set(member_id.clone()),
        user_id: Set(user_id),
        email: Set(Some(body.email.to_lowercase())),
        name: Set(Some(body.name.clone())),
        role: Set("VIEWER".to_owned()),
        role_id: Set(None),
        permissions: Set(Some(json!(GUEST_DEFAULT_PERMISSIONS))),
        member_type: Set("EXTERNAL_GUEST".to_owned()),
        status: Set("ACTIVE".to_owned()),
        clerk_membership_id: Set(Some(membership.id)),
        invited_by: Set(Some(caller.user_id.clone())),
        invited_at: Set(Some(stamp)),
        accepted_at: Set(Some(stamp)),
        created_at: Set(stamp),
        updated_at: Set(stamp),
        ..Default::default()
    };
    members::Entity::insert(row)
        .exec_without_returning(&orm(&caller.db))
        .await?;
    Ok(Some(
        Created(
            json!({ "memberId": member_id, "memberType": "EXTERNAL_GUEST", "activated": true }),
        )
        .into_response(),
    ))
}

/// `insertPendingMember`: the PENDING row mirroring a fresh invitation.
async fn insert_pending_member(
    caller: &Caller,
    body: &InviteBody,
    role_name: &str,
    role_id: Option<&str>,
    invitation_id: &str,
) -> Result<String, DbErr> {
    let member_id = generate_id("mbr");
    let user_id = format!("invited_{}", body.email);
    release_removed_user_id(&caller.db, &user_id).await?;
    let role = if role_name == "OWNER" {
        "MEMBER"
    } else {
        role_name
    };
    let permissions = if body.member_type == "EXTERNAL_GUEST" {
        json!(GUEST_DEFAULT_PERMISSIONS)
    } else {
        json!([])
    };
    let stamp = stamp();
    // A live row already on the placeholder fails the insert (the user id is
    // unique), and the caller takes the invitation back.
    let row = members::ActiveModel {
        id: Set(member_id.clone()),
        user_id: Set(user_id),
        email: Set(Some(body.email.to_lowercase())),
        name: Set(Some(body.name.clone())),
        role: Set(role.to_owned()),
        role_id: Set(role_id.map(str::to_owned)),
        permissions: Set(Some(permissions)),
        member_type: Set(body.member_type.clone()),
        status: Set("PENDING".to_owned()),
        clerk_invitation_id: Set(Some(invitation_id.to_owned())),
        invited_by: Set(Some(caller.user_id.clone())),
        invited_at: Set(Some(stamp)),
        created_at: Set(stamp),
        updated_at: Set(stamp),
        ..Default::default()
    };
    members::Entity::insert(row)
        .exec_without_returning(&orm(&caller.db))
        .await?;
    Ok(member_id)
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

#[derive(Default)]
struct UpdateBody {
    name: Option<String>,
    role: Option<String>,
    role_id: Option<String>,
    permissions: Option<Vec<String>>,
    permission_denies: Option<Vec<String>>,
    hours_per_week: Option<String>,
}

fn read_update(issues: &mut Issues, fields: &Map<String, Value>) -> Option<UpdateBody> {
    let strings = |issues: &mut Issues, key: &str| {
        issues
            .list(
                fields,
                key,
                Presence::Optional,
                None,
                None,
                |issues, item| issues.item_text(item, Text::default()),
            )
            .into_option()
    };
    let body = UpdateBody {
        name: issues
            .text(fields, "name", Presence::Optional, Some(1), Some(255))
            .into_option(),
        role: issues
            .choice(
                fields,
                "role",
                Presence::Optional,
                &["ADMIN", "MEMBER", "VIEWER"],
            )
            .into_option(),
        role_id: issues
            .text(fields, "roleId", Presence::Optional, None, None)
            .into_option(),
        permissions: strings(issues, "permissions"),
        permission_denies: strings(issues, "permissionDenies"),
        hours_per_week: issues
            .text(fields, "hoursPerWeek", Presence::Optional, None, None)
            .into_option(),
    };
    // `.refine`: at most one of `role` / `roleId` (an empty roleId is none).
    let roles = usize::from(body.role.is_some())
        + usize::from(body.role_id.as_deref().is_some_and(|id| !id.is_empty()));
    (roles <= 1).then_some(body)
}

async fn update(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    answer(update_member(&state, &caller, &id, &body).await)
}

async fn update_member(
    state: &CoreTeamState,
    caller: &Caller,
    member_id: &str,
    body: &Bytes,
) -> TeamResult<Response> {
    let org = org_of(caller)?;
    let body = parse_body(body, read_update)?;
    let Some(member) = live_member(&caller.db, member_id).await? else {
        return Err(TeamError::api(ApiError::not_found(
            "Member",
            Some(member_id),
        )));
    };
    if let Some(keys) = &body.permissions {
        refuse_ungrantable(caller, keys, &json_strings(member.permissions.as_ref()))?;
    }
    if let Some(next) = &body.permission_denies {
        refuse_unliftable_denies(
            caller,
            &json_strings(member.permission_denies.as_ref()),
            next,
        )?;
    }

    let role_id_set = body.role_id.as_deref().is_some_and(|id| !id.is_empty());
    let mut role_change: Option<(String, Option<String>)> = None;
    if body.role.is_some() || role_id_set {
        role_change =
            Some(apply_role_change(state, caller, &org, &member, &body, role_id_set).await?);
    }

    let mut update =
        members::Entity::update_many().col_expr(members::Column::UpdatedAt, Expr::value(stamp()));
    if let Some((tier, role_id)) = role_change {
        update = update
            .col_expr(members::Column::Role, Expr::value(tier))
            .col_expr(members::Column::RoleId, Expr::value(role_id));
    }
    if let Some(name) = &body.name {
        update = update.col_expr(members::Column::Name, Expr::value(name.clone()));
    }
    if let Some(keys) = &body.permissions {
        update = update.col_expr(members::Column::Permissions, Expr::value(json!(keys)));
    }
    if let Some(keys) = &body.permission_denies {
        update = update.col_expr(members::Column::PermissionDenies, Expr::value(json!(keys)));
    }
    if let Some(hours) = &body.hours_per_week {
        // The text as sent, converted by Postgres (`$n::numeric`).
        update = update.col_expr(
            members::Column::HoursPerWeek,
            sea_orm::ExprTrait::cast_as(Expr::val(hours.clone()), "numeric"),
        );
    }
    update
        .filter(members::Column::Id.eq(member_id))
        .exec(&orm(&caller.db))
        .await?;
    Ok(Data(json!({ "id": member_id })).into_response())
}

/// `applyMemberRoleChange`: owner lock, active guard, grant ceiling, the
/// provider's role. The tier and custom role id to write.
async fn apply_role_change(
    state: &CoreTeamState,
    caller: &Caller,
    org: &str,
    member: &members::Model,
    body: &UpdateBody,
    role_id_set: bool,
) -> TeamResult<(String, Option<String>)> {
    if member.role == "OWNER" {
        return Err(forbidden("Cannot change the role of the workspace owner."));
    }
    if member.status != "ACTIVE" {
        return Err(TeamError::api(ApiError::bad_request(
            "Can only update role of an active member.",
        )));
    }
    if member.member_type == "EMPLOYEE" {
        return Err(TeamError::api(ApiError::bad_request(
            "Employee members have fixed access and no role. Invite them as a team member to give them a role.",
        )));
    }
    let (tier, role_id) = if role_id_set {
        let role_id = body.role_id.clone().unwrap_or_default();
        let Some(name) = lookup_role(&caller.db, &role_id).await? else {
            return Err(TeamError::api(ApiError::not_found("Role", Some(&role_id))));
        };
        let name = name.to_uppercase();
        let tier = if name == "ADMIN" || name == "VIEWER" {
            name
        } else {
            "MEMBER".to_owned()
        };
        (tier, Some(role_id))
    } else {
        (body.role.clone().unwrap_or_default(), None)
    };
    let grants = role_permissions_for(&caller.db, &tier, role_id.as_deref()).await?;
    refuse_ungrantable(caller, &grants, &[])?;

    if !text(member.clerk_membership_id.as_ref()).is_empty() {
        let idp = seats::identity(caller, state);
        if let Err(error) = idp
            .set_membership_role(org, &member.user_id, provider_role(&tier))
            .await
        {
            tracing::error!(%error, "team members: role update in the identity provider failed");
            return Err(internal("Failed to update role in Clerk"));
        }
    }
    Ok((tier, role_id))
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(remove_member(&state, &caller, &id).await)
}

async fn remove_member(
    state: &CoreTeamState,
    caller: &Caller,
    member_id: &str,
) -> TeamResult<Response> {
    let org = org_of(caller)?;
    let Some(member) = live_member(&caller.db, member_id).await? else {
        return Err(TeamError::api(ApiError::not_found(
            "Member",
            Some(member_id),
        )));
    };
    if member.role == "OWNER" {
        return Err(forbidden("Cannot remove the workspace owner."));
    }
    let status = member.status.as_str();
    let idp = seats::identity(caller, state);
    // By user id: the provider addresses memberships that way.
    if status == "ACTIVE"
        && !text(member.clerk_membership_id.as_ref()).is_empty()
        && let Err(error) = idp.remove_membership(&org, &member.user_id).await
        && !error.is_not_found()
    {
        tracing::error!(%error, "team members: membership delete failed");
        return Err(internal("Failed to remove member from Clerk organization"));
    }
    let invitation = text(member.clerk_invitation_id.as_ref());
    if status == "PENDING"
        && !invitation.is_empty()
        && let Err(error) = idp.revoke_invitation(&org, invitation).await
        && !error.is_not_found()
    {
        tracing::error!(%error, "team members: invitation revoke failed");
        return Err(internal("Failed to revoke invitation in Clerk"));
    }
    soft_delete_members()
        .filter(members::Column::Id.eq(member_id))
        .exec(&orm(&caller.db))
        .await?;
    // A cancelled invitation never signed in: no keys to revoke.
    if status != "PENDING" {
        revoke_member_keys(caller, state, &member.user_id).await;
    }
    Ok(NoContent.into_response())
}

// ── POST /:id/resend-invite ─────────────────────────────────────────────────

async fn resend_invite(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(resend(&state, &caller, &id).await)
}

async fn resend(state: &CoreTeamState, caller: &Caller, member_id: &str) -> TeamResult<Response> {
    let org = org_of(caller)?;
    let Some(member) = live_member(&caller.db, member_id).await? else {
        return Err(TeamError::api(ApiError::not_found(
            "Member",
            Some(member_id),
        )));
    };
    if member.status != "PENDING" {
        return Err(TeamError::api(ApiError::bad_request(
            "Can only resend invite to a pending member.",
        )));
    }
    let email = text(member.email.as_ref());
    if email.is_empty() {
        return Err(TeamError::api(ApiError::bad_request(
            "Pending member has no email address.",
        )));
    }
    let idp = seats::identity(caller, state);
    let old = text(member.clerk_invitation_id.as_ref());
    if !old.is_empty() {
        // Best effort, any failure ignored.
        let _ = idp.revoke_invitation(&org, old).await;
    }
    let invitation = idp
        .invite(
            &org,
            &NewInvitation {
                email_address: email.to_owned(),
                role: provider_role(&member.role).to_owned(),
                redirect_url: Some(invitation_redirect_url(caller, &org)),
                public_metadata: None,
                inviter_user_id: None,
                invited_by: Some(caller.user_id.clone()),
            },
        )
        .await
        .map_err(|error| {
            tracing::error!(%error, "team members: resend-invite failed");
            internal("Failed to resend invitation via Clerk")
        })?;
    // `deleted_at = null` restores a row the revoke webhook may have removed meanwhile.
    let stamp = stamp();
    members::Entity::update_many()
        .col_expr(
            members::Column::ClerkInvitationId,
            Expr::value(invitation.id),
        )
        .col_expr(members::Column::InvitedAt, Expr::value(stamp))
        .col_expr(members::Column::UpdatedAt, Expr::value(stamp))
        .col_expr(
            members::Column::DeletedAt,
            Expr::value(Option::<OffsetDateTime>::None),
        )
        .filter(members::Column::Id.eq(member_id))
        .exec(&orm(&caller.db))
        .await?;
    Ok(Data(json!({ "success": true })).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_map_to_the_provider() {
        assert_eq!(provider_role("ADMIN"), "org:admin");
        assert_eq!(provider_role("admin"), "org:admin");
        assert_eq!(provider_role("VIEWER"), "org:member");
    }

    #[test]
    fn form_encoding_like_url_search_params() {
        assert_eq!(form_urlencoded("org_1"), "org_1");
        assert_eq!(form_urlencoded("a b&c"), "a+b%26c");
    }
}
