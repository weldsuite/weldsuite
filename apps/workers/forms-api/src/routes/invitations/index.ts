/**
 * Invitations of one form — /api/forms/forms/:id/invitations/*
 *
 *   POST /:id/invitations                  → invite members, CRM people, a CRM list, pasted addresses
 *   GET  /:id/invitations                  → list (status, q, cursor)
 *   GET  /:id/invitations/stats
 *   POST /:id/invitations/remind           → everyone who has not answered, or the given ones
 *   POST /:id/invitations/:iid/revoke      → every link of the invitation stops working
 *
 * `forms:send`, narrowed by the member's role on the form. Events:
 * `form_invitation:sent` (with `reminder: true` for reminders) and `:revoked`;
 * `:completed` comes from the submit. The workspace is marked due in the
 * reminder index so the 15-minute sweep sees the next automatic reminder.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { markWorkspaceDue } from '@weldsuite/worker-kit/due-index';
import { cursorPagination, list, success } from '@weldsuite/worker-kit/response';
import {
  createFormInvitationsSchema,
  listFormInvitationsQuerySchema,
  remindFormInvitationsSchema,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { handle } from '../../lib/errors';
import { createInvitations, invitationStats, listInvitations, remindInvitations, revokeInvitation, toInvitationDto } from '../../services/invitations';
import type { Env, Variables } from '../../types';
import { loadForm } from '../forms/shared';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/:id/invitations', requirePermission('forms:send'), zValidator('json', createFormInvitationsSchema), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'send');
    const { result, created, nextReminderAt } = await createInvitations(loaded.ctx, loaded.form, loaded.userId, c.req.valid('json'));
    for (const row of created) {
      publishEntityEvent({
        c,
        entityType: 'form_invitation',
        action: 'sent',
        entityId: row.id,
        data: { id: row.id, formId: row.formId, email: row.email, personId: row.personId },
      });
    }
    if (nextReminderAt) c.executionCtx.waitUntil(markWorkspaceDue(c.env.SCHEDULE_INDEX, 'forms_reminders', loaded.ctx.clerkOrgId, nextReminderAt));
    return success(c, result, 201);
  }),
);

app.get('/:id/invitations', requirePermission('forms:send'), zValidator('query', listFormInvitationsQuerySchema), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'send');
    const page = await listInvitations(loaded.ctx, loaded.form.id, c.req.valid('query'));
    return list(c, page.rows, cursorPagination(page.total, page.next !== null, page.next));
  }),
);

app.get('/:id/invitations/stats', requirePermission('forms:send'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'send');
    return success(c, await invitationStats(loaded.ctx, loaded.form.id));
  }),
);

app.post('/:id/invitations/remind', requirePermission('forms:send'), zValidator('json', remindFormInvitationsSchema), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'send');
    const outcome = await remindInvitations(loaded.ctx, loaded.form, loaded.userId, c.req.valid('json').invitationIds);
    for (const row of outcome.reminded) {
      publishEntityEvent({
        c,
        entityType: 'form_invitation',
        action: 'sent',
        entityId: row.id,
        data: { id: row.id, formId: row.formId, email: row.email, personId: row.personId, reminder: true },
      });
    }
    if (outcome.nextReminderAt) c.executionCtx.waitUntil(markWorkspaceDue(c.env.SCHEDULE_INDEX, 'forms_reminders', loaded.ctx.clerkOrgId, outcome.nextReminderAt));
    return success(c, outcome.result);
  }),
);

app.post('/:id/invitations/:iid/revoke', requirePermission('forms:send'), (c) =>
  handle(c, async () => {
    const loaded = await loadForm(c, c.req.param('id'), 'send');
    const row = await revokeInvitation(loaded.ctx, loaded.form.id, c.req.param('iid'));
    publishEntityEvent({
      c,
      entityType: 'form_invitation',
      action: 'revoked',
      entityId: row.id,
      data: { id: row.id, formId: row.formId, email: row.email, personId: row.personId },
    });
    return success(c, toInvitationDto(row));
  }),
);

export default app;
