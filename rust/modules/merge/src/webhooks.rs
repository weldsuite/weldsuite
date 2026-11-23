//! Webhooks on GitLab, Bitbucket and Azure DevOps repositories
//! (`services/webhook-registration.ts`) and their master index rows
//! (`services/webhook-index.ts`).
//!
//! Adding a repository registers a hook at the provider that delivers to
//! `${WEBHOOK_BASE_URL}/webhooks/merge/<provider>/<webhook_key>` with a fresh
//! secret, stores the key, the secret (sealed) and the provider's hook id on
//! the repository, and writes the master `merge_provider_index` row (`kind =
//! webhook`, `workspaces.id`), which lets the integration workers turn the
//! key into a workspace. Removing the repository undoes all of it. GitHub
//! delivers through the App and registers nothing.

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter};
use weldsuite_db::{Keyring, PgPool, decrypt_field, encrypt_field, orm, utc_now};
use weldsuite_kit::id::ALPHANUMERIC;
use weldsuite_kit::{generate_id, random_string};
use weldsuite_schema::master::merge_provider_index;
use weldsuite_schema::tenant::merge_repositories;

use crate::credentials::adapter_context;
use crate::db::{Row, json_row, opt_text, text};
use crate::providers::shared::trim_trailing_slashes;
use crate::providers::{self, AdapterContext, RepositoryRef, WebhookTarget};
use crate::{MergeError, MergeState, Overrides};

pub(crate) const WEBHOOK_KEY_LENGTH: usize = 40;
pub(crate) const WEBHOOK_SECRET_LENGTH: usize = 48;

/// `getMasterDb(env)`.
pub(crate) fn master_of(state: &MergeState, overrides: &Overrides) -> Result<PgPool, MergeError> {
    overrides
        .master(state)
        .ok_or_else(|| MergeError::Unexpected("DATABASE_URL_MASTER is not configured".to_owned()))
}

/// `putWebhookIndex(env, provider, key, workspaceId)`: records (or
/// re-points) the workspace a webhook key belongs to.
pub(crate) async fn put_webhook_index(
    master: &PgPool,
    provider: &str,
    key: &str,
    workspace_id: &str,
) -> Result<(), DbErr> {
    let at = utc_now().assume_utc();
    merge_provider_index::Entity::insert(merge_provider_index::ActiveModel {
        id: Set(generate_id("mpi")),
        provider: Set(provider.to_owned()),
        kind: Set("webhook".to_owned()),
        external_key: Set(key.to_owned()),
        workspace_id: Set(workspace_id.to_owned()),
        created_at: Set(at),
        updated_at: Set(at),
    })
    .on_conflict(
        OnConflict::columns([
            merge_provider_index::Column::Provider,
            merge_provider_index::Column::Kind,
            merge_provider_index::Column::ExternalKey,
        ])
        .update_columns([
            merge_provider_index::Column::WorkspaceId,
            merge_provider_index::Column::UpdatedAt,
        ])
        .to_owned(),
    )
    .exec_without_returning(&orm(master))
    .await?;
    Ok(())
}

/// `deleteWebhookIndex(env, provider, key)`: later deliveries for the key
/// are unknown.
pub(crate) async fn delete_webhook_index(
    master: &PgPool,
    provider: &str,
    key: &str,
) -> Result<(), DbErr> {
    merge_provider_index::Entity::delete_many()
        .filter(merge_provider_index::Column::Provider.eq(provider))
        .filter(merge_provider_index::Column::Kind.eq("webhook"))
        .filter(merge_provider_index::Column::ExternalKey.eq(key))
        .exec(&orm(master))
        .await?;
    Ok(())
}

/// `webhookUrl(env, provider, key)`.
fn webhook_url(base: Option<String>, provider: &str, key: &str) -> String {
    format!(
        "{}/webhooks/merge/{provider}/{key}",
        trim_trailing_slashes(&base.unwrap_or_default())
    )
}

