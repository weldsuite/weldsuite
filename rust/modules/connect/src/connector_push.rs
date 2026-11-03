//! The WeldBooks → Moneybird push from connect-api: a pass in the background
//! (`c.executionCtx.waitUntil(pushToMoneybird(…))`), and another one asked
//! of the cron while a backlog remains (`scheduleMoneybirdPushBacklog`).

use serde_json::Value;
use weldsuite_connect_domain::moneybird_push::{push_to_moneybird, schedule_backlog};
use weldsuite_connect_domain::sync::SyncEnv;
use weldsuite_db::PgPool;

use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use weldsuite_catalogs::entity_events::CONNECTOR_CONNECTION_SYNC_STARTED;
use weldsuite_kit::{ApiError, Data};

use crate::{Caller, ConnectState};

/// `POST /connections/:id/moneybird/push`: "Send now", failed invoices
/// retried at once.
pub(crate) async fn push_now(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let row = match weldsuite_connect_domain::connections::get_connection(&caller.db, &id).await {
        Ok(Some(row)) if row["provider"] == "moneybird" => row,
        Ok(_) => return ApiError::not_found("Moneybird connection", Some(&id)).into_response(),
        Err(error) => return crate::internal(&error, "Connector request failed"),
    };
    if !weldsuite_connect_domain::js::truthy(&row["settings"]["moneybirdPush"]["enabled"]) {
        return ApiError::bad_request("Turn on sending to Moneybird first").into_response();
    }
    spawn_push(
        &state,
        caller.db.clone(),
        crate::connector_sync::sync_env_for(&caller.overrides, &state, &caller.workspace_id),
        row.clone(),
        true,
    );
    caller.publish(
        &state,
        CONNECTOR_CONNECTION_SYNC_STARTED,
        &id,
        &json!({ "id": id, "provider": row["provider"], "syncs": ["moneybird-push"], "full": false }),
    );
    Data(json!({ "started": true })).into_response()
}

/// A push pass on the tracker; a pass that leaves work schedules the next.
#[allow(clippy::needless_pass_by_value)] // moved into the task
pub(crate) fn spawn_push(
    state: &ConnectState,
    db: PgPool,
    env: SyncEnv,
    connection: Value,
    force: bool,
) {
    let trigger = "manual";
    state.events.tracker().spawn(async move {
        match push_to_moneybird(&db, &env, &connection, trigger, force).await {
            Ok(result) if result.remaining => schedule_backlog(&env).await,
            Ok(_) => {}
            Err(error) => tracing::error!(%error, "[connect-api/moneybird-push] push failed"),
        }
    });
}
