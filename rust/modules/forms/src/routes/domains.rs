//! A workspace's custom domains for its form links ([`crate::domains`]), at
//! `/api/forms/domains`. EU and self-hosted only: Global has no such route
//! (the platform hides the section there).
//!
//! ```text
//! GET    /domains/config        what this install offers
//! GET    /domains               the workspace's domains, with the DNS records to add
//! POST   /domains               { hostname }
//! POST   /domains/:id/refresh   checked now (the sweep also checks)
//! POST   /domains/:id/primary   the domain form links use
//! PATCH  /domains/:id           { homeFormPublicId: string | null }: the form at `/`
//! DELETE /domains/:id
//! ```

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    FORM_DOMAIN_CREATED, FORM_DOMAIN_DELETED, FORM_DOMAIN_UPDATED,
};
use weldsuite_catalogs::permission_keys::{FORMS_MANAGE, FORMS_READ};
use weldsuite_custom_domains::{CertManagerHosts, normalize_host};
use weldsuite_db::{is_unique_violation, orm, utc_now};
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::master::{form_link_registry, forms_custom_domains as domains};

use super::Member;
use crate::FormsState;
use crate::common::{FormsResult, answer, forms_error, forms_error_with, not_found};
use crate::domains::{
    MAX_DOMAINS_PER_WORKSPACE, check, event_data, find, forget, is_host_name, list, new_token,
    portal_url, present,
};
use crate::input;

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<FormsState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/domains/config", get(config).route_layer(need(FORMS_READ)))
        .route("/domains", get(index).route_layer(need(FORMS_READ)))
        .route("/domains", post(create).route_layer(need(FORMS_MANAGE)))
        .route(
            "/domains/{id}/refresh",
            post(refresh).route_layer(need(FORMS_MANAGE)),
        )
        .route(
            "/domains/{id}/primary",
            post(make_primary).route_layer(need(FORMS_MANAGE)),
        )
        .route(
            "/domains/{id}",
            axum::routing::patch(update)
                .delete(remove)
                .route_layer(need(FORMS_MANAGE)),
        )
}

/// cert-manager, or a 503 saying custom domains are not offered here.
fn cert(state: &FormsState) -> FormsResult<&CertManagerHosts> {
    state.domains.as_deref().ok_or_else(|| {
        forms_error(
            503,
            "FEATURE_UNAVAILABLE",
            "Custom domains aren't available on this install.",
        )
    })
}

/// The domain a member's route is about, 404 when it isn't the workspace's.
async fn load(member: &Member, id: &str) -> FormsResult<domains::Model> {
    find(member.ctx.master()?, &member.ctx.workspace_id, id)
        .await?
        .ok_or_else(|| not_found("Domain"))
}

async fn forget_all(member: &Member, hosts: &[String]) {
    forget(&member.ctx.svc.cache, &member.ctx.workspace_id, hosts).await;
}

async fn config(State(state): State<FormsState>, member: Member) -> Response {
    let target = state.domains.as_deref().map(CertManagerHosts::target);
    Data(json!({
        "available": target.is_some(),
        "cnameTarget": target.map(|t| t.host.clone()),
        "apexAddresses": target.map(|t| t.apex_addresses.clone()).unwrap_or_default(),
        "portalUrl": portal_url(&member.ctx.svc.env),
        "maxDomains": MAX_DOMAINS_PER_WORKSPACE,
    }))
    .into_response()
}

async fn index(State(state): State<FormsState>, member: Member) -> Response {
    answer(
        async {
            let rows = list(member.ctx.master()?, &member.ctx.workspace_id).await?;
            let cert = state.domains.as_deref();
            Ok(Data(Value::Array(
                rows.iter().map(|row| present(cert, row)).collect(),
            ))
            .into_response())
        }
        .await,
    )
}

