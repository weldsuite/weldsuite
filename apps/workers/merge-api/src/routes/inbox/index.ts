/**
 * Inbox route: GET /api/merge/inbox. Derived on every request: review requests,
 * the member's pull requests with failed checks or requested changes, issues
 * assigned to them that changed lately, and their recently merged pull
 * requests. Newest first. The member's own read, snooze and archive state
 * (state.ts) is applied: archived and still-snoozed items are left out unless
 * `?include=archived` / `?include=snoozed`.
 *
 * Permission: merge_pull_requests:read. The assigned-issue items need
 * merge_issues:read as well and are left out without it.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, list } from '@weldsuite/worker-kit/response';
import { listMergeInboxQuerySchema } from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import type { Env, Variables } from '../../types';
import { buildInbox } from '../../services/inbox';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('merge_pull_requests:read'), zValidator('query', listMergeInboxQuerySchema), async (c) => {
  const items = await buildInbox(c.get('tenantDb'), {
    userId: c.get('userId'),
    canReadIssues: await hasContextPermission(c, 'merge_issues:read'),
    include: c.req.valid('query').include,
  });
  return list(c, items, cursorPagination(items.length, false, null));
});

export default app;
