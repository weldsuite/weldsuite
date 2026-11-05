/**
 * Per-member inbox state: /api/merge/inbox/items/:itemKey and /api/merge/inbox/read-all.
 *
 *   PATCH /items/:itemKey {read?, snoozedUntil?, archived?} -> the item's state (created on first use)
 *   POST  /read-all                                         -> marks every visible unread item read
 *
 * Permission: merge_pull_requests:read. Own rows only: the state is the
 * member's, never anyone else's. No entity events: this is per-member UI state
 * (the sweep in routes/_sweeps.test.ts only scans each directory's index.ts).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { error, success } from '@weldsuite/worker-kit/response';
import { updateMergeInboxItemSchema } from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import type { Env, Variables } from '../../types';
import { markInboxRead, updateInboxItem } from '../../services/inbox';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** The longest item key `merge_inbox_states.item_key` holds. */
const MAX_ITEM_KEY = 200;

app.patch('/items/:itemKey', requirePermission('merge_pull_requests:read'), zValidator('json', updateMergeInboxItemSchema), async (c) => {
  const itemKey = c.req.param('itemKey');
  if (itemKey.length > MAX_ITEM_KEY) return error.badRequest(c, 'The item key is too long');
  return success(c, await updateInboxItem(c.get('tenantDb'), c.get('userId'), itemKey, c.req.valid('json')));
});

app.post('/read-all', requirePermission('merge_pull_requests:read'), async (c) => {
  const updated = await markInboxRead(c.get('tenantDb'), {
    userId: c.get('userId'),
    canReadIssues: await hasContextPermission(c, 'merge_issues:read'),
  });
  return success(c, { updated });
});

export default app;
