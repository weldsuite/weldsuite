//! `/api/legal-entities` (`app-api/src/routes/legal-entities/index.ts`): the
//! companies of the workspace, shared by WeldBooks and WeldHR, with their
//! registrations, bank accounts and per-entity access
//! (`docs/plans/legal-entities.md`). The work is the core service's
//! (`weldsuite-legal-entities`); these handlers are the routes around it.
//!
//! ```text
//! GET    /                                       list what the member sees  [legal_entities:read]
//! GET    /default                                the default entity or null [read]
//! GET    /:id, /:id/usage                                                   [read]
//! POST   /                                       create                     [create]
//! PATCH  /:id                                    update                     [update]
//! POST   /:id/make-default | archive | unarchive                            [update]
//! DELETE /:id                                    soft delete (204)          [delete]
//! GET    /:id/registrations                                                 [read]
//! POST|PATCH|DELETE /:id/registrations[/:registrationId]                    [update]
//! GET    /:id/bank-accounts                                                 [read]
//! POST|PATCH|DELETE /:id/bank-accounts[/:accountId]                         [update]
//! POST   /:id/bank-accounts/:accountId/reveal    full account number        [reveal]
//! GET    /:id/access, PATCH /:id/access                                     [manage]
//! PUT|DELETE /:id/access/members/:userId                                    [manage]
//! GET    /:id/my-access                          the caller's role here     [authenticated]
//! ```
//!
//! An entity the member does not see answers 404 on every route; owners and
//! `legal_entities:manage` holders see all. Giving someone an entity role is
//! held to the grant ceiling, as assigning a workspace role is: the caller
//! must hold every permission the role carries. Writes answer the entity as the
//! caller sees it after the write (a fresh access snapshot). Registrations,
//! make-default, unarchive and the Restricted switch publish `legal_entity`
//! `updated`; a reveal publishes no event (it is logged in `tax_id_reveals`).
//!
//! The default entity is the workspace business profile, and the worker
//! mirrors it onto the workspace's Stripe customer after a change to it.
//! Billing (Stripe) is Global-only: the mirror is skipped here, as the worker
//! skips it without `STRIPE_SECRET_KEY`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use serde::Serialize;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    LEGAL_ENTITY_ARCHIVED, LEGAL_ENTITY_BANK_ACCOUNT_CREATED, LEGAL_ENTITY_BANK_ACCOUNT_DELETED,
    LEGAL_ENTITY_BANK_ACCOUNT_UPDATED, LEGAL_ENTITY_CREATED, LEGAL_ENTITY_DELETED,
    LEGAL_ENTITY_MEMBER_CREATED, LEGAL_ENTITY_MEMBER_DELETED, LEGAL_ENTITY_MEMBER_UPDATED,
    LEGAL_ENTITY_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    LEGAL_ENTITIES_CREATE, LEGAL_ENTITIES_DELETE, LEGAL_ENTITIES_MANAGE, LEGAL_ENTITIES_READ,
    LEGAL_ENTITIES_REVEAL, LEGAL_ENTITIES_UPDATE,
};
use weldsuite_db::Keyring;
use weldsuite_kit::validation::{Invalid, json_body};
use weldsuite_kit::{ApiError, Created, Data, NoContent};
use weldsuite_legal_entities::service::{
    self as le, EntityRow, RevealBankAccount, SetEntityMember,
};
use weldsuite_legal_entities::{EntityAccess, LegalEntityError, can_see_entity, schemas};
use weldsuite_permissions::{
    PermissionGate, PermissionQueries, ResolvedPermissions, check_permission_grants,
    role_row_permissions,
};

