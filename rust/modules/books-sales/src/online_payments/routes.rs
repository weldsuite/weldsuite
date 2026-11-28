//! `/api/accounting-payment-connections`: the legal entity's Mollie
//! connection (`accounts:read|update`, the entity's WeldBooks settings).
//!
//! - `GET /`: the entity's connection, or `null`.
//! - `POST /mollie/authorize` `{ returnUrl }`: `{ authorizeUrl }` (Mollie Connect).
//!   Mollie sends the merchant to `/public/weldbooks/mollie/callback`
//!   ([`super::webhook`]), which stores the tokens and redirects to `returnUrl`.
//! - `POST /mollie/api-key` `{ apiKey, profileId? }`: connects with the
//!   merchant's own key, checked with Mollie first.
//! - `PATCH /:id` `{ methods? }`: the methods offered, among those the
//!   profile has active.
//! - `GET /:id/methods`: the methods the profile has active.
//! - `DELETE /:id`: disconnects, revoking an OAuth grant.
//! - `POST /:id/sync-settlements`: reads Mollie's settlements now.
//!
//! A credential is sealed and never leaves the server; neither responses nor
//! events carry one. Connecting and disconnecting ask for a second factor, as
//! linking a bank does.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Extension, Router};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_auth::{AuthContext, StepUp, StepUpGuard};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, no_content, ok, reply, validate,
};
use weldsuite_books_domain::payment_refs::{self, PayRef};
use weldsuite_books_domain::system_accounts::ensure_payment_provider_account;
use weldsuite_catalogs::entity_events::{
    ACCOUNT_CREATED, BANK_ACCOUNT_CREATED, PAYMENT_CONNECTION_CREATED, PAYMENT_CONNECTION_DELETED,
    PAYMENT_CONNECTION_UPDATED,
};
use weldsuite_db::orm;
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_legal_entities::{EntityRecordGuard, EntityTable};
use weldsuite_mollie::Mollie;
use weldsuite_mollie::connect::BOOKS_SCOPES;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{accounts, bank_accounts};

use super::connection::{self, NewConnection, Row, view};
use super::{ACCOUNT_NAME, Ctx, PayError, settlements};

pub(super) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(read).route_layer(need("accounts:read")))
        .route(
            "/mollie/authorize",
            post(authorize).route_layer(need("accounts:update")),
        )
        .route(
            "/mollie/api-key",
            post(api_key).route_layer(need("accounts:update")),
        )
        .route("/{id}", patch(update).route_layer(need("accounts:update")))
        .route(
            "/{id}",
            delete(disconnect).route_layer(need("accounts:update")),
        )
        .route(
            "/{id}/methods",
            get(methods).route_layer(need("accounts:read")),
        )
        .route(
            "/{id}/sync-settlements",
            post(sync_settlements).route_layer(need("accounts:update")),
        )
        // A record of an entity the request may not touch answers 404.
        .route_layer(
            EntityRecordGuard::table(
                EntityTable::new("accounting_payment_connections"),
                "Payment connection",
            )
            .layer(),
        )
        .with_state(state)
}

fn ctx_of(caller: &Caller, state: &BooksState) -> Result<Ctx, Refusal> {
    Ctx::new(state, &caller.db, caller.http(state))
        .ok_or_else(|| Refusal::unavailable("Outbound HTTP is not available on this install"))
}

async fn entity_of(caller: &Caller) -> Result<String, Refusal> {
    resolve_entity_id(caller)
        .await?
        .ok_or_else(|| Refusal::bad_request("No accounting entity resolved"))
}

