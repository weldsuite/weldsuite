/**
 * The master `merge_provider_index` rows for repository webhooks
 * (`kind = 'webhook'`): what lets integration-webhook-worker turn the key in a
 * webhook URL (`/webhooks/merge/<provider>/<key>`) into a workspace without
 * scanning tenant databases. Rows hold `workspaces.id` (ADR SEC-011), a random
 * key and nothing else.
 */

import { and, eq } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import { getMasterDb, masterSchema } from '@weldsuite/worker-kit/db';
import type { MergeProvider } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { Env } from '../types';

const { mergeProviderIndex } = masterSchema;

/** Records (or re-points) the workspace a webhook key belongs to. */
export async function putWebhookIndex(env: Env, provider: MergeProvider, key: string, workspaceId: string): Promise<void> {
  const now = new Date();
  await getMasterDb(env)
    .insert(mergeProviderIndex)
    .values({ id: generateId('mpi'), provider, kind: 'webhook', externalKey: key, workspaceId, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [mergeProviderIndex.provider, mergeProviderIndex.kind, mergeProviderIndex.externalKey],
      set: { workspaceId, updatedAt: now },
    });
}

/** Drops a webhook key: later deliveries for it are unknown. */
export async function deleteWebhookIndex(env: Env, provider: MergeProvider, key: string): Promise<void> {
  await getMasterDb(env)
    .delete(mergeProviderIndex)
    .where(
      and(
        eq(mergeProviderIndex.provider, provider),
        eq(mergeProviderIndex.kind, 'webhook'),
        eq(mergeProviderIndex.externalKey, key),
      ),
    );
}
