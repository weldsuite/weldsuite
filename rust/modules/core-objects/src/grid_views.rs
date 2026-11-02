//! `/api/grid-views/:gridName`: a member's column visibility and widths for
//! one data grid (`routes/grid-views`). Reads and writes need only
//! `general:read`; the shared grids (`customer`) keep one workspace-wide row
//! under a sentinel user id, which any member may write.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::Path;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::GENERAL_READ;
use weldsuite_kit::validation::{Issues, Number, Presence};
use weldsuite_kit::{Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Answer, Caller, CoreObjectsState, answer, now, validate};

const WORKSPACE_SHARED_GRIDS: [&str; 1] = ["customer"];
const WORKSPACE_GRID_USER_ID: &str = "__workspace__";

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreObjectsState>
where
    Q: PermissionQueries + 'static,
{
    Router::new().route(
        "/{grid_name}",
        get(read)
            .put(write)
            .route_layer(gate.require([GENERAL_READ])),
    )
}

fn grid_user<'a>(grid_name: &str, user_id: &'a str) -> &'a str {
    if WORKSPACE_SHARED_GRIDS.contains(&grid_name) {
        WORKSPACE_GRID_USER_ID
    } else {
        user_id
    }
}

/// `view.x || {}`: a stored `null` reads as an empty map.
fn or_empty(value: Option<Value>) -> Value {
    match value {
        Some(Value::Null) | None => json!({}),
        Some(value) => value,
    }
}

async fn read(caller: Caller, Path(grid_name): Path<String>) -> Response {
    let user = grid_user(&grid_name, &caller.user_id);
    let result: Answer = async {
        let view: Option<(Option<Value>, Option<Value>)> = sqlx::query_as(
            "select column_visibility, column_widths from grid_views where user_id = $1 and grid_name = $2 limit 1",
        )
        .bind(user)
        .bind(&grid_name)
        .fetch_optional(&caller.db)
        .await?;
        let data = view.map_or(Value::Null, |(visibility, widths)| {
            json!({ "columnVisibility": or_empty(visibility), "columnWidths": or_empty(widths) })
        });
        Ok(Data(data).into_response())
    }
    .await;
    answer(result, "Failed to fetch grid view")
}

/// `z.record(z.boolean())` / `z.record(z.number())`: every entry checked at
/// its own path.
fn record_of(issues: &mut Issues, body: &Map<String, Value>, key: &str, numbers: bool) -> Value {
    issues
        .nested(body, key, Presence::Required, |issues, entries| {
            for entry in entries.keys() {
                if numbers {
                    issues.number(entries, entry, Presence::Required, Number::default());
                } else {
                    issues.boolean(entries, entry, Presence::Required);
                }
            }
            Value::Object(entries.clone())
        })
        .into_option()
        .unwrap_or_default()
}

async fn write(
    caller: Caller,
    Path(grid_name): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (visibility, widths) = match validate(&headers, &body, |issues, fields| {
        (
            record_of(issues, fields, "columnVisibility", false),
            record_of(issues, fields, "columnWidths", true),
        )
    }) {
        Ok(input) => input,
        Err(invalid) => return *invalid,
    };
    let user = grid_user(&grid_name, &caller.user_id);
    let result: Answer = async {
        let db = &caller.db;
        let existing: Option<String> =
            sqlx::query_scalar("select id from grid_views where user_id = $1 and grid_name = $2 limit 1")
                .bind(user)
                .bind(&grid_name)
                .fetch_optional(db)
                .await?;
        let stored_widths = crate::js::whole_numbers(&widths);
        if let Some(id) = existing {
            sqlx::query(
                "update grid_views set column_visibility = $2, column_widths = $3, updated_at = $4::timestamptz
                  where id = $1",
            )
            .bind(&id)
            .bind(&visibility)
            .bind(&stored_widths)
            .bind(now())
            .execute(db)
            .await?;
        } else {
            sqlx::query(
                "insert into grid_views (id, user_id, grid_name, column_visibility, column_widths)
                 values ($1, $2, $3, $4, $5)",
            )
            .bind(generate_id("gv"))
            .bind(user)
            .bind(&grid_name)
            .bind(&visibility)
            .bind(&stored_widths)
            .execute(db)
            .await?;
        }
        Ok(Data(json!({ "columnVisibility": visibility, "columnWidths": widths })).into_response())
    }
    .await;
    answer(result, "Failed to update grid view")
}