use crate::{Caller, CoreTeamState, TeamError, TeamResult, answer};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need(LEGAL_ENTITIES_READ)))
        .route("/", post(create).route_layer(need(LEGAL_ENTITIES_CREATE)))
        .route(
            "/default",
            get(get_default).route_layer(need(LEGAL_ENTITIES_READ)),
        )
        .route("/{id}", get(detail).route_layer(need(LEGAL_ENTITIES_READ)))
        .route(
            "/{id}",
            patch(update).route_layer(need(LEGAL_ENTITIES_UPDATE)),
        )
        .route(
            "/{id}",
            delete(remove).route_layer(need(LEGAL_ENTITIES_DELETE)),
        )
        .route(
            "/{id}/usage",
            get(usage).route_layer(need(LEGAL_ENTITIES_READ)),
        )
        .route(
            "/{id}/make-default",
            post(make_default).route_layer(need(LEGAL_ENTITIES_UPDATE)),
        )
        .route(
            "/{id}/archive",
            post(archive).route_layer(need(LEGAL_ENTITIES_UPDATE)),
        )
        .route(
            "/{id}/unarchive",
            post(unarchive).route_layer(need(LEGAL_ENTITIES_UPDATE)),
        )
        .route(
            "/{id}/registrations",
            get(list_registrations).route_layer(need(LEGAL_ENTITIES_READ)),
        )
        .route(
            "/{id}/registrations",
            post(create_registration).route_layer(need(LEGAL_ENTITIES_UPDATE)),
        )
        .route(
            "/{id}/registrations/{registration_id}",
            patch(update_registration)
                .delete(delete_registration)
                .route_layer(need(LEGAL_ENTITIES_UPDATE)),
        )
        .route(
            "/{id}/bank-accounts",
            get(list_bank_accounts).route_layer(need(LEGAL_ENTITIES_READ)),
        )
        .route(
            "/{id}/bank-accounts",
            post(create_bank_account).route_layer(need(LEGAL_ENTITIES_UPDATE)),
        )
        .route(
            "/{id}/bank-accounts/{account_id}",
            patch(update_bank_account)
                .delete(delete_bank_account)
                .route_layer(need(LEGAL_ENTITIES_UPDATE)),
        )
        .route(
            "/{id}/bank-accounts/{account_id}/reveal",
            post(reveal_bank_account).route_layer(need(LEGAL_ENTITIES_REVEAL)),
        )
        .route(
            "/{id}/access",
            get(get_access)
                .patch(set_restricted)
                .route_layer(need(LEGAL_ENTITIES_MANAGE)),
        )
        .route(
            "/{id}/access/members/{user_id}",
            put(set_member)
                .delete(remove_member)
                .route_layer(need(LEGAL_ENTITIES_MANAGE)),
        )
        // Authentication only: the caller's own role in the entity.
        .route(
            "/{id}/my-access",
            get(my_access).route_layer(gate.resolve()),
        )
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/// `failure(c, err)`: a service error as app-api's routes answer it.
fn failure(error: &LegalEntityError) -> TeamError {
    TeamError::api(error.to_api_error())
}

/// A validation failure (`zValidator`): Zod's 400.
fn invalid(error: Invalid) -> TeamError {
    TeamError::Response(Box::new(error.into_response()))
}

/// `zValidator('json', schema)`'s body: the JSON of a JSON request, else `{}`.
fn body_json(headers: &HeaderMap, body: &Bytes) -> TeamResult<Value> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    json_body(content_type, body).map_err(|bad| TeamError::Response(Box::new(bad.into_response())))
}

fn not_found() -> TeamError {
    TeamError::api(ApiError::not_found("Legal entity", None))
}

/// The member's workspace permissions, as the gate layer settled them
/// (`ensurePermissionsResolved(c) ?? NO_PERMISSIONS`).
fn workspace_permissions(caller: &Caller) -> ResolvedPermissions {
    caller
        .permissions
        .as_ref()
        .map(|permissions| permissions.resolved().clone())
        .unwrap_or_default()
}

/// `getEntityAccess(c)`: the member's access snapshot.
async fn entity_access(caller: &Caller) -> TeamResult<EntityAccess> {
    Ok(weldsuite_legal_entities::load_entity_access(
        &caller.db,
        &caller.user_id,
        workspace_permissions(caller),
    )
    .await?)
}

