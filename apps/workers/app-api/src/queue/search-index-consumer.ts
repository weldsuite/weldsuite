/**
 * SEARCH_EVENTS queue consumer — keeps the semantic index fresh.
 *
 * Every entity mutation fans out to this queue via `publishEntityEvent`
 * (sink 4 in `@weldsuite/entity-events`). Messages are grouped by workspace so
 * one tenant DB connection serves a whole batch, then coalesced per record: an
 * edit burst on one ticket produces many events but exactly one re-index.
 *
 * The consumer never trusts the event payload. It re-reads the record through
 * the loader registry, which means a delete, a soft-delete and a move into a
 * private space all converge on the same behaviour — the record stops loading
 * and its chunks are dropped — without the publisher having to describe why.
 *
 * Retry posture: `ack()` on success and on permanent failure (a workspace that
 * no longer resolves), `retry()` only for transient faults, so a poison message
 * can't loop. Embedding failures inside `indexEntity` are already caught and
 * logged per record.
 */

import type { EntityEventMessage } from '@weldsuite/entity-events';
import type { Env } from '../types';
import { getTenantDbForWorkspace } from '../db';
import { createEmbedder, indexEntity } from '../services/search/indexer';
import { resolveIndexedType } from '../services/search/documents';
import type { SearchEntityType } from '@weldsuite/app-api-client/schemas/search';

interface PendingIndex {
  entityType: SearchEntityType;
  entityId: string;
  messages: Message<EntityEventMessage>[];
}

/**
 * Collapse a batch into one job per (workspace, entityType, entityId).
 *
 * Exported for testing: the coalescing is the part with real logic in it, and
 * it is worth asserting that ten edits to one record yield one index job while
 * still acking all ten messages.
 */
export function groupBatch(
  messages: readonly Message<EntityEventMessage>[],
): Map<string, Map<string, PendingIndex>> {
  const byWorkspace = new Map<string, Map<string, PendingIndex>>();

  for (const message of messages) {
    const body = message.body;
    const workspaceId = body?.metadata?.workspaceId;
    const entityType = body?.entityType ? resolveIndexedType(body.entityType) : null;
    const entityId = body?.entityId;

    // Not an indexed type, or malformed — ack it and move on. Retrying would
    // never make an un-indexed entity type become indexable.
    if (!workspaceId || !entityType || !entityId) {
      message.ack();
      continue;
    }

    let workspace = byWorkspace.get(workspaceId);
    if (!workspace) {
      workspace = new Map();
      byWorkspace.set(workspaceId, workspace);
    }

    const key = `${entityType}:${entityId}`;
    const pending = workspace.get(key);
    if (pending) {
      pending.messages.push(message);
    } else {
      workspace.set(key, { entityType, entityId, messages: [message] });
    }
  }

  return byWorkspace;
}

export async function handleSearchIndexBatch(
  batch: MessageBatch<EntityEventMessage>,
  env: Env,
): Promise<void> {
  const byWorkspace = groupBatch(batch.messages);
  if (byWorkspace.size === 0) return;

  let embedder: ReturnType<typeof createEmbedder>;
  try {
    embedder = createEmbedder(env);
  } catch (err) {
    // No AI gateway configured. Retry the whole batch: this is an environment
    // problem that a redeploy fixes, and dropping the messages would leave the
    // index permanently behind with nothing to signal it.
    console.error(
      '[search-index-consumer] AI gateway unavailable:',
      err instanceof Error ? err.message : err,
    );
    batch.retryAll();
    return;
  }

  for (const [workspaceId, jobs] of byWorkspace) {
    let db: Awaited<ReturnType<typeof getTenantDbForWorkspace>>;
    try {
      db = await getTenantDbForWorkspace(env, workspaceId);
    } catch (err) {
      // A workspace that cannot be resolved is usually deleted, not down.
      // Ack rather than retry so its backlog does not recycle forever.
      console.error(
        `[search-index-consumer] cannot resolve workspace ${workspaceId} — dropping ${jobs.size} job(s):`,
        err instanceof Error ? err.message : err,
      );
      for (const job of jobs.values()) job.messages.forEach((m) => m.ack());
      continue;
    }

    for (const job of jobs.values()) {
      try {
        const result = await indexEntity(db, embedder, job.entityType, job.entityId);
        if (result.embedded > 0 || result.removed > 0) {
          console.log(
            `[search-index-consumer] ${job.entityType}/${job.entityId}: ` +
              `${result.embedded} embedded, ${result.skipped} unchanged, ${result.removed} removed`,
          );
        }
        job.messages.forEach((m) => m.ack());
      } catch (err) {
        console.error(
          `[search-index-consumer] failed ${job.entityType}/${job.entityId}:`,
          err instanceof Error ? err.message : err,
        );
        job.messages.forEach((m) => m.retry());
      }
    }
  }
}
