//! `/api/helpcenter-settings` (`routes/helpcenter-settings/index.ts`): the
//! help center's singleton settings, enabling it on its
//! `{slug}.welddesk.org` subdomain (master `helpcenter_domain_registry`),
//! its custom domains and the WeldHost domains one could attach.
//! Permissions `settings:read|update`.
//!
//! Not served here: attaching (`POST /domains`), verifying
//! (`POST /domains/:id/verify`) and removing (`DELETE /domains/:id`) a
//! custom domain. They write a CNAME through Cloudflare's zone API and
//! register the hostname on the Vercel project that hosts the help center;
//! a Kubernetes deployment has neither, so these routes are left out of its
//! API (the conformance suite excludes them) and its platform hides the
//! custom-domain UI.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Issues, Number, Presence};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::enums::{HostDnsProvider, HostDomainStatus};
use weldsuite_schema::tenant::{dns_zones, domains, helpcenter_domains, helpcenter_settings};

use super::master;
use crate::crud::write_failed;
use crate::tables::HELPCENTER_SETTINGS;
use crate::{Caller, DeskState, Refusal, now, validate};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(read).route_layer(need("settings:read")))
        .route("/", put(save).route_layer(need("settings:update")))
        .route("/enable", post(enable).route_layer(need("settings:update")))
        .route("/domains", get(domains).route_layer(need("settings:read")))
        .route(
            "/host-domains",
            get(host_domains).route_layer(need("settings:read")),
        )
}

/// `updateSettingsSchema`: each field `.optional().nullable()` but the
/// 0/1 toggles, in the schema's order.
fn read_settings(issues: &mut Issues, body: &Map<String, Value>) -> Map<String, Value> {
    enum F {
        Str(Option<usize>),
        Toggle,
        Links,
    }
    const FIELDS: [(&str, F); 18] = [
        ("siteName", F::Str(Some(255))),
        ("logo", F::Str(Some(500))),
        ("logoDark", F::Str(Some(500))),
        ("favicon", F::Str(Some(500))),
        ("primaryColor", F::Str(Some(20))),
        ("accentColor", F::Str(Some(20))),
        ("heroTitle", F::Str(None)),
        ("heroSubtitle", F::Str(None)),
        ("showSearch", F::Toggle),
        ("showCategories", F::Toggle),
        // Sign-in and requests on the help center (helpdesk-widget-api's /api/portal).
        ("portalEnabled", F::Toggle),
        ("metaTitle", F::Str(Some(255))),
        ("metaDescription", F::Str(None)),
        ("ogImage", F::Str(Some(500))),
        ("footerText", F::Str(None)),
        ("socialLinks", F::Links),
        ("customCss", F::Str(None)),
        ("googleAnalyticsId", F::Str(Some(50))),
    ];
    let mut data = Map::new();
    for (key, kind) in &FIELDS {
        let value = match kind {
            F::Str(max) => match issues.text(body, key, Presence::Nullish, None, *max) {
                weldsuite_kit::validation::Field::Set(text) => Some(Value::String(text)),
                weldsuite_kit::validation::Field::Null => Some(Value::Null),
                weldsuite_kit::validation::Field::Absent => None,
            },
            F::Toggle => issues
                .number(
                    body,
                    key,
                    Presence::Optional,
                    Number {
                        min: Some(0.0),
                        max: Some(1.0),
                        ..Number::default()
                    },
                )
                .into_option()
                .and(body.get(*key).cloned()),
            // `z.record(z.string())`
            F::Links => match issues.nested(body, key, Presence::Nullish, |issues, links| {
                let mut out = Map::new();
                for link in links.keys() {
                    if let Some(text) = issues
                        .text(links, link, Presence::Required, None, None)
                        .into_option()
                    {
                        out.insert(link.clone(), Value::String(text));
                    }
                }
                Value::Object(out)
            }) {
                weldsuite_kit::validation::Field::Set(links) => Some(links),
                weldsuite_kit::validation::Field::Null => Some(Value::Null),
                weldsuite_kit::validation::Field::Absent => None,
            },
        };
        if let Some(value) = value {
            data.insert((*key).to_owned(), value);
        }
    }
    data
}

/// The live settings rows, oldest first: the routes use the first.
fn live_settings() -> sea_orm::Select<helpcenter_settings::Entity> {
    helpcenter_settings::Entity::find()
        .filter(helpcenter_settings::Column::DeletedAt.is_null())
        .order_by_asc(helpcenter_settings::Column::CreatedAt)
        .order_by_asc(helpcenter_settings::Column::Id)
}

