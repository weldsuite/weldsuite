//! `/api/bank-connections` (`routes/bank-connections/index.ts`): link a bank
//! through an aggregator (Plaid, Stripe Financial Connections, Ponto, Enable
//! Banking), map its accounts to bank accounts, sync, disconnect. The work is
//! `weldsuite_books_domain::bank_feeds`; the providers are called through
//! the outbound HTTP port.
//!
//! Responses never carry provider tokens or full account numbers, and
//! neither do the entity events. Starting a link takes a recently verified
//! second factor. The connections a plan includes are billed through
//! Global's billing-worker; billing is off on these editions (the `billing`
//! feature), so no connection is limited or charged and `GET /billing` is
//! `null`, as the worker answers where billing is off.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Router};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_auth::AuthContext;
use weldsuite_books_domain::bank_feeds::connections::{
    self as feeds, LinkSessionArgs, Mapping, require_connection,
};
use weldsuite_books_domain::bank_feeds::providers::capabilities;
use weldsuite_books_domain::bank_feeds::sync::sync_connection;
use weldsuite_books_domain::bank_feeds::{FeedConfig, FeedContext, ServiceError};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, all_rows, created, no_content, ok, reply, validate,
};
use weldsuite_catalogs::entity_events::{
    BANK_CONNECTION_CREATED, BANK_CONNECTION_DELETED, BANK_CONNECTION_SYNCED,
    BANK_CONNECTION_UPDATED,
};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Format, Issues, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::common::text;

const ACCOUNT_TYPES: [&str; 5] = [
    "checking",
    "savings",
    "credit_card",
    "money_market",
    "line_of_credit",
];

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("banking:read")))
        .route(
            "/providers",
            get(providers).route_layer(need("banking:read")),
        )
        .route(
            "/institutions",
            get(institutions).route_layer(need("banking:read")),
        )
        .route(
            "/link-session",
            post(link_session).route_layer(need("banking:create")),
        )
        .route(
            "/complete",
            post(complete).route_layer(need("banking:create")),
        )
        .route(
            "/{id}/map-accounts",
            post(map_accounts).route_layer(need("banking:update")),
        )
        .route("/{id}/sync", post(sync).route_layer(need("banking:update")))
        .route(
            "/{id}/disconnect",
            post(disconnect).route_layer(need("banking:manage")),
        )
        .route("/{id}", delete(remove).route_layer(need("banking:manage")))
        .route("/billing", get(billing).route_layer(need("banking:read")))
        .route(
            "/{id}/pending",
            get(pending).route_layer(need("banking:read")),
        )
        .route("/{id}", get(detail).route_layer(need("banking:read")))
        .with_state(state)
}

/// `createFeedContext(c)`: the providers configured in the env, the keyring,
/// the master index and the outbound clients of this request.
fn feed_context(caller: &Caller, state: &BooksState) -> FeedContext {
    FeedContext {
        db: caller.db.clone(),
        keyring: caller.keyring(state),
        master: caller.master(state),
        config: FeedConfig::from_env(|name| caller.env(state, name).map(str::to_owned)),
        http: caller.http(state),
        ponto_http: state.ponto_http.clone(),
        clerk_org_id: caller.org_id.clone().unwrap_or_default(),
        auto_reconcile: true,
    }
}

/// The route's `catch`: a feed failure by its code, anything else the
/// route's 500.
fn failure(error: ServiceError) -> Refusal {
    match error {
        ServiceError::Service(code, message) => match code {
            "not_found" => ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", message).into(),
            "bad_request" => Refusal::bad_request(message),
            "conflict" => Refusal::conflict(message),
            "unavailable" => Refusal::unavailable(message),
            _ => ApiError::new(StatusCode::BAD_GATEWAY, "UPSTREAM_ERROR", message).into(),
        },
        ServiceError::Database(error) => Refusal::Database(error),
        ServiceError::Other(message) => Refusal::Internal(message),
    }
}

/// Event payload: identifiers and status only.
fn event_data(view: &Value) -> Value {
    json!({
        "id": view.get("id"),
        "entityId": view.get("entityId"),
        "provider": view.get("provider"),
        "institutionName": view.get("institutionName"),
        "status": view.get("status"),
        "accountCount": view.get("accounts").and_then(Value::as_array).map_or(0, Vec::len),
    })
}

fn no_entity() -> Refusal {
    Refusal::bad_request("No accounting entity resolved")
}

// GET / — connections of the resolved entity
async fn list(caller: Caller, State(state): State<BooksState>) -> Response {
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(no_entity());
        };
        let views = feeds::list_views(&feed_context(&caller, &state), &entity_id).await?;
        Ok(all_rows(views))
    }
    .await;
    reply(result, "Failed to list bank connections")
}

