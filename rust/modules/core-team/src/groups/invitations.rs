//! `/api/invitations` (`app-api/src/routes/invitations`,
//! `services/member-link.ts`), behind the session only: an invited user may
//! have no active workspace yet.
//!
//! - `GET /:token`: the invitation's details. First through the identity
//!   provider (the caller's organizations, each asked for the invitation),
//!   then by looking for a member row with that invitation in up to 50
//!   workspaces' tenant databases.
//! - `POST /accept`: for each organization the provider lists for the
//!   caller, link their invited (`PENDING`) member row to their user id, make
//!   it active and join them to the public channels and to the channels of
//!   their role (with the realtime notices); else answer the first of their
//!   organizations that is a workspace.
//!
//! Other workspaces' tenant databases are opened like `getTenantDbForWorkspace`:
//! a workspace without a database configured on its master row is skipped.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, StatusCode};
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Asterisk, Expr, Func, OnConflict};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect, QueryTrait,
    RelationDef,
};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_ports::{
    DynRealtimePublisher, IdentityError, Invitation, Membership, RealtimeMessage, Room,
    with_identity,
};
use weldsuite_schema::master::workspaces;
use weldsuite_schema::tenant::{
    chat_channel_members as channel_members, chat_channel_role_links as role_links,
    chat_channels, workspace_members as members,
};

use crate::access::js;
use crate::{AccountCaller, CoreTeamState, TeamError, TeamResult, answer, validate};

pub(crate) fn router() -> Router<CoreTeamState> {
    Router::new()
        // `GET /accept` is `GET /:token` with the token `accept`, as in Hono.
        .route("/accept", post(accept).get(details_of_accept))
        .route("/{token}", get(details))
}

/// `CLERK_ROLE_MAP`: provider role → tenant role.
fn tenant_role(role: &str) -> Option<&'static str> {
    match role {
        "org:admin" => Some("ADMIN"),
        "org:member" => Some("MEMBER"),
        _ => None,
    }
}

/// A workspace's tenant database, from its master row (`getTenantDbForWorkspace`).
/// `None` when it has no database configured or can't be opened.
///
/// "Configured" is a stored `database_url`, which is what
/// [`weldsuite_db::Workspaces::tenant`] opens. TypeScript checks the Neon
/// columns instead (`neon_project_id`, `neon_branch_id`, `neon_role_name`)
/// because it may ask Neon for the URL; the CloudNativePG shards of the
/// Kubernetes editions record no `neon_branch_id`, and that check skipped
/// every workspace there: an accepted invitation left the member row
/// PENDING, so the new member's every request was refused.
async fn tenant_db(state: &CoreTeamState, master: &PgPool, org: &str) -> Option<PgPool> {
    let database_url: Option<Option<String>> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::DatabaseUrl)
        .filter(
            Condition::any()
                .add(workspaces::Column::Id.eq(org))
                .add(workspaces::Column::ClerkOrgId.eq(org)),
        )
        .into_tuple()
        .one(&orm(master))
        .await
        .ok()?;
    // `coalesce(database_url, '') <> ''`.
    let configured = database_url.map(|url| url.is_some_and(|url| !url.is_empty()));
    if configured != Some(true) {
        return None;
    }
    match state.workspaces.tenant(org).await {
        Ok(tenant) => Some(tenant.db),
        Err(error) => {
            tracing::warn!(%error, org, "invitations: tenant database unavailable");
            None
        }
    }
}

/// The workspace of a provider's organization: its name, if any.
async fn workspace_name(master: &PgPool, org_id: &str) -> Result<Option<String>, DbErr> {
    workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Name)
        .filter(workspaces::Column::ClerkOrgId.eq(org_id))
        .into_tuple()
        .one(&orm(master))
        .await
}

// ── GET /:token ─────────────────────────────────────────────────────────────

/// `Date#toISOString()` of milliseconds since the epoch.
fn iso_millis(millis: i64) -> Option<String> {
    let at =
        time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000).ok()?;
    Some(weldsuite_events::iso_timestamp(at))
}

fn now_millis() -> i64 {
    let nanos = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    i64::try_from(nanos).unwrap_or(i64::MAX)
}

/// `lookupClerkOrgInvitation`: the invitation in one organization, or `None`.
async fn lookup_org_invitation(
    caller: &AccountCaller,
    state: &CoreTeamState,
    master: &PgPool,
    membership: &Membership,
    token: &str,
) -> Option<Value> {
    let org = membership.organization.clone().unwrap_or_default();
    let identity = caller.identity(state);
    let invitation = with_identity(identity.as_ref(), |i| i.invitation(&org.id, token))
        .await
        .ok()?;
    let name = workspace_name(master, &org.id).await.ok()?;
    // `workspace?.name || org.name`.
    let workspace_name = name.filter(|n| !n.is_empty()).unwrap_or(org.name);
    Some(invitation_details(&org.id, &workspace_name, &invitation))
}

/// What `GET /:token` answers for a provider's (or WeldSuite's own) invitation.
fn invitation_details(org_id: &str, workspace_name: &str, invitation: &Invitation) -> Value {
    let expires = invitation.expires_at.filter(|at| *at != 0);
    let mut details = json!({
        "workspaceId": org_id,
        "workspaceName": workspace_name,
        "role": invitation.role,
        "inviteeEmail": invitation.email_address,
        "inviteeName": "",
        "isExpired": expires.is_some_and(|at| at < now_millis()),
        "isUsed": invitation.status == "accepted" || invitation.status == "revoked",
    });
    if let Some(at) = expires.and_then(iso_millis) {
        details["expiresAt"] = json!(at);
    }
    details
}