/// The settings row the routes use: the oldest live one.
async fn settings_id(db: &PgPool) -> Result<Option<String>, DbErr> {
    live_settings()
        .select_only()
        .column(helpcenter_settings::Column::Id)
        .into_tuple()
        .one(&orm(db))
        .await
}

async fn read(caller: Caller) -> Response {
    let row = live_settings().one(&orm(&caller.db)).await;
    match row.and_then(|row| row.map(to_json).transpose()) {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Data(json!({
            "isEnabled": 0,
            "siteName": null,
            "logo": null,
            "logoDark": null,
            "favicon": null,
            "primaryColor": null,
            "accentColor": null,
            "heroTitle": null,
            "heroSubtitle": null,
            "showSearch": 1,
            "showCategories": 1,
            "portalEnabled": 0,
            "metaTitle": null,
            "metaDescription": null,
            "ogImage": null,
            "footerText": null,
            "socialLinks": null,
            "customCss": null,
            "googleAnalyticsId": null,
            "defaultSubdomain": null,
            "customDomain": null,
        }))
        .into_response(),
        Err(error) => Refusal::from(error).respond("Failed to fetch helpcenter settings"),
    }
}

/// `{ id, ...data }`, the event data of a save.
fn with_id(id: &str, data: &Map<String, Value>) -> Value {
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    for (key, value) in data {
        event.insert(key.clone(), value.clone());
    }
    Value::Object(event)
}

async fn save(
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to update helpcenter settings";
    let data = match validate(&headers, &body, read_settings) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    let existing = match settings_id(&caller.db).await {
        Ok(id) => id,
        Err(error) => return Refusal::from(error).respond(message),
    };
    let mut values = HELPCENTER_SETTINGS.values(&data);
    HELPCENTER_SETTINGS.set(&mut values, "updatedAt", json!(now()));
    if let Some(id) = existing {
        let updated = match HELPCENTER_SETTINGS
            .patch(&caller.db, &id, values, false, &["updatedAt"])
            .await
        {
            Ok(row) => row,
            Err(error) => return write_failed(&error, message),
        };
        caller.publish(
            &state,
            ev::HELPCENTER_SETTINGS_UPDATED,
            &id,
            &with_id(&id, &data),
        );
        return Data(updated.unwrap_or(Value::Null)).into_response();
    }
    let id = generate_id("hcs");
    HELPCENTER_SETTINGS.set(&mut values, "id", json!(id));
    let created = match HELPCENTER_SETTINGS
        .insert(&caller.db, values, &["updatedAt"])
        .await
    {
        Ok(row) => row,
        Err(error) => return write_failed(&error, message),
    };
    caller.publish(
        &state,
        ev::HELPCENTER_SETTINGS_UPDATED,
        &id,
        &with_id(&id, &data),
    );
    Created(created).into_response()
}

async fn enable(State(state): State<DeskState>, caller: Caller) -> Response {
    let message = "Failed to enable helpcenter";
    let Some(master) = master(&caller, &state) else {
        return ApiError::internal().with_message(message).into_response();
    };
    match enable_on(&state, &caller, &master).await {
        Ok(response) => response,
        Err(error) => Refusal::from(error).respond(message),
    }
}

