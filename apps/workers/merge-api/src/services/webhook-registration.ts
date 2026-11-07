/**
 * Webhooks on GitLab, Bitbucket and Azure DevOps repositories. Adding a
 * repository registers a hook at the provider that delivers to
 * `${WEBHOOK_BASE_URL}/webhooks/merge/<provider>/<webhook_key>` with a fresh
 * secret, stores the key, the secret (sealed) and the provider's hook id on the
 * repository, and writes the master index row; removing the repository undoes
 * all of it. GitHub delivers through the App and registers nothing.
 */

import { eq } from 'drizzle-orm';
import { trimTrailingSlashes } from '@weldsuite/merge-domain/providers/shared';
import { decryptField, encryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { ALPHANUMERIC, randomString } from '@weldsuite/worker-kit/random';
import type { Env } from '../types';
import { adapterContextFor } from './providers/context';
import { mergeRepositories, type Db, type MergeConnectionRow, type MergeRepositoryRow } from './db';
import { adapterFor } from './providers/registry';
import type { AdapterContext, RepositoryRef } from './providers/types';
import { deleteWebhookIndex, putWebhookIndex } from './webhook-index';

export const WEBHOOK_KEY_LENGTH = 40;
export const WEBHOOK_SECRET_LENGTH = 48;

const refOf = (repository: MergeRepositoryRow): RepositoryRef => ({
  externalId: repository.externalId,
  fullName: repository.fullName,
  externalProject: repository.externalProject,
  defaultBranch: repository.defaultBranch,
});

/** Whether the repository's provider registers a hook per repository. */
export const usesRepositoryWebhooks = (repository: Pick<MergeRepositoryRow, 'provider'>): boolean =>
  repository.provider !== 'github';

/** `${WEBHOOK_BASE_URL}/webhooks/merge/<provider>/<key>`. */
export function webhookUrl(env: Env, provider: string, key: string): string {
  return `${trimTrailingSlashes(env.WEBHOOK_BASE_URL ?? '')}/webhooks/merge/${provider}/${key}`;
}

/**
 * Registers the hook for a repository that was just stored and writes its index
 * row; returns the repository with `webhook_id`, `webhook_key` and the sealed
 * `webhook_secret` set. On a provider failure nothing is left behind (the caller
 * removes the repository row).
 */
export async function registerRepositoryWebhook(
  db: Db,
  ctx: AdapterContext,
  workspaceId: string,
  repository: MergeRepositoryRow,
): Promise<MergeRepositoryRow> {
  const adapter = adapterFor(repository.provider);
  if (!adapter.registerWebhook) return repository;
  const key = randomString(WEBHOOK_KEY_LENGTH, ALPHANUMERIC);
  const secret = randomString(WEBHOOK_SECRET_LENGTH, ALPHANUMERIC);
  const { webhookId } = await adapter.registerWebhook(ctx, refOf(repository), {
    url: webhookUrl(ctx.env, repository.provider, key),
    secret,
  });
  try {
    await putWebhookIndex(ctx.env, repository.provider, key, workspaceId);
    const [updated] = await db
      .update(mergeRepositories)
      .set({
        webhookId,
        webhookKey: key,
        webhookSecret: await encryptField(secret, keyringFromEnv(ctx.env)),
        updatedAt: new Date(),
      })
      .where(eq(mergeRepositories.id, repository.id))
      .returning();
    return updated!;
  } catch (err) {
    // The hook exists at the provider but we cannot route it: take it down again.
    await adapter.deleteWebhook?.(ctx, refOf(repository), webhookId).catch(() => undefined);
    throw err;
  }
}

/**
 * Deletes the repository's hook at the provider and its index row. Best effort:
 * a provider that cannot be reached must not keep a member from removing the
 * repository (the hook then delivers to an unknown key, which is ignored).
 */
export async function unregisterRepositoryWebhook(
  env: Env,
  ctx: AdapterContext | null,
  repository: MergeRepositoryRow,
): Promise<void> {
  if (!repository.webhookKey) return;
  const adapter = adapterFor(repository.provider);
  if (ctx && repository.webhookId && adapter.deleteWebhook) {
    try {
      await adapter.deleteWebhook(ctx, refOf(repository), repository.webhookId);
    } catch (err) {
      console.error(`[merge-api] could not delete the ${repository.provider} webhook of ${repository.fullName}:`, err);
    }
  }
  try {
    await deleteWebhookIndex(env, repository.provider, repository.webhookKey);
  } catch (err) {
    console.error('[merge-api] could not remove a webhook from the master index:', err);
  }
}

/**
 * A removed connection takes its repositories' hooks and index rows down too.
 * Best effort, like `unregisterRepositoryWebhook`: the connection is already gone.
 */
export async function releaseConnectionWebhooks(
  db: Db,
  env: Env,
  connection: MergeConnectionRow,
  repositories: MergeRepositoryRow[],
): Promise<void> {
  const hooked = repositories.filter((repository) => repository.webhookKey);
  if (hooked.length === 0) return;
  const ctx = await adapterContextFor(db, env, connection).catch(() => null);
  for (const repository of hooked) await unregisterRepositoryWebhook(env, ctx, repository);
}

/** The repository's webhook secret in the clear (for verifying a delivery); null when it has none or it cannot be read. */
export async function webhookSecretOf(env: Env, repository: Pick<MergeRepositoryRow, 'webhookSecret'>): Promise<string | null> {
  if (!repository.webhookSecret) return null;
  try {
    return await decryptField(repository.webhookSecret, keyringFromEnv(env));
  } catch {
    return null;
  }
}