/// A second factor verified in the last 10 minutes (with Clerk sign-in, or
/// on an install that asks for step-up), as linking a bank asks.
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
fn second_factor(
    state: &BooksState,
    auth: &AuthContext,
    step_up: &StepUpGuard,
) -> Result<(), Response> {
    let refused = if state.second_factor_step_up {
        weldsuite_auth::require_second_factor(auth, 10)
    } else {
        step_up.require(StepUp::SecondFactor)
    };
    refused.map_err(IntoResponse::into_response)
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn read(caller: Caller) -> Response {
    reply(
        read_connection(&caller).await,
        "Failed to fetch the payment connection",
    )
}

pub(super) async fn read_connection(caller: &Caller) -> Reply {
    let entity = entity_of(caller).await?;
    let row = connection::live(&orm(&caller.db), &entity)
        .await?
        .filter(|row| row.status != "disconnected");
    Ok(ok(row.as_ref().map_or(Value::Null, view)))
}

// ── POST /mollie/authorize ──────────────────────────────────────────────────

/// Where the browser may be sent back to: a path on the platform, or a URL
/// on its origin. The absolute URL, or `None`.
pub(super) fn return_target(app_url: &str, wanted: &str) -> Option<String> {
    let wanted = wanted.trim();
    if wanted.is_empty() || wanted.len() > 500 || wanted.contains(char::is_control) {
        return None;
    }
    if wanted.starts_with('/') {
        if wanted.starts_with("//") || wanted.contains('\\') {
            return None;
        }
        return Some(format!("{}{wanted}", app_url.trim_end_matches('/')));
    }
    let given = url::Url::parse(wanted).ok()?;
    let app = url::Url::parse(app_url).ok()?;
    (matches!(given.scheme(), "http" | "https")
        && given.origin() == app.origin()
        && given.username().is_empty()
        && given.password().is_none())
    .then(|| given.to_string())
}

async fn authorize(
    caller: Caller,
    State(state): State<BooksState>,
    Extension(auth): Extension<AuthContext>,
    step_up: StepUpGuard,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(refused) = second_factor(&state, &auth, &step_up) {
        return refused;
    }
    let wanted = match validate(&headers, &body, |issues, fields| {
        issues
            .text(fields, "returnUrl", Presence::Required, Some(1), Some(500))
            .into_option()
    }) {
        Ok(Some(wanted)) => wanted,
        Ok(None) => return Refusal::Internal("body".into()).respond(FAILED_AUTHORIZE),
        Err(refusal) => return refusal.respond(FAILED_AUTHORIZE),
    };
    reply(
        authorize_url(&caller, &state, &wanted).await,
        FAILED_AUTHORIZE,
    )
}

const FAILED_AUTHORIZE: &str = "Failed to start the Mollie connection";

pub(super) async fn authorize_url(caller: &Caller, state: &BooksState, wanted: &str) -> Reply {
    let entity = entity_of(caller).await?;
    let ctx = ctx_of(caller, state)?;
    let settings = &ctx.settings;
    let (Some(app), Some(secret), Some(callback), Some(app_url)) = (
        settings.connect.as_ref(),
        settings.secret.as_deref(),
        settings.callback_url(),
        settings.app_url.as_deref(),
    ) else {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "MOLLIE_CONNECT_NOT_CONFIGURED",
            "This install has no Mollie Connect app configured",
        )
        .into());
    };
    let Some(target) = return_target(app_url, wanted) else {
        return Err(Refusal::bad_request(
            "returnUrl must be a path or a URL on this platform",
        ));
    };
    let now_secs = time::OffsetDateTime::now_utc().unix_timestamp();
    let state_text = payment_refs::sign(
        secret,
        &PayRef::connect(
            &caller.workspace_id,
            &entity,
            &caller.user_id,
            &target,
            now_secs,
        ),
    );
    let Some(url) = app.authorize_url(&callback, &state_text, BOOKS_SCOPES) else {
        return Err(Refusal::Internal("the authorize URL is not a URL".into()));
    };
    Ok(ok(json!({ "authorizeUrl": url })))
}

// ── POST /mollie/api-key ────────────────────────────────────────────────────

pub(super) struct KeyBody {
    pub(super) api_key: String,
    pub(super) profile_id: Option<String>,
}

fn read_key(issues: &mut Issues, fields: &Map<String, Value>) -> Option<KeyBody> {
    let api_key = issues
        .text(fields, "apiKey", Presence::Required, Some(1), Some(200))
        .into_option();
    let profile_id = issues
        .text(fields, "profileId", Presence::Optional, Some(1), Some(50))
        .into_option();
    Some(KeyBody {
        api_key: api_key?.trim().to_owned(),
        profile_id,
    })
}

async fn api_key(
    caller: Caller,
    State(state): State<BooksState>,
    Extension(auth): Extension<AuthContext>,
    step_up: StepUpGuard,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to connect Mollie";
    if let Err(refused) = second_factor(&state, &auth, &step_up) {
        return refused;
    }
    let input = match validate(&headers, &body, read_key) {
        Ok(Some(input)) => input,
        Ok(None) => return Refusal::Internal("body".into()).respond(FAILED),
        Err(refusal) => return refusal.respond(FAILED),
    };
    reply(connect_api_key(&caller, &state, input).await, FAILED)
}

