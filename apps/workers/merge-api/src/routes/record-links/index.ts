/**
 * Record link lookup: /api/merge/record-links.
 *
 *   GET /?recordType=&recordId=  -> the issues a ticket, company or chat channel is linked to,
 *                                   each with its status, team key and the shipped release (if any)
 *
 * Permission: merge_issues:read. Links are created and removed through the issue
 * (`/issues/:id/links`). A link's stored title is the record's: null unless the
 * caller may read the record (its module's read permission, or channel access).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, list } from '@weldsuite/worker-kit/response';
import { listMergeRecordLinksQuerySchema } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import type { Env, Variables } from '../../types';
import { listLinkedIssues } from '../../services/record-links';
import { titleAccess } from '../shared';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('merge_issues:read'), zValidator('query', listMergeRecordLinksQuerySchema), async (c) => {
  const { recordType, recordId } = c.req.valid('query');
  const rows = await listLinkedIssues(c.get('tenantDb'), recordType, recordId);
  // The record's own title only for a caller who may read the record (`withVisibleTitles`).
  const visible = rows.length === 0 || (await titleAccess(c)(recordType, recordId));
  const out = visible ? rows : rows.map((r) => ({ ...r, link: { ...r.link, title: null } }));
  return list(c, out, cursorPagination(out.length, false, null));
});

export default app;
