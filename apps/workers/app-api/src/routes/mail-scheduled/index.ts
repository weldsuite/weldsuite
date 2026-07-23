/**
 * Scheduled mail routes — /api/mail-scheduled/*.
 *
 * Store-then-send via a Cloudflare Workflow hosted in the api-worker
 * (`SEND_SCHEDULED_EMAIL` cross-worker binding). The workflow class
 * itself stays in api-worker for now; app-api just creates and
 * terminates instances via the binding.
 *
 * Entity events: `email:email_scheduled` on create, `email:email_sent`
 * on send-now, `email:deleted` on cancel.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import * as scheduled from '../../services/mail/scheduled';
import { MailScheduledError } from '../../services/mail/scheduled';
import { checkAccountAccess } from '../../services/mail/access';
import { getMessageAccountId } from '../../services/mail/messages';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const scheduleAttachmentSchema = z.object({
  filename: z.string().min(1).max(500),
  contentType: z.string().max(255).optional(),
  size: z.number().int().nonnegative(),
  fileKey: z.string().min(1),
});

const scheduleBody = z.object({
  accountId: z.string().min(1),
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  htmlBody: z.string().optional(),
  replyTo: z.string().email().optional(),
  importance: z.enum(['low', 'normal', 'high']).optional(),
  attachmentIds: z.array(z.string()).optional(),
  attachments: z.array(scheduleAttachmentSchema).optional(),
  scheduledFor: z.string().datetime(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
});

const rescheduleBody = z.object({ scheduledFor: z.string().datetime() });
const listQuery = z.object({ accountId: z.string().optional() });

function mapScheduledError(c: Parameters<typeof error.badRequest>[0], err: MailScheduledError) {
  switch (err.code) {
    case 'ACCOUNT_NOT_FOUND':
    case 'MESSAGE_NOT_FOUND':
      return error.notFound(c, err.message);
    case 'NOT_SCHEDULED':
      return error.conflict(c, err.message);
    case 'SCHEDULE_IN_PAST':
    case 'SCHEDULE_TOO_FAR':
    case 'ATTACHMENT_NOT_IN_WORKSPACE':
    case 'ATTACHMENT_NOT_IN_STORAGE':
    case 'EMAIL_TOO_LARGE':
      return error.badRequest(c, err.message);
    case 'STORAGE_BINDING_MISSING':
    case 'WORKFLOW_BINDING_MISSING':
      return c.json({ error: { code: err.code, message: err.message } }, 503);
  }
}

app.get('/', requirePermission('messages:read'), zValidator('query', listQuery), async (c) => {
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const filters = c.req.valid('query');
    if (filters.accountId) {
      const allowed = await checkAccountAccess(db, filters.accountId, userId);
      if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    }
    const rows = await scheduled.listScheduled(db, filters);
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/mail-scheduled] list failed:', err);
    return error.internal(c, 'Failed to list scheduled emails');
  }
});

app.post(
  '/',
  requirePermission('messages:create'),
  zValidator('json', scheduleBody),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const data = c.req.valid('json');
    const allowed = await checkAccountAccess(db, data.accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    try {
      const result = await scheduled.scheduleEmail(
        c.env,
        db,
        orgId,
        userId,
        data,
      );
      publishEntityEvent({
        c,
        entityType: 'email',
        entityId: result.messageId,
        action: 'email_scheduled',
        data: {
          id: result.messageId,
          accountId: data.accountId,
          subject: data.subject ?? null,
          from: null,
          to: data.to,
        },
      });
      return success(c, result, 201);
    } catch (err) {
      if (err instanceof MailScheduledError) return mapScheduledError(c, err);
      console.error('[app-api/mail-scheduled] schedule failed:', err);
      return error.internal(c, 'Failed to schedule email');
    }
  },
);

app.post('/:messageId/cancel', requirePermission('messages:delete'), async (c) => {
  const messageId = c.req.param('messageId');
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const accountId = await getMessageAccountId(db, messageId);
    if (!accountId) return error.notFound(c, 'Scheduled message', messageId);
    const allowed = await checkAccountAccess(db, accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    const result = await scheduled.cancelScheduled(c.env, db, messageId);
    publishEntityEvent({
      c,
      entityType: 'email',
      entityId: messageId,
      action: 'deleted',
      data: { id: messageId, accountId: '', subject: null, from: null, to: null },
    });
    return success(c, result);
  } catch (err) {
    if (err instanceof MailScheduledError) return mapScheduledError(c, err);
    console.error('[app-api/mail-scheduled] cancel failed:', err);
    return error.internal(c, 'Failed to cancel scheduled email');
  }
});

app.post(
  '/:messageId/reschedule',
  requirePermission('messages:update'),
  zValidator('json', rescheduleBody),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);
    const messageId = c.req.param('messageId');
    const { scheduledFor } = c.req.valid('json');
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const accountId = await getMessageAccountId(db, messageId);
    if (!accountId) return error.notFound(c, 'Scheduled message', messageId);
    const allowed = await checkAccountAccess(db, accountId, userId);
    if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
    try {
      const result = await scheduled.rescheduleScheduled(
        c.env,
        db,
        orgId,
        userId,
        messageId,
        new Date(scheduledFor),
      );
      return success(c, result);
    } catch (err) {
      if (err instanceof MailScheduledError) return mapScheduledError(c, err);
      console.error('[app-api/mail-scheduled] reschedule failed:', err);
      return error.internal(c, 'Failed to reschedule email');
    }
  },
);

app.post('/:messageId/send-now', requirePermission('messages:update'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  const messageId = c.req.param('messageId');
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const accountId = await getMessageAccountId(db, messageId);
  if (!accountId) return error.notFound(c, 'Scheduled message', messageId);
  const allowed = await checkAccountAccess(db, accountId, userId);
  if (!allowed) return error.forbidden(c, 'Access to this mail account is not allowed');
  try {
    const result = await scheduled.sendScheduledNow(
      c.env,
      db,
      orgId,
      userId,
      messageId,
    );
    publishEntityEvent({
      c,
      entityType: 'email',
      entityId: messageId,
      action: 'email_sent',
      data: { id: messageId, accountId: '', subject: null, from: null, to: null },
    });
    return success(c, result);
  } catch (err) {
    if (err instanceof MailScheduledError) return mapScheduledError(c, err);
    console.error('[app-api/mail-scheduled] send-now failed:', err);
    return error.internal(c, 'Failed to send email immediately');
  }
});

export const mailScheduledRoutes = app;