// GET /providers?country=US — what the connect button can offer
async fn providers(caller: Caller, State(state): State<BooksState>) -> Response {
    let result = async {
        let mut country = caller.query().get("country").map(str::to_uppercase);
        if country.as_deref().is_none_or(str::is_empty)
            && let Some(entity_id) = resolve_entity_id(&caller).await?
        {
            let code: Option<Option<String>> =
                sqlx::query_scalar("select jurisdiction_code from entities where id = $1 limit 1")
                    .bind(&entity_id)
                    .fetch_optional(&caller.db)
                    .await?;
            country = code.flatten().map(|c| c.to_uppercase());
        }
        let country = country.unwrap_or_else(|| "US".to_owned());
        let config = FeedConfig::from_env(|name| caller.env(&state, name).map(str::to_owned));
        let providers: Vec<Value> = config
            .enabled(&country)
            .into_iter()
            .map(|id| {
                let kind = match id {
                    "plaid" => "plaid_link",
                    "stripe_fc" => "stripe_fc",
                    _ => "redirect",
                };
                json!({
                    "id": id,
                    "kind": kind,
                    "requiresInstitution": id == "enable_banking",
                    "capabilities": capabilities(id, &config),
                })
            })
            .collect();
        Ok(ok(json!({ "country": country, "providers": providers })))
    }
    .await;
    reply(result, "Failed to list providers")
}

// GET /institutions?provider=enable_banking&country=NL
async fn institutions(caller: Caller, State(state): State<BooksState>) -> Response {
    let result = async {
        let query = caller.query();
        let (Some(provider_id), Some(country)) = (
            query.get("provider").filter(|p| !p.is_empty()),
            query.get("country").filter(|c| !c.is_empty()),
        ) else {
            return Err(Refusal::bad_request("provider and country are required"));
        };
        let ctx = feed_context(&caller, &state);
        let provider = ctx.provider(provider_id).map_err(|e| failure(e.into()))?;
        if !provider.has_institution_list() {
            return Err(Refusal::bad_request(format!(
                "Provider '{provider_id}' has no institution list"
            )));
        }
        let institutions = provider
            .list_institutions(country)
            .await
            .map_err(|e| failure(e.into()))?;
        Ok(all_rows(institutions))
    }
    .await;
    reply(result, "Failed to list institutions")
}

// ── POST /link-session ──────────────────────────────────────────────────────

struct LinkBody {
    provider: String,
    mode: String,
    connection_id: Option<String>,
    redirect_url: String,
    institution: Option<Value>,
    psu_type: Option<String>,
}

fn read_link(issues: &mut Issues, body: &Map<String, Value>) -> Option<LinkBody> {
    let provider = issues.text(body, "provider", Presence::Required, Some(1), Some(30));
    let mode = issues.choice(
        body,
        "mode",
        Presence::Optional,
        &["create", "reauth", "add_accounts"],
    );
    let connection_id = issues.text(body, "connectionId", Presence::Optional, None, Some(30));
    let redirect_url = issues.text_with(
        body,
        "redirectUrl",
        Presence::Required,
        Text {
            format: Some(Format::Url),
            max: Some(2048),
            ..Text::default()
        },
    );
    let institution = issues.nested(body, "institution", Presence::Optional, |issues, fields| {
        let id = issues.text(fields, "id", Presence::Optional, None, Some(100));
        let name = issues.text(fields, "name", Presence::Required, Some(1), Some(255));
        let country = issues.text(fields, "country", Presence::Required, None, None);
        if let Some(country) = country.as_set() {
            issues.string_length("country", 2, country.encode_utf16().count());
        }
        let mut out = Map::new();
        if let Some(id) = id.into_option() {
            out.insert("id".to_owned(), json!(id));
        }
        out.insert("name".to_owned(), json!(name.into_option()));
        out.insert("country".to_owned(), json!(country.into_option()));
        Value::Object(out)
    });
    let psu_type = issues.choice(
        body,
        "psuType",
        Presence::Optional,
        &["business", "personal"],
    );
    issues.boolean(body, "acceptExtraCharge", Presence::Optional);
    Some(LinkBody {
        provider: provider.into_option()?,
        mode: mode.into_option().unwrap_or_else(|| "create".to_owned()),
        connection_id: connection_id.into_option(),
        redirect_url: redirect_url.into_option()?,
        institution: institution.into_option(),
        psu_type: psu_type.into_option(),
    })
}

