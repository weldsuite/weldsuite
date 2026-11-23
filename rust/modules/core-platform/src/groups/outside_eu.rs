//! `/api/outside-eu-services` (Rust only; ADR OPS-026): which services
//! outside the EU the workspace has switched on.
//!
//! There is no TypeScript twin: Global keeps calling these services as it
//! always has, so app-api does not mount the route, and the platform hides
//! the page there (`outside-eu-services` is in `GLOBAL_UNAVAILABLE_FEATURES`)
//! and on a self-hosted install, whose operator decides
//! (`crate::edition` lists it as unavailable unless `EDITION=eu`).
//!
//! | Route | Permission | |
//! |---|---|---|
//! | `GET /` | any member | every service with its state, `enforced`, `canManage`, and the integration codes each service covers |
//! | `PUT /:service` | `settings:manage` | `{ enabled, acknowledgedOutsideEu }`: switch one on (with the acknowledgement) or off; answers the service |
//!
//! The list is `weldsuite_outside_eu::SERVICES`; the state is the
//! workspace's `workspace_settings.features.outsideEu`
//! (`weldsuite_outside_eu::store`). Switching on needs
//! `acknowledgedOutsideEu: true` (400 `OUTSIDE_EU_NOT_ACKNOWLEDGED`, as in
//! `/api/ai-settings`). A change is recorded as `workspace_settings.updated`
//! (`field: "outsideEu"`), as the SSO settings are, which the audit log
//! keeps. The backend's call paths check the same switch
//! (`weldsuite_outside_eu::require`), so switching a service off stops its
//! calls at once.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use http::{HeaderMap, StatusCode};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::WORKSPACE_SETTINGS_UPDATED;
use weldsuite_db::orm;
use weldsuite_kit::{ApiError, Data};
use weldsuite_outside_eu::catalog::INTEGRATION_CODES;
use weldsuite_outside_eu::store::{self, Change, OptIn, OptIns, Via};
use weldsuite_outside_eu::{Enforcement, NOT_ACKNOWLEDGED_CODE, SERVICES, Service, ServiceId};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::workspace_members as members;

use crate::{Caller, CorePlatformState, PlatformError, answer, now, validate};

/// The permission that switches a service on or off: workspace admins and
/// owners.
pub(crate) const MANAGE: &str = "settings:manage";

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CorePlatformState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/", get(list).route_layer(gate.resolve()))
        .route(
            "/{service}",
            put(switch).route_layer(gate.require([MANAGE])),
        )
}

/// A member's name or email by user id, for "switched on by".
async fn member_names(caller: &Caller, opt_ins: &OptIns) -> HashMap<String, String> {
    let ids: Vec<String> = opt_ins
        .values()
        .filter_map(|opt_in| opt_in.enabled_by.clone().or(opt_in.disabled_by.clone()))
        .collect();
    if ids.is_empty() {
        return HashMap::new();
    }
    let rows: Vec<(String, Option<String>, Option<String>)> = members::Entity::find()
        .select_only()
        .columns([
            members::Column::UserId,
            members::Column::Name,
            members::Column::Email,
        ])
        .filter(members::Column::UserId.is_in(ids))
        .filter(members::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(&caller.db))
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "outside-eu: could not read the members' names");
            Vec::new()
        });
    rows.into_iter()
        .filter_map(|(id, name, email)| {
            let shown = name
                .filter(|n| !n.trim().is_empty())
                .or(email.filter(|e| !e.trim().is_empty()))?;
            Some((id, shown))
        })
        .collect()
}

/// One service as the settings page shows it.
fn service_view(
    service: &Service,
    opt_in: Option<&OptIn>,
    names: &HashMap<String, String>,
) -> Value {
    let opt_in = opt_in.cloned().unwrap_or_default();
    let name_of = |id: &Option<String>| id.as_ref().and_then(|id| names.get(id)).cloned();
    json!({
        "id": service.id,
        "name": service.name,
        "company": service.company,
        "country": service.country,
        "data": service.data,
        "account": service.account,
        "uses": service.uses,
        "enabled": opt_in.enabled,
        "enabledBy": opt_in.enabled_by,
        "enabledByName": name_of(&opt_in.enabled_by),
        "enabledAt": opt_in.enabled_at,
        "acknowledgedAt": opt_in.acknowledged_at,
        "via": opt_in.via,
        "disabledBy": opt_in.disabled_by,
        "disabledByName": name_of(&opt_in.disabled_by),
        "disabledAt": opt_in.disabled_at,
    })
}

/// The integration codes the platform labels, by service.
fn integration_map() -> Map<String, Value> {
    INTEGRATION_CODES
        .iter()
        .filter_map(|code| {
            ServiceId::for_integration(code).map(|id| ((*code).to_owned(), json!(id)))
        })
        .collect()
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(State(_state): State<CorePlatformState>, caller: Caller) -> Response {
    answer(
        async {
            let opt_ins = store::read(&caller.db)
                .await
                .map_err(|error| PlatformError::internal("Failed to read the services", error))?;
            let names = member_names(&caller, &opt_ins).await;
            let services: Vec<Value> = SERVICES
                .iter()
                .map(|service| service_view(service, opt_ins.get(&service.id), &names))
                .collect();
            Ok(Data(json!({
                "enforced": Enforcement::current().is_enforced(),
                "canManage": caller.can(MANAGE),
                "settingsPath": weldsuite_outside_eu::SETTINGS_PATH,
                "services": services,
                "integrations": integration_map(),
            }))
            .into_response())
        }
        .await,
    )
}

// ── PUT /:service ───────────────────────────────────────────────────────────

/// `{ enabled: boolean, acknowledgedOutsideEu?: boolean }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SwitchInput {
    enabled: bool,
    acknowledged: bool,
}

