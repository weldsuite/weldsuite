/**
 * Record link lookup: /api/merge/record-links.
 *
 *   GET /?recordType=&recordId=  -> the issues a ticket, company or chat channel is linked to,
 *                                   each with its status, team key and the shipped release (if any)
 *
 * Permission: merge_issues:read. Links are created and removed through the issue
 * (`/issues/:id/links`).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, list } from '@weldsuite/worker-kit/response';
import { listMergeRecordLinksQuerySchema } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import type { Env, Variables } from '../../types';
import { listLinkedIssues } from '../../services/record-links';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('merge_issues:read'), zValidator('query', listMergeRecordLinksQuerySchema), async (c) => {
  const { recordType, recordId } = c.req.valid('query');
  const rows = await listLinkedIssues(c.get('tenantDb'), recordType, recordId);
  return list(c, rows, cursorPagination(rows.length, false, null));
});

export default app;