/// (role, email, name, status) of a member row.
type MemberRef = (String, Option<String>, Option<String>, String);

/// The invitation in a member row of one of the first 50 active workspaces.
async fn find_in_tenant_dbs(
    state: &CoreTeamState,
    master: &PgPool,
    token: &str,
) -> Result<Option<Value>, DbErr> {
    let active: Vec<(String, Option<String>)> = workspaces::Entity::find()
        .select_only()
        .columns([workspaces::Column::Name, workspaces::Column::ClerkOrgId])
        .filter(workspaces::Column::IsActive.eq(true))
        .limit(50)
        .into_tuple()
        .all(&orm(master))
        .await?;
    for (name, org) in active {
        let Some(org) = org else { continue };
        let Some(db) = tenant_db(state, master, &org).await else {
            continue;
        };
        let member: Result<Option<MemberRef>, _> = members::Entity::find()
            .select_only()
            .columns([
                members::Column::Role,
                members::Column::Email,
                members::Column::Name,
                members::Column::Status,
            ])
            .filter(members::Column::ClerkInvitationId.eq(token))
            .filter(members::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(&db))
            .await;
        if let Ok(Some((role, email, member_name, status))) = member {
            return Ok(Some(json!({
                "workspaceId": org,
                "workspaceName": name,
                "role": role,
                "inviteeEmail": email.unwrap_or_default(),
                "inviteeName": member_name.unwrap_or_default(),
                "isExpired": false,
                "isUsed": status == "ACTIVE",
            })));
        }
    }
    Ok(None)
}

async fn details(
    State(state): State<CoreTeamState>,
    caller: AccountCaller,
    Path(token): Path<String>,
) -> Response {
    answer(run_details(&state, &caller, &token).await)
}

async fn run_details(
    state: &CoreTeamState,
    caller: &AccountCaller,
    token: &str,
) -> TeamResult<Response> {
    let failed = |error: &dyn std::fmt::Display| {
        TeamError::internal("Failed to fetch invitation details", error)
    };
    let master = caller.master(state);
    let identity = caller.identity(state);
    // Membership mode: WeldSuite keeps the invitation, and finds it by id
    // whoever asks (accepting still takes the invited address).
    if let Some(provider) = identity.as_ref() {
        match provider.find_invitation(token).await {
            Ok(Some((org, invitation))) => {
                return Ok(
                    Data(invitation_details(&org.id, &org.name, &invitation)).into_response()
                );
            }
            Ok(None) => {}
            Err(error) if error.is_not_found() => {
                return Err(TeamError::api(ApiError::not_found("Invitation", None)));
            }
            Err(error) => return Err(failed(&error)),
        }
    }
    // A provider that can't be reached is an error; a refusal is "not there".
    match with_identity(identity.as_ref(), |i| {
        i.user_memberships(&caller.user_id, 100)
    })
    .await
    {
        Ok(memberships) => {
            for membership in &memberships {
                if let Some(found) =
                    lookup_org_invitation(caller, state, &master, membership, token).await
                {
                    return Ok(Data(found).into_response());
                }
            }
        }
        Err(IdentityError::Rejected { .. }) => {}
        Err(error) => return Err(failed(&error)),
    }
    if let Some(found) = find_in_tenant_dbs(state, &master, token)
        .await
        .map_err(|e| failed(&e))?
    {
        return Ok(Data(found).into_response());
    }
    Err(TeamError::api(ApiError::not_found("Invitation", None)))
}

async fn details_of_accept(State(state): State<CoreTeamState>, caller: AccountCaller) -> Response {
    answer(run_details(&state, &caller, "accept").await)
}

// ── POST /accept ────────────────────────────────────────────────────────────

async fn accept(
    State(state): State<CoreTeamState>,
    caller: AccountCaller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_accept(&state, &caller, &headers, &body).await)
}

