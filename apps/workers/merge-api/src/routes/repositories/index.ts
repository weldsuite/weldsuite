/**
 * Repository routes: /api/merge/repositories/*.
 *
 *   GET    /           -> tracked repositories (merge_connections:read)
 *   POST   /           -> add one: look it up through the connection's provider (GitLab, Bitbucket and Azure DevOps also register
 *                         their webhook and index its key), then load its open and recently merged pull requests
 *   PATCH  /:id        -> team, prSync; issueSync accepts off|import|two_way on GitHub and GitLab, only off elsewhere (422)
 *   DELETE /:id        -> stop tracking (soft delete); a provider hook and its index row are deleted first
 *   POST   /:id/sync   -> read the pull requests again (Refresh)
 *
 * Changing repositories needs merge_connections:manage. Loading history never
 * runs the automations: a backfill must not move issues.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { addMergeRepositorySchema, updateMergeRepositorySchema } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { Env, Variables } from '../../types';
import { providerFailure, unprocessable, type Ctx } from '../shared';
import { diffFields, publishEntityEvents } from '../../services/events';
import { repositoryDto } from '../../services/mappers';
import type { MergeRepositoryRow } from '../../services/db';
import { findConnection } from '../../services/connections';
import { adapterContextFor } from '../../services/providers/context';
import { registerRepositoryWebhook, unregisterRepositoryWebhook, usesRepositoryWebhooks } from '../../services/webhook-registration';
import {
  addRepository,
  deleteRepository,
  findRepository,
  listRepositories,
  openPullRequestCounts,
  repositoryEventData,
  syncRepository,
  touchSynced,
  updateRepository,
} from '../../services/repositories';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function publishRepositoryEvent(
  c: Ctx,
  repository: MergeRepositoryRow,
  action: 'created' | 'updated' | 'deleted',
  changes?: Record<string, { old: unknown; new: unknown }> | null,
) {
  publishEntityEvents(c, [
    { entityType: 'merge_repository', action, entityId: repository.id, data: repositoryEventData(repository), changes },
  ]);
}

async function dto(c: Ctx, repository: MergeRepositoryRow) {
  const counts = await openPullRequestCounts(c.get('tenantDb'), [repository.id]);
  return repositoryDto(repository, counts.get(repository.id) ?? 0);
}

app.get('/', requirePermission('merge_connections:read'), async (c) => {
  const rows = await listRepositories(c.get('tenantDb'));
  return list(c, rows.map((r) => repositoryDto(r.row, r.openPullRequestCount)), cursorPagination(rows.length, false, null));
});

app.post('/', requirePermission('merge_connections:manage'), zValidator('json', addMergeRepositorySchema), async (c) => {
  const db = c.get('tenantDb');
  const input = c.req.valid('json');
  const connection = await findConnection(db, input.connectionId);
  if (!connection || connection.status !== 'active') {
    return error.notFound(c, 'Connection', input.connectionId);
  }
  try {
    const ctx = await adapterContextFor(db, c.env, connection);
    const afterInsert = usesRepositoryWebhooks(connection)
      ? (row: MergeRepositoryRow) => registerRepositoryWebhook(db, ctx, c.get('workspaceId'), row)
      : undefined;
    const result = await addRepository(db, connection, input, c.get('userId'), ctx, afterInsert);
    if (!result.ok) {
      switch (result.reason) {
        case 'team_not_found':
          return error.notFound(c, 'Team', input.teamId ?? undefined);
        case 'repository_not_found':
          return error.notFound(c, 'Repository', input.externalId);
        case 'already_added':
          return error.conflict(c, 'This repository is already tracked');
        case 'connection_not_found':
          return error.notFound(c, 'Connection', input.connectionId);
      }
    }
    publishEntityEvents(c, [
      { entityType: 'merge_repository', action: 'created', entityId: result.repository.id, data: repositoryEventData(result.repository) },
      ...result.sync.events,
    ]);
    return success(
      c,
      {
        repository: await dto(c, result.repository),
        pullRequestsSynced: result.sync.pullRequestsSynced,
        linksCreated: result.sync.linksCreated,
      },
      201,
    );
  } catch (err) {
    const response = providerFailure(c, err);
    if (response) return response;
    throw err;
  }
});

app.patch('/:id', requirePermission('merge_connections:manage'), zValidator('json', updateMergeRepositorySchema), async (c) => {
  const id = c.req.param('id');
  const result = await updateRepository(c.get('tenantDb'), id, c.req.valid('json'));
  if (!result.ok) {
    switch (result.reason) {
      case 'not_found':
        return error.notFound(c, 'Repository', id);
      case 'team_not_found':
        return error.notFound(c, 'Team');
      case 'issue_sync_unsupported':
        return unprocessable(c, 'This provider has no issue sync: only "off" is accepted');
    }
  }
  publishRepositoryEvent(
    c,
    result.repository,
    'updated',
    diffFields(
      result.before as unknown as Record<string, unknown>,
      result.repository as unknown as Record<string, unknown>,
      ['teamId', 'prSync', 'issueSync'],
    ),
  );
  return success(c, await dto(c, result.repository));
});

app.delete('/:id', requirePermission('merge_connections:manage'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const existing = await findRepository(db, id);
  if (!existing) return error.notFound(c, 'Repository', id);
  // GitLab, Bitbucket and Azure DevOps: take the provider's hook and the index row down first.
  if (existing.webhookKey) {
    const connection = await findConnection(db, existing.connectionId);
    const ctx = connection ? await adapterContextFor(db, c.env, connection).catch(() => null) : null;
    await unregisterRepositoryWebhook(c.env, ctx, existing);
  }
  const repository = await deleteRepository(db, id);
  if (!repository) return error.notFound(c, 'Repository', id);
  publishRepositoryEvent(c, repository, 'deleted');
  return noContent(c);
});

app.post('/:id/sync', requirePermission('merge_connections:manage'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const repository = await findRepository(db, id);
  if (!repository) return error.notFound(c, 'Repository', id);
  const connection = await findConnection(db, repository.connectionId);
  if (!connection || connection.status !== 'active') return error.notFound(c, 'Connection', repository.connectionId);
  try {
    const sync = await syncRepository(db, repository, await adapterContextFor(db, c.env, connection));
    const synced = await touchSynced(db, id);
    publishEntityEvents(c, sync.events);
    return success(c, {
      repository: await dto(c, synced),
      pullRequestsSynced: sync.pullRequestsSynced,
      linksCreated: sync.linksCreated,
    });
  } catch (err) {
    const response = providerFailure(c, err);
    if (response) return response;
    throw err;
  }
});

export default app;