fn parse_switch(fields: &Map<String, Value>) -> Result<SwitchInput, ApiError> {
    let enabled = match fields.get("enabled") {
        Some(Value::Bool(enabled)) => *enabled,
        _ => return Err(ApiError::bad_request("enabled: expected a boolean")),
    };
    let acknowledged = match fields.get("acknowledgedOutsideEu") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(ack)) => *ack,
        Some(_) => {
            return Err(ApiError::bad_request(
                "acknowledgedOutsideEu: expected a boolean",
            ));
        }
    };
    if enabled && !acknowledged {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            NOT_ACKNOWLEDGED_CODE,
            "This service runs outside the EU: confirm it with acknowledgedOutsideEu",
        ));
    }
    Ok(SwitchInput {
        enabled,
        acknowledged,
    })
}

async fn switch(
    State(state): State<CorePlatformState>,
    caller: Caller,
    Path(service): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let service = ServiceId::parse(&service)
                .ok_or_else(|| ApiError::not_found("Service", Some(&service)))?;
            let input = validate(&headers, &body, |_, fields| parse_switch(fields))??;
            let at = now();
            let (before, after) = store::set(
                &caller.db,
                &Change {
                    service,
                    enabled: input.enabled,
                    actor: &caller.user_id,
                    via: Via::Admin,
                    acknowledged: input.acknowledged,
                    reason: None,
                    at: &at,
                },
            )
            .await
            .map_err(|error| PlatformError::internal("Failed to switch the service", error))?;
            if before != after {
                caller.publish(
                    &state,
                    WORKSPACE_SETTINGS_UPDATED,
                    &caller.workspace_id,
                    &changed_event(&caller.workspace_id, service, &after),
                );
            }
            let opt_ins: OptIns = BTreeMap::from([(service, after)]);
            let names = member_names(&caller, &opt_ins).await;
            Ok(Data(service_view(
                service.service(),
                opt_ins.get(&service),
                &names,
            ))
            .into_response())
        }
        .await,
    )
}

/// The `workspace_settings.updated` payload of a switch.
fn changed_event(workspace_id: &str, service: ServiceId, after: &OptIn) -> Value {
    json!({
        "id": workspace_id,
        "field": "outsideEu",
        "change": if after.enabled { "enabled" } else { "disabled" },
        "service": service,
        "serviceName": service.service().name,
        "enabled": after.enabled,
        "acknowledgedAt": after.acknowledged_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(value: &Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn switching_on_needs_the_acknowledgement() {
        let refused = parse_switch(&fields(&json!({ "enabled": true }))).expect_err("no ack");
        assert_eq!(refused.code(), NOT_ACKNOWLEDGED_CODE);
        let refused = parse_switch(&fields(
            &json!({ "enabled": true, "acknowledgedOutsideEu": false }),
        ))
        .expect_err("ack false");
        assert_eq!(refused.code(), NOT_ACKNOWLEDGED_CODE);
        assert_eq!(
            parse_switch(&fields(
                &json!({ "enabled": true, "acknowledgedOutsideEu": true })
            )),
            Ok(SwitchInput {
                enabled: true,
                acknowledged: true
            })
        );
        // Switching off needs none.
        assert_eq!(
            parse_switch(&fields(&json!({ "enabled": false }))),
            Ok(SwitchInput {
                enabled: false,
                acknowledged: false
            })
        );
        assert!(parse_switch(&fields(&json!({ "enabled": "yes" }))).is_err());
        assert!(
            parse_switch(&fields(
                &json!({ "enabled": true, "acknowledgedOutsideEu": "yes" })
            ))
            .is_err()
        );
    }

    #[test]
    fn every_integration_code_points_at_a_listed_service() {
        let map = integration_map();
        assert_eq!(map["gmail"], json!("google"));
        assert_eq!(map["azure_devops"], json!("microsoft"));
        for id in map.values() {
            let id = id.as_str().and_then(ServiceId::parse).expect("a service");
            assert!(SERVICES.iter().any(|s| s.id == id));
        }
    }

    #[test]
    fn the_event_names_the_service_and_the_change() {
        let on = OptIn {
            enabled: true,
            acknowledged_at: Some("2026-11-20T10:00:00.000Z".to_owned()),
            ..OptIn::default()
        };
        let event = changed_event("ws_1", ServiceId::Telnyx, &on);
        assert_eq!(event["field"], "outsideEu");
        assert_eq!(event["change"], "enabled");
        assert_eq!(event["service"], "telnyx");
        let off = changed_event("ws_1", ServiceId::Telnyx, &OptIn::default());
        assert_eq!(off["change"], "disabled");
    }
}