pub(super) async fn connect_api_key(caller: &Caller, state: &BooksState, input: KeyBody) -> Reply {
    let entity = entity_of(caller).await?;
    let ctx = ctx_of(caller, state)?;
    let key = input.api_key;
    let testmode = key.starts_with("test_");
    if !testmode && !key.starts_with("live_") {
        return Err(Refusal::bad_request(
            "A Mollie API key starts with live_ or test_",
        ));
    }
    let profile = match Mollie::new(&ctx.settings.api_url, &key)
        .current_profile(&ctx.http)
        .await
    {
        Ok(profile) => profile,
        Err(error) if error.is_refusal() => {
            return Err(Refusal::bad_request("Mollie does not accept this API key"));
        }
        Err(error) => return Err(PayError::from(error).refusal()),
    };
    let row = connection::save(
        &ctx,
        &NewConnection {
            entity_id: &entity,
            auth_method: "api_key",
            tokens: None,
            api_key: Some(&key),
            testmode,
            profile_id: Some(profile.id.as_str()).or(input.profile_id.as_deref()),
            profile_name: Some(profile.name.as_str()),
            organization_id: None,
            organization_name: None,
            methods: None,
            connected_by: caller.user(),
        },
    )
    .await
    .map_err(PayError::refusal)?;
    let row = finish_connect(&ctx, caller, row)
        .await
        .map_err(PayError::refusal)?;
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(&entity),
            entity_type: "payment_connection",
            entity_id: &row.id,
            action: "created",
            changes: None,
        },
    )
    .await;
    Ok(created(view(&row)))
}

/// What follows storing a connection, for both ways in: the entity's Mollie
/// money account (made on the first connection), and the methods its profile
/// has active (all of them are on until the entity picks). Announces the
/// connection and what was made.
pub(super) async fn finish_connect(ctx: &Ctx, caller: &Caller, row: Row) -> Result<Row, PayError> {
    let account =
        ensure_payment_provider_account(&ctx.db, &row.entity_id, super::PROVIDER, ACCOUNT_NAME)
            .await?;
    let db = orm(&ctx.db);
    connection::set_bank_account(&db, &row.id, &account.bank_account_id).await?;
    if account.ledger_created {
        announce_ledger_account(ctx, caller, &account.ledger_account_id).await;
    }
    if account.created {
        announce_bank_account(ctx, caller, &account.bank_account_id).await;
    }
    // The methods are best effort: a connection without them offers every
    // method the profile has.
    let http = &ctx.http;
    match connection::call(
        ctx,
        &row,
        |mollie| async move { mollie.methods(http).await },
    )
    .await
    {
        Ok(active) if !active.is_empty() => {
            let ids: Vec<String> = active.into_iter().map(|m| m.id).collect();
            connection::set_methods(&db, &row.id, &ids).await?;
        }
        Ok(_) => {}
        Err(error) => tracing::warn!(%error, "[books/mollie] the profile's methods were not read"),
    }
    let row = connection::by_id(&db, &row.id)
        .await?
        .ok_or(PayError::NotConnected)?;
    caller.publish(
        &ctx.books,
        PAYMENT_CONNECTION_CREATED,
        &row.id,
        connection::event_data(&row),
    );
    Ok(row)
}

async fn announce_ledger_account(ctx: &Ctx, caller: &Caller, id: &str) {
    use sea_orm::EntityTrait;
    if let Ok(Some(row)) = accounts::Entity::find_by_id(id.to_owned())
        .one(&orm(&ctx.db))
        .await
        && let Ok(data) = serde_json::to_value(row)
    {
        caller.publish(&ctx.books, ACCOUNT_CREATED, id, data);
    }
}

async fn announce_bank_account(ctx: &Ctx, caller: &Caller, id: &str) {
    use sea_orm::EntityTrait;
    if let Ok(Some(row)) = bank_accounts::Entity::find_by_id(id.to_owned())
        .one(&orm(&ctx.db))
        .await
        && let Ok(mut data) = serde_json::to_value(row)
    {
        if let Some(object) = data.as_object_mut() {
            object.remove("accountNumberEncrypted");
        }
        caller.publish(&ctx.books, BANK_ACCOUNT_CREATED, id, data);
    }
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

fn read_methods(issues: &mut Issues, fields: &Map<String, Value>) -> Option<Vec<String>> {
    let Some(list) = fields.get("methods") else {
        return Some(Vec::new());
    };
    let Some(list) = list.as_array() else {
        issues.custom("methods", "Expected an array of payment method ids");
        return None;
    };
    let mut out = Vec::new();
    for item in list {
        match item.as_str() {
            Some(id)
                if (2..=30).contains(&id.len())
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') =>
            {
                if !out.iter().any(|known| known == id) {
                    out.push(id.to_owned());
                }
            }
            _ => {
                issues.custom(
                    "methods",
                    "Every method must be a Mollie method id, such as ideal",
                );
                return None;
            }
        }
    }
    Some(out)
}

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update the payment connection";
    let methods = match validate(&headers, &body, |issues, fields| {
        let present = fields.contains_key("methods");
        read_methods(issues, fields).filter(|_| present)
    }) {
        Ok(methods) => methods,
        Err(refusal) => return refusal.respond(FAILED),
    };
    reply(
        update_connection(&caller, &state, &id, methods).await,
        FAILED,
    )
}

