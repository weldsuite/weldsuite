//! `/api/helpdesk-email` (`routes/helpdesk-email/index.ts`): the addresses
//! connected to the helpdesk, from the master `mail_account_registry`
//! (`helpdesk_…` accounts) and from WeldMail accounts flagged
//! `metadata.helpdeskEnabled`.
//! Permissions `settings:read|create|delete`.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Router};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_db::{PgPool, Tenant};
use weldsuite_kit::validation::{Format, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::{js_stamp, master, truthy};
use crate::{Caller, DeskState, Refusal, now, validate};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/addresses",
            get(addresses).route_layer(need("settings:read")),
        )
        .route(
            "/addresses",
            post(connect).route_layer(need("settings:create")),
        )
        .route(
            "/addresses/{id}",
            delete(disconnect).route_layer(need("settings:delete")),
        )
        .route(
            "/mail-accounts",
            get(mail_accounts).route_layer(need("settings:read")),
        )
        .route("/domains", get(domains).route_layer(need("settings:read")))
}

/// `getMasterDb(c.env)` inside the route's `try`: without one the route
/// answers its 500.
fn master_or(caller: &Caller, state: &DeskState, message: &str) -> Result<PgPool, Response> {
    master(caller, state).ok_or_else(|| ApiError::internal().with_message(message).into_response())
}

async fn addresses(
    State(state): State<DeskState>,
    caller: Caller,
    Extension(tenant): Extension<Tenant>,
) -> Response {
    let message = "Failed to list email addresses";
    let master = match master_or(&caller, &state, message) {
        Ok(master) => master,
        Err(response) => return response,
    };
    let registry: Result<Vec<(String, String, String, bool, Option<String>)>, _> = sqlx::query_as(
        "select id, email, account_id, is_active, to_jsonb(created_at)#>>'{}' from mail_account_registry
         where workspace_id = $1 and account_id like 'helpdesk_%'",
    )
    .bind(&tenant.workspace_id)
    .fetch_all(&master)
    .await;
    let registry = match registry {
        Ok(rows) => rows,
        Err(error) => return Refusal::Database(error).respond(message),
    };
    let accounts: Result<Vec<(String, String, Option<String>)>, _> = sqlx::query_as(
        "select id, email, to_jsonb(created_at)#>>'{}' from mail_accounts
         where status = 'active' and deleted_at is null and metadata->>'helpdeskEnabled' = 'true'",
    )
    .fetch_all(&caller.db)
    .await;
    let accounts = match accounts {
        Ok(rows) => rows,
        Err(error) => return Refusal::Database(error).respond(message),
    };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (id, email, account_id, is_active, created_at) in registry {
        if seen.insert(email.clone()) {
            out.push(json!({
                "id": id,
                "email": email,
                "accountId": account_id,
                "isActive": is_active,
                "createdAt": js_stamp(created_at),
                "source": "registry",
            }));
        }
    }
    for (id, email, created_at) in accounts {
        if seen.insert(email.clone()) {
            out.push(json!({
                "id": id,
                "email": email,
                "accountId": format!("helpdesk_mail_{id}"),
                "isActive": true,
                "createdAt": js_stamp(created_at),
                "source": "mail_account",
            }));
        }
    }
    Data(Value::Array(out)).into_response()
}

async fn mail_accounts(caller: Caller) -> Response {
    type Row = (
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        Option<Value>,
    );
    let rows: Result<Vec<Row>, _> = sqlx::query_as(
        "select id, name, email, display_name, provider::text, status::text, metadata from mail_accounts
         where status = 'active' and deleted_at is null",
    )
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.into_iter()
                .map(
                    |(id, name, email, display_name, provider, status, metadata)| {
                        let linked = metadata
                            .as_ref()
                            .and_then(|meta| meta.get("helpdeskEnabled"))
                            == Some(&Value::Bool(true));
                        json!({
                            "id": id,
                            "name": name,
                            "email": email,
                            "displayName": display_name,
                            "provider": provider,
                            "status": status,
                            "metadata": metadata,
                            "isLinkedToHelpdesk": linked,
                        })
                    },
                )
                .collect(),
        ))
        .into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to list mail accounts"),
    }
}

