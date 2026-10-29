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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Issues, Number, Presence};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::master;
use crate::crud::write_failed;
use crate::tables::{HELPCENTER_DOMAINS, HELPCENTER_SETTINGS};
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

/// `updateSettingsSchema`: each field `.optional().nullable()` but the two
/// 0/1 toggles, in the schema's order.
fn read_settings(issues: &mut Issues, body: &Map<String, Value>) -> Map<String, Value> {
    enum F {
        Str(Option<usize>),
        Toggle,
        Links,
    }
    const FIELDS: [(&str, F); 17] = [
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

/// The settings row the routes use: the oldest live one.
async fn settings_id(db: &PgPool) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select id from helpcenter_settings where deleted_at is null
         order by created_at asc, id asc limit 1",
    )
    .fetch_optional(db)
    .await
}

async fn read(caller: Caller) -> Response {
    let row: Result<Option<Value>, _> = sqlx::query_scalar(
        "select to_jsonb(t) from helpcenter_settings t where t.deleted_at is null
         order by t.created_at asc, t.id asc limit 1",
    )
    .fetch_optional(&caller.db)
    .await;
    match row {
        Ok(Some(row)) => Data(HELPCENTER_SETTINGS.js(row)).into_response(),
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
        Err(error) => Refusal::Database(error).respond("Failed to fetch helpcenter settings"),
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
        Err(error) => return Refusal::Database(error).respond(message),
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
        Err(error) => Refusal::Database(error).respond(message),
    }
}

async fn enable_on(
    state: &DeskState,
    caller: &Caller,
    master: &PgPool,
) -> Result<Response, sqlx::Error> {
    // `c.get('orgId')`: the Clerk org id of the workspace.
    let workspace: Option<(String, String)> =
        sqlx::query_as("select id, slug from workspaces where clerk_org_id = $1 limit 1")
            .bind(&caller.clerk_org_id)
            .fetch_optional(master)
            .await?;
    let Some((workspace_id, slug)) = workspace else {
        return Ok(ApiError::not_found("Workspace", None).into_response());
    };
    let domain = format!("{slug}.welddesk.org");
    let existing: Option<(String, String)> = sqlx::query_as(
        "select id, workspace_id from helpcenter_domain_registry where domain = $1 limit 1",
    )
    .bind(&domain)
    .fetch_optional(master)
    .await?;
    let now = now();
    match existing {
        Some((_, owner)) if owner != workspace_id => {
            return Ok(ApiError::conflict("This subdomain is already taken").into_response());
        }
        Some((id, _)) => {
            sqlx::query(
                "update helpcenter_domain_registry set is_active = 1, updated_at = $2::timestamp where id = $1",
            )
            .bind(&id)
            .bind(&now)
            .execute(master)
            .await?;
        }
        None => {
            sqlx::query(
                "insert into helpcenter_domain_registry (id, domain, domain_type, workspace_id, is_verified, is_active, verified_at)
                 values ($1, $2, 'subdomain', $3, 1, 1, $4::timestamp)",
            )
            .bind(generate_id("hcreg"))
            .bind(&domain)
            .bind(&workspace_id)
            .bind(&now)
            .execute(master)
            .await?;
        }
    }
    match settings_id(&caller.db).await? {
        Some(id) => {
            sqlx::query(
                "update helpcenter_settings set is_enabled = 1, default_subdomain = $2, updated_at = $3::timestamp where id = $1",
            )
            .bind(&id)
            .bind(&domain)
            .bind(&now)
            .execute(&caller.db)
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
            sqlx::query(
                "insert into helpcenter_settings (id, is_enabled, default_subdomain, hero_title, hero_subtitle, updated_at)
                 values ($1, 1, $2, 'How can we help?', 'Search our knowledge base or browse categories below.', $3::timestamp)",
            )
            .bind(&id)
            .bind(&domain)
            .bind(&now)
            .execute(&caller.db)
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
    let rows: Result<Vec<Value>, _> = sqlx::query_scalar(
        "select to_jsonb(t) from helpcenter_domains t where t.deleted_at is null",
    )
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.into_iter()
                .map(|row| HELPCENTER_DOMAINS.js(row))
                .collect(),
        ))
        .into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to list helpcenter domains"),
    }
}

async fn host_domains(caller: Caller) -> Response {
    type Row = (String, String, String, Option<String>, Option<String>);
    let rows: Result<Vec<Row>, _> = sqlx::query_as(
        "select d.id, d.full_domain, d.status::text, z.external_zone_id, z.provider::text
         from domains d left join dns_zones z on z.domain_id = d.id
         where d.deleted_at is null",
    )
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.into_iter()
                .filter(|(_, _, status, zone_id, provider)| {
                    status == "active"
                        && provider.as_deref() == Some("cloudflare")
                        && zone_id.as_deref().is_some_and(|zone| !zone.is_empty())
                })
                .map(|(id, full_domain, ..)| json!({ "id": id, "fullDomain": full_domain, "hasZone": true }))
                .collect(),
        ))
        .into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to list WeldHost domains"),
    }
}
