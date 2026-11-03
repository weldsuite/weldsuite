//! `BOOKS_INTERNAL` in process: books-api's internal bank-feed routes
//! (`routes/bank-connections/internal.ts`, mounted on its `BooksInternal`
//! entrypoint), answered by `weldsuite-books-domain` on the workspace's own
//! database, as the route answers:
//!
//! - `POST /internal/bank-connections/events`: verified provider events from
//!   the webhook receiver; applied, and a sync when one asks for it.
//! - `POST /internal/bank-connections/:connectionId/sync`: one sync (the due
//!   sweep).
//!
//! The workspace is the `X-Workspace-Id` (its Clerk org id). A sync that ran
//! publishes `bank_connection:synced` as the system.

use std::sync::Arc;

use serde_json::{Value, json};
use weldsuite_books_domain::bank_feeds::events::{FeedEvent, apply_events};
use weldsuite_books_domain::bank_feeds::sync::{SyncOutcome, sync_connection};
use weldsuite_books_domain::bank_feeds::{FeedConfig, FeedContext, ServiceError};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_db::{Keyring, PgPool, Tenant};
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, EventSource};
use weldsuite_ports::{BoxFuture, OutboundHttp};

use crate::binding::{BindingRequest, BindingResponse, ServiceBinding};

/// A workspace's tenant, by its Clerk org id or `workspaces.id`.
pub type TenantResolver =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<Tenant, String>> + Send + Sync>;

/// WeldBooks' bank-feed internal routes, in this process.
#[derive(Clone)]
pub struct InProcessBooks {
    pub tenants: TenantResolver,
    pub keyring: Keyring,
    /// The master database, for `bank_feed_connection_index`.
    pub master: Option<PgPool>,
    /// The bank-feed provider settings (`PLAID_*`, …) by name.
    pub env: Arc<std::collections::HashMap<String, String>>,
    pub http: Option<OutboundHttp>,
    pub ponto_http: Option<OutboundHttp>,
    pub events: EntityEventPublisher,
}

fn answer(status: u16, body: &Value) -> BindingResponse {
    BindingResponse {
        status,
        body: body.to_string(),
    }
}

fn error(status: u16, code: &str, message: &str) -> BindingResponse {
    answer(
        status,
        &json!({ "error": { "code": code, "message": message } }),
    )
}

/// `eventsSchema`'s checks: the shape the webhook receiver sends.
fn events_of(body: &Value) -> Option<(String, Vec<FeedEvent>)> {
    let text = |value: Option<&Value>, max: usize| {
        value
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.encode_utf16().count() <= max)
            .map(str::to_owned)
    };
    let connection_id = text(body.get("connectionId"), 30)?;
    text(body.get("provider"), 30)?;
    text(body.get("providerConnectionId"), 255)?;
    let events = body.get("events").and_then(Value::as_array)?;
    if events.is_empty() || events.len() > 50 {
        return None;
    }
    let kinds = [
        "sync_available",
        "reauth_required",
        "expiring",
        "revoked",
        "disconnected",
        "error",
    ];
    let mut parsed = Vec::with_capacity(events.len());
    for event in events {
        let kind = event.get("type").and_then(Value::as_str)?;
        if !kinds.contains(&kind) {
            return None;
        }
        let optional_text = |name: &str| match event.get(name) {
            None | Some(Value::Null) => Some(None),
            Some(Value::String(s)) => Some(Some(s.clone())),
            Some(_) => None,
        };
        let account_ids = match event.get("accountIds") {
            None => None,
            Some(Value::Array(ids)) => Some(
                ids.iter()
                    .map(|id| id.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()?,
            ),
            Some(_) => return None,
        };
        parsed.push(FeedEvent {
            kind: kind.to_owned(),
            provider_connection_id: text(event.get("providerConnectionId"), 255)?,
            account_ids,
            expires_at: optional_text("expiresAt")?,
            message: optional_text("message")?,
        });
    }
    Some((connection_id, parsed))
}

impl InProcessBooks {
    /// `createInternalFeedContext(c)`: none without a workspace, or for a
    /// suspended one.
    async fn context(&self, key: &str) -> Option<(FeedContext, Tenant)> {
        if key.is_empty() {
            return None;
        }
        let tenant = match (self.tenants)(key.to_owned()).await {
            Ok(tenant) if !tenant.suspended => tenant,
            Ok(_) => return None,
            Err(error) => {
                tracing::error!("[bank-feeds/internal] tenant resolution failed: {error}");
                return None;
            }
        };
        let ctx = FeedContext {
            db: tenant.db.clone(),
            keyring: self.keyring.clone(),
            master: self.master.clone(),
            config: FeedConfig::from_env(|name| self.env.get(name).cloned()),
            http: self.http.clone(),
            ponto_http: self.ponto_http.clone(),
            clerk_org_id: key.to_owned(),
            auto_reconcile: true,
        };
        Some((ctx, tenant))
    }