/// `seesEntity(c, id)`: unknown and hidden look the same (404).
async fn require_visible(caller: &Caller, id: &str) -> TeamResult<()> {
    if can_see_entity(&entity_access(caller).await?, Some(id)) {
        Ok(())
    } else {
        Err(not_found())
    }
}

/// `entityView(c, id)`: the entity as the caller now sees it, from a fresh
/// access snapshot (the request's predates this write).
async fn entity_view(caller: &Caller, id: &str) -> TeamResult<Value> {
    let access = entity_access(caller).await?;
    let entity = le::get_legal_entity(&caller.db, id, Some(&access))
        .await
        .map_err(|error| failure(&error))?;
    Ok(to_json(&entity))
}

fn to_json<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// `publishEntityUpdated(c, id, action)`: `legal_entity` `updated` (or
/// `archived`) with the entity as it is now.
async fn publish_entity_updated(
    state: &CoreTeamState,
    caller: &Caller,
    id: &str,
    archived: bool,
) -> TeamResult<()> {
    let entity = le::get_legal_entity(&caller.db, id, None)
        .await
        .map_err(|error| failure(&error))?;
    let data = entity.map_or_else(|| json!({ "id": id }), |entity| to_json(&entity));
    let event = if archived {
        LEGAL_ENTITY_ARCHIVED
    } else {
        LEGAL_ENTITY_UPDATED
    };
    caller.publish(state, event, id, &data);
    Ok(())
}

/// `mirrorDefaultToStripe(c, entity)`: the default entity is the workspace
/// business profile, which the Stripe customer mirrors. Billing is
/// Global-only, so there is no customer to update on this edition.
fn mirror_default_to_stripe(entity: &EntityRow) {
    if entity.is_default == Some(true) {
        tracing::debug!("legal entities: no Stripe on this edition, customer not updated");
    }
}

/// The field-encryption keyring (`DATABASE_ENCRYPTION_KEY[_V2]`): the
/// request's (conformance), else the process's.
fn keyring(caller: &Caller) -> Keyring {
    Keyring {
        v1: caller.env_value("DATABASE_ENCRYPTION_KEY"),
        v2: caller.env_value("DATABASE_ENCRYPTION_KEY_V2"),
    }
}

fn ok(data: Value) -> Response {
    Data(data).into_response()
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    answer(run_list(&caller, query.as_deref()).await)
}

async fn run_list(caller: &Caller, query: Option<&str>) -> TeamResult<Response> {
    let options = schemas::parse_list_query(query).map_err(invalid)?;
    let access = entity_access(caller).await?;
    let entities = le::list_legal_entities(&caller.db, Some(&access), options)
        .await
        .map_err(|error| failure(&error))?;
    Ok(ok(to_json(&entities)))
}

async fn get_default(caller: Caller) -> Response {
    answer(run_get_default(&caller).await)
}

async fn run_get_default(caller: &Caller) -> TeamResult<Response> {
    let access = entity_access(caller).await?;
    let entity = le::get_default_legal_entity(&caller.db, Some(&access))
        .await
        .map_err(|error| failure(&error))?;
    Ok(ok(to_json(&entity)))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    answer(run_detail(&caller, &id).await)
}

async fn run_detail(caller: &Caller, id: &str) -> TeamResult<Response> {
    let access = entity_access(caller).await?;
    let entity = le::get_legal_entity(&caller.db, id, Some(&access))
        .await
        .map_err(|error| failure(&error))?;
    match entity {
        Some(entity) => Ok(ok(to_json(&entity))),
        None => Err(not_found()),
    }
}

async fn usage(caller: Caller, Path(id): Path<String>) -> Response {
    answer(run_usage(&caller, &id).await)
}

async fn run_usage(caller: &Caller, id: &str) -> TeamResult<Response> {
    require_visible(caller, id).await?;
    let usage = le::legal_entity_usage(&caller.db, id)
        .await
        .map_err(|error| failure(&error))?;
    Ok(ok(to_json(&usage)))
}

