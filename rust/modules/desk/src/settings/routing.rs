//! `/api/desk/routing` (`routes/desk-routing/index.ts`): the WeldDesk
//! routing rules, kept in `helpdesk_settings.automation.deskRouting`
//! (`weldsuite_desk_domain::routing`, `@weldsuite/db/lib/desk-routing`).
//!
//!   GET  /   the ordered rules            (settings:read)
//!   PUT  /   replace the ordered rules    (settings:update)

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_desk_domain::routing;
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Caller, DeskState, Refusal, validate};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(read).route_layer(need("settings:read")))
        .route("/", put(save).route_layer(need("settings:update")))
}

/// `DESK_CHANNELS`.
const CHANNELS: [&str; 7] = ["messenger", "email", "phone", "whatsapp", "sms", "api", "portal"];
/// `DESK_ROUTING_PRIORITIES`.
const PRIORITIES: [&str; 4] = ["low", "medium", "high", "urgent"];

async fn read(caller: Caller) -> Response {
    match routing::settings(&caller.db).await {
        Ok((_, rules)) => Data(routing::rules_json(&rules)).into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to load routing rules"),
    }
}

/// `z.array(z.string().min(min).max(max)).max(most).optional()` at `key`.
fn texts(issues: &mut Issues, body: &Map<String, Value>, key: &str, max: usize, most: usize) {
    issues.list(body, key, Presence::Optional, None, Some(most), |issues, item| {
        issues.item_text(item, Text::length(Some(1), Some(max)))
    });
}

/// `z.array(z.enum(options)).max(most).optional()` at `key`.
fn choices(issues: &mut Issues, body: &Map<String, Value>, key: &str, options: &[&str], most: usize) {
    issues.list(body, key, Presence::Optional, None, Some(most), |issues, item| {
        issues.item_choice(item, options)
    });
}

/// `deskRoutingRuleSchema`, field by field in the schema's order.
fn rule_schema(issues: &mut Issues, item: &Value) -> Option<()> {
    let rule = issues.object(item)?;
    issues.text(rule, "id", Presence::Required, Some(1), Some(64));
    issues.text(rule, "name", Presence::Required, Some(1), Some(120));
    issues.boolean(rule, "enabled", Presence::Required);
    issues.nested(rule, "conditions", Presence::Required, |issues, conditions| {
        choices(issues, conditions, "channels", &CHANNELS, 10);
        texts(issues, conditions, "ticketTypeIds", 30, 50);
        texts(issues, conditions, "tags", 50, 50);
        choices(issues, conditions, "priorities", &PRIORITIES, 4);
        texts(issues, conditions, "departmentIds", 30, 50);
    });
    issues.nested(rule, "actions", Presence::Required, |issues, actions| {
        issues.text(actions, "departmentId", Presence::Nullish, Some(1), Some(30));
        issues.text(actions, "assigneeId", Presence::Nullish, Some(1), Some(255));
        issues.choice(actions, "priority", Presence::Nullish, &PRIORITIES);
        texts(issues, actions, "addTags", 50, 20);
    });
    Some(())
}

async fn save(State(state): State<DeskState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let message = "Failed to save routing rules";
    let valid = validate(&headers, &body, |issues, fields| {
        issues
            .list(fields, "rules", Presence::Required, None, Some(100), rule_schema)
            .into_option()
            .map(|_| Value::Object(fields.clone()))
    });
    let data = match valid {
        Ok(Some(data)) => data,
        Ok(None) => return weldsuite_kit::ApiError::internal().with_message(message).into_response(),
        Err(refusal) => return refusal.respond(message),
    };
    let rules = match routing::save(&caller.db, &data).await {
        Ok(rules) => rules,
        Err(error) => return Refusal::Database(error).respond(message),
    };
    let answer = routing::rules_json(&rules);
    match routing::settings(&caller.db).await {
        Ok((Some(id), _)) => caller.publish(
            &state,
            ev::HELPDESK_SETTINGS_UPDATED,
            &id,
            &json!({ "deskRouting": answer }),
        ),
        Ok((None, _)) => {}
        Err(error) => return Refusal::Database(error).respond(message),
    }
    Data(answer).into_response()
}