#[allow(clippy::single_match_else)] // the route's two branches, as TypeScript writes them
async fn enable_on(state: &DeskState, caller: &Caller, master: &PgPool) -> Result<Response, DbErr> {
    use weldsuite_schema::master::{helpcenter_domain_registry as registry, workspaces};
    let master = orm(master);
    let tenant = orm(&caller.db);
    // `c.get('orgId')`: the Clerk org id of the workspace.
    let workspace: Option<(String, String)> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .column(workspaces::Column::Slug)
        .filter(workspaces::Column::ClerkOrgId.eq(&caller.clerk_org_id))
        .into_tuple()
        .one(&master)
        .await?;
    let Some((workspace_id, slug)) = workspace else {
        return Ok(ApiError::not_found("Workspace", None).into_response());
    };
    let domain = format!("{slug}.welddesk.org");
    let existing: Option<(String, String)> = registry::Entity::find()
        .select_only()
        .column(registry::Column::Id)
        .column(registry::Column::WorkspaceId)
        .filter(registry::Column::Domain.eq(&domain))
        .into_tuple()
        .one(&master)
        .await?;
    let now = utc_now();
    match existing {
        Some((_, owner)) if owner != workspace_id => {
            return Ok(ApiError::conflict("This subdomain is already taken").into_response());
        }
        Some((id, _)) => {
            registry::Entity::update_many()
                .col_expr(registry::Column::IsActive, Expr::value(1))
                .col_expr(registry::Column::UpdatedAt, Expr::value(now))
                .filter(registry::Column::Id.eq(id))
                .exec(&master)
                .await?;
        }
        None => {
            registry::Entity::insert(registry::ActiveModel {
                id: Set(generate_id("hcreg")),
                domain: Set(domain.clone()),
                domain_type: Set("subdomain".to_owned()),
                workspace_id: Set(workspace_id),
                is_verified: Set(1),
                is_active: Set(1),
                verified_at: Set(Some(now)),
                ..Default::default()
            })
            .exec_without_returning(&master)
            .await?;
        }
    }
    match settings_id(&caller.db).await? {
        Some(id) => {
            helpcenter_settings::Entity::update_many()
                .col_expr(helpcenter_settings::Column::IsEnabled, Expr::value(1))
                .col_expr(
                    helpcenter_settings::Column::DefaultSubdomain,
                    Expr::value(&domain),
                )
                .col_expr(helpcenter_settings::Column::UpdatedAt, Expr::value(now))
                .filter(helpcenter_settings::Column::Id.eq(&id))
                .exec(&tenant)
                .await?;
            caller.publish(
                state,
                ev::HELPCENTER_SETTINGS_UPDATED,
                &id,
                &json!({ "id": id, "isEnabled": 1 }),
            );
        }
        None => {
            let id = generate_id("hcs");
            helpcenter_settings::Entity::insert(helpcenter_settings::ActiveModel {
                id: Set(id.clone()),
                is_enabled: Set(Some(1)),
                default_subdomain: Set(Some(domain.clone())),
                hero_title: Set(Some("How can we help?".to_owned())),
                hero_subtitle: Set(Some(
                    "Search our knowledge base or browse categories below.".to_owned(),
                )),
                updated_at: Set(now),
                ..Default::default()
            })
            .exec_without_returning(&tenant)
            .await?;
            caller.publish(
                state,
                ev::HELPCENTER_SETTINGS_UPDATED,
                &id,
                &json!({ "id": id, "isEnabled": 1 }),
            );
        }
    }
    Ok(Created(json!({ "domain": domain, "slug": slug, "enabled": true })).into_response())
}

async fn domains(caller: Caller) -> Response {
    let rows = helpcenter_domains::Entity::find()
        .filter(helpcenter_domains::Column::DeletedAt.is_null())
        .all(&orm(&caller.db))
        .await;
    match rows.and_then(|rows| rows.into_iter().map(to_json).collect::<Result<Vec<_>, _>>()) {
        Ok(rows) => Data(Value::Array(rows)).into_response(),
        Err(error) => Refusal::from(error).respond("Failed to list helpcenter domains"),
    }
}

/// A row as Drizzle's `select()` returns it.
fn to_json(model: impl serde::Serialize) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

async fn host_domains(caller: Caller) -> Response {
    type Row = (
        String,
        String,
        HostDomainStatus,
        Option<String>,
        Option<HostDnsProvider>,
    );
    let zone = domains::Entity::belongs_to(dns_zones::Entity)
        .from(domains::Column::Id)
        .to(dns_zones::Column::DomainId)
        .into();
    let rows: Result<Vec<Row>, _> = domains::Entity::find()
        .select_only()
        .column(domains::Column::Id)
        .column(domains::Column::FullDomain)
        .column(domains::Column::Status)
        .column(dns_zones::Column::ExternalZoneId)
        .column(dns_zones::Column::Provider)
        .join(JoinType::LeftJoin, zone)
        .filter(domains::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.into_iter()
                .filter(|(_, _, status, zone_id, provider)| {
                    *status == HostDomainStatus::Active
                        && *provider == Some(HostDnsProvider::Cloudflare)
                        && zone_id.as_deref().is_some_and(|zone| !zone.is_empty())
                })
                .map(|(id, full_domain, ..)| json!({ "id": id, "fullDomain": full_domain, "hasZone": true }))
                .collect(),
        ))
        .into_response(),
        Err(error) => Refusal::from(error).respond("Failed to list WeldHost domains"),
    }
}