async fn create(
    State(state): State<CoreTeamState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_create(&state, &caller, &headers, &body).await)
}

async fn run_create(
    state: &CoreTeamState,
    caller: &Caller,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let input = schemas::parse_create_legal_entity(&body_json(headers, body)?).map_err(invalid)?;
    let row = le::create_legal_entity(&caller.db, &input)
        .await
        .map_err(|error| failure(&error))?;
    let entity = entity_view(caller, &row.id).await?;
    let data = if entity.is_null() {
        row.row.clone()
    } else {
        entity.clone()
    };
    caller.publish(state, LEGAL_ENTITY_CREATED, &row.id, &data);
    mirror_default_to_stripe(&row);
    Ok(Created(entity).into_response())
}

async fn update(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_update(&state, &caller, &id, &headers, &body).await)
}

async fn run_update(
    state: &CoreTeamState,
    caller: &Caller,
    id: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let input = schemas::parse_update_legal_entity(&body_json(headers, body)?).map_err(invalid)?;
    require_visible(caller, id).await?;
    let row = le::update_legal_entity(&caller.db, id, &input)
        .await
        .map_err(|error| failure(&error))?;
    let entity = entity_view(caller, id).await?;
    let data = if entity.is_null() {
        row.row.clone()
    } else {
        entity.clone()
    };
    caller.publish(state, LEGAL_ENTITY_UPDATED, id, &data);
    mirror_default_to_stripe(&row);
    Ok(ok(entity))
}

async fn make_default(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(run_make_default(&state, &caller, &id).await)
}

async fn run_make_default(
    state: &CoreTeamState,
    caller: &Caller,
    id: &str,
) -> TeamResult<Response> {
    require_visible(caller, id).await?;
    let row = le::set_default_legal_entity(&caller.db, id)
        .await
        .map_err(|error| failure(&error))?;
    publish_entity_updated(state, caller, id, false).await?;
    mirror_default_to_stripe(&row);
    Ok(ok(entity_view(caller, id).await?))
}

async fn archive(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(run_set_archived(&state, &caller, &id, true).await)
}

async fn unarchive(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(run_set_archived(&state, &caller, &id, false).await)
}

async fn run_set_archived(
    state: &CoreTeamState,
    caller: &Caller,
    id: &str,
    archived: bool,
) -> TeamResult<Response> {
    require_visible(caller, id).await?;
    le::set_legal_entity_archived(&caller.db, id, archived)
        .await
        .map_err(|error| failure(&error))?;
    publish_entity_updated(state, caller, id, archived).await?;
    Ok(ok(entity_view(caller, id).await?))
}

async fn remove(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(run_remove(&state, &caller, &id).await)
}

async fn run_remove(state: &CoreTeamState, caller: &Caller, id: &str) -> TeamResult<Response> {
    require_visible(caller, id).await?;
    let before = le::get_legal_entity(&caller.db, id, None)
        .await
        .map_err(|error| failure(&error))?;
    let row = le::delete_legal_entity(&caller.db, id)
        .await
        .map_err(|error| failure(&error))?;
    let data = before.map_or_else(|| row.row.clone(), |entity| to_json(&entity));
    caller.publish(state, LEGAL_ENTITY_DELETED, id, &data);
    Ok(NoContent.into_response())
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

async fn list_registrations(caller: Caller, Path(id): Path<String>) -> Response {
    answer(run_list_registrations(&caller, &id).await)
}

async fn run_list_registrations(caller: &Caller, id: &str) -> TeamResult<Response> {
    require_visible(caller, id).await?;
    // Not wrapped in `failure` by the worker: a lost race is its 500.
    let registrations = le::list_registrations(&caller.db, id)
        .await
        .map_err(|error| TeamError::api(unhandled(&error)))?;
    Ok(ok(to_json(&registrations)))
}

/// What the worker's global handler answers for an error a route rethrows:
/// a 500, whatever the error.
fn unhandled(error: &LegalEntityError) -> ApiError {
    tracing::error!(%error, "legal entities: unhandled service error");
    ApiError::internal()
}

async fn create_registration(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_create_registration(&state, &caller, &id, &headers, &body).await)
}

