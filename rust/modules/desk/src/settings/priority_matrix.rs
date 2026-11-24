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
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_db::{orm, utc_now};
use weldsuite_desk_domain::priority_matrix::{self, LEVELS};
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::helpdesk_settings;

use crate::{Caller, DeskState, Refusal, validate};

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
        Err(error) => Refusal::from(error).respond("Failed to fetch the priority matrix"),
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
        Err(error) => Refusal::from(error).respond(message),
    }
}

/// Put the matrix into the live settings row's `tickets` (merged), or a new
/// row with only it; the row's id.
async fn write(caller: &Caller, matrix: &Value) -> Result<String, DbErr> {
    let db = orm(&caller.db);
    let existing: Option<(String, Option<Value>)> = helpdesk_settings::Entity::find()
        .select_only()
        .column(helpdesk_settings::Column::Id)
        .column(helpdesk_settings::Column::Tickets)
        .filter(helpdesk_settings::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&db)
        .await?;
    let now = utc_now();
    let Some((id, tickets)) = existing else {
        let id = generate_id("hds");
        helpdesk_settings::Entity::insert(helpdesk_settings::ActiveModel {
            id: Set(id.clone()),
            tickets: Set(Some(json!({ "priorityMatrix": matrix }))),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        })
        .exec_without_returning(&db)
        .await?;
        return Ok(id);
    };
    let mut tickets = match tickets {
        Some(Value::Object(fields)) => fields,
        _ => Map::new(),
    };
    tickets.insert("priorityMatrix".to_owned(), matrix.clone());
    helpdesk_settings::Entity::update_many()
        .col_expr(
            helpdesk_settings::Column::Tickets,
            Expr::value(Value::Object(tickets)),
        )
        .col_expr(helpdesk_settings::Column::UpdatedAt, Expr::value(now))
        .filter(helpdesk_settings::Column::Id.eq(&id))
        .exec(&db)
        .await?;
    Ok(id)
}