// A second factor verified in the last 10 minutes, for every mode: a link
// (new or renewed) opens the bank's data to this workspace.
async fn link_session(
    caller: Caller,
    State(state): State<BooksState>,
    Extension(auth): Extension<AuthContext>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(refused) = weldsuite_auth::require_second_factor(&auth, 10) {
        return refused.into_response();
    }
    let input = match validate(&headers, &body, read_link) {
        Ok(Some(input)) => input,
        Ok(None) => return ApiError::internal().into_response(),
        Err(refusal) => return refusal.respond(""),
    };
    let result = async {
        // Billing is off here: a new connection is never above the plan.
        let session = feeds::create_link_session(
            &feed_context(&caller, &state),
            LinkSessionArgs {
                provider_id: input.provider,
                mode: input.mode,
                connection_id: input.connection_id,
                // Plaid's `client_user_id` and Stripe's account holder are keyed by it.
                workspace_id: caller.clerk_org_id.clone().unwrap_or_default(),
                redirect_url: input.redirect_url,
                institution: input.institution,
                psu_type: input.psu_type,
            },
        )
        .await
        .map_err(failure)?;
        Ok(created(session))
    }
    .await;
    reply(result, "Failed to start the bank link")
}

// ── POST /complete ──────────────────────────────────────────────────────────

fn read_complete(
    issues: &mut Issues,
    body: &Map<String, Value>,
) -> Option<(String, Value, Option<String>)> {
    let provider = issues.text(body, "provider", Presence::Required, Some(1), Some(30));
    let payload = issues.nested(body, "payload", Presence::Required, |_, fields| {
        Value::Object(fields.clone())
    });
    let connection_id = issues.text(body, "connectionId", Presence::Optional, None, Some(30));
    Some((
        provider.into_option()?,
        payload.into_option()?,
        connection_id.into_option(),
    ))
}

async fn complete(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (provider, payload, connection_id) = match validate(&headers, &body, read_complete) {
        Ok(Some(input)) => input,
        Ok(None) => return ApiError::internal().into_response(),
        Err(refusal) => return refusal.respond(""),
    };
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(no_entity());
        };
        let ctx = feed_context(&caller, &state);
        let linked = feeds::complete_link(
            &ctx,
            &provider,
            &payload,
            connection_id.as_deref(),
            &entity_id,
            caller.user(),
        )
        .await
        .map_err(failure)?;
        let id = text(&linked.view, "id").unwrap_or_default().to_owned();
        let event = if linked.created {
            BANK_CONNECTION_CREATED
        } else {
            BANK_CONNECTION_UPDATED
        };
        caller.publish(&state, event, &id, event_data(&linked.view));
        let data = json!({ "connection": linked.view, "accounts": linked.view.get("accounts") });
        Ok(if linked.created {
            created(data)
        } else {
            ok(data)
        })
    }
    .await;
    reply(result, "Failed to complete the bank link")
}

// ── POST /:id/map-accounts ──────────────────────────────────────────────────

fn day(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|i| b[*i].is_ascii_digit())
}

/// `dateOnly.nullable().optional()`: `None` absent, `Some(None)` null.
#[allow(clippy::option_option)] // absent and null differ, as in `Mapping::sync_from`
fn sync_from(issues: &mut Issues, body: &Map<String, Value>) -> Option<Option<String>> {
    let field = issues.pattern(
        body,
        "syncFrom",
        Presence::Nullish,
        None,
        None,
        day,
        "Use YYYY-MM-DD",
    );
    match body.get("syncFrom") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(_) => Some(field.into_option()),
    }
}

struct MapBody {
    mappings: Vec<Mapping>,
    #[allow(clippy::option_option)] // absent and null differ
    sync_from: Option<Option<String>>,
    sync: Option<bool>,
}

fn read_map(issues: &mut Issues, body: &Map<String, Value>) -> Option<MapBody> {
    let mappings = issues.list(
        body,
        "mappings",
        Presence::Required,
        Some(1),
        Some(50),
        |issues, item| {
            let fields = issues.object(item)?;
            let start = issues.count();
            let feed_account_id = issues.text(
                fields,
                "feedAccountId",
                Presence::Required,
                Some(1),
                Some(255),
            );
            let bank_account_id =
                issues.text(fields, "bankAccountId", Presence::Optional, None, Some(30));
            let create = issues.nested(fields, "create", Presence::Optional, |issues, create| {
                let name = issues.text(create, "name", Presence::Required, Some(1), Some(255));
                let account_type =
                    issues.choice(create, "accountType", Presence::Optional, &ACCOUNT_TYPES);
                let ledger = issues.text(
                    create,
                    "ledgerAccountId",
                    Presence::Optional,
                    None,
                    Some(30),
                );
                (
                    name.into_option().unwrap_or_default(),
                    account_type.into_option(),
                    ledger.into_option(),
                )
            });
            let sync_from = sync_from(issues, fields);
            if issues.count() > start {
                return None;
            }
            Some(Mapping {
                feed_account_id: feed_account_id.into_option()?,
                bank_account_id: bank_account_id.into_option(),
                create: create.into_option(),
                sync_from,
            })
        },
    );
    let top_sync_from = sync_from(issues, body);
    let sync = issues.boolean(body, "sync", Presence::Optional);
    Some(MapBody {
        mappings: mappings.into_option()?,
        sync_from: top_sync_from,
        sync: sync.into_option(),
    })
}