/// `{ hostname }`: a host name, lower-cased, without scheme or trailing dot.
fn create_input(issues: &mut Issues, body: &Map<String, Value>) -> String {
    let raw = issues
        .text(body, "hostname", Presence::Required, Some(1), Some(253))
        .into_option()
        .unwrap_or_default();
    let host = normalize_host(&raw);
    if !raw.is_empty() && !is_host_name(&host) {
        issues.custom("hostname", "A domain name such as forms.example.com");
    }
    host
}

async fn create(
    State(state): State<FormsState>,
    member: Member,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let hostname = input::json(&headers, &body, create_input)?;
            let cert = cert(&state)?;
            if cert.is_install_host(&hostname)
                || crate::domains::is_portal_host(&member.ctx.svc.env, &hostname)
            {
                return Err(forms_error_with(
                    400,
                    "HOST_RESERVED",
                    "This domain belongs to the install; choose another.",
                    json!({ "field": "hostname" }),
                ));
            }
            let master = member.ctx.master()?.clone();
            let db = orm(&master);
            let count = domains::Entity::find()
                .filter(domains::Column::WorkspaceId.eq(member.ctx.workspace_id.clone()))
                .count(&db)
                .await?;
            if count >= MAX_DOMAINS_PER_WORKSPACE {
                return Err(forms_error(
                    409,
                    "TOO_MANY_DOMAINS",
                    format!("A workspace has at most {MAX_DOMAINS_PER_WORKSPACE} form domains."),
                ));
            }
            let now = utc_now();
            let row = domains::ActiveModel {
                id: Set(generate_id("fdom")),
                created_at: Set(now),
                updated_at: Set(now),
                hostname: Set(hostname.clone()),
                workspace_id: Set(member.ctx.workspace_id.clone()),
                is_primary: Set(false),
                status: Set("pending".to_owned()),
                ssl_status: Set(None),
                verification_token: Set(new_token()),
                last_error: Set(None),
                last_checked_at: Set(None),
                verified_at: Set(None),
                home_form_public_id: Set(None),
                created_by_user_id: Set(Some(member.user_id.clone())),
            };
            let row = match domains::Entity::insert(row).exec_with_returning(&db).await {
                Ok(row) => row,
                Err(error) if is_unique_violation(&error) => {
                    return Err(forms_error_with(
                        409,
                        "HOST_TAKEN",
                        "This domain is already in use.",
                        json!({ "hostname": hostname }),
                    ));
                }
                Err(error) => return Err(error.into()),
            };
            member.publish(FORM_DOMAIN_CREATED, &row.id, &event_data(&row));
            let (row, event) = check(&master, Some(cert), row).await;
            if let Some(event) = event {
                member.publish(event, &row.id, &event_data(&row));
            }
            forget_all(&member, std::slice::from_ref(&row.hostname)).await;
            Ok(Created(present(Some(cert), &row)).into_response())
        }
        .await,
    )
}

async fn refresh(
    State(state): State<FormsState>,
    member: Member,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let row = load(&member, &id).await?;
            let cert = cert(&state)?;
            let (row, event) = check(member.ctx.master()?, Some(cert), row).await;
            forget_all(&member, std::slice::from_ref(&row.hostname)).await;
            if let Some(event) = event {
                member.publish(event, &row.id, &event_data(&row));
            }
            Ok(Data(present(Some(cert), &row)).into_response())
        }
        .await,
    )
}

async fn make_primary(
    State(state): State<FormsState>,
    member: Member,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let row = load(&member, &id).await?;
            if row.status != "active" {
                return Err(forms_error(
                    409,
                    "DOMAIN_NOT_ACTIVE",
                    "Only an active domain can be the primary one.",
                ));
            }
            let db = orm(member.ctx.master()?);
            domains::Entity::update_many()
                .set(domains::ActiveModel {
                    is_primary: Set(false),
                    ..Default::default()
                })
                .filter(domains::Column::WorkspaceId.eq(member.ctx.workspace_id.clone()))
                .filter(domains::Column::Id.ne(row.id.clone()))
                .exec(&db)
                .await?;
            let row = domains::Entity::update(domains::ActiveModel {
                id: Set(row.id.clone()),
                is_primary: Set(true),
                updated_at: Set(utc_now()),
                ..Default::default()
            })
            .exec(&db)
            .await?;
            forget_all(&member, std::slice::from_ref(&row.hostname)).await;
            member.publish(FORM_DOMAIN_UPDATED, &row.id, &event_data(&row));
            Ok(Data(present(state.domains.as_deref(), &row)).into_response())
        }
        .await,
    )
}

