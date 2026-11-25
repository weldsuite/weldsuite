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
use sea_orm::sea_query::Expr;
use sea_orm::sea_query::extension::postgres as pg;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events as ev;
use weldsuite_db::{PgPool, Tenant, orm, utc_now};
use weldsuite_kit::validation::{Format, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::master::mail_account_registry as registry;
use weldsuite_schema::tenant::enums::{MailAccountStatus, MailDomainDnsStatus, MailProvider};
use weldsuite_schema::tenant::{mail_accounts, mail_domains};

use super::{master, truthy};
use crate::{Caller, DeskState, Refusal, validate};

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

/// A `timestamp` as the route's `Date` serializes: `toISOString()`.
fn js_date(at: PrimitiveDateTime) -> Value {
    weldsuite_schema::js::timestamp::serialize(&at, serde_json::value::Serializer)
        .unwrap_or(Value::Null)
}

/// `metadata->>'helpdeskEnabled' = 'true'`.
fn helpdesk_enabled() -> Expr {
    sea_orm::ExprTrait::eq(
        pg::PgExpr::cast_json_field(
            Expr::col(mail_accounts::Column::Metadata),
            "helpdeskEnabled",
        ),
        "true",
    )
}

/// `getMasterDb(c.env)` inside the route's `try`: without one the route
/// answers its 500.
#[allow(clippy::result_large_err)] // the response is the route's answer
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
    #[allow(clippy::type_complexity)] // the registry row's columns
    let entries: Result<Vec<(String, String, String, bool, PrimitiveDateTime)>, _> =
        registry::Entity::find()
            .select_only()
            .columns([
                registry::Column::Id,
                registry::Column::Email,
                registry::Column::AccountId,
                registry::Column::IsActive,
                registry::Column::CreatedAt,
            ])
            .filter(registry::Column::WorkspaceId.eq(&tenant.workspace_id))
            .filter(registry::Column::AccountId.like("helpdesk_%"))
            .into_tuple()
            .all(&orm(&master))
            .await;
    let entries = match entries {
        Ok(rows) => rows,
        Err(error) => return Refusal::from(error).respond(message),
    };
    let accounts: Result<Vec<(String, String, PrimitiveDateTime)>, _> =
        mail_accounts::Entity::find()
            .select_only()
            .columns([
                mail_accounts::Column::Id,
                mail_accounts::Column::Email,
                mail_accounts::Column::CreatedAt,
            ])
            .filter(mail_accounts::Column::Status.eq(MailAccountStatus::Active))
            .filter(mail_accounts::Column::DeletedAt.is_null())
            .filter(helpdesk_enabled())
            .into_tuple()
            .all(&orm(&caller.db))
            .await;
    let accounts = match accounts {
        Ok(rows) => rows,
        Err(error) => return Refusal::from(error).respond(message),
    };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (id, email, account_id, is_active, created_at) in entries {
        if seen.insert(email.clone()) {
            out.push(json!({
                "id": id,
                "email": email,
                "accountId": account_id,
                "isActive": is_active,
                "createdAt": js_date(created_at),
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
                "createdAt": js_date(created_at),
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
        MailProvider,
        MailAccountStatus,
        Option<Value>,
    );
    let rows: Result<Vec<Row>, _> = mail_accounts::Entity::find()
        .select_only()
        .columns([
            mail_accounts::Column::Id,
            mail_accounts::Column::Name,
            mail_accounts::Column::Email,
            mail_accounts::Column::DisplayName,
            mail_accounts::Column::Provider,
            mail_accounts::Column::Status,
            mail_accounts::Column::Metadata,
        ])
        .filter(mail_accounts::Column::Status.eq(MailAccountStatus::Active))
        .filter(mail_accounts::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(&caller.db))
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
        Err(error) => Refusal::from(error).respond("Failed to list mail accounts"),
    }
}

async fn domains(caller: Caller) -> Response {
    #[allow(clippy::type_complexity)] // the domain row's columns
    let rows: Result<Vec<(String, String, Option<MailDomainDnsStatus>, bool)>, _> =
        mail_domains::Entity::find()
            .select_only()
            .columns([
                mail_domains::Column::Id,
                mail_domains::Column::DomainName,
                mail_domains::Column::DnsStatus,
                mail_domains::Column::IsActive,
            ])
            .filter(mail_domains::Column::IsActive.eq(true))
            .filter(mail_domains::Column::DnsStatus.eq(MailDomainDnsStatus::Verified))
            .filter(mail_domains::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&orm(&caller.db))
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
        Err(error) => Refusal::from(error).respond("Failed to list email domains"),
    }
}

/// The registry entry with `email` (`limit 1`); `helpdesk_only` keeps the
/// active `helpdesk_…` accounts.
async fn registry_entry(
    master: &PgPool,
    email: &str,
    helpdesk_only: bool,
) -> Result<Option<String>, DbErr> {
    let mut find = registry::Entity::find()
        .select_only()
        .column(registry::Column::Id)
        .filter(registry::Column::Email.eq(email));
    if helpdesk_only {
        find = find
            .filter(registry::Column::AccountId.like("helpdesk_%"))
            .filter(registry::Column::IsActive.eq(true));
    }
    find.into_tuple().one(&orm(master)).await
}

/// `update(mailAccounts).set({ metadata, updatedAt: new Date() })` of the
/// account `id`.
async fn set_metadata(db: &PgPool, id: &str, metadata: Map<String, Value>) -> Result<(), DbErr> {
    mail_accounts::Entity::update_many()
        .col_expr(
            mail_accounts::Column::Metadata,
            Expr::value(Value::Object(metadata)),
        )
        .col_expr(mail_accounts::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(mail_accounts::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// Insert a helpdesk registry entry for `email`; its id and account id.
async fn register(
    master: &PgPool,
    workspace_id: &str,
    email: &str,
) -> Result<(String, String), DbErr> {
    let id = generate_id("mreg");
    let account_id = format!("helpdesk_{}", generate_id("hd"));
    registry::Entity::insert(registry::ActiveModel {
        id: Set(id.clone()),
        email: Set(email.to_owned()),
        workspace_id: Set(Some(workspace_id.to_owned())),
        account_id: Set(account_id.clone()),
        is_active: Set(true),
        ..Default::default()
    })
    .exec_without_returning(&orm(master))
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
        Err(error) => Refusal::from(error).respond(message),
    }
}

async fn connect_address(
    state: &DeskState,
    caller: &Caller,
    master: &PgPool,
    workspace_id: &str,
    email: &str,
) -> Result<Response, DbErr> {
    // An active WeldMail account with this address.
    let account: Option<(String, Option<Value>)> = mail_accounts::Entity::find()
        .select_only()
        .columns([mail_accounts::Column::Id, mail_accounts::Column::Metadata])
        .filter(mail_accounts::Column::Email.eq(email))
        .filter(mail_accounts::Column::Status.eq(MailAccountStatus::Active))
        .filter(mail_accounts::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
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
        set_metadata(&caller.db, &id, meta).await?;
        if registry_entry(master, email, false).await?.is_none() {
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
    if registry_entry(master, email, true).await?.is_some() {
        return Ok(already_connected(email));
    }
    // `emailLower.split('@')[1]`
    let domain = email.split('@').nth(1).unwrap_or_default();
    let verified: Option<String> = mail_domains::Entity::find()
        .select_only()
        .column(mail_domains::Column::Id)
        .filter(mail_domains::Column::DomainName.eq(domain))
        .filter(mail_domains::Column::IsActive.eq(true))
        .filter(mail_domains::Column::DnsStatus.eq(MailDomainDnsStatus::Verified))
        .filter(mail_domains::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
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
        Err(error) => Refusal::from(error).respond(message),
    }
}

async fn disconnect_address(
    state: &DeskState,
    caller: &Caller,
    master: &PgPool,
    workspace_id: &str,
    id: &str,
) -> Result<Response, DbErr> {
    let master = orm(master);
    let entry: Option<String> = registry::Entity::find()
        .select_only()
        .column(registry::Column::Id)
        .filter(registry::Column::Id.eq(id))
        .filter(registry::Column::WorkspaceId.eq(workspace_id))
        .filter(registry::Column::AccountId.like("helpdesk_%"))
        .into_tuple()
        .one(&master)
        .await?;
    if entry.is_some() {
        registry::Entity::update_many()
            .col_expr(registry::Column::IsActive, Expr::value(false))
            .col_expr(registry::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(registry::Column::Id.eq(id))
            .exec(&master)
            .await?;
        caller.publish(state, ev::HELPDESK_EMAIL_DELETED, id, &json!({ "id": id }));
        return Ok(Data(json!({ "id": id, "isActive": false })).into_response());
    }
    let account: Option<(String, Option<Value>)> = mail_accounts::Entity::find()
        .select_only()
        .columns([mail_accounts::Column::Id, mail_accounts::Column::Metadata])
        .filter(mail_accounts::Column::Id.eq(id))
        .filter(mail_accounts::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
        .await?;
    if let Some((_, metadata)) = account {
        // `{ ...metadata }` without `helpdeskEnabled`: a null blob becomes `{}`.
        let mut meta = match metadata {
            Some(Value::Object(fields)) => fields,
            _ => Map::new(),
        };
        meta.remove("helpdeskEnabled");
        set_metadata(&caller.db, id, meta).await?;
        caller.publish(state, ev::HELPDESK_EMAIL_DELETED, id, &json!({ "id": id }));
        return Ok(Data(json!({ "id": id, "isActive": false })).into_response());
    }
    Ok(ApiError::not_found("Email address", Some(id)).into_response())
}