async fn run_accept(
    state: &CoreTeamState,
    caller: &AccountCaller,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let token = validate(headers, body, |issues, fields| {
        issues.text(fields, "token", Presence::Required, Some(1), None)
    })?
    .into_option()
    .unwrap_or_default();
    let failed =
        |error: &dyn std::fmt::Display| TeamError::internal("Failed to accept invitation", error);
    let master = caller.master(state);
    let identity = caller.identity(state);
    // Membership mode: the invitation becomes a membership here, WeldSuite's
    // own, and the invited member row is linked to it as below.
    if let Some(provider) = identity.as_ref() {
        match provider.accept_invitation(&token, &caller.user_id).await {
            Ok(Some(membership)) => {
                let joined =
                    accept_in_org(state, &master, &membership, &caller.user_id, &token).await;
                let (workspace_id, workspace_name, role) = joined.unwrap_or_else(|| {
                    let org = membership.organization.clone().unwrap_or_default();
                    let role = tenant_role(&membership.role).unwrap_or("MEMBER");
                    (org.id, org.name, role.to_owned())
                });
                return Ok(Data(json!({
                    "workspaceId": workspace_id,
                    "workspaceName": workspace_name,
                    "role": role,
                }))
                .into_response());
            }
            Ok(None) => {}
            Err(error) => return Err(acceptance_refused(&error).unwrap_or_else(|| failed(&error))),
        }
    }
    let Ok(memberships) = with_identity(identity.as_ref(), |i| {
        i.user_memberships(&caller.user_id, 100)
    })
    .await
    else {
        return Err(TeamError::api(
            ApiError::internal().with_message("Failed to verify membership"),
        ));
    };

    let mut matched: Option<(String, String, String)> = None;
    for membership in &memberships {
        matched = accept_in_org(state, &master, membership, &caller.user_id, &token).await;
        if matched.is_some() {
            break;
        }
    }
    if matched.is_none() {
        for membership in &memberships {
            let org = membership.organization.clone().unwrap_or_default();
            let name = workspace_name(&master, &org.id)
                .await
                .map_err(|e| failed(&e))?;
            if let Some(name) = name {
                let role = tenant_role(&membership.role).unwrap_or("MEMBER");
                matched = Some((org.id, name, role.to_owned()));
                break;
            }
        }
    }
    let Some((workspace_id, workspace_name, role)) = matched else {
        return Err(TeamError::api(ApiError::not_found("Invitation", None)));
    };
    Ok(Data(json!({
        "workspaceId": workspace_id,
        "workspaceName": workspace_name,
        "role": role,
    }))
    .into_response())
}

/// Membership mode's refusals of an acceptance, as the platform reads them:
/// gone, not found, or forbidden with the reason (`invitation_email_mismatch`,
/// `invitation_email_unverified`) in `details`. `None`: not a refusal.
fn acceptance_refused(error: &IdentityError) -> Option<TeamError> {
    let IdentityError::Rejected {
        status,
        code,
        message,
        ..
    } = error
    else {
        return None;
    };
    let message = message.clone().unwrap_or_default();
    let error = match status {
        404 => ApiError::not_found("Invitation", None),
        410 => ApiError::new(StatusCode::GONE, "INVITATION_EXPIRED", message),
        403 => ApiError::forbidden()
            .with_message(message)
            .with_details(json!({ "reason": code })),
        _ => return None,
    };
    Some(TeamError::api(error))
}