async fn map_accounts(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_map) {
        Ok(Some(input)) => input,
        Ok(None) => return ApiError::internal().into_response(),
        Err(refusal) => return refusal.respond(""),
    };
    let result = async {
        let entity_id = resolve_entity_id(&caller).await?;
        let ctx = feed_context(&caller, &state);
        let mapped = feeds::map_accounts(
            &ctx,
            &id,
            &input.mappings,
            input.sync_from.clone(),
            entity_id.as_deref(),
        )
        .await
        .map_err(failure)?;
        caller.publish(
            &state,
            BANK_CONNECTION_UPDATED,
            &id,
            event_data(&mapped.view),
        );
        let mut sync_started = false;
        if mapped.needs_sync && input.sync != Some(false) {
            sync_started = true;
            let connection_id = id.clone();
            state.events.tracker().spawn(async move {
                if let Err(error) = sync_connection(&ctx, &connection_id, false).await {
                    tracing::error!(?error, "[books-api/bank-connections] first sync failed");
                }
            });
        }
        Ok(ok(json!({
            "connection": mapped.view,
            "mapped": mapped.mapped,
            "syncStarted": sync_started,
        })))
    }
    .await;
    reply(result, "Failed to map the accounts")
}

// POST /:id/sync — on demand; { refresh: true } asks the provider to fetch fresh data first
async fn sync(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let result = async {
        let refresh = serde_json::from_slice::<Value>(&body)
            .is_ok_and(|b| b.get("refresh") == Some(&Value::Bool(true)));
        let entity_id = resolve_entity_id(&caller).await?;
        let ctx = feed_context(&caller, &state);
        require_connection(&ctx.db, &id, entity_id.as_deref())
            .await
            .map_err(failure)?;
        let outcome = sync_connection(&ctx, &id, refresh).await.map_err(failure)?;
        let view = feeds::view_by_id(&ctx, &id, false).await.map_err(failure)?;
        if outcome.skipped.is_none() && outcome.error.is_none() {
            let mut data = event_data(&view);
            if let Value::Object(fields) = &mut data {
                fields.insert("added".to_owned(), json!(outcome.added));
                fields.insert("updated".to_owned(), json!(outcome.updated));
                fields.insert("removed".to_owned(), json!(outcome.removed));
            }
            caller.publish(&state, BANK_CONNECTION_SYNCED, &id, data);
        }
        Ok(ok(
            json!({ "outcome": outcome.to_json(), "connection": view }),
        ))
    }
    .await;
    reply(result, "Failed to sync the bank connection")
}

// POST /:id/disconnect
async fn disconnect(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let entity_id = resolve_entity_id(&caller).await?;
        let view = feeds::disconnect(&feed_context(&caller, &state), &id, entity_id.as_deref())
            .await
            .map_err(failure)?;
        caller.publish(&state, BANK_CONNECTION_UPDATED, &id, event_data(&view));
        Ok(ok(view))
    }
    .await;
    reply(result, "Failed to disconnect the bank connection")
}

// DELETE /:id — disconnect and remove; synced transactions stay on their bank accounts
async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let entity_id = resolve_entity_id(&caller).await?;
        let removed = feeds::delete(&feed_context(&caller, &state), &id, entity_id.as_deref())
            .await
            .map_err(failure)?;
        caller.publish(
            &state,
            BANK_CONNECTION_DELETED,
            &id,
            json!({
                "id": id,
                "entityId": removed.get("entityId"),
                "provider": removed.get("provider"),
                "institutionName": removed.get("institutionName"),
            }),
        );
        Ok(no_content())
    }
    .await;
    reply(result, "Failed to delete the bank connection")
}

// GET /billing — null: billing is off on these editions
async fn billing() -> Response {
    ok(Value::Null)
}

// GET /:id/pending
async fn pending(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let entity_id = resolve_entity_id(&caller).await?;
        require_connection(&caller.db, &id, entity_id.as_deref())
            .await
            .map_err(failure)?;
        let query = caller.query();
        let rows = feeds::list_pending(&caller.db, &id, query.get("bankAccountId")).await?;
        Ok(all_rows(rows))
    }
    .await;
    reply(result, "Failed to list pending transactions")
}

// GET /:id
async fn detail(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let entity_id = resolve_entity_id(&caller).await?;
        require_connection(&caller.db, &id, entity_id.as_deref())
            .await
            .map_err(failure)?;
        let view = feeds::view_by_id(&feed_context(&caller, &state), &id, false)
            .await
            .map_err(failure)?;
        Ok(ok(view))
    }
    .await;
    reply(result, "Failed to fetch the bank connection")
}