pub(super) async fn update_connection(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    methods: Option<Vec<String>>,
) -> Reply {
    let ctx = ctx_of(caller, state)?;
    let db = orm(&caller.db);
    let row = owned(caller, id).await?;
    if let Some(methods) = methods {
        let active = active_methods(&ctx, &row)
            .await
            .map_err(PayError::refusal)?;
        if let Some(unknown) = methods.iter().find(|m| !active.iter().any(|a| &a.id == *m)) {
            return Err(Refusal::bad_request(format!(
                "{unknown} is not active on the Mollie profile"
            )));
        }
        connection::set_methods(&db, id, &methods).await?;
    }
    let row = connection::by_id(&db, id)
        .await?
        .ok_or_else(|| Refusal::not_found("Payment connection", id))?;
    caller.publish(
        state,
        PAYMENT_CONNECTION_UPDATED,
        id,
        connection::event_data(&row),
    );
    Ok(ok(view(&row)))
}

/// The live connection `id`, when it is the request's entity's: a request
/// about one entity never reaches another's.
async fn owned(caller: &Caller, id: &str) -> Result<Row, Refusal> {
    let entity = entity_of(caller).await?;
    connection::by_id(&orm(&caller.db), id)
        .await?
        .filter(|row| row.entity_id == entity)
        .ok_or_else(|| Refusal::not_found("Payment connection", id))
}

async fn active_methods(ctx: &Ctx, row: &Row) -> Result<Vec<weldsuite_mollie::Method>, PayError> {
    let http = &ctx.http;
    connection::call(ctx, row, |mollie| async move { mollie.methods(http).await }).await
}

// ── GET /:id/methods ────────────────────────────────────────────────────────

async fn methods(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        read_methods_of(&caller, &state, &id).await,
        "Failed to fetch the payment methods",
    )
}

async fn read_methods_of(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let ctx = ctx_of(caller, state)?;
    let row = owned(caller, id).await?;
    let active = active_methods(&ctx, &row)
        .await
        .map_err(PayError::refusal)?;
    Ok(ok(json!(
        active
            .iter()
            .map(|m| json!({ "id": m.id, "description": m.description }))
            .collect::<Vec<_>>()
    )))
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn disconnect(
    caller: Caller,
    State(state): State<BooksState>,
    Extension(auth): Extension<AuthContext>,
    step_up: StepUpGuard,
    Path(id): Path<String>,
) -> Response {
    if let Err(refused) = second_factor(&state, &auth, &step_up) {
        return refused;
    }
    reply(
        disconnect_connection(&caller, &state, &id).await,
        "Failed to disconnect Mollie",
    )
}

pub(super) async fn disconnect_connection(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let ctx = ctx_of(caller, state)?;
    let row = owned(caller, id).await?;
    connection::disconnect(&ctx, &row)
        .await
        .map_err(PayError::refusal)?;
    let mut data = connection::event_data(&row);
    data["status"] = json!("disconnected");
    caller.publish(state, PAYMENT_CONNECTION_DELETED, id, data);
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(&row.entity_id),
            entity_type: "payment_connection",
            entity_id: id,
            action: "deleted",
            changes: None,
        },
    )
    .await;
    Ok(no_content())
}

// ── POST /:id/sync-settlements ──────────────────────────────────────────────

async fn sync_settlements(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        sync_now(&caller, &state, &id).await,
        "Failed to read the Mollie settlements",
    )
}

pub(super) async fn sync_now(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let ctx = ctx_of(caller, state)?;
    let row = owned(caller, id).await?;
    if !connection::settlements_available(&row) {
        return Err(Refusal::conflict_with(
            "Settlements can only be read from a Mollie account connected with Mollie Connect",
            json!({ "code": "SETTLEMENTS_UNAVAILABLE" }),
        ));
    }
    let outcome = settlements::sync(&ctx, caller, &row)
        .await
        .map_err(PayError::refusal)?;
    Ok(ok(outcome.json()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_return_target_stays_on_the_platform() {
        let app = "https://app.example.test";
        assert_eq!(
            return_target(app, "/settings/apps/weldbooks?tab=payments").as_deref(),
            Some("https://app.example.test/settings/apps/weldbooks?tab=payments")
        );
        assert_eq!(
            return_target(app, "https://app.example.test/settings").as_deref(),
            Some("https://app.example.test/settings")
        );
        for bad in [
            "",
            "//evil.test/x",
            "/\\evil.test",
            "https://evil.test/settings",
            "https://app.example.test.evil.test/",
            "https://user@app.example.test/",
            "javascript:alert(1)",
            "ftp://app.example.test/",
            "settings",
        ] {
            assert_eq!(return_target(app, bad), None, "{bad:?}");
        }
    }
}
