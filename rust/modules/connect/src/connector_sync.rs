//! Running a connector sync from connect-api: "Sync now"
//! (`POST /api/connectors/connections/:id/sync`, in the background like
//! `c.executionCtx.waitUntil(syncConnection(…))`) and what the other routes
//! start (the first sync of a new connection, a re-read after a Stripe start
//! date change, the internal catch-up). The engine is
//! `weldsuite_connect_domain::sync`.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::CONNECTOR_CONNECTION_SYNC_STARTED;
use weldsuite_connect_domain::connections::get_connection;
use weldsuite_connect_domain::sync::{SyncArgs, SyncEnv, Trigger, sync_connection};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Data};

use crate::{Caller, ConnectState, Overrides, validate};

/// The env a sync reads: the keyring, the Stripe platform key, `STORAGE`,
/// third-party HTTP and the event publisher.
pub(crate) fn sync_env(overrides: &Overrides, state: &ConnectState) -> SyncEnv {
    SyncEnv {
        keyring: weldsuite_connect_domain::connections::keyring(
            overrides.env(state, "DATABASE_ENCRYPTION_KEY"),
            overrides.env(state, "DATABASE_ENCRYPTION_KEY_V2"),
        ),
        stripe_secret_key: overrides.env(state, "STRIPE_SECRET_KEY"),
        storage: overrides.storage(state),
        http: overrides.http(state),
        events: state.events.clone(),
    }
}

/// What a background sync needs, owned.
pub(crate) struct Background {
    pub(crate) db: PgPool,
    pub(crate) env: SyncEnv,
    pub(crate) connection: Value,
    pub(crate) owner_id: String,
    pub(crate) workspace_id: String,
    pub(crate) trigger: Trigger,
    pub(crate) full: bool,
    pub(crate) syncs: Option<Vec<String>>,
}

impl Background {
    pub(crate) async fn run(
        self,
    ) -> Result<Vec<String>, weldsuite_connect_domain::sync::SyncError> {
        sync_connection(&SyncArgs {
            db: &self.db,
            env: &self.env,
            connection: &self.connection,
            owner_id: &self.owner_id,
            workspace_id: &self.workspace_id,
            trigger: self.trigger,
            full: self.full,
            syncs: self.syncs,
        })
        .await
    }
}

/// `c.executionCtx.waitUntil(syncConnection(…).catch(log))`.
pub(crate) fn spawn_sync(state: &ConnectState, job: Background, label: &'static str) {
    state.events.tracker().spawn(async move {
        if let Err(error) = job.run().await {
            tracing::error!(%error, "[app-api/connectors] {label} failed");
        }
    });
}

/// `POST /connections/:id/sync`.
pub(crate) async fn sync_now(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (full, syncs) = match validate(&headers, &body, |issues, b| {
        let full = issues.boolean(b, "full", Presence::Optional).into_option();
        let syncs = issues
            .list(
                b,
                "syncs",
                Presence::Optional,
                None,
                None,
                |issues, item| issues.item_text(item, Text::length(Some(1), None)),
            )
            .into_option();
        (full, syncs)
    }) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Connector request failed"),
    };
    let row = match get_connection(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Connection", Some(&id)).into_response(),
        Err(error) => return crate::internal(&error, "Connector request failed"),
    };
    if row["status"] == "paused" {
        return ApiError::bad_request("Connection is paused").into_response();
    }
    if caller.clerk_org_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    let syncs: Option<Vec<String>> = syncs;
    let full = full.unwrap_or(false);
    spawn_sync(
        &state,
        Background {
            db: caller.db.clone(),
            env: sync_env(&caller.overrides, &state),
            connection: row.clone(),
            owner_id: caller.user_id.clone(),
            workspace_id: caller.clerk_org_id.clone(),
            trigger: Trigger::Manual,
            full,
            syncs: syncs.clone(),
        },
        "sync",
    );
    let triggered = syncs.clone().map_or_else(
        || row.get("enabled_syncs").cloned().unwrap_or(Value::Null),
        |list| json!(list),
    );
    caller.publish(
        &state,
        CONNECTOR_CONNECTION_SYNC_STARTED,
        &id,
        &json!({
            "id": row["id"],
            "provider": row["provider"],
            "syncs": triggered,
            "full": full,
        }),
    );
    let triggered = if triggered.is_null() {
        json!([])
    } else {
        triggered
    };
    Data(json!({ "triggered": triggered, "full": full })).into_response()
}
