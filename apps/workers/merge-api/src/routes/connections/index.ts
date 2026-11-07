/**
 * Git-provider connection routes: /api/merge/connections/*.
 *
 *   GET    /                                -> connections (merge_connections:read)
 *   POST   /github                          -> the workspace's live GitHub connection, or { status: 'needs_install', url? } (url: the install page)
 *   DELETE /:id                             -> stop tracking the connection and its repositories (never uninstalls the App)
 *   GET    /:id/available-repositories      -> what the installation can see, from GitHub
 *
 * Changing connections needs merge_connections:manage. Entity events carry the
 * provider and account login only, never credentials.
 */

import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { providerFailure } from '../shared';
import { publishEntityEvents } from '../../services/events';
import { connectionDto } from '../../services/mappers';
import { mergeRepositories } from '../../services/db';
import {
  connectGithub,
  deleteConnection,
  findConnection,
  listConnections,
  repositoryCount,
} from '../../services/connections';
import { adapterContextFor } from '../../services/providers/context';
import { adapterFor } from '../../services/providers/registry';
import { connectionEventData, repositoryEventData } from '../../services/repositories';
import { releaseConnectionWebhooks } from '../../services/webhook-registration';
import { githubInstallPage, releaseGithubInstallation } from '../../services/github-install';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('merge_connections:read'), async (c) => {
  const rows = await listConnections(c.get('tenantDb'));
  return list(c, rows.map((r) => connectionDto(r.row, r.repositoryCount)), cursorPagination(rows.length, false, null));
});

app.post('/github', requirePermission('merge_connections:manage'), async (c) => {
  const db = c.get('tenantDb');
  const result = await connectGithub(db);
  if (result.status === 'needs_install') {
    const slug = c.env.GITHUB_APP_SLUG;
    return success(c, slug ? { status: 'needs_install' as const, url: githubInstallPage(slug) } : { status: 'needs_install' as const });
  }
  const count = await repositoryCount(db, result.connection.id);
  return success(c, { status: 'connected' as const, connection: connectionDto(result.connection, count) });
});

app.delete('/:id', requirePermission('merge_connections:manage'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const existing = await findConnection(db, id);
  if (!existing) return error.notFound(c, 'Connection', id);
  // A GitHub installation leaves the master index (when it names this workspace) and the webhook
  // route cache, so another workspace can install it and its events stop reaching this one. First,
  // so a failure leaves the connection in place to retry.
  if (existing.provider === 'github') await releaseGithubInstallation(c.env, existing.externalAccountId, c.get('workspaceId'));
  const result = await deleteConnection(db, id);
  if (!result) return error.notFound(c, 'Connection', id);
  await releaseConnectionWebhooks(db, c.env, result.connection, result.repositories);
  publishEntityEvents(c, [
    ...result.repositories.map((repo) => ({
      entityType: 'merge_repository' as const,
      action: 'deleted' as const,
      entityId: repo.id,
      data: repositoryEventData(repo),
    })),
    { entityType: 'merge_connection', action: 'deleted', entityId: result.connection.id, data: connectionEventData(result.connection) },
  ]);
  return noContent(c);
});

app.get('/:id/available-repositories', requirePermission('merge_connections:manage'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const connection = await findConnection(db, id);
  if (!connection) return error.notFound(c, 'Connection', id);
  try {
    const available = await adapterFor(connection.provider).listAvailableRepositories(await adapterContextFor(db, c.env, connection));
    const added = await db
      .select({ externalId: mergeRepositories.externalId })
      .from(mergeRepositories)
      .where(and(eq(mergeRepositories.connectionId, id), isNull(mergeRepositories.deletedAt)));
    const taken = new Set(added.map((r) => r.externalId));
    const rows = available.map((repo) => ({ ...repo, added: taken.has(repo.externalId) }));
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    const response = providerFailure(c, err);
    if (response) return response;
    throw err;
  }
});

export default app;
