//! `/api/helpdesk-settings/priority-matrix`
//! (`routes/helpdesk-settings/priority-matrix.ts`): WeldDesk's priority
//! matrix, ITIL impact × urgency → priority, kept in
//! `helpdesk_settings.tickets.priorityMatrix` (the rest of `tickets` is left
//! as it is). GET answers the default grid, off, until it is saved; PUT
//! replaces the whole setting. Permissions `settings:read|update`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_desk_domain::priority_matrix::{self, LEVELS};
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Caller, DeskState, Refusal, now, validate};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/priority-matrix",
            get(read).route_layer(need("settings:read")),
        )
        .route(
            "/priority-matrix",
            put(save).route_layer(need("settings:update")),
        )
}

async fn read(caller: Caller) -> Response {
    match priority_matrix::read(&caller.db).await {
        Ok(matrix) => Data(matrix).into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to fetch the priority matrix"),
    }
}

const PRIORITIES: &[&str] = &["low", "medium", "high", "urgent"];

/// `deskPriorityMatrixSchema`: `{ enabled: boolean, matrix: { low|medium|high:
/// { low|medium|high: priority } } }`.
fn matrix_schema(issues: &mut Issues, body: &Map<String, Value>) -> Value {
    let enabled = issues.boolean(body, "enabled", Presence::Required);
    let _ = issues.nested(body, "matrix", Presence::Required, |issues, grid| {
        for impact in LEVELS {
            let _ = issues.nested(grid, impact, Presence::Required, |issues, row| {
                for urgency in LEVELS {
                    let _ = issues.choice(row, urgency, Presence::Required, PRIORITIES);
                }
            });
        }
    });
    let mut value = body.clone();
    value.insert("enabled".to_owned(), json!(enabled.into_option()));
    Value::Object(value)
}

async fn save(
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to update the priority matrix";
    let input = match validate(&headers, &body, matrix_schema) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(message),
    };
    let matrix = priority_matrix::normalize(&input);
    match write(&caller, &matrix).await {
        Ok(id) => {
            caller.publish(
                &state,
                ev::HELPDESK_SETTINGS_UPDATED,
                &id,
                &json!({ "tickets": { "priorityMatrix": matrix } }),
            );
            Data(matrix).into_response()
        }
        Err(error) => Refusal::Database(error).respond(message),
    }
}

/// Put the matrix into the live settings row's `tickets` (merged), or a new
/// row with only it; the row's id.
async fn write(caller: &Caller, matrix: &Value) -> Result<String, sqlx::Error> {
    let existing: Option<(String, Option<Value>)> = sqlx::query_as(
        "select id, tickets from helpdesk_settings where deleted_at is null limit 1",
    )
    .fetch_optional(&caller.db)
    .await?;
    let now = now();
    match existing {
        Some((id, tickets)) => {
            let mut tickets = match tickets {
                Some(Value::Object(fields)) => fields,
                _ => Map::new(),
            };
            tickets.insert("priorityMatrix".to_owned(), matrix.clone());
            sqlx::query(
                "update helpdesk_settings set tickets = $2::jsonb, updated_at = $3::timestamp where id = $1",
            )
            .bind(&id)
            .bind(Value::Object(tickets))
            .bind(&now)
            .execute(&caller.db)
            .await?;
            Ok(id)
        }
        None => {
            let id = generate_id("hds");
            sqlx::query(
                "insert into helpdesk_settings (id, tickets, created_at, updated_at)
                 values ($1, $2::jsonb, $3::timestamp, $3::timestamp)",
            )
            .bind(&id)
            .bind(json!({ "priorityMatrix": matrix }))
            .bind(&now)
            .execute(&caller.db)
            .await?;
            Ok(id)
        }
    }
}