async fn domains(caller: Caller) -> Response {
    let rows: Result<Vec<(String, String, Option<String>, bool)>, _> = sqlx::query_as(
        "select id, domain_name, dns_status::text, is_active from mail_domains
         where is_active = true and dns_status = 'verified' and deleted_at is null",
    )
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.into_iter()
                .map(|(id, domain_name, dns_status, is_active)| {
                    json!({
                        "id": id,
                        "domainName": domain_name,
                        "dnsStatus": dns_status,
                        "isActive": is_active,
                    })
                })
                .collect(),
        ))
        .into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to list email domains"),
    }
}

/// Insert a helpdesk registry entry for `email`; its id and account id.
async fn register(
    master: &PgPool,
    workspace_id: &str,
    email: &str,
) -> Result<(String, String), sqlx::Error> {
    let id = generate_id("mreg");
    let account_id = format!("helpdesk_{}", generate_id("hd"));
    sqlx::query(
        "insert into mail_account_registry (id, email, workspace_id, account_id, is_active)
         values ($1, $2, $3, $4, true)",
    )
    .bind(&id)
    .bind(email)
    .bind(workspace_id)
    .bind(&account_id)
    .execute(master)
    .await?;
    Ok((id, account_id))
}

fn already_connected(email: &str) -> Response {
    ApiError::conflict(format!(
        "Email \"{email}\" is already connected to helpdesk."
    ))
    .into_response()
}

async fn connect(
    State(state): State<DeskState>,
    caller: Caller,
    Extension(tenant): Extension<Tenant>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to connect email address";
    let email = match validate(&headers, &body, |issues, fields| {
        let rules = Text {
            format: Some(Format::Email),
            ..Text::default()
        };
        issues
            .text_with(fields, "email", Presence::Required, rules)
            .into_option()
    }) {
        Ok(Some(email)) => email,
        Ok(None) => return ApiError::internal().with_message(message).into_response(),
        Err(refusal) => return refusal.respond(message),
    };
    let email = email.to_lowercase();
    let master = match master_or(&caller, &state, message) {
        Ok(master) => master,
        Err(response) => return response,
    };
    match connect_address(&state, &caller, &master, &tenant.workspace_id, &email).await {
        Ok(response) => response,
        Err(error) => Refusal::Database(error).respond(message),
    }
}

