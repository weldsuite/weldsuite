/**
 * Git-provider connection routes: /api/merge/connections/*.
 *
 *   GET    /                                -> connections (merge_connections:read)
 *   POST   /github                          -> adopt the workspace's GitHub App installation, or { status: 'needs_install' }
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
import { githubClientFor, githubFailure, type Ctx } from '../shared';
import { publishEntityEvents } from '../../services/events';
import { connectionDto } from '../../services/mappers';
import { mergeRepositories, type MergeConnectionRow } from '../../services/db';
import {
  connectGithub,
  deleteConnection,
  findConnection,
  listConnections,
  repositoryCount,
} from '../../services/connections';
import { listInstallationRepositories } from '../../services/github-client';
import { connectionEventData, repositoryEventData } from '../../services/repositories';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function publishConnectionEvent(c: Ctx, connection: MergeConnectionRow, action: 'created' | 'deleted') {
  publishEntityEvents(c, [
    { entityType: 'merge_connection', action, entityId: connection.id, data: connectionEventData(connection) },
  ]);
}

app.get('/', requirePermission('merge_connections:read'), async (c) => {
  const rows = await listConnections(c.get('tenantDb'));
  return list(c, rows.map((r) => connectionDto(r.row, r.repositoryCount)), cursorPagination(rows.length, false, null));
});

app.post('/github', requirePermission('merge_connections:manage'), async (c) => {
  const db = c.get('tenantDb');
  const result = await connectGithub(db, c.get('userId'));
  if (result.status === 'needs_install') return success(c, { status: 'needs_install' as const });
  if (result.created) publishConnectionEvent(c, result.connection, 'created');
  const count = await repositoryCount(db, result.connection.id);
  return success(c, { status: 'connected' as const, connection: connectionDto(result.connection, count) }, result.created ? 201 : 200);
});

app.delete('/:id', requirePermission('merge_connections:manage'), async (c) => {
  const id = c.req.param('id');
  const result = await deleteConnection(c.get('tenantDb'), id);
  if (!result) return error.notFound(c, 'Connection', id);
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
  if (!connection || connection.provider !== 'github') return error.notFound(c, 'Connection', id);
  try {
    const available = await listInstallationRepositories(githubClientFor(c)(connection.externalAccountId));
    const added = await db
      .select({ externalId: mergeRepositories.externalId })
      .from(mergeRepositories)
      .where(and(eq(mergeRepositories.connectionId, id), isNull(mergeRepositories.deletedAt)));
    const taken = new Set(added.map((r) => r.externalId));
    const rows = available.map((repo) => ({
      externalId: String(repo.id),
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch ?? null,
      url: repo.html_url ?? null,
      added: taken.has(String(repo.id)),
    }));
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    const response = githubFailure(c, err);
    if (response) return response;
    throw err;
  }
});

export default app;
