/**
 * Inbox route: GET /api/merge/inbox. Derived on every request (nothing stored
 * in phase 1): review requests, the member's pull requests with failed checks
 * or requested changes, issues assigned to them that changed lately, and their
 * recently merged pull requests. Newest first.
 *
 * Permission: merge_pull_requests:read. The assigned-issue items need
 * merge_issues:read as well and are left out without it.
 */

import { Hono } from 'hono';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, list } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { buildInbox } from '../../services/inbox';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('merge_pull_requests:read'), async (c) => {
  const items = await buildInbox(c.get('tenantDb'), {
    userId: c.get('userId'),
    canReadIssues: await hasContextPermission(c, 'merge_issues:read'),
  });
  return list(c, items, cursorPagination(items.length, false, null));
});

export default app;
