//! The `moneybird-sync` consumer (ADR INT-013): WeldBooks changes reach
//! Moneybird within seconds. It is a durable consumer of its own on the
//! entity-event hub (Rust only, not in the TypeScript subscriber registry),
//! so its retries and dead letters are its own.
//!
//! An event only rings the bell. Imports and crons (`source: system`) are
//! skipped; for anything else the producing workspace is opened and every
//! Moneybird connection that sends an object (or the Stripe push) gets one
//! push pass, which reads what changed from the database. Events of one
//! workspace in a batch share one pass.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::Value;
use weldsuite_connect_domain::moneybird_push::{
    connections_by_provider, push_to_moneybird, schedule_backlog, settings_of, two_way,
};
use weldsuite_connect_domain::sync::{DueIndex, SyncEnv};
use weldsuite_db::{Keyring, PgPool};
use weldsuite_events::EntityEventPublisher;
use weldsuite_ports::{BatchHandler, BoxFuture, Delivery, Disposition, OutboundHttp};
use weldsuite_subscribers::{HubEvent, Tenants};

/// The durable consumer's name.
pub const MONEYBIRD_SYNC_CONSUMER: &str = "moneybird-sync";

/// The WeldBooks events that can mean something changed for Moneybird.
pub const MONEYBIRD_SYNC_TOPICS: &[&str] = &[
    "invoice:*",
    "bill:*",
    "payment:*",
    "accounting_contact:*",
    "company:*",
    "person:*",
    "product:*",
];

/// The subscriber.
pub struct MoneybirdSyncSubscriber {
    tenants: Arc<dyn Tenants>,
    /// The env a pass runs with; its due index row is set per workspace.
    env: SyncEnv,
    /// The master database, for the push backlog's due index.
    master: Option<PgPool>,
}

impl std::fmt::Debug for MoneybirdSyncSubscriber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MoneybirdSyncSubscriber")
            .field("master", &self.master.is_some())
            .finish_non_exhaustive()
    }
}

/// Whether an event asks for a pass: not an import's or a cron's own.
fn rings(event: &HubEvent) -> bool {
    event.metadata.source.as_deref() != Some("system") && !event.metadata.workspace_id.is_empty()
}

/// Whether a connection sends anything to Moneybird.
fn sends(connection: &Value) -> bool {
    let stripe_push = settings_of(connection)
        .and_then(|s| s.get("enabled").cloned())
        .is_some_and(|enabled| weldsuite_connect_domain::js::truthy(&enabled));
    stripe_push || !two_way::outbound_objects(connection).is_empty()
}

impl MoneybirdSyncSubscriber {
    /// `stripe_secret_key`: `STRIPE_SECRET_KEY`, which OAuth Stripe
    /// connections read with (a pass may import a conflict's other side).
    pub fn new(
        tenants: Arc<dyn Tenants>,
        keyring: Keyring,
        http: Option<OutboundHttp>,
        events: EntityEventPublisher,
        stripe_secret_key: Option<String>,
        master: Option<PgPool>,
    ) -> Self {
        Self {
            tenants,
            env: SyncEnv {
                keyring,
                stripe_secret_key,
                storage: None,
                http,
                events,
                due: None,
            },
            master,
        }
    }

    /// One pass per sending Moneybird connection of the workspace.
    async fn pass(&self, reference: &str) -> Result<(), String> {
        let tenant = self
            .tenants
            .tenant(reference)
            .await
            .map_err(|error| format!("cannot resolve the workspace: {error}"))?;
        let connections = connections_by_provider(&tenant.db, "moneybird")
            .await
            .map_err(|error| error.to_string())?;
        let mut env = self.env.clone();
        env.due = self.master.clone().map(|master| DueIndex {
            master,
            workspace_id: tenant.workspace_id.clone(),
        });
        for connection in connections.iter().filter(|c| sends(c)) {
            match push_to_moneybird(&tenant.db, &env, connection, "event", false).await {
                Ok(result) if result.remaining => schedule_backlog(&env).await,
                Ok(_) => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(())
    }
}

impl BatchHandler for MoneybirdSyncSubscriber {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>> {
        Box::pin(async move {
            // The workspace each delivery rings for (`None`: nothing to do).
            let rung: Vec<Option<String>> = batch
                .iter()
                .map(|delivery| match HubEvent::parse(&delivery.payload) {
                    Ok(event) if rings(&event) => Some(event.metadata.workspace_id),
                    Ok(_) => None,
                    Err(error) => {
                        tracing::error!(%error, "[MoneybirdSync] not an entity event; dropped");
                        None
                    }
                })
                .collect();
            let workspaces: BTreeSet<&String> = rung.iter().flatten().collect();
            let mut failed: Vec<(&String, String)> = Vec::new();
            for workspace in workspaces {
                if let Err(error) = self.pass(workspace).await {
                    tracing::warn!(workspace, %error, "[MoneybirdSync] pass failed; retried");
                    failed.push((workspace, error));
                }
            }
            rung.iter()
                .map(|workspace| {
                    match workspace
                        .as_ref()
                        .and_then(|w| failed.iter().find(|(f, _)| *f == w))
                    {
                        Some((_, error)) => Disposition::retry(error.clone()),
                        None => Disposition::Ack,
                    }
                })
                .collect()
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    fn event(source: &str, workspace: &str) -> HubEvent {
        let payload = json!({
            "id": "evt_0000000000000001",
            "eventType": "invoice:updated",
            "entityType": "invoice",
            "entityId": "inv_1",
            "action": "updated",
            "data": { "id": "inv_1" },
            "metadata": { "workspaceId": workspace, "timestamp": "2026-11-22T10:00:00.000Z", "source": source },
        });
        HubEvent::parse(payload.to_string().as_bytes()).unwrap()
    }

    #[test]
    fn imports_and_crons_do_not_ring() {
        assert!(rings(&event("api", "ws_1")));
        assert!(rings(&event("web", "ws_1")));
        assert!(!rings(&event("system", "ws_1")));
        assert!(!rings(&event("api", "")));
    }

    #[test]
    fn only_sending_connections_get_a_pass() {
        let mut connection = json!({
            "provider": "moneybird", "direction": "inbound", "object_sync_directions": null,
            "enabled_syncs": null, "settings": {},
        });
        assert!(!sends(&connection));
        connection["object_sync_directions"] = json!({ "contacts": "bidirectional" });
        assert!(sends(&connection));
        connection["object_sync_directions"] = Value::Null;
        connection["settings"] = json!({ "moneybirdPush": { "enabled": true } });
        assert!(sends(&connection));
    }
}
