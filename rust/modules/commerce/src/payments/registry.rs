//! The master `commerce_connection_registry`: how Mollie's webhook, which
//! has no session, finds the workspace of a connection
//! (`/webhooks/commerce/mollie/:connectionId`). The tenant's
//! `commerce_payment_connections` row stays the source of truth.
//!
//! The pattern of the storefront key registry
//! (`channels/registry.rs`): the master is written first, and undone when the
//! tenant write fails, so the registry never names a connection the tenant
//! does not have, and a removed connection stops answering webhooks at once.

use http::StatusCode;
use sqlx::PgPool;
use weldsuite_kit::ApiError;

use crate::{Caller, Refusal};

/// What the registry held about a connection before a change, to put back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Before {
    /// No row.
    Absent,
    /// A live row.
    Live,
    /// A removed row.
    Removed,
}

pub(super) struct Registry<'a> {
    pool: &'a PgPool,
    workspace_id: &'a str,
}

impl<'a> Registry<'a> {
    pub(super) fn new(pool: &'a PgPool, workspace_id: &'a str) -> Self {
        Self { pool, workspace_id }
    }

    /// The registry of the caller's workspace; 503 when the server has none.
    pub(super) fn of(caller: &'a Caller) -> Result<Self, Refusal> {
        match &caller.registry {
            Some(pool) => Ok(Self::new(pool, &caller.workspace_id)),
            None => Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "CONNECTION_REGISTRY_UNAVAILABLE",
                "Payment connections are not available on this server",
            )
            .into()),
        }
    }

    pub(super) async fn before(&self, id: &str) -> Result<Before, sqlx::Error> {
        let row: Option<bool> = sqlx::query_scalar(
            "select deleted_at is not null from commerce_connection_registry \
             where id = $1 and workspace_id = $2",
        )
        .bind(id)
        .bind(self.workspace_id)
        .fetch_optional(self.pool)
        .await?;
        Ok(match row {
            None => Before::Absent,
            Some(false) => Before::Live,
            Some(true) => Before::Removed,
        })
    }

    /// The connection is registered (again).
    pub(super) async fn register(&self, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "insert into commerce_connection_registry (id, workspace_id, provider) \
             values ($1, $2, 'mollie') \
             on conflict (id) do update set deleted_at = null \
             where commerce_connection_registry.workspace_id = excluded.workspace_id",
        )
        .bind(id)
        .bind(self.workspace_id)
        .execute(self.pool)
        .await?;
        Ok(())
    }

    /// The connection no longer answers webhooks.
    pub(super) async fn remove(&self, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "update commerce_connection_registry set deleted_at = coalesce(deleted_at, now() at time zone 'utc') \
             where id = $1 and workspace_id = $2",
        )
        .bind(id)
        .bind(self.workspace_id)
        .execute(self.pool)
        .await?;
        Ok(())
    }

    /// Undoes a change: the row as it was.
    pub(super) async fn restore(&self, id: &str, before: Before) -> Result<(), sqlx::Error> {
        match before {
            Before::Absent => {
                sqlx::query(
                    "delete from commerce_connection_registry where id = $1 and workspace_id = $2",
                )
                .bind(id)
                .bind(self.workspace_id)
                .execute(self.pool)
                .await?;
                Ok(())
            }
            Before::Live => self.register(id).await,
            Before::Removed => self.remove(id).await,
        }
    }
}

/// The workspace (`ws_…`) of a live connection, for the webhook.
pub(super) async fn workspace_of(
    master: &PgPool,
    connection_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select workspace_id from commerce_connection_registry \
         where id = $1 and provider = 'mollie' and deleted_at is null",
    )
    .bind(connection_id)
    .fetch_optional(master)
    .await
}
