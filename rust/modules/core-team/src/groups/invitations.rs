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
use serde_json::{Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_ports::{
    DynRealtimePublisher, IdentityError, Invitation, Membership, RealtimeMessage, Room,
    with_identity,
};

use crate::{AccountCaller, CoreTeamState, TeamError, TeamResult, answer, now, validate};

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
async fn tenant_db(state: &CoreTeamState, master: &PgPool, org: &str) -> Option<PgPool> {
    let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "select neon_project_id, neon_branch_id, neon_role_name from workspaces
         where id = $1 or clerk_org_id = $1 limit 1",
    )
    .bind(org)
    .fetch_optional(master)
    .await
    .ok()?;
    let (Some(_), Some(_), Some(_)) = row? else {
        return None;
    };
    match state.workspaces.tenant(org).await {
        Ok(tenant) => Some(tenant.db),
        Err(error) => {
            tracing::warn!(%error, org, "invitations: tenant database unavailable");
            None
        }
    }
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
    let name: Option<String> =
        sqlx::query_scalar("select name from workspaces where clerk_org_id = $1 limit 1")
            .bind(&org.id)
            .fetch_optional(master)
            .await
            .ok()?;
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
) -> Result<Option<Value>, sqlx::Error> {
    let workspaces: Vec<(String, Option<String>)> =
        sqlx::query_as("select name, clerk_org_id from workspaces where is_active = true limit 50")
            .fetch_all(master)
            .await?;
    for (name, org) in workspaces {
        let Some(org) = org else { continue };
        let Some(db) = tenant_db(state, master, &org).await else {
            continue;
        };
        let member: Result<Option<MemberRef>, _> = sqlx::query_as(
            "select role, email, name, status from workspace_members
                 where clerk_invitation_id = $1 and deleted_at is null limit 1",
        )
        .bind(token)
        .fetch_optional(&db)
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
            let name: Option<String> =
                sqlx::query_scalar("select name from workspaces where clerk_org_id = $1 limit 1")
                    .bind(&org.id)
                    .fetch_optional(&master)
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
    let name: Option<String> =
        sqlx::query_scalar("select name from workspaces where clerk_org_id = $1 limit 1")
            .bind(&org.id)
            .fetch_optional(master)
            .await
            .ok()?;
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
) -> Result<Option<Value>, sqlx::Error> {
    if !token.is_empty() {
        let row: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(m) from workspace_members m
             where clerk_invitation_id = $1 and status = 'PENDING' and deleted_at is null limit 1",
        )
        .bind(token)
        .fetch_optional(db)
        .await?;
        if let Some(row) = row {
            return Ok(Some(js_row(row)));
        }
    }
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from workspace_members m
         where lower(email) = lower($1)
           and (status = 'PENDING' or user_id like 'invited_%' or user_id like 'pending_clerk_%')
           and deleted_at is null
         limit 1",
    )
    .bind(email)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `linkInvitedMember`: the row as it was before linking, or `None`.
async fn link_invited_member(
    state: &CoreTeamState,
    db: &PgPool,
    org: &str,
    membership: &Membership,
    user_id: &str,
    token: &str,
) -> Result<Option<Value>, sqlx::Error> {
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
) -> Result<bool, sqlx::Error> {
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
    // A returning member's removed row still holds their user id.
    sqlx::query(
        "update workspace_members set user_id = 'removed_' || id
         where user_id = $1 and deleted_at is not null",
    )
    .bind(user_id)
    .execute(db)
    .await?;
    let stamp = now();
    let updated: Option<String> = sqlx::query_scalar(
        "update workspace_members
         set user_id = $3, name = coalesce($4, name), picture = coalesce($5, picture),
             role = $6, status = 'ACTIVE', clerk_membership_id = $7,
             accepted_at = coalesce(accepted_at, $8::timestamptz), updated_at = $8::timestamptz
         where id = $1 and user_id = $2
         returning id",
    )
    .bind(pending["id"].as_str())
    .bind(pending["userId"].as_str())
    .bind(user_id)
    .bind(name)
    .bind(membership.user.image_url.as_deref())
    .bind(role)
    .bind(&membership.id)
    .bind(stamp)
    .fetch_optional(db)
    .await?;
    if let Some(cache) = &state.cache
        && let Err(error) = cache
            .delete_boxed(&format!("member-type:{org}:{user_id}"))
            .await
    {
        tracing::warn!(%error, "invitations: member-type cache delete failed");
    }
    Ok(updated.is_some())
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
) -> Result<Vec<(String, String)>, sqlx::Error> {
    let channels: Vec<(String, String)> = sqlx::query_as(
        "select id, name from chat_channels where type = 'public' and deleted_at is null",
    )
    .fetch_all(db)
    .await?;
    if channels.is_empty() {
        return Ok(channels);
    }
    let existing: Vec<String> =
        sqlx::query_scalar("select channel_id from chat_channel_members where user_id = $1")
            .bind(user_id)
            .fetch_all(db)
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
) -> Result<(), sqlx::Error> {
    let ids: Vec<String> = channels.iter().map(|_| generate_id("cmb")).collect();
    let channel_ids: Vec<String> = channels.iter().map(|(id, _)| id.clone()).collect();
    let stamp = now();
    if let Some(role_id) = role_id {
        sqlx::query(
            "insert into chat_channel_members
                 (id, channel_id, user_id, member_type, role, added_by_role_id, joined_at, created_at)
             select i, c, $3, 'user', 'member', $4, $5::timestamp, $5::timestamp
             from unnest($1::varchar[], $2::varchar[]) as t(i, c)
             on conflict do nothing",
        )
        .bind(&ids)
        .bind(&channel_ids)
        .bind(user_id)
        .bind(role_id)
        .bind(stamp)
        .execute(db)
        .await?;
    } else {
        sqlx::query(
            "insert into chat_channel_members (id, channel_id, user_id, role, joined_at, created_at)
             select i, c, $3, 'member', $4::timestamp, $4::timestamp
             from unnest($1::varchar[], $2::varchar[]) as t(i, c)
             on conflict do nothing",
        )
        .bind(&ids)
        .bind(&channel_ids)
        .bind(user_id)
        .bind(stamp)
        .execute(db)
        .await?;
    }
    Ok(())
}

async fn recount(db: &PgPool, channels: &[(String, String)]) -> Result<(), sqlx::Error> {
    let ids: Vec<String> = channels.iter().map(|(id, _)| id.clone()).collect();
    sqlx::query(
        "update chat_channels c
         set member_count = (select count(*)::int from chat_channel_members m where m.channel_id = c.id),
             updated_at = $2::timestamp
         where c.id = any($1)",
    )
    .bind(&ids)
    .bind(now())
    .execute(db)
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
) -> Result<Vec<(String, String)>, sqlx::Error> {
    let channels: Vec<(String, String)> = sqlx::query_as(
        "select c.id, c.name from chat_channel_role_links l
         inner join chat_channels c on c.id = l.channel_id
         where l.role_id = $1 and c.deleted_at is null",
    )
    .bind(role_id)
    .fetch_all(db)
    .await?;
    if channels.is_empty() {
        return Ok(channels);
    }
    let ids: Vec<String> = channels.iter().map(|(id, _)| id.clone()).collect();
    let existing: Vec<String> = sqlx::query_scalar(
        "select channel_id from chat_channel_members where channel_id = any($1) and user_id = $2",
    )
    .bind(&ids)
    .bind(user_id)
    .fetch_all(db)
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

    #[tokio::test]
    async fn links_a_pending_member_and_joins_their_channels() {
        let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
            eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
            return;
        };
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