async fn run_create_registration(
    state: &CoreTeamState,
    caller: &Caller,
    id: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let input = schemas::parse_create_registration(&body_json(headers, body)?).map_err(invalid)?;
    require_visible(caller, id).await?;
    let registration = le::create_registration(&caller.db, id, &input)
        .await
        .map_err(|error| failure(&error))?;
    publish_entity_updated(state, caller, id, false).await?;
    Ok(Created(to_json(&registration)).into_response())
}

async fn update_registration(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path((id, registration_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_update_registration(&state, &caller, &id, &registration_id, &headers, &body).await)
}

async fn run_update_registration(
    state: &CoreTeamState,
    caller: &Caller,
    id: &str,
    registration_id: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let input = schemas::parse_update_registration(&body_json(headers, body)?).map_err(invalid)?;
    require_visible(caller, id).await?;
    let registration = le::update_registration(&caller.db, id, registration_id, &input)
        .await
        .map_err(|error| failure(&error))?;
    publish_entity_updated(state, caller, id, false).await?;
    Ok(ok(to_json(&registration)))
}

async fn delete_registration(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path((id, registration_id)): Path<(String, String)>,
) -> Response {
    answer(run_delete_registration(&state, &caller, &id, &registration_id).await)
}

async fn run_delete_registration(
    state: &CoreTeamState,
    caller: &Caller,
    id: &str,
    registration_id: &str,
) -> TeamResult<Response> {
    require_visible(caller, id).await?;
    le::delete_registration(&caller.db, id, registration_id)
        .await
        .map_err(|error| failure(&error))?;
    publish_entity_updated(state, caller, id, false).await?;
    Ok(NoContent.into_response())
}

// ---------------------------------------------------------------------------
// Bank accounts (events carry the public shape, never the encrypted number)
// ---------------------------------------------------------------------------

async fn list_bank_accounts(caller: Caller, Path(id): Path<String>) -> Response {
    answer(run_list_bank_accounts(&caller, &id).await)
}

async fn run_list_bank_accounts(caller: &Caller, id: &str) -> TeamResult<Response> {
    require_visible(caller, id).await?;
    // Not wrapped in `failure` by the worker: a lost race is its 500.
    let accounts = le::list_bank_accounts(&caller.db, id)
        .await
        .map_err(|error| TeamError::api(unhandled(&error)))?;
    Ok(ok(to_json(&accounts)))
}

async fn create_bank_account(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_create_bank_account(&state, &caller, &id, &headers, &body).await)
}

async fn run_create_bank_account(
    state: &CoreTeamState,
    caller: &Caller,
    id: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let input = schemas::parse_create_bank_account(&body_json(headers, body)?).map_err(invalid)?;
    require_visible(caller, id).await?;
    let account = le::create_bank_account(&caller.db, &keyring(caller), id, &input)
        .await
        .map_err(|error| failure(&error))?;
    let data = to_json(&account);
    caller.publish(state, LEGAL_ENTITY_BANK_ACCOUNT_CREATED, &account.id, &data);
    Ok(Created(data).into_response())
}

