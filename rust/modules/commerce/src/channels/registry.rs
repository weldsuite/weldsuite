//! The master `storefront_key_registry`: how the storefront API finds the
//! workspace of a key without a session (the pattern of `widget_registry`).
//! The tenant `commerce_channel_keys` rows stay the source of truth; every
//! key write here changes both, and never in a way that lets the registry
//! accept a key the tenant would refuse:
//!
//! - a new key is registered first, and unregistered again when the tenant
//!   write fails (until then nobody holds the secret);
//! - a revocation reaches the registry first, so the key stops working at
//!   once; a tenant write that then fails is retried by revoking again;
//! - origin edits and rotations undo their registry change when the tenant
//!   write fails.
//!
//! Callers hold the tenant row's lock for the whole sequence.

use http::StatusCode;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::json;
use time::PrimitiveDateTime;
use weldsuite_db::{OrmConn, PgPool, orm};
use weldsuite_kit::ApiError;
use weldsuite_schema::master::storefront_key_registry as registry;

use crate::{Caller, Refusal};

/// A key as the registry stores it.
pub(super) struct NewKey<'a> {
    pub(super) id: &'a str,
    pub(super) hash: &'a str,
    pub(super) kind: &'a str,
    pub(super) prefix: &'a str,
    pub(super) channel_id: &'a str,
    pub(super) origins: &'a [String],
    pub(super) rotated_from: Option<&'a str>,
    pub(super) at: PrimitiveDateTime,
}

pub(super) struct Registry<'a> {
    pool: &'a PgPool,
    workspace_id: &'a str,
}

impl<'a> Registry<'a> {
    /// The registry of the caller's workspace; 503 when the server has none.
    pub(super) fn of(caller: &'a Caller) -> Result<Self, Refusal> {
        match &caller.registry {
            Some(pool) => Ok(Self {
                pool,
                workspace_id: &caller.workspace_id,
            }),
            None => Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "KEY_REGISTRY_UNAVAILABLE",
                "Storefront keys are not available on this server",
            )
            .into()),
        }
    }

    pub(super) async fn insert(&self, key: &NewKey<'_>) -> Result<(), DbErr> {
        insert_row(&orm(self.pool), self.workspace_id, key).await
    }

    pub(super) async fn delete(&self, id: &str) -> Result<(), DbErr> {
        registry::Entity::delete_many()
            .filter(registry::Column::Id.eq(id))
            .filter(registry::Column::WorkspaceId.eq(self.workspace_id))
            .exec(&orm(self.pool))
            .await?;
        Ok(())
    }

    /// Revoke `id` (its first revocation time stays).
    pub(super) async fn revoke(&self, id: &str, at: PrimitiveDateTime) -> Result<(), DbErr> {
        revoke_row(&orm(self.pool), self.workspace_id, id, at).await
    }

    pub(super) async fn unrevoke(&self, id: &str, at: PrimitiveDateTime) -> Result<(), DbErr> {
        registry::Entity::update_many()
            .col_expr(
                registry::Column::RevokedAt,
                Expr::val(None::<PrimitiveDateTime>),
            )
            .col_expr(registry::Column::UpdatedAt, Expr::val(at))
            .filter(registry::Column::Id.eq(id))
            .filter(registry::Column::WorkspaceId.eq(self.workspace_id))
            .exec(&orm(self.pool))
            .await?;
        Ok(())
    }

    /// Rotation, as one registry transaction: the new key in, the old one out.
    pub(super) async fn rotate(&self, old_id: &str, new: &NewKey<'_>) -> Result<(), DbErr> {
        let mut tx = self.pool.begin().await.map_err(weldsuite_db::orm_error)?;
        let db = OrmConn::new(&mut tx);
        revoke_row(&db, self.workspace_id, old_id, new.at).await?;
        insert_row(&db, self.workspace_id, new).await?;
        tx.commit().await.map_err(weldsuite_db::orm_error)
    }

    pub(super) async fn set_origins(
        &self,
        id: &str,
        origins: &[String],
        at: PrimitiveDateTime,
    ) -> Result<(), DbErr> {
        registry::Entity::update_many()
            .col_expr(registry::Column::AllowedOrigins, Expr::val(json!(origins)))
            .col_expr(registry::Column::UpdatedAt, Expr::val(at))
            .filter(registry::Column::Id.eq(id))
            .filter(registry::Column::WorkspaceId.eq(self.workspace_id))
            .exec(&orm(self.pool))
            .await?;
        Ok(())
    }

    /// Every key of the channel stops working.
    pub(super) async fn revoke_channel(
        &self,
        channel_id: &str,
        at: PrimitiveDateTime,
    ) -> Result<(), DbErr> {
        registry::Entity::update_many()
            .col_expr(registry::Column::RevokedAt, first_revocation(at))
            .col_expr(registry::Column::UpdatedAt, Expr::val(at))
            .filter(registry::Column::ChannelId.eq(channel_id))
            .filter(registry::Column::WorkspaceId.eq(self.workspace_id))
            .exec(&orm(self.pool))
            .await?;
        Ok(())
    }

    /// When each key of the channel was last used, as the storefront records
    /// it in the registry.
    pub(super) async fn last_used(
        &self,
        channel_id: &str,
    ) -> Result<Vec<(String, Option<PrimitiveDateTime>)>, DbErr> {
        registry::Entity::find()
            .select_only()
            .columns([registry::Column::Id, registry::Column::LastUsedAt])
            .filter(registry::Column::ChannelId.eq(channel_id))
            .filter(registry::Column::WorkspaceId.eq(self.workspace_id))
            .into_tuple()
            .all(&orm(self.pool))
            .await
    }
}

/// `coalesce(revoked_at, at)`: a key keeps its first revocation time.
fn first_revocation(at: PrimitiveDateTime) -> Expr {
    Func::coalesce([
        Expr::col((registry::Entity, registry::Column::RevokedAt)),
        Expr::val(at),
    ])
    .into()
}

async fn revoke_row<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    id: &str,
    at: PrimitiveDateTime,
) -> Result<(), DbErr> {
    registry::Entity::update_many()
        .col_expr(registry::Column::RevokedAt, first_revocation(at))
        .col_expr(registry::Column::UpdatedAt, Expr::val(at))
        .filter(registry::Column::Id.eq(id))
        .filter(registry::Column::WorkspaceId.eq(workspace_id))
        .exec(db)
        .await?;
    Ok(())
}

async fn insert_row<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
    key: &NewKey<'_>,
) -> Result<(), DbErr> {
    registry::Entity::insert(registry::ActiveModel {
        id: Set(key.id.to_owned()),
        key_hash: Set(key.hash.to_owned()),
        kind: Set(key.kind.to_owned()),
        key_prefix: Set(key.prefix.to_owned()),
        workspace_id: Set(workspace_id.to_owned()),
        channel_id: Set(key.channel_id.to_owned()),
        allowed_origins: Set(json!(key.origins)),
        rotated_from_id: Set(key.rotated_from.map(str::to_owned)),
        created_at: Set(key.at),
        updated_at: Set(key.at),
        ..Default::default()
    })
    .exec_without_returning(db)
    .await?;
    Ok(())
}
