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

use serde_json::Value;
use weldsuite_db::{Keyring, PgPool, decrypt_field, encrypt_field, js_row};
use weldsuite_kit::id::ALPHANUMERIC;
use weldsuite_kit::{generate_id, random_string};

use crate::credentials::adapter_context;
use crate::db::{Row, opt_text, text};
use crate::providers::shared::trim_trailing_slashes;
use crate::providers::{self, AdapterContext, RepositoryRef, WebhookTarget};
use crate::{MergeError, MergeState, Overrides, now};

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
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into merge_provider_index (id, provider, kind, external_key, workspace_id, created_at, updated_at) \
         values ($1, $2, 'webhook', $3, $4, $5::timestamptz, $5::timestamptz) \
         on conflict (provider, kind, external_key) do update set workspace_id = excluded.workspace_id, \
           updated_at = excluded.updated_at",
    )
    .bind(generate_id("mpi"))
    .bind(provider)
    .bind(key)
    .bind(workspace_id)
    .bind(now())
    .execute(master)
    .await?;
    Ok(())
}

/// `deleteWebhookIndex(env, provider, key)`: later deliveries for the key
/// are unknown.
pub(crate) async fn delete_webhook_index(
    master: &PgPool,
    provider: &str,
    key: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "delete from merge_provider_index where provider = $1 and kind = 'webhook' and external_key = $2",
    )
    .bind(provider)
    .bind(key)
    .execute(master)
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
        let row: Value = sqlx::query_scalar(
            "update merge_repositories set webhook_id = $2, webhook_key = $3, webhook_secret = $4, \
               updated_at = $5::timestamptz where id = $1 returning to_jsonb(merge_repositories.*)",
        )
        .bind(text(repository, "id"))
        .bind(&webhook_id)
        .bind(&key)
        .bind(sealed)
        .bind(now())
        .fetch_one(db)
        .await?;
        Ok::<Row, MergeError>(js_row(row))
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
