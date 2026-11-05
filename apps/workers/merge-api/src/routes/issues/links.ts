/**
 * Record links of an issue: /api/merge/issues/:id/links.
 *
 *   GET    /:id/links           -> the records the issue is linked to      (merge_issues:read)
 *   POST   /:id/links           -> link a ticket, company or chat channel   (merge_issues:update)
 *   DELETE /:id/links/:linkId   -> remove a link                            (merge_issues:update)
 *
 * Events: merge_record_link created | deleted.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { createMergeRecordLinkSchema } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { Env, Variables } from '../../types';
import { publishEntityEvents } from '../../services/events';
import { findIssue, insertRecordLinks, listRecordLinks } from '../../services/issues';
import { recordLinkDto, recordLinkEventData } from '../../services/mappers';
import { deleteRecordLink, findRecordLink } from '../../services/record-links';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/:id/links', requirePermission('merge_issues:read'), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  if (!(await findIssue(db, id))) return error.notFound(c, 'Issue', id);
  const rows = await listRecordLinks(db, id);
  return list(c, rows.map(recordLinkDto), cursorPagination(rows.length, false, null));
});

app.post('/:id/links', requirePermission('merge_issues:update'), zValidator('json', createMergeRecordLinkSchema), async (c) => {
  const id = c.req.param('id');
  const db = c.get('tenantDb');
  if (!(await findIssue(db, id))) return error.notFound(c, 'Issue', id);
  const [link] = await insertRecordLinks(db, id, [c.req.valid('json')], c.get('userId'));
  if (!link) return error.conflict(c, 'The issue is already linked to this record');
  publishEntityEvents(c, [
    { entityType: 'merge_record_link', action: 'created', entityId: link.id, data: recordLinkEventData(link) },
  ]);
  return success(c, recordLinkDto(link), 201);
});

app.delete('/:id/links/:linkId', requirePermission('merge_issues:update'), async (c) => {
  const id = c.req.param('id');
  const linkId = c.req.param('linkId');
  const db = c.get('tenantDb');
  if (!(await findIssue(db, id))) return error.notFound(c, 'Issue', id);
  const link = await findRecordLink(db, id, linkId);
  if (!link) return error.notFound(c, 'Link', linkId);
  await deleteRecordLink(db, link);
  publishEntityEvents(c, [
    { entityType: 'merge_record_link', action: 'deleted', entityId: link.id, data: recordLinkEventData(link) },
  ]);
  return noContent(c);
});

export default app;
