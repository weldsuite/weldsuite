/**
 * Form routes — /api/forms/forms/*.
 *
 *   GET    /                         → list (folder, status, search, sort, cursor)
 *   POST   /                         → new form (blank, from a template, from a definition)
 *   GET    /:id                      → the draft, settings and what the member may do
 *   PATCH  /:id                      → save the draft (optimistic `revision`, 409 REVISION_CONFLICT)
 *   DELETE /:id                      → delete with responses, files and links
 *   POST   /:id/duplicate            → a copy as a new draft, with the same audience (needs `edit`)
 *   POST   /:id/publish|close|reopen → lifecycle (publish snapshots a version, refreshes the public cache)
 *   POST   /:id/discard              → throw the draft away, back to the published version
 *   GET    /:id/versions[/:versionId]
 *   GET|PUT /:id/access              → the member list of a restricted form
 *   GET|PUT /:id/subscription        → the member's own notification setting (PUT needs `readResponses`)
 *
 * A restricted form the member is not on is a 404 (services/access.ts).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createFormSchema,
  duplicateFormSchema,
  formSubscriptionSchema,
  listFormsQuerySchema,
  setFormAccessSchema,
  updateFormSchema,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { FormsError, handle } from '../../lib/errors';
import { resolveGrants } from '../../services/access';
import { workspaceCtx } from '../../services/context';
import { formEventData } from '../../services/events';
import { createForm, deleteForm, duplicateForm, listAccess, listForms, setAccess, updateForm } from '../../services/forms';
import { closeForm, discardChanges, getVersion, listVersions, publishForm, reopenForm } from '../../services/publishing';
import { getSubscription, setSubscription } from '../../services/settings';
import type { Env, Variables } from '../../types';
import { detailOf, loadForm } from './shared';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', requirePermission('forms:read'), zValidator('query', listFormsQuerySchema), (c) =>
  handle(c, async () => {
    const ctx = workspaceCtx(c);
    const result = await listForms(ctx, c.get('userId'), await resolveGrants(c), c.req.valid('query'));
    return list(c, result.rows, cursorPagination(result.total, result.next !== null, result.next));
  }),
);

app.post('/', requirePermission('forms:create'), zValidator('json', createFormSchema), (c) =>
  handle(c, async () => {
    const ctx = workspaceCtx(c);
    const form = await createForm(ctx, c.get('userId'), c.req.valid('json'));
    publishEntityEvent({ c, entityType: 'form', entityId: form.id, action: 'created', data: formEventData(form) });
    return success(c, await detailOf(await loadForm(c, form.id), form), 201);
  }),
);

app.get('/:id', requirePermission('forms:read'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'));
    return success(c, await detailOf(loaded));
  }),
);

app.patch('/:id', requirePermission('forms:update'), zValidator('json', updateFormSchema), (c) =>
  handle(c, async () => {
    const input = c.req.valid('json');
    const loaded = await loadForm(c, c.req.param('id'), 'edit');
    if (input.access !== undefined && !loaded.permissions.manageAccess) {
      throw new FormsError(403, 'FORBIDDEN', 'Only the owner can change who can see this form.');
    }
    const form = await updateForm(loaded.ctx, loaded.form, input);
    publishEntityEvent({ c, entityType: 'form', entityId: form.id, action: 'updated', data: formEventData(form) });
    return success(c, await detailOf(loaded, form));
  }),
);

app.delete('/:id', requirePermission('forms:delete'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'delete');
    const keys = await deleteForm(loaded.ctx, loaded.form);
    // R2 deletes take 1000 keys a call; the files are gone from the DB already, so this is best effort.
    for (let i = 0; i < keys.length; i += 1000) c.executionCtx.waitUntil(c.env.PRIVATE_STORAGE.delete(keys.slice(i, i + 1000)));
    publishEntityEvent({ c, entityType: 'form', entityId: loaded.form.id, action: 'deleted', data: formEventData(loaded.form) });
    return noContent(c);
  }),
);

// The copy keeps the original's audience (`access` and its access list), and
// only someone who may edit the original may copy it: a `results` member of a
// restricted form cannot make a copy everyone sees.
app.post('/:id/duplicate', requirePermission('forms:create'), zValidator('json', duplicateFormSchema), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'edit');
    const copy = await duplicateForm(loaded.ctx, loaded.form, loaded.userId, c.req.valid('json').title);
    publishEntityEvent({ c, entityType: 'form', entityId: copy.id, action: 'created', data: formEventData(copy) });
    return success(c, await detailOf(await loadForm(c, copy.id), copy), 201);
  }),
);

// ── Lifecycle ────────────────────────────────────────────────────────────────

app.post('/:id/publish', requirePermission('forms:publish'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'publish');
    const { form, version } = await publishForm(loaded.ctx, loaded.form, loaded.userId);
    publishEntityEvent({ c, entityType: 'form', entityId: form.id, action: 'published', data: formEventData(form, { version: version.number }) });
    return success(c, { form: await detailOf(loaded, form), version });
  }),
);

app.post('/:id/close', requirePermission('forms:publish'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'publish');
    const form = await closeForm(loaded.ctx, loaded.form);
    publishEntityEvent({ c, entityType: 'form', entityId: form.id, action: 'closed', data: formEventData(form) });
    return success(c, await detailOf(loaded, form));
  }),
);

app.post('/:id/reopen', requirePermission('forms:publish'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'publish');
    const form = await reopenForm(loaded.ctx, loaded.form);
    publishEntityEvent({ c, entityType: 'form', entityId: form.id, action: 'updated', data: formEventData(form) });
    return success(c, await detailOf(loaded, form));
  }),
);

app.post('/:id/discard', requirePermission('forms:update'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'edit');
    const form = await discardChanges(loaded.ctx, loaded.form);
    publishEntityEvent({ c, entityType: 'form', entityId: form.id, action: 'updated', data: formEventData(form) });
    return success(c, await detailOf(loaded, form));
  }),
);

// ── Versions ─────────────────────────────────────────────────────────────────

app.get('/:id/versions', requirePermission('forms:read'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'));
    return success(c, await listVersions(loaded.ctx, loaded.form.id));
  }),
);

app.get('/:id/versions/:versionId', requirePermission('forms:read'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'));
    return success(c, await getVersion(loaded.ctx, loaded.form.id, c.req.param('versionId')));
  }),
);

// ── Access list ──────────────────────────────────────────────────────────────

app.get('/:id/access', requirePermission('forms:read'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'manageAccess');
    return success(c, await listAccess(loaded.ctx, loaded.form.id));
  }),
);

app.put('/:id/access', requirePermission('forms:update'), zValidator('json', setFormAccessSchema), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'manageAccess');
    const entries = await setAccess(loaded.ctx, loaded.form, c.req.valid('json'));
    publishEntityEvent({ c, entityType: 'form', entityId: loaded.form.id, action: 'updated', data: formEventData(loaded.form) });
    return success(c, entries);
  }),
);

// ── My notification setting ──────────────────────────────────────────────────

app.get('/:id/subscription', requirePermission('forms:read'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'));
    return success(c, await getSubscription(loaded.ctx, loaded.form.id, loaded.userId));
  }),
);

// Instant mails and the daily digest carry answers and respondents' addresses:
// following a form takes the right to read its responses.
app.put('/:id/subscription', requirePermission('forms:read'), zValidator('json', formSubscriptionSchema), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'readResponses');
    return success(c, await setSubscription(loaded.ctx, loaded.form.id, loaded.userId, c.req.valid('json')));
  }),
);

export default app;