async fn update_bank_account(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path((id, account_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_update_bank_account(&state, &caller, &id, &account_id, &headers, &body).await)
}

async fn run_update_bank_account(
    state: &CoreTeamState,
    caller: &Caller,
    id: &str,
    account_id: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let input = schemas::parse_update_bank_account(&body_json(headers, body)?).map_err(invalid)?;
    require_visible(caller, id).await?;
    let account = le::update_bank_account(&caller.db, &keyring(caller), id, account_id, &input)
        .await
        .map_err(|error| failure(&error))?;
    let data = to_json(&account);
    caller.publish(state, LEGAL_ENTITY_BANK_ACCOUNT_UPDATED, &account.id, &data);
    Ok(ok(data))
}

async fn delete_bank_account(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path((id, account_id)): Path<(String, String)>,
) -> Response {
    answer(run_delete_bank_account(&state, &caller, &id, &account_id).await)
}

async fn run_delete_bank_account(
    state: &CoreTeamState,
    caller: &Caller,
    id: &str,
    account_id: &str,
) -> TeamResult<Response> {
    require_visible(caller, id).await?;
    let existing = le::list_bank_accounts(&caller.db, id)
        .await
        .map_err(|error| failure(&error))?
        .into_iter()
        .find(|account| account.id == account_id);
    le::delete_bank_account(&caller.db, id, account_id)
        .await
        .map_err(|error| failure(&error))?;
    let data = existing.map_or_else(
        || json!({ "id": account_id, "entityId": id }),
        |account| to_json(&account),
    );
    caller.publish(state, LEGAL_ENTITY_BANK_ACCOUNT_DELETED, account_id, &data);
    Ok(NoContent.into_response())
}

async fn reveal_bank_account(
    caller: Caller,
    Path((id, account_id)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    answer(run_reveal_bank_account(&caller, &id, &account_id, &body).await)
}

/// Logged in `tax_id_reveals` by the service; no entity event.
async fn run_reveal_bank_account(
    caller: &Caller,
    id: &str,
    account_id: &str,
    body: &Bytes,
) -> TeamResult<Response> {
    require_visible(caller, id).await?;
    // `c.req.json().catch(() => ({}))`: any body that parses, whatever its
    // content type; one that doesn't is `{}`.
    let body: Value = serde_json::from_slice(body).unwrap_or_else(|_| json!({}));
    let reason = schemas::parse_reveal_bank_account(&body).map_err(|error| {
        TeamError::api(ApiError::bad_request("Invalid request").with_details(error.flatten()))
    })?;
    let revealed = le::reveal_bank_account_number(
        &caller.db,
        &keyring(caller),
        RevealBankAccount {
            entity_id: id,
            account_id,
            user_id: &caller.user_id,
            reason: reason.as_deref(),
        },
    )
    .await
    .map_err(|error| failure(&error))?;
    Ok(ok(to_json(&revealed)))
}

// ---------------------------------------------------------------------------
// Per-entity access
// ---------------------------------------------------------------------------

async fn get_access(caller: Caller, Path(id): Path<String>) -> Response {
    answer(run_get_access(&caller, &id).await)
}

async fn run_get_access(caller: &Caller, id: &str) -> TeamResult<Response> {
    require_visible(caller, id).await?;
    let list = le::get_entity_access_list(&caller.db, id)
        .await
        .map_err(|error| failure(&error))?;
    Ok(ok(to_json(&list)))
}

async fn set_restricted(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_set_restricted(&state, &caller, &id, &headers, &body).await)
}

async fn run_set_restricted(
    state: &CoreTeamState,
    caller: &Caller,
    id: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let restricted =
        schemas::parse_update_entity_access(&body_json(headers, body)?).map_err(invalid)?;
    require_visible(caller, id).await?;
    le::set_entity_restricted(&caller.db, id, restricted)
        .await
        .map_err(|error| failure(&error))?;
    publish_entity_updated(state, caller, id, false).await?;
    let list = le::get_entity_access_list(&caller.db, id)
        .await
        .map_err(|error| failure(&error))?;
    Ok(ok(to_json(&list)))
}

/// `refuseUngrantableRole`: the grant ceiling for an entity role (as
/// team-members' `refuseUngrantable`). The role replaces the member's
/// permissions inside the entity, so whoever gives it must hold every
/// permission it carries. No role (the workspace role) needs no check; an
/// unknown role and the Owner role are left to `set_entity_member`, which
/// refuses both with a 400.
async fn refuse_ungrantable_role(caller: &Caller, role_id: Option<&str>) -> TeamResult<()> {
    let Some(role_id) = role_id.filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    let role: Option<(String, bool, Option<Value>)> = sqlx::query_as(
        "select name, is_system, permissions from roles where id = $1 and deleted_at is null limit 1",
    )
    .bind(role_id)
    .fetch_optional(&caller.db)
    .await?;
    let Some((name, is_system, stored)) = role else {
        return Ok(());
    };
    if is_system && name.to_uppercase() == "OWNER" {
        return Ok(());
    }
    let Some(grantor) = caller.permissions.as_ref() else {
        return Err(TeamError::api(ApiError::unauthorized()));
    };
    let stored: Option<Vec<String>> = stored.as_ref().map(|value| {
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
    });
    let keys = role_row_permissions(is_system, &name, stored.as_deref());
    let none: &[&str] = &[];
    if check_permission_grants(grantor.resolved(), keys.as_slice(), none).ok {
        Ok(())
    } else {
        Err(TeamError::api(ApiError::forbidden().with_message(
            "You cannot grant permissions you do not hold yourself",
        )))
    }
}

async fn set_member(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path((id, user_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_set_member(&state, &caller, &id, &user_id, &headers, &body).await)
}

async fn run_set_member(
    state: &CoreTeamState,
    caller: &Caller,
    id: &str,
    user_id: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let role_id = schemas::parse_set_entity_member(&body_json(headers, body)?).map_err(invalid)?;
    require_visible(caller, id).await?;
    refuse_ungrantable_role(caller, role_id.as_deref()).await?;
    let set = le::set_entity_member(
        &caller.db,
        SetEntityMember {
            entity_id: id,
            user_id,
            role_id: role_id.as_deref(),
            granted_by: &caller.user_id,
        },
    )
    .await
    .map_err(|error| failure(&error))?;
    let event = if set.created {
        LEGAL_ENTITY_MEMBER_CREATED
    } else {
        LEGAL_ENTITY_MEMBER_UPDATED
    };
    caller.publish(
        state,
        event,
        &set.member.id,
        &json!({ "entityId": id, "userId": user_id, "roleId": set.member.role_id }),
    );
    let list = le::get_entity_access_list(&caller.db, id)
        .await
        .map_err(|error| failure(&error))?;
    // `success(c, undefined)` serializes as `{}`.
    let member = list
        .members
        .iter()
        .find(|member| member.user_id == user_id)
        .map(to_json);
    let body = member.map_or_else(|| json!({}), |member| json!({ "data": member }));
    let status = if set.created {
        http::StatusCode::CREATED
    } else {
        http::StatusCode::OK
    };
    Ok((status, axum::Json(body)).into_response())
}

async fn remove_member(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path((id, user_id)): Path<(String, String)>,
) -> Response {
    answer(run_remove_member(&state, &caller, &id, &user_id).await)
}

async fn run_remove_member(
    state: &CoreTeamState,
    caller: &Caller,
    id: &str,
    user_id: &str,
) -> TeamResult<Response> {
    require_visible(caller, id).await?;
    // Not wrapped in `failure` by the worker: an error is its 500.
    let removed = le::remove_entity_member(&caller.db, id, user_id)
        .await
        .map_err(|error| TeamError::api(unhandled(&error)))?;
    let Some(removed) = removed else {
        return Err(TeamError::api(ApiError::not_found("Member", None)));
    };
    caller.publish(
        state,
        LEGAL_ENTITY_MEMBER_DELETED,
        &removed.id,
        &json!({ "entityId": id, "userId": user_id, "roleId": removed.role_id }),
    );
    Ok(NoContent.into_response())
}

async fn my_access(caller: Caller, Path(id): Path<String>) -> Response {
    answer(run_my_access(&caller, &id).await)
}

async fn run_my_access(caller: &Caller, id: &str) -> TeamResult<Response> {
    let access = entity_access(caller).await?;
    // Not wrapped in `failure` by the worker: an error is its 500.
    let effective = le::my_effective_access(&caller.db, &access, id)
        .await
        .map_err(|error| TeamError::api(unhandled(&error)))?;
    match effective {
        Some(effective) => Ok(ok(to_json(&effective))),
        None => Err(not_found()),
    }
}
