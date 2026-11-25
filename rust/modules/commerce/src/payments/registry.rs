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
use sea_orm::sea_query::{Alias, Expr, Func, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, Insert, QueryFilter, QuerySelect,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::ApiError;
use weldsuite_schema::master::commerce_connection_registry as registry;

use crate::args::utc_now_sql;

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

    pub(super) async fn before(&self, id: &str) -> Result<Before, DbErr> {
        let row: Option<Option<sea_orm::prelude::TimeDateTime>> = registry::Entity::find_by_id(id)
            .select_only()
            .column(registry::Column::DeletedAt)
            .filter(registry::Column::WorkspaceId.eq(self.workspace_id))
            .into_tuple()
            .one(&orm(self.pool))
            .await?;
        Ok(match row {
            None => Before::Absent,
            Some(None) => Before::Live,
            Some(Some(_)) => Before::Removed,
        })
    }

    /// The connection is registered (again).
    pub(super) async fn register(&self, id: &str) -> Result<(), DbErr> {
        registration(id, self.workspace_id)
            .exec_without_returning(&orm(self.pool))
            .await?;
        Ok(())
    }

    /// The connection no longer answers webhooks.
    pub(super) async fn remove(&self, id: &str) -> Result<(), DbErr> {
        registry::Entity::update_many()
            .col_expr(
                registry::Column::DeletedAt,
                Func::coalesce([
                    Expr::col((registry::Entity, registry::Column::DeletedAt)),
                    utc_now_sql(),
                ])
                .into(),
            )
            .filter(registry::Column::Id.eq(id))
            .filter(registry::Column::WorkspaceId.eq(self.workspace_id))
            .exec(&orm(self.pool))
            .await?;
        Ok(())
    }

    /// Undoes a change: the row as it was.
    pub(super) async fn restore(&self, id: &str, before: Before) -> Result<(), DbErr> {
        match before {
            Before::Absent => {
                registry::Entity::delete_many()
                    .filter(registry::Column::Id.eq(id))
                    .filter(registry::Column::WorkspaceId.eq(self.workspace_id))
                    .exec(&orm(self.pool))
                    .await?;
                Ok(())
            }
            Before::Live => self.register(id).await,
            Before::Removed => self.remove(id).await,
        }
    }
}

/// `insert … on conflict (id) do update set deleted_at = null where the
/// row is this workspace's`: a removed row of the workspace comes back,
/// another workspace's row is left alone.
fn registration(id: &str, workspace_id: &str) -> Insert<registry::ActiveModel> {
    let mut upsert = OnConflict::column(registry::Column::Id);
    upsert
        .value(
            registry::Column::DeletedAt,
            Expr::val(None::<sea_orm::prelude::TimeDateTime>),
        )
        .action_and_where(sea_orm::ExprTrait::eq(
            Expr::col((registry::Entity, registry::Column::WorkspaceId)),
            Expr::col((Alias::new("excluded"), registry::Column::WorkspaceId)),
        ));
    registry::Entity::insert(registry::ActiveModel {
        id: Set(id.to_owned()),
        workspace_id: Set(workspace_id.to_owned()),
        provider: Set("mollie".to_owned()),
        ..Default::default()
    })
    .on_conflict(upsert)
}

/// The workspace (`ws_…`) of a live connection, for the webhook.
pub(super) async fn workspace_of(
    master: &PgPool,
    connection_id: &str,
) -> Result<Option<String>, DbErr> {
    registry::Entity::find_by_id(connection_id)
        .select_only()
        .column(registry::Column::WorkspaceId)
        .filter(registry::Column::Provider.eq("mollie"))
        .filter(registry::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(master))
        .await
}

#[cfg(test)]
mod tests {
    use sea_orm::{DbBackend, QueryTrait};

    use super::*;

    #[test]
    fn a_registration_revives_only_its_own_workspaces_row() {
        assert_eq!(
            registration("cpc_1", "ws_1").build(DbBackend::Postgres).sql,
            r#"INSERT INTO "commerce_connection_registry" ("id", "workspace_id", "provider") VALUES ($1, $2, $3) ON CONFLICT ("id") DO UPDATE SET "deleted_at" = $4 WHERE "commerce_connection_registry"."workspace_id" = "excluded"."workspace_id""#
        );
    }
}