async fn connect_address(
    state: &DeskState,
    caller: &Caller,
    master: &PgPool,
    workspace_id: &str,
    email: &str,
) -> Result<Response, sqlx::Error> {
    // An active WeldMail account with this address.
    let account: Option<(String, Option<Value>)> = sqlx::query_as(
        "select id, metadata from mail_accounts
         where email = $1 and status = 'active' and deleted_at is null limit 1",
    )
    .bind(email)
    .fetch_optional(&caller.db)
    .await?;
    if let Some((id, metadata)) = account {
        let mut meta = match metadata {
            Some(Value::Object(fields)) => fields,
            _ => Map::new(),
        };
        if truthy(meta.get("helpdeskEnabled")) {
            return Ok(already_connected(email));
        }
        meta.insert("helpdeskEnabled".to_owned(), Value::Bool(true));
        sqlx::query("update mail_accounts set metadata = $2::jsonb, updated_at = $3::timestamp where id = $1")
            .bind(&id)
            .bind(Value::Object(meta))
            .bind(now())
            .execute(&caller.db)
            .await?;
        let registered: Option<String> =
            sqlx::query_scalar("select id from mail_account_registry where email = $1 limit 1")
                .bind(email)
                .fetch_optional(master)
                .await?;
        if registered.is_none() {
            register(master, workspace_id, email).await?;
        }
        caller.publish(
            state,
            ev::HELPDESK_EMAIL_CREATED,
            &id,
            &json!({ "id": id, "email": email }),
        );
        return Ok(Created(json!({
            "id": id,
            "email": email,
            "accountId": format!("helpdesk_mail_{id}"),
            "isActive": true,
            "source": "mail_account",
        }))
        .into_response());
    }
    let connected: Option<String> = sqlx::query_scalar(
        "select id from mail_account_registry
         where email = $1 and account_id like 'helpdesk_%' and is_active = true limit 1",
    )
    .bind(email)
    .fetch_optional(master)
    .await?;
    if connected.is_some() {
        return Ok(already_connected(email));
    }
    // `emailLower.split('@')[1]`
    let domain = email.split('@').nth(1).unwrap_or_default();
    let verified: Option<String> = sqlx::query_scalar(
        "select id from mail_domains
         where domain_name = $1 and is_active = true and dns_status = 'verified' and deleted_at is null limit 1",
    )
    .bind(domain)
    .fetch_optional(&caller.db)
    .await?;
    if verified.is_none() {
        return Ok(ApiError::bad_request(format!(
            "Domain \"{domain}\" is not verified. Please verify it in Mail settings first."
        ))
        .into_response());
    }
    let (id, account_id) = register(master, workspace_id, email).await?;
    caller.publish(
        state,
        ev::HELPDESK_EMAIL_CREATED,
        &id,
        &json!({ "id": id, "email": email }),
    );
    Ok(Created(json!({
        "id": id,
        "email": email,
        "accountId": account_id,
        "isActive": true,
    }))
    .into_response())
}

async fn disconnect(
    State(state): State<DeskState>,
    caller: Caller,
    Extension(tenant): Extension<Tenant>,
    Path(id): Path<String>,
) -> Response {
    let message = "Failed to disconnect email address";
    let master = match master_or(&caller, &state, message) {
        Ok(master) => master,
        Err(response) => return response,
    };
    match disconnect_address(&state, &caller, &master, &tenant.workspace_id, &id).await {
        Ok(response) => response,
        Err(error) => Refusal::Database(error).respond(message),
    }
}

async fn disconnect_address(
    state: &DeskState,
    caller: &Caller,
    master: &PgPool,
    workspace_id: &str,
    id: &str,
) -> Result<Response, sqlx::Error> {
    let entry: Option<String> = sqlx::query_scalar(
        "select id from mail_account_registry
         where id = $1 and workspace_id = $2 and account_id like 'helpdesk_%' limit 1",
    )
    .bind(id)
    .bind(workspace_id)
    .fetch_optional(master)
    .await?;
    if entry.is_some() {
        sqlx::query("update mail_account_registry set is_active = false, updated_at = $2::timestamp where id = $1")
            .bind(id)
            .bind(now())
            .execute(master)
            .await?;
        caller.publish(state, ev::HELPDESK_EMAIL_DELETED, id, &json!({ "id": id }));
        return Ok(Data(json!({ "id": id, "isActive": false })).into_response());
    }
    let account: Option<(String, Option<Value>)> = sqlx::query_as(
        "select id, metadata from mail_accounts where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    if let Some((_, metadata)) = account {
        // `{ ...metadata }` without `helpdeskEnabled`: a null blob becomes `{}`.
        let mut meta = match metadata {
            Some(Value::Object(fields)) => fields,
            _ => Map::new(),
        };
        meta.remove("helpdeskEnabled");
        sqlx::query("update mail_accounts set metadata = $2::jsonb, updated_at = $3::timestamp where id = $1")
            .bind(id)
            .bind(Value::Object(meta))
            .bind(now())
            .execute(&caller.db)
            .await?;
        caller.publish(state, ev::HELPDESK_EMAIL_DELETED, id, &json!({ "id": id }));
        return Ok(Data(json!({ "id": id, "isActive": false })).into_response());
    }
    Ok(ApiError::not_found("Email address", Some(id)).into_response())
}
