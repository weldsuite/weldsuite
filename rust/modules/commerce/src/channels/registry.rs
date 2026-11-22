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
use serde_json::Value;
use sqlx::PgPool;
use weldsuite_kit::ApiError;

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
    pub(super) at: &'a str,
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

    pub(super) async fn insert(&self, key: &NewKey<'_>) -> Result<(), sqlx::Error> {
        insert_row(self.pool, self.workspace_id, key).await
    }

    pub(super) async fn delete(&self, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("delete from storefront_key_registry where id = $1 and workspace_id = $2")
            .bind(id)
            .bind(self.workspace_id)
            .execute(self.pool)
            .await?;
        Ok(())
    }

    /// Revoke `id` (its first revocation time stays).
    pub(super) async fn revoke(&self, id: &str, at: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "update storefront_key_registry set revoked_at = coalesce(revoked_at, $3::timestamp), \
               updated_at = $3::timestamp where id = $1 and workspace_id = $2",
        )
        .bind(id)
        .bind(self.workspace_id)
        .bind(at)
        .execute(self.pool)
        .await?;
        Ok(())
    }

    pub(super) async fn unrevoke(&self, id: &str, at: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "update storefront_key_registry set revoked_at = null, updated_at = $3::timestamp \
             where id = $1 and workspace_id = $2",
        )
        .bind(id)
        .bind(self.workspace_id)
        .bind(at)
        .execute(self.pool)
        .await?;
        Ok(())
    }

    /// Rotation, as one registry transaction: the new key in, the old one out.
    pub(super) async fn rotate(&self, old_id: &str, new: &NewKey<'_>) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "update storefront_key_registry set revoked_at = coalesce(revoked_at, $3::timestamp), \
               updated_at = $3::timestamp where id = $1 and workspace_id = $2",
        )
        .bind(old_id)
        .bind(self.workspace_id)
        .bind(new.at)
        .execute(&mut *tx)
        .await?;
        insert_row(&mut *tx, self.workspace_id, new).await?;
        tx.commit().await
    }

    pub(super) async fn set_origins(
        &self,
        id: &str,
        origins: &[String],
        at: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "update storefront_key_registry set allowed_origins = $3::jsonb, \
               updated_at = $4::timestamp where id = $1 and workspace_id = $2",
        )
        .bind(id)
        .bind(self.workspace_id)
        .bind(serde_json::json!(origins))
        .bind(at)
        .execute(self.pool)
        .await?;
        Ok(())
    }

    /// Every key of the channel stops working.
    pub(super) async fn revoke_channel(
        &self,
        channel_id: &str,
        at: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "update storefront_key_registry set revoked_at = coalesce(revoked_at, $3::timestamp), \
               updated_at = $3::timestamp where channel_id = $1 and workspace_id = $2",
        )
        .bind(channel_id)
        .bind(self.workspace_id)
        .bind(at)
        .execute(self.pool)
        .await?;
        Ok(())
    }

    /// When each key of the channel was last used, as the storefront records
    /// it in the registry: `(id, ISO-ish timestamp)`.
    pub(super) async fn last_used(
        &self,
        channel_id: &str,
    ) -> Result<Vec<(String, Option<String>)>, sqlx::Error> {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select jsonb_build_object('id', id, 'at', to_jsonb(last_used_at)) \
             from storefront_key_registry where channel_id = $1 and workspace_id = $2",
        )
        .bind(channel_id)
        .bind(self.workspace_id)
        .fetch_all(self.pool)
        .await?;
        Ok(rows
            .iter()
            .filter_map(|row| {
                Some((
                    row["id"].as_str()?.to_owned(),
                    row["at"].as_str().map(str::to_owned),
                ))
            })
            .collect())
    }
}

async fn insert_row<'e>(
    executor: impl sqlx::PgExecutor<'e>,
    workspace_id: &str,
    key: &NewKey<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into storefront_key_registry (id, key_hash, kind, key_prefix, workspace_id, \
           channel_id, allowed_origins, rotated_from_id, created_at, updated_at) \
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::timestamp, $9::timestamp)",
    )
    .bind(key.id)
    .bind(key.hash)
    .bind(key.kind)
    .bind(key.prefix)
    .bind(workspace_id)
    .bind(key.channel_id)
    .bind(serde_json::json!(key.origins))
    .bind(key.rotated_from)
    .bind(key.at)
    .execute(executor)
    .await?;
    Ok(())
}
