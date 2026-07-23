/**
 * Mail campaign routes — /api/mail-campaigns/*.
 *
 * CRUD on bulk-send campaigns. The actual fan-out (per-recipient send +
 * tracking pixel + bounce handling) is owned by a separate worker;
 * this surface only manages the campaign record.
 *
 * Status guard: once a campaign is in `sent`, `cancelled`, or `failed`,
 * only tags and preheader can be edited.
 *
 * Entity events: `mail_campaign:created | updated | deleted`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import * as campaigns from '../../services/mail/campaigns';
import { MailCampaignError } from '../../services/mail/campaigns';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const statusEnum = z.enum([
  'draft', 'scheduled', 'sending', 'sent', 'paused', 'cancelled', 'failed',
]);

const recipientListSchema = z.object({
  type: z.enum(['contacts', 'people', 'segments', 'manual', 'csv']),
  contactIds: z.array(z.string()).optional(),
  personIds: z.array(z.string()).optional(),
  segmentIds: z.array(z.string()).optional(),
  emails: z.array(z.object({ email: z.string().email(), name: z.string().optional() })).optional(),
  csvUrl: z.string().url().optional(),
  excludeUnsubscribed: z.boolean().optional(),
  excludeBounced: z.boolean().optional(),
});

const listQuery = z.object({
  status: statusEnum.optional(),
  templateId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

const baseBody = {
  templateId: z.string().optional(),
  name: z.string().min(1).max(255),
  subject: z.string().min(1).max(998),
  preheader: z.string().max(500).optional(),
  htmlContent: z.string().min(1),
  textContent: z.string().optional(),
  recipientList: recipientListSchema,
  fromName: z.string().min(1).max(255),
  fromEmail: z.string().email().max(255),
  replyToEmail: z.string().email().max(255).optional(),
  scheduledAt: z.string().datetime().optional(),
  status: statusEnum.optional(),
  trackOpens: z.boolean().optional(),
  trackClicks: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
} as const;

const createBody = z.object(baseBody);
const updateBody = z.object(baseBody).partial();

function mapCampaignError(c: Parameters<typeof error.badRequest>[0], err: MailCampaignError) {
  switch (err.code) {
    case 'NOT_FOUND':
      return error.notFound(c, 'Campaign');
    case 'INVALID_TRANSITION':
      return error.conflict(c, err.message);
  }
}

app.get('/', requirePermission('campaigns:read'), zValidator('query', listQuery), async (c) => {
  try {
    const result = await campaigns.listCampaigns(c.get('tenantDb'), c.req.valid('query'));
    return list(c, result.data, cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    console.error('[app-api/mail-campaigns] list failed:', err);
    return error.internal(c, 'Failed to list campaigns');
  }
});

app.get('/:id', requirePermission('campaigns:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await campaigns.getCampaign(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'Campaign', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/mail-campaigns] get failed:', err);
    return error.internal(c, 'Failed to fetch campaign');
  }
});

app.post('/', requirePermission('campaigns:create'), zValidator('json', createBody), async (c) => {
  try {
    const row = await campaigns.createCampaign(c.get('tenantDb'), c.req.valid('json'));
    publishEntityEvent({
      c,
      entityType: 'mail_campaign',
      entityId: row.id,
      action: 'created',
      data: { id: row.id, name: row.name, status: row.status },
    });
    return success(c, row, 201);
  } catch (err) {
    console.error('[app-api/mail-campaigns] create failed:', err);
    return error.internal(c, 'Failed to create campaign');
  }
});

const updateRoute = async (
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }>,
) => {
  const id = c.req.param('id');
  const data = c.req.valid('json' as never) as z.infer<typeof updateBody>;
  try {
    const result = await campaigns.updateCampaign(c.get('tenantDb'), id, data);
    publishEntityEvent({
      c,
      entityType: 'mail_campaign',
      entityId: id,
      action: 'updated',
      data: { id, name: result.after.name, status: result.after.status },
    });
    return success(c, result.after);
  } catch (err) {
    if (err instanceof MailCampaignError) return mapCampaignError(c, err);
    console.error('[app-api/mail-campaigns] update failed:', err);
    return error.internal(c, 'Failed to update campaign');
  }
};

app.put('/:id', requirePermission('campaigns:update'), zValidator('json', updateBody), updateRoute);
app.patch('/:id', requirePermission('campaigns:update'), zValidator('json', updateBody), updateRoute);

app.delete('/:id', requirePermission('campaigns:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const deleted = await campaigns.softDeleteCampaign(c.get('tenantDb'), id);
    if (!deleted) return error.notFound(c, 'Campaign', id);
    publishEntityEvent({
      c,
      entityType: 'mail_campaign',
      entityId: id,
      action: 'deleted',
      data: { id, name: deleted.name, status: deleted.status },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/mail-campaigns] delete failed:', err);
    return error.internal(c, 'Failed to delete campaign');
  }
});

export const mailCampaignsRoutes = app;