/// `registerRepositoryWebhook(db, ctx, workspaceId, repository)`: registers
/// the hook for a repository just stored and writes its index row; answers
/// the repository with `webhook_id`, `webhook_key` and the sealed
/// `webhook_secret` set. On a provider failure nothing is left behind (the
/// caller removes the repository row).
pub(crate) async fn register_repository_webhook(
    db: &PgPool,
    ctx: &AdapterContext,
    workspace_id: &str,
    repository: &Row,
) -> Result<Row, MergeError> {
    let provider = text(repository, "provider").to_owned();
    if !providers::registers_webhooks(&provider) {
        return Ok(repository.clone());
    }
    let key = random_string(WEBHOOK_KEY_LENGTH, ALPHANUMERIC);
    let secret = random_string(WEBHOOK_SECRET_LENGTH, ALPHANUMERIC);
    let reference = RepositoryRef::of(repository);
    let target = WebhookTarget {
        url: webhook_url(ctx.env("WEBHOOK_BASE_URL"), &provider, &key),
        secret: secret.clone(),
    };
    let webhook_id = providers::register_webhook(ctx, &reference, &target).await?;
    let stored = async {
        let master = master_of(&ctx.state, &ctx.overrides)?;
        put_webhook_index(&master, &provider, &key, workspace_id).await?;
        let sealed = encrypt_field(&secret, &ctx.overrides.keyring(&ctx.state))
            .map_err(|error| MergeError::Unexpected(error.to_string()))?;
        let rows = merge_repositories::Entity::update_many()
            .col_expr(
                merge_repositories::Column::WebhookId,
                Expr::value(webhook_id.clone()),
            )
            .col_expr(merge_repositories::Column::WebhookKey, Expr::value(key))
            .col_expr(
                merge_repositories::Column::WebhookSecret,
                Expr::value(sealed),
            )
            .col_expr(
                merge_repositories::Column::UpdatedAt,
                Expr::value(utc_now().assume_utc()),
            )
            .filter(merge_repositories::Column::Id.eq(text(repository, "id")))
            .exec_with_returning(&orm(db))
            .await?;
        // `fetch_one`: no row is the statement's error (the route's 500).
        let row = rows
            .into_iter()
            .next()
            .ok_or_else(|| DbErr::RecordNotFound("merge_repositories".to_owned()))?;
        Ok::<Row, MergeError>(json_row(serde_json::to_value(row))?)
    }
    .await;
    match stored {
        Ok(row) => Ok(row),
        Err(error) => {
            // The hook exists at the provider but cannot be routed: take it down again.
            let _ = providers::delete_webhook(ctx, &reference, &webhook_id).await;
            Err(error)
        }
    }
}

/// `unregisterRepositoryWebhook(env, ctx, repository)`: deletes the hook at
/// the provider and the index row. Best effort: a provider that cannot be
/// reached must not keep a member from removing the repository.
pub(crate) async fn unregister_repository_webhook(
    state: &MergeState,
    overrides: &Overrides,
    ctx: Option<&AdapterContext>,
    repository: &Row,
) {
    let Some(key) = opt_text(repository, "webhookKey") else {
        return;
    };
    let provider = text(repository, "provider");
    if let (Some(ctx), Some(webhook_id)) = (ctx, opt_text(repository, "webhookId"))
        && providers::registers_webhooks(provider)
        && let Err(error) =
            providers::delete_webhook(ctx, &RepositoryRef::of(repository), &webhook_id).await
    {
        tracing::error!(
            ?error,
            provider,
            "merge: could not delete a repository webhook"
        );
    }
    let removed = match master_of(state, overrides) {
        Ok(master) => delete_webhook_index(&master, provider, &key)
            .await
            .map_err(MergeError::from),
        Err(error) => Err(error),
    };
    if let Err(error) = removed {
        tracing::error!(
            ?error,
            "merge: could not remove a webhook from the master index"
        );
    }
}

/// `releaseConnectionWebhooks(db, env, connection, repositories)`: a removed
/// connection takes its repositories' hooks and index rows down too.
pub(crate) async fn release_connection_webhooks(
    db: &PgPool,
    state: &MergeState,
    overrides: &Overrides,
    connection: &Row,
    repositories: &[Row],
) {
    let hooked: Vec<&Row> = repositories
        .iter()
        .filter(|r| opt_text(r, "webhookKey").is_some())
        .collect();
    if hooked.is_empty() {
        return;
    }
    let ctx = adapter_context(db, state, overrides, connection, None)
        .await
        .ok();
    for repository in hooked {
        unregister_repository_webhook(state, overrides, ctx.as_ref(), repository).await;
    }
}

/// `webhookSecretOf(env, repository)`: the secret in the clear, for
/// verifying a delivery; `None` when there is none or it cannot be read.
pub(crate) fn webhook_secret_of(keyring: &Keyring, repository: &Row) -> Option<String> {
    let sealed = opt_text(repository, "webhookSecret")?;
    decrypt_field(&sealed, keyring).ok()
}