/// `{ homeFormPublicId: string | null }`.
fn update_input(issues: &mut Issues, body: &Map<String, Value>) -> Option<String> {
    issues
        .text(
            body,
            "homeFormPublicId",
            Presence::Nullable,
            Some(1),
            Some(20),
        )
        .into_option()
}

async fn update(
    State(state): State<FormsState>,
    member: Member,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let home = input::json(&headers, &body, update_input)?;
            let row = load(&member, &id).await?;
            let db = orm(member.ctx.master()?);
            // Only a form of this workspace can be a home form.
            if let Some(public_id) = &home {
                let owned = form_link_registry::Entity::find()
                    .filter(form_link_registry::Column::PublicId.eq(public_id.clone()))
                    .filter(
                        form_link_registry::Column::WorkspaceId.eq(member.ctx.workspace_id.clone()),
                    )
                    .one(&db)
                    .await?
                    .is_some();
                if !owned {
                    return Err(forms_error_with(
                        400,
                        "VALIDATION_ERROR",
                        "Choose a published form of this workspace.",
                        json!({ "field": "homeFormPublicId" }),
                    ));
                }
            }
            let row = domains::Entity::update(domains::ActiveModel {
                id: Set(row.id.clone()),
                home_form_public_id: Set(home),
                updated_at: Set(utc_now()),
                ..Default::default()
            })
            .exec(&db)
            .await?;
            forget_all(&member, std::slice::from_ref(&row.hostname)).await;
            member.publish(FORM_DOMAIN_UPDATED, &row.id, &event_data(&row));
            Ok(Data(present(state.domains.as_deref(), &row)).into_response())
        }
        .await,
    )
}

async fn remove(
    State(state): State<FormsState>,
    member: Member,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let row = load(&member, &id).await?;
            // The route first, so the host stops serving before the row goes.
            if let Some(cert) = state.domains.as_deref()
                && let Err(error) = cert.remove(&row.hostname).await
            {
                tracing::error!(%error, host = %row.hostname, "forms: removing a domain's route failed");
                return Err(forms_error(
                    502,
                    "DOMAIN_REMOVE_FAILED",
                    "The domain's certificate and route could not be removed; try again.",
                ));
            }
            let db = orm(member.ctx.master()?);
            domains::Entity::delete_by_id(row.id.clone())
                .exec(&db)
                .await?;
            if row.is_primary {
                // The oldest active domain left takes over, so links keep a custom domain.
                let next = domains::Entity::find()
                    .filter(domains::Column::WorkspaceId.eq(member.ctx.workspace_id.clone()))
                    .filter(domains::Column::Status.eq("active"))
                    .order_by_asc(domains::Column::CreatedAt)
                    .one(&db)
                    .await?;
                if let Some(next) = next {
                    let next = domains::Entity::update(domains::ActiveModel {
                        id: Set(next.id),
                        is_primary: Set(true),
                        updated_at: Set(utc_now()),
                        ..Default::default()
                    })
                    .exec(&db)
                    .await?;
                    member.publish(FORM_DOMAIN_UPDATED, &next.id, &event_data(&next));
                }
            }
            forget_all(&member, std::slice::from_ref(&row.hostname)).await;
            member.publish(FORM_DOMAIN_DELETED, &row.id, &event_data(&row));
            Ok(NoContent.into_response())
        }
        .await,
    )
}