/// `acceptPendingInOrg`: link and activate the invited row in this org.
async fn accept_in_org(
    state: &CoreTeamState,
    master: &PgPool,
    membership: &Membership,
    user_id: &str,
    token: &str,
) -> Option<(String, String, String)> {
    let org = membership.organization.clone().unwrap_or_default();
    let db = tenant_db(state, master, &org.id).await?;
    let pending = match link_invited_member(state, &db, &org.id, membership, user_id, token).await {
        Ok(Some(pending)) => pending,
        Ok(None) => return None,
        Err(error) => {
            tracing::warn!(%error, org = org.id, "invitations: checking the org failed");
            return None;
        }
    };
    let name = workspace_name(master, &org.id).await.ok()?;
    let name = name.filter(|n| !n.is_empty()).unwrap_or(org.name);
    // `CLERK_ROLE_MAP[role] || pending.role || 'MEMBER'`.
    let role = tenant_role(&membership.role)
        .map(str::to_owned)
        .or_else(|| {
            pending["role"]
                .as_str()
                .filter(|r| !r.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "MEMBER".to_owned());
    Some((org.id, name, role))
}

/// `findPendingMember`: by invitation id, then by email.
async fn find_pending_member(
    db: &PgPool,
    token: &str,
    email: &str,
) -> Result<Option<Value>, DbErr> {
    let db = orm(db);
    if !token.is_empty() {
        let row = members::Entity::find()
            .filter(members::Column::ClerkInvitationId.eq(token))
            .filter(members::Column::Status.eq("PENDING"))
            .filter(members::Column::DeletedAt.is_null())
            .one(&db)
            .await?;
        if let Some(row) = row {
            return js(row).map(Some);
        }
    }
    // `lower(email) = lower($1)`.
    let same_email = sea_orm::ExprTrait::eq(
        Expr::from(Func::lower(Expr::col(members::Column::Email))),
        Func::lower(Expr::value(email)),
    );
    members::Entity::find()
        .filter(same_email)
        .filter(
            Condition::any()
                .add(members::Column::Status.eq("PENDING"))
                .add(members::Column::UserId.like("invited_%"))
                .add(members::Column::UserId.like("pending_clerk_%")),
        )
        .filter(members::Column::DeletedAt.is_null())
        .one(&db)
        .await?
        .map(js)
        .transpose()
}

/// `linkInvitedMember`: the row as it was before linking, or `None`.
async fn link_invited_member(
    state: &CoreTeamState,
    db: &PgPool,
    org: &str,
    membership: &Membership,
    user_id: &str,
    token: &str,
) -> Result<Option<Value>, DbErr> {
    let Some(pending) = find_pending_member(db, token, &membership.user.identifier).await? else {
        return Ok(None);
    };
    if !activate_pending_member(state, db, org, user_id, membership, &pending).await? {
        return Ok(None);
    }
    let member_type = pending["memberType"].as_str().unwrap_or_default();
    join_public_channels(state, db, org, user_id, member_type).await;
    if let Some(role_id) = pending["roleId"].as_str() {
        apply_role_channels(state, db, org, user_id, role_id).await;
    }
    Ok(Some(pending))
}

/// `activatePendingMember`: move the placeholder row onto the user, active.
async fn activate_pending_member(
    state: &CoreTeamState,
    db: &PgPool,
    org: &str,
    user_id: &str,
    membership: &Membership,
    pending: &Value,
) -> Result<bool, DbErr> {
    let name = [&membership.user.first_name, &membership.user.last_name]
        .into_iter()
        .filter_map(|part| part.as_deref().filter(|p| !p.is_empty()))
        .collect::<Vec<_>>()
        .join(" ");
    let name = (!name.is_empty()).then_some(name);
    let pending_role = pending["role"].as_str().filter(|r| !r.is_empty());
    let keeps_role = matches!(
        pending["memberType"].as_str(),
        Some("EXTERNAL_GUEST" | "EMPLOYEE")
    );
    let role = if keeps_role {
        pending_role.unwrap_or("VIEWER").to_owned()
    } else {
        tenant_role(&membership.role)
            .or(pending_role)
            .unwrap_or("MEMBER")
            .to_owned()
    };
    let db = orm(db);
    // A returning member's removed row still holds their user id.
    members::Entity::update_many()
        .col_expr(
            members::Column::UserId,
            sea_orm::sea_query::extension::postgres::PgExpr::concat(
                Expr::value("removed_"),
                Expr::col(members::Column::Id),
            ),
        )
        .filter(members::Column::UserId.eq(user_id))
        .filter(members::Column::DeletedAt.is_not_null())
        .exec(&db)
        .await?;
    let stamp = utc_now().assume_utc();
    let mut link = members::Entity::update_many()
        .col_expr(members::Column::UserId, Expr::value(user_id));
    // `coalesce($name, name)`.
    if let Some(name) = name {
        link = link.col_expr(members::Column::Name, Expr::value(name));
    }
    // No picture: avatars are the account's (master `users.image_url`).
    let updated = link
        .col_expr(members::Column::Role, Expr::value(role))
        .col_expr(members::Column::Status, Expr::value("ACTIVE"))
        .col_expr(
            members::Column::ClerkMembershipId,
            Expr::value(&membership.id),
        )
        .col_expr(
            members::Column::AcceptedAt,
            Func::coalesce([Expr::col(members::Column::AcceptedAt), Expr::value(stamp)]).into(),
        )
        .col_expr(members::Column::UpdatedAt, Expr::value(stamp))
        .filter(members::Column::Id.eq(pending["id"].as_str()))
        .filter(members::Column::UserId.eq(pending["userId"].as_str()))
        .exec(&db)
        .await?;
    if let Some(cache) = &state.cache
        && let Err(error) = cache
            .delete_boxed(&format!("member-type:{org}:{user_id}"))
            .await
    {
        tracing::warn!(%error, "invitations: member-type cache delete failed");
    }
    Ok(updated.rows_affected > 0)
}

/// Publish without holding up the response; failures are logged.
fn publish_later(state: &CoreTeamState, messages: Vec<RealtimeMessage>) {
    let Some(realtime) = state.realtime.clone() else {
        return;
    };
    if messages.is_empty() {
        return;
    }
    state
        .events
        .tracker()
        .spawn(publish_all(realtime, messages));
}

async fn publish_all(realtime: Arc<dyn DynRealtimePublisher>, messages: Vec<RealtimeMessage>) {
    for message in messages {
        if let Err(error) = realtime.publish_boxed(&message).await {
            tracing::error!(%error, "invitations: realtime publish failed");
        }
    }
}

fn channel_new(org: &str, user_id: &str, channel_id: &str, channel_name: &str) -> RealtimeMessage {
    RealtimeMessage::personal(
        org,
        &format!("chat.user.{user_id}"),
        "channel_new",
        json!({ "channelId": channel_id, "channelName": channel_name }),
        user_id,
    )
}

/// `autoJoinUserToPublicChannels` + the `channel_new` notices (non-fatal).
async fn join_public_channels(
    state: &CoreTeamState,
    db: &PgPool,
    org: &str,
    user_id: &str,
    member_type: &str,
) {
    if member_type != "INTERNAL" && member_type != "EMPLOYEE" {
        return;
    }
    match auto_join_public_channels(db, user_id).await {
        Ok(joined) => publish_later(
            state,
            joined
                .iter()
                .map(|(id, name)| channel_new(org, user_id, id, name))
                .collect(),
        ),
        Err(error) => tracing::error!(%error, "invitations: joining public channels failed"),
    }
}

async fn auto_join_public_channels(
    db: &PgPool,
    user_id: &str,
) -> Result<Vec<(String, String)>, DbErr> {
    let channels: Vec<(String, String)> = chat_channels::Entity::find()
        .select_only()
        .columns([chat_channels::Column::Id, chat_channels::Column::Name])
        .filter(chat_channels::Column::Type.eq("public"))
        .filter(chat_channels::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    if channels.is_empty() {
        return Ok(channels);
    }
    let existing: Vec<String> = channel_members::Entity::find()
        .select_only()
        .column(channel_members::Column::ChannelId)
        .filter(channel_members::Column::UserId.eq(user_id))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let to_insert: Vec<(String, String)> = channels
        .into_iter()
        .filter(|(id, _)| !existing.contains(id))
        .collect();
    if to_insert.is_empty() {
        return Ok(to_insert);
    }
    insert_memberships(db, user_id, &to_insert, None).await?;
    recount(db, &to_insert).await?;
    Ok(to_insert)
}

/// One insert for every channel, as Drizzle's multi-row insert.
async fn insert_memberships(
    db: &PgPool,
    user_id: &str,
    channels: &[(String, String)],
    role_id: Option<&str>,
) -> Result<(), DbErr> {
    let stamp = utc_now();
    let rows = channels.iter().map(|(channel_id, _)| {
        let mut row = channel_members::ActiveModel {
            id: Set(generate_id("cmb")),
            channel_id: Set(channel_id.clone()),
            user_id: Set(user_id.to_owned()),
            role: Set("member".to_owned()),
            joined_at: Set(stamp),
            created_at: Set(stamp),
            ..Default::default()
        };
        if let Some(role_id) = role_id {
            row.member_type = Set("user".to_owned());
            row.added_by_role_id = Set(Some(role_id.to_owned()));
        }
        row
    });
    channel_members::Entity::insert_many(rows)
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .exec_without_returning(&orm(db))
        .await?;
    Ok(())
}

/// Each channel's `member_count` from its members:
/// `(select count(*)::int from chat_channel_members m where m.channel_id = c.id)`.
async fn recount(db: &PgPool, channels: &[(String, String)]) -> Result<(), DbErr> {
    let ids: Vec<String> = channels.iter().map(|(id, _)| id.clone()).collect();
    let member_count = channel_members::Entity::find()
        .select_only()
        .expr(sea_orm::ExprTrait::cast_as(
            Func::count(Expr::col(Asterisk)),
            "int",
        ))
        .filter(sea_orm::ExprTrait::equals(
            Expr::col((channel_members::Entity, channel_members::Column::ChannelId)),
            (chat_channels::Entity, chat_channels::Column::Id),
        ))
        .into_query();
    chat_channels::Entity::update_many()
        .col_expr(
            chat_channels::Column::MemberCount,
            Expr::SubQuery(None, Box::new(member_count.into())),
        )
        .col_expr(chat_channels::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(chat_channels::Column::Id.is_in(ids))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `applyRoleChangeToChannels(db, user, null, roleId)` + the notices
/// (non-fatal).
async fn apply_role_channels(
    state: &CoreTeamState,
    db: &PgPool,
    org: &str,
    user_id: &str,
    role_id: &str,
) {
    match add_to_role_channels(db, user_id, role_id).await {
        Ok(added) => {
            let mut messages = Vec::new();
            for (id, name) in &added {
                messages.push(RealtimeMessage::room(
                    Room::Chat,
                    id,
                    json!({ "type": "member", "userId": user_id, "userName": "", "action": "joined" }),
                ));
                messages.push(channel_new(org, user_id, id, name));
            }
            publish_later(state, messages);
        }
        Err(error) => tracing::error!(%error, "invitations: applying role channels failed"),
    }
}

async fn add_to_role_channels(
    db: &PgPool,
    user_id: &str,
    role_id: &str,
) -> Result<Vec<(String, String)>, DbErr> {
    let channel: RelationDef = role_links::Entity::belongs_to(chat_channels::Entity)
        .from(role_links::Column::ChannelId)
        .to(chat_channels::Column::Id)
        .into();
    let channels: Vec<(String, String)> = role_links::Entity::find()
        .select_only()
        .columns([chat_channels::Column::Id, chat_channels::Column::Name])
        .join(JoinType::InnerJoin, channel)
        .filter(role_links::Column::RoleId.eq(role_id))
        .filter(chat_channels::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    if channels.is_empty() {
        return Ok(channels);
    }
    let ids: Vec<String> = channels.iter().map(|(id, _)| id.clone()).collect();
    let existing: Vec<String> = channel_members::Entity::find()
        .select_only()
        .column(channel_members::Column::ChannelId)
        .filter(channel_members::Column::ChannelId.is_in(ids))
        .filter(channel_members::Column::UserId.eq(user_id))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let to_insert: Vec<(String, String)> = channels
        .into_iter()
        .filter(|(id, _)| !existing.contains(id))
        .collect();
    if to_insert.is_empty() {
        return Ok(to_insert);
    }
    insert_memberships(db, user_id, &to_insert, Some(role_id)).await?;
    recount(db, &to_insert).await?;
    Ok(to_insert)
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test fixtures")]
mod tests {
    use super::*;

    #[test]
    fn provider_roles_map_to_tenant_roles() {
        assert_eq!(tenant_role("org:admin"), Some("ADMIN"));
        assert_eq!(tenant_role("org:member"), Some("MEMBER"));
        assert_eq!(tenant_role("org:billing"), None);
    }

    /// Linking a pending member, against the real tenant schema (the
    /// conformance suite can't reach another workspace's database). Runs
    /// when `WELDSUITE_TEST_TENANT_URL` is set.
    async fn seed_invited_member(db: &PgPool) {
        sqlx::raw_sql(
            r"delete from chat_channel_members where user_id in ('user_lnk', 'user_lnk_other');
              delete from chat_channel_role_links where id like 'crl_lnk_%';
              delete from chat_channels where id like 'ch_lnk_%';
              delete from roles where id like 'role_lnk_%';
              delete from workspace_members where id like 'wm_lnk_%';
              insert into roles (id, name, permissions) values ('role_lnk_sales', 'Sales', '[]');
              insert into workspace_members (id, user_id, email, role, role_id, status, member_type, clerk_invitation_id)
                  values ('wm_lnk_1', 'invited_lnk@example.com', 'lnk@example.com', 'MEMBER', 'role_lnk_sales', 'PENDING', 'INTERNAL', 'inv_lnk');
              insert into chat_channels (id, name, slug, type) values
                  ('ch_lnk_general', 'general', 'general-lnk', 'public'),
                  ('ch_lnk_sales', 'sales', 'sales-lnk', 'private');
              insert into chat_channel_role_links (id, channel_id, role_id) values ('crl_lnk_1', 'ch_lnk_sales', 'role_lnk_sales');",
        )
        .execute(db)
        .await
        .expect("seed");
    }

    fn test_state(
        db: &PgPool,
        realtime: Arc<weldsuite_ports::RecordingRealtime>,
        tracker: &weldsuite_events::TaskTracker,
    ) -> CoreTeamState {
        CoreTeamState {
            events: weldsuite_events::EntityEventPublisher::new(None, tracker.clone()),
            realtime: Some(realtime),
            cache: None,
            files: None,
            master: db.clone(),
            workspaces: Arc::new(weldsuite_db::Workspaces::new(
                db.clone(),
                weldsuite_db::Keyring::default(),
                weldsuite_db::WorkspaceConfig::default(),
            )),
            identity: None,
            plan_seat_limits: true,
        }
    }

    /// The tests on the tenant database run one at a time: linking joins the
    /// public channels, which they share.
    static TENANT_DB: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn links_a_pending_member_and_joins_their_channels() {
        let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
            eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
            return;
        };
        let _serial = TENANT_DB.lock().await;
        let db = weldsuite_db::master_pool(&url, 2).expect("tenant pool");
        seed_invited_member(&db).await;
        let realtime = Arc::new(weldsuite_ports::RecordingRealtime::new());
        let tracker = weldsuite_events::TaskTracker::new();
        let state = test_state(&db, realtime.clone(), &tracker);
        let membership = Membership {
            id: "orgmem_lnk".to_owned(),
            role: "org:admin".to_owned(),
            user: weldsuite_ports::MemberUser {
                user_id: "user_lnk".to_owned(),
                first_name: Some("Lin".to_owned()),
                last_name: Some("Ked".to_owned()),
                identifier: "lnk@example.com".to_owned(),
                image_url: None,
            },
            ..Membership::default()
        };
        let pending =
            link_invited_member(&state, &db, "org_lnk", &membership, "user_lnk", "inv_lnk")
                .await
                .expect("link")
                .expect("a pending row");
        assert_eq!(pending["id"], "wm_lnk_1");
        tracker.close();
        tracker.wait().await;

        let (user, status, role, name, membership_id): (String, String, String, Option<String>, Option<String>) =
            sqlx::query_as(
                "select user_id, status, role, name, clerk_membership_id from workspace_members where id = 'wm_lnk_1'",
            )
            .fetch_one(&db)
            .await
            .expect("row");
        assert_eq!(
            (user.as_str(), status.as_str(), role.as_str()),
            ("user_lnk", "ACTIVE", "ADMIN")
        );
        assert_eq!(name.as_deref(), Some("Lin Ked"));
        assert_eq!(membership_id.as_deref(), Some("orgmem_lnk"));

        let mut channels: Vec<(String, Option<String>)> = sqlx::query_as(
            "select channel_id, added_by_role_id from chat_channel_members where user_id = 'user_lnk'",
        )
        .fetch_all(&db)
        .await
        .expect("memberships");
        channels.sort();
        assert_eq!(
            channels,
            vec![
                ("ch_lnk_general".to_owned(), None),
                ("ch_lnk_sales".to_owned(), Some("role_lnk_sales".to_owned())),
            ]
        );
        let counts: Vec<i32> =
            sqlx::query_scalar("select member_count from chat_channels where id like 'ch_lnk_%'")
                .fetch_all(&db)
                .await
                .expect("counts");
        assert_eq!(counts, vec![1, 1]);
        let channels: Vec<String> = realtime.messages().into_iter().map(|m| m.channel).collect();
        assert!(
            channels.contains(&"chat:ch_lnk_sales".to_owned()),
            "{channels:?}"
        );
        assert_eq!(
            channels
                .iter()
                .filter(|c| c.as_str() == "workspace:org_lnk")
                .count(),
            2
        );

        // A second accept finds nothing left to link.
        let again = link_invited_member(&state, &db, "org_lnk", &membership, "user_lnk", "inv_lnk")
            .await
            .expect("link");
        assert!(again.is_none());
    }

    #[test]
    fn millis_print_like_to_iso_string() {
        assert_eq!(iso_millis(0).as_deref(), Some("1970-01-01T00:00:00.000Z"));
        assert_eq!(
            iso_millis(1_767_225_600_123).as_deref(),
            Some("2026-01-01T00:00:00.123Z")
        );
    }

    // ── membership mode: invitations WeldSuite keeps (WeldID) ───────────

    use weldsuite_ports::{IdentityCall, MemoryIdentity, Organization};

    /// A provider that keeps invitations, and no database behind the state:
    /// these branches answer from the provider (linking the tenant's member
    /// row finds no database and is skipped).
    fn kept_state(
        identity: &Arc<MemoryIdentity>,
    ) -> (CoreTeamState, weldsuite_events::TaskTracker) {
        let db = weldsuite_db::master_pool("postgres://weldsuite:x@127.0.0.1:1/none", 1)
            .expect("lazy pool");
        let tracker = weldsuite_events::TaskTracker::new();
        let mut state = test_state(
            &db,
            Arc::new(weldsuite_ports::RecordingRealtime::new()),
            &tracker,
        );
        state.identity = Some(Arc::clone(identity) as Arc<dyn weldsuite_ports::Identity>);
        (state, tracker)
    }

    fn kept() -> MemoryIdentity {
        MemoryIdentity::new()
            .keeping_invitations()
            .with_organization(Organization {
                id: "org_kept".to_owned(),
                name: "Kept Co".to_owned(),
                slug: Some("kept".to_owned()),
                ..Organization::default()
            })
            .with_invitation(
                "org_kept",
                Invitation {
                    id: "inv_kept".to_owned(),
                    email_address: "new@kept.test".to_owned(),
                    role: "org:admin".to_owned(),
                    status: "pending".to_owned(),
                    expires_at: Some(now_millis() + 86_400_000),
                    ..Invitation::default()
                },
            )
            .with_invitation(
                "org_kept",
                Invitation {
                    id: "inv_late".to_owned(),
                    email_address: "new@kept.test".to_owned(),
                    role: "org:member".to_owned(),
                    status: "expired".to_owned(),
                    expires_at: Some(1),
                    ..Invitation::default()
                },
            )
            .with_user("new@kept.test", "user_new")
            .with_user("other@kept.test", "user_other")
    }

    async fn body_of(response: Response) -> (u16, Value) {
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn accept_as(state: &CoreTeamState, user_id: &str, token: &str) -> (u16, Value) {
        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::CONTENT_TYPE,
            http::HeaderValue::from_static("application/json"),
        );
        let body = Bytes::from(json!({ "token": token }).to_string());
        body_of(answer(
            run_accept(state, &AccountCaller::for_test(user_id), &headers, &body).await,
        ))
        .await
    }

    #[tokio::test]
    async fn a_kept_invitation_is_found_by_id_whoever_asks() {
        let identity = Arc::new(kept());
        let (state, _tracker) = kept_state(&identity);
        let caller = AccountCaller::for_test("user_other");
        let (status, body) = body_of(answer(run_details(&state, &caller, "inv_kept").await)).await;
        assert_eq!(status, 200, "{body}");
        let details = &body["data"];
        assert_eq!(details["workspaceId"], "org_kept");
        assert_eq!(details["workspaceName"], "Kept Co");
        assert_eq!(details["role"], "org:admin");
        assert_eq!(details["inviteeEmail"], "new@kept.test");
        assert_eq!(details["isExpired"], false);
        assert_eq!(details["isUsed"], false);
        assert!(details["expiresAt"].is_string());

        let (status, _) = body_of(answer(run_details(&state, &caller, "inv_none").await)).await;
        assert_eq!(status, 404);
        // Never through the caller's memberships or the tenants' databases.
        assert!(
            !identity
                .calls()
                .iter()
                .any(|call| matches!(call, IdentityCall::UserMemberships(..)))
        );
    }

    #[tokio::test]
    async fn accepting_a_kept_invitation_makes_the_membership_here() {
        let identity = Arc::new(kept());
        let (state, _tracker) = kept_state(&identity);
        let (status, body) = accept_as(&state, "user_new", "inv_kept").await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(
            body["data"],
            json!({ "workspaceId": "org_kept", "workspaceName": "Kept Co", "role": "ADMIN" })
        );
        assert!(identity.calls().contains(&IdentityCall::AcceptInvitation(
            "inv_kept".to_owned(),
            "user_new".to_owned()
        )));
        // Once.
        let (status, _) = accept_as(&state, "user_new", "inv_kept").await;
        assert_eq!(status, 404);
    }

    #[tokio::test]
    async fn a_kept_invitation_refuses_another_address_and_an_expired_one() {
        let identity = Arc::new(kept());
        let (state, _tracker) = kept_state(&identity);
        let (status, body) = accept_as(&state, "user_other", "inv_kept").await;
        assert_eq!(status, 403, "{body}");
        assert_eq!(
            body["error"]["details"]["reason"],
            "invitation_email_mismatch"
        );
        assert_eq!(
            body["error"]["message"],
            "This invitation is for another email address."
        );
        let (status, body) = accept_as(&state, "user_new", "inv_late").await;
        assert_eq!(status, 410, "{body}");
        assert_eq!(body["error"]["code"], "INVITATION_EXPIRED");
    }

    /// Membership mode on a CloudNativePG shard (the EU edition): the
    /// workspace's placement has no `neon_branch_id`, and accepting must
    /// still link the invited row to the user, or every request they make
    /// in the workspace is refused. Runs when `WELDSUITE_TEST_MASTER_URL` and
    /// `WELDSUITE_TEST_TENANT_URL` are set.
    #[tokio::test]
    async fn accepting_links_the_invited_row_on_a_shard_without_a_neon_branch() {
        let (Ok(master_url), Ok(tenant_url)) = (
            std::env::var("WELDSUITE_TEST_MASTER_URL"),
            std::env::var("WELDSUITE_TEST_TENANT_URL"),
        ) else {
            eprintln!("WELDSUITE_TEST_MASTER_URL or WELDSUITE_TEST_TENANT_URL not set; skipping");
            return;
        };
        let _serial = TENANT_DB.lock().await;
        let master = weldsuite_db::master_pool(&master_url, 2).expect("master pool");
        let tenant = weldsuite_db::master_pool(&tenant_url, 2).expect("tenant pool");
        clean_shard_case(&master, &tenant).await;
        // Placed as `CnpgProvisioner` places a workspace (the URL in the
        // clear here; sealed in a deployment, which the resolver opens).
        sqlx::query(
            "insert into workspaces (id, clerk_org_id, name, slug, neon_project_id, neon_branch_id,
                                     neon_database_name, neon_role_name, database_url)
             values ('ws_inv_cnpg', 'org_inv_cnpg', 'Shard Co', 'inv-cnpg', 'cnpg:tenants-1', null,
                     'ws_ws_inv_cnpg', 'role_ws_inv_cnpg', $1)",
        )
        .bind(&tenant_url)
        .execute(&master)
        .await
        .expect("workspace");
        sqlx::query(
            "insert into workspace_members (id, user_id, email, role, status, member_type, clerk_invitation_id)
             values ('wm_cnpg_1', 'invited_cnpg@example.com', 'cnpg@example.com', 'ADMIN', 'PENDING', 'INTERNAL', 'inv_cnpg')",
        )
        .execute(&tenant)
        .await
        .expect("invited row");

        let identity = Arc::new(
            MemoryIdentity::new()
                .keeping_invitations()
                .with_organization(Organization {
                    id: "org_inv_cnpg".to_owned(),
                    name: "Shard Co".to_owned(),
                    slug: Some("inv-cnpg".to_owned()),
                    ..Organization::default()
                })
                .with_invitation(
                    "org_inv_cnpg",
                    Invitation {
                        id: "inv_cnpg".to_owned(),
                        email_address: "cnpg@example.com".to_owned(),
                        role: "org:admin".to_owned(),
                        status: "pending".to_owned(),
                        expires_at: Some(now_millis() + 86_400_000),
                        ..Invitation::default()
                    },
                )
                .with_user("cnpg@example.com", "user_cnpg"),
        );
        let tracker = weldsuite_events::TaskTracker::new();
        let mut state = test_state(
            &master,
            Arc::new(weldsuite_ports::RecordingRealtime::new()),
            &tracker,
        );
        state.identity = Some(identity as Arc<dyn weldsuite_ports::Identity>);

        let (status, body) = accept_as(&state, "user_cnpg", "inv_cnpg").await;
        tracker.close();
        tracker.wait().await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["data"]["workspaceId"], "org_inv_cnpg");
        assert_eq!(body["data"]["role"], "ADMIN");
        let (user, member_status, role): (String, String, String) = sqlx::query_as(
            "select user_id, status, role from workspace_members where id = 'wm_cnpg_1'",
        )
        .fetch_one(&tenant)
        .await
        .expect("row");
        assert_eq!(
            (user.as_str(), member_status.as_str(), role.as_str()),
            ("user_cnpg", "ACTIVE", "ADMIN")
        );

        // Not configured: skipped, as before.
        sqlx::query("update workspaces set database_url = null where id = 'ws_inv_cnpg'")
            .execute(&master)
            .await
            .expect("no database");
        assert!(tenant_db(&state, &master, "org_inv_cnpg").await.is_none());
        clean_shard_case(&master, &tenant).await;
    }

    /// The rows the shard test writes, which it removes before and after.
    async fn clean_shard_case(master: &PgPool, tenant: &PgPool) {
        sqlx::query("delete from workspaces where id = 'ws_inv_cnpg'")
            .execute(master)
            .await
            .expect("clean master");
        // Linking joined the public channels: leave them as they were.
        sqlx::raw_sql(
            r"update chat_channels set member_count = greatest(member_count - 1, 0)
               where id in (select channel_id from chat_channel_members where user_id = 'user_cnpg');
              delete from chat_channel_members where user_id = 'user_cnpg';
              delete from workspace_members where id = 'wm_cnpg_1' or user_id = 'user_cnpg';",
        )
        .execute(tenant)
        .await
        .expect("clean tenant");
    }

    #[tokio::test]
    async fn a_provider_that_keeps_no_invitations_goes_the_old_way() {
        let identity = Arc::new(MemoryIdentity::new());
        let (state, _tracker) = kept_state(&identity);
        let (status, _) = accept_as(&state, "user_new", "inv_kept").await;
        // No membership names the invitation: not found, as before.
        assert_eq!(status, 404);
        let calls = identity.calls();
        assert!(
            calls
                .iter()
                .any(|call| matches!(call, IdentityCall::UserMemberships(..))),
            "{calls:?}"
        );
        assert!(
            !calls
                .iter()
                .any(|call| matches!(call, IdentityCall::AcceptInvitation(..)))
        );
    }
}
