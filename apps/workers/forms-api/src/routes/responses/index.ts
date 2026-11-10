/**
 * Responses, results and exports of one form — /api/forms/forms/:id/…
 *
 *   GET    /:id/responses                       → list (status, dates, q, version, person, invitation, answer filters, sort, cursor)
 *   GET    /:id/responses/export?format=csv|xlsx
 *   POST   /:id/responses/bulk-delete
 *   GET    /:id/responses/:rid                  → one response with its integration actions
 *   DELETE /:id/responses/:rid
 *   GET    /:id/responses/:rid/files/:fileId    → streamed from the private bucket
 *   POST   /:id/responses/:rid/actions/:actionId/retry
 *   GET    /:id/columns | /:id/summary | /:id/insights
 *
 * Mounted next to `routes/forms` on the same prefix. Permissions: the
 * workspace's `form_responses:read|export|delete`, narrowed by the member's
 * relation to the form (restricted form → 404). Deleting publishes
 * `form_response:deleted`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  bulkDeleteFormResponsesSchema,
  exportFormResponsesQuerySchema,
  formSummaryQuerySchema,
  listFormResponsesQuerySchema,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { z } from 'zod';
import { countersFor } from '../../lib/counters';
import { handle } from '../../lib/errors';
import { exportResponses } from '../../services/export';
import { buildColumns, loadVersions } from '../../services/response-model';
import { deleteResponses, findResponseFile, getResponse, listResponses, retryAction, type DeletedResponse } from '../../services/responses';
import { insights, summarise } from '../../services/results';
import type { Env, Variables } from '../../types';
import { loadForm, type Ctx } from '../forms/shared';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const insightsQuerySchema = z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() });

/** One `form_response:deleted` event per response, after the delete went through. */
export function publishDeleted(c: Ctx, deleted: DeletedResponse[]): void {
  for (const r of deleted) {
    publishEntityEvent({
      c,
      entityType: 'form_response',
      action: 'deleted',
      entityId: r.id,
      data: {
        id: r.id,
        formId: r.formId,
        formTitle: r.formTitle,
        number: r.number,
        respondentEmail: r.respondentEmail,
        personId: r.personId,
        invitationId: r.invitationId,
      },
    });
  }
}

/** The bucket keys are removed after the answer, 1000 at a time (R2's limit per call). */
export function dropFiles(c: Ctx, keys: string[]): void {
  for (let i = 0; i < keys.length; i += 1000) c.executionCtx.waitUntil(c.env.PRIVATE_STORAGE.delete(keys.slice(i, i + 1000)));
}

// ── List and export ──────────────────────────────────────────────────────────

app.get('/:id/responses', requirePermission('form_responses:read'), zValidator('query', listFormResponsesQuerySchema), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'readResponses');
    const result = await listResponses(loaded.ctx, loaded.form.id, c.req.valid('query'));
    return list(c, result.rows, cursorPagination(result.total, result.next !== null, result.next));
  }),
);

app.get('/:id/responses/export', requirePermission('form_responses:export'), zValidator('query', exportFormResponsesQuerySchema), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'exportResponses');
    const file = await exportResponses(loaded.ctx, loaded.form, c.req.valid('query'));
    return new Response(file.body, {
      status: 200,
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `attachment; filename="${file.filename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }),
);

app.post('/:id/responses/bulk-delete', requirePermission('form_responses:delete'), zValidator('json', bulkDeleteFormResponsesSchema), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'deleteResponses');
    const { deleted, keys } = await deleteResponses(loaded.ctx, c.req.valid('json').ids, { formId: loaded.form.id });
    dropFiles(c, keys);
    publishDeleted(c, deleted);
    return success(c, { deleted: deleted.length });
  }),
);

// ── One response ─────────────────────────────────────────────────────────────

app.get('/:id/responses/:rid', requirePermission('form_responses:read'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'readResponses');
    return success(c, await getResponse(loaded.ctx, loaded.form.id, c.req.param('rid')));
  }),
);

app.delete('/:id/responses/:rid', requirePermission('form_responses:delete'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'deleteResponses');
    const { deleted, keys } = await deleteResponses(loaded.ctx, [c.req.param('rid')], { formId: loaded.form.id });
    if (deleted.length === 0) return c.json({ error: { code: 'NOT_FOUND', message: 'Response not found' } }, 404);
    dropFiles(c, keys);
    publishDeleted(c, deleted);
    return noContent(c);
  }),
);

/** Streams an uploaded file or signature. Never cached, never sniffed, always a download. */
app.get('/:id/responses/:rid/files/:fileId', requirePermission('form_responses:read'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'readResponses');
    const file = await findResponseFile(loaded.ctx, loaded.form.id, c.req.param('rid'), c.req.param('fileId'));
    const object = await c.env.PRIVATE_STORAGE.get(file.storageKey);
    if (!object) return c.json({ error: { code: 'NOT_FOUND', message: 'The file is no longer available.' } }, 404);
    return new Response(object.body, {
      status: 200,
      headers: {
        'Content-Type': file.contentType,
        'Content-Length': String(file.sizeBytes),
        'Content-Disposition': `attachment; filename="${file.name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }),
);

/** Runs the step of one integration again; the response shows it pending until the workflow finishes. */
app.post('/:id/responses/:rid/actions/:actionId/retry', requirePermission('forms:update'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'edit');
    await retryAction(loaded.ctx, loaded.form, c.req.param('rid'), c.req.param('actionId'), (p) => c.executionCtx.waitUntil(p));
    return success(c, { queued: true as const });
  }),
);

// ── Columns, summary, insights ───────────────────────────────────────────────

app.get('/:id/columns', requirePermission('form_responses:read'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'readResponses');
    return success(c, buildColumns(await loadVersions(loaded.ctx.db, loaded.form.id)));
  }),
);

app.get('/:id/summary', requirePermission('form_responses:read'), zValidator('query', formSummaryQuerySchema), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'readResponses');
    return success(c, await summarise(loaded.ctx, loaded.form.id, c.req.valid('query')));
  }),
);

app.get('/:id/insights', requirePermission('form_responses:read'), zValidator('query', insightsQuerySchema), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'readResponses');
    return success(c, await insights(loaded.ctx, loaded.form.id, countersFor(c.env.FORM_COUNTERS, loaded.form.id), c.req.valid('query')));
  }),
);

export default app;