    /// `publishSynced`: a sync that ran, as the system.
    fn publish_synced(
        &self,
        tenant: &Tenant,
        key: &str,
        connection_id: &str,
        outcome: &SyncOutcome,
    ) {
        if outcome.skipped.is_some() || outcome.error.is_some() {
            return;
        }
        let context = EventContext::from_ids(&tenant.workspace_id, Some(key), "system")
            .with_source(EventSource::System);
        self.events.publish(
            &context,
            EntityEvent::new(
                ev::BANK_CONNECTION_SYNCED,
                connection_id,
                json!({
                    "id": connection_id,
                    "status": outcome.status,
                    "added": outcome.added,
                    "updated": outcome.updated,
                    "removed": outcome.removed,
                }),
            ),
        );
    }

    async fn events(&self, request: &BindingRequest) -> BindingResponse {
        let body = request
            .body
            .as_deref()
            .and_then(|body| serde_json::from_str::<Value>(body).ok())
            .unwrap_or(Value::Null);
        let Some((connection_id, events)) = events_of(&body) else {
            return error(400, "BAD_REQUEST", "Invalid events payload");
        };
        let Some((ctx, tenant)) = self.context(&request.workspace_key).await else {
            return error(
                400,
                "BAD_REQUEST",
                "X-Workspace-Id is missing or does not match an active workspace",
            );
        };
        match apply_events(&ctx, &connection_id, &events).await {
            Ok(outcome) => {
                if let Some(sync) = &outcome.outcome {
                    self.publish_synced(&tenant, &request.workspace_key, &connection_id, sync);
                }
                answer(200, &json!({ "data": outcome.to_json() }))
            }
            Err(failure) => {
                tracing::error!(
                    "[books-api/bank-connections/internal] events failed: {}",
                    describe(&failure)
                );
                error(500, "INTERNAL_ERROR", "Failed to apply bank feed events")
            }
        }
    }

    async fn sync(&self, request: &BindingRequest, connection_id: &str) -> BindingResponse {
        let Some((ctx, tenant)) = self.context(&request.workspace_key).await else {
            return error(
                400,
                "BAD_REQUEST",
                "X-Workspace-Id is missing or does not match an active workspace",
            );
        };
        match sync_connection(&ctx, connection_id, false).await {
            Ok(outcome) if outcome.skipped == Some("not_found") => error(
                404,
                "NOT_FOUND",
                &format!("Bank connection '{connection_id}' not found"),
            ),
            Ok(outcome) => {
                self.publish_synced(&tenant, &request.workspace_key, connection_id, &outcome);
                answer(200, &json!({ "data": outcome.to_json() }))
            }
            Err(failure) => {
                tracing::error!(
                    "[books-api/bank-connections/internal] sync failed: {}",
                    describe(&failure)
                );
                error(500, "INTERNAL_ERROR", "Failed to sync the bank connection")
            }
        }
    }
}

fn describe(error: &ServiceError) -> String {
    match error {
        ServiceError::Service(code, message) => format!("{code}: {message}"),
        ServiceError::Database(error) => error.to_string(),
        ServiceError::Other(message) => message.clone(),
    }
}

impl ServiceBinding for InProcessBooks {
    fn fetch(&self, request: BindingRequest) -> BoxFuture<'_, Result<BindingResponse, String>> {
        Box::pin(async move {
            const PREFIX: &str = "/internal/bank-connections/";
            let rest = request.path.strip_prefix(PREFIX);
            let response = match (request.method.as_str(), rest) {
                ("POST", Some("events")) => self.events(&request).await,
                ("POST", Some(rest)) => match rest.strip_suffix("/sync") {
                    Some(id) if !id.is_empty() && !id.contains('/') => {
                        let id = weldsuite_kit::cursor::decode_uri_component(id)
                            .unwrap_or_else(|| id.to_owned());
                        self.sync(&request, &id).await
                    }
                    _ => error(404, "NOT_FOUND", "Not Found"),
                },
                _ => error(404, "NOT_FOUND", "Not Found"),
            };
            Ok(response)
        })
    }
}
