/**
 * Pull request routes: /api/merge/pull-requests/*. Read-only: the mirror is
 * written by sync (webhooks, adding a repository, Refresh), never by a member.
 *
 *   GET /     -> view needs_review | mine | open | merged | closed; repositoryId, teamId, q; cursor
 *   GET /:id  -> detail with the linked issues
 *
 * Permission: merge_pull_requests:read.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import { listMergePullRequestsQuerySchema } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { Env, Variables } from '../../types';
import { getPullRequestDetail, listPullRequests } from '../../services/pull-requests';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('merge_pull_requests:read'), zValidator('query', listMergePullRequestsQuerySchema), async (c) => {
  const page = await listPullRequests(c.get('tenantDb'), c.req.valid('query'), c.get('userId'));
  return list(c, page.items, cursorPagination(page.items.length, page.hasMore, page.cursor));
});

app.get('/:id', requirePermission('merge_pull_requests:read'), async (c) => {
  const id = c.req.param('id');
  const detail = await getPullRequestDetail(c.get('tenantDb'), id);
  if (!detail) return error.notFound(c, 'Pull request', id);
  return success(c, detail);
});

export default app;
