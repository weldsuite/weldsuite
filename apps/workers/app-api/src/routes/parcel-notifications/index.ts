/**
 * Parcel notifications routes — /api/parcel-notifications/* CRUD for
 * email/SMS/WhatsApp notification templates and outbound webhooks used by
 * the parcel/shipping module.
 *
 * Backed by: `emailTemplates`, `smsTemplates`, `whatsAppTemplates`,
 * `externalWebhooks`, `webhookDeliveries`.
 *
 * Permissions: orders:read (all operations). The source used orders:read
 * throughout — preserved here.
 *
 * Entity events: entity type `notification_template` with actions
 * created / updated / deleted.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createEmailTemplateSchema,
  updateEmailTemplateSchema,
  createSmsTemplateSchema,
  updateSmsTemplateSchema,
  createWhatsAppTemplateSchema,
  updateWhatsAppTemplateSchema,
  createWebhookSchema,
  updateWebhookSchema,
} from '@weldsuite/app-api-client/schemas/parcel-notifications';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const { emailTemplates, smsTemplates, whatsAppTemplates, externalWebhooks, webhookDeliveries } = schema;

// ── Shared pagination helper ──────────────────────────────────────────────────

/** Simple offset-based page → offset calculation. */
function pageOffset(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}

// ── Email Templates ───────────────────────────────────────────────────────────

app.get('/email', requirePermission('orders:read'), async (c) => {
  const q = c.req.query();
  const page = Math.max(1, q.page ? parseInt(q.page, 10) : 1);
  const pageSize = Math.min(q.pageSize ? parseInt(q.pageSize, 10) : 20, 100);

  try {
    const db = c.get('tenantDb');
    const conditions: ReturnType<typeof eq>[] = [isNull(emailTemplates.deletedAt)];

    if (q.search) {
      const term = `%${q.search}%`;
      conditions.push(or(like(emailTemplates.name, term), like(emailTemplates.subject, term))!);
    }
    if (q.isActive !== undefined) conditions.push(eq(emailTemplates.isActive, q.isActive === 'true'));
    if (q.triggerEvent) conditions.push(eq(emailTemplates.triggerEvent, q.triggerEvent));

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(emailTemplates)
      .where(and(...conditions));

    const totalCount = countRow?.count ?? 0;
    const rows = await db
      .select()
      .from(emailTemplates)
      .where(and(...conditions))
      .orderBy(desc(emailTemplates.createdAt))
      .limit(pageSize)
      .offset(pageOffset(page, pageSize));

    return c.json({
      data: {
        templates: rows.map((t) => ({
          ...t,
          createdAt: t.createdAt?.toISOString(),
          updatedAt: t.updatedAt?.toISOString(),
          lastUsedAt: t.lastUsedAt?.toISOString(),
        })),
        pagination: {
          page,
          pageSize,
          totalCount,
          totalPages: Math.ceil(totalCount / pageSize),
          hasMore: page * pageSize < totalCount,
        },
      },
    });
  } catch (err) {
    console.error('[app-api/parcel-notifications] list email templates failed:', err);
    return error.internal(c, 'Failed to fetch email templates');
  }
});

app.get('/email/:id', requirePermission('orders:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const [row] = await db
      .select()
      .from(emailTemplates)
      .where(and(eq(emailTemplates.id, id), isNull(emailTemplates.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'Email template', id);
    return success(c, { ...row, createdAt: row.createdAt?.toISOString(), updatedAt: row.updatedAt?.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() });
  } catch (err) {
    console.error('[app-api/parcel-notifications] get email template failed:', err);
    return error.internal(c, 'Failed to fetch email template');
  }
});

app.post('/email', requirePermission('orders:read'), zValidator('json', createEmailTemplateSchema), async (c) => {
  const data = c.req.valid('json');
  const id = generateId('etpl');
  const now = new Date();
  try {
    const db = c.get('tenantDb');
    await db.insert(emailTemplates).values({
      id,
      name: data.name,
      subject: data.subject,
      body: data.body,
      htmlBody: data.htmlBody,
      variables: data.variables,
      triggerEvent: data.triggerEvent,
      isActive: data.isActive,
      isDefault: data.isDefault,
      description: data.description,
      tags: data.tags,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof emailTemplates.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'notification_template',
      entityId: id,
      action: 'created',
      data: { id, templateType: 'email', name: data.name },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/parcel-notifications] create email template failed:', err);
    return error.internal(c, 'Failed to create email template');
  }
});

app.put('/email/:id', requirePermission('orders:read'), zValidator('json', updateEmailTemplateSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const db = c.get('tenantDb');
    const [existing] = await db
      .select({ id: emailTemplates.id })
      .from(emailTemplates)
      .where(and(eq(emailTemplates.id, id), isNull(emailTemplates.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Email template', id);
    await db
      .update(emailTemplates)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(emailTemplates.id, id), isNull(emailTemplates.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'notification_template',
      entityId: id,
      action: 'updated',
      data: { id, templateType: 'email' },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/parcel-notifications] update email template failed:', err);
    return error.internal(c, 'Failed to update email template');
  }
});

app.patch('/email/:id/toggle', requirePermission('orders:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const [current] = await db
      .select({ isActive: emailTemplates.isActive })
      .from(emailTemplates)
      .where(and(eq(emailTemplates.id, id), isNull(emailTemplates.deletedAt)))
      .limit(1);
    if (!current) return error.notFound(c, 'Email template', id);
    await db
      .update(emailTemplates)
      .set({ isActive: !current.isActive, updatedAt: new Date() })
      .where(and(eq(emailTemplates.id, id), isNull(emailTemplates.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'notification_template',
      entityId: id,
      action: 'updated',
      data: { id, templateType: 'email', isActive: !current.isActive },
    });
    return success(c, { id, isActive: !current.isActive });
  } catch (err) {
    console.error('[app-api/parcel-notifications] toggle email template failed:', err);
    return error.internal(c, 'Failed to toggle email template status');
  }
});

app.delete('/email/:id', requirePermission('orders:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const [existing] = await db
      .select({ id: emailTemplates.id })
      .from(emailTemplates)
      .where(and(eq(emailTemplates.id, id), isNull(emailTemplates.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Email template', id);
    await db
      .update(emailTemplates)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(emailTemplates.id, id), isNull(emailTemplates.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'notification_template',
      entityId: id,
      action: 'deleted',
      data: { id, templateType: 'email' },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/parcel-notifications] delete email template failed:', err);
    return error.internal(c, 'Failed to delete email template');
  }
});

// ── SMS Templates ─────────────────────────────────────────────────────────────

app.get('/sms', requirePermission('orders:read'), async (c) => {
  const q = c.req.query();
  const page = Math.max(1, q.page ? parseInt(q.page, 10) : 1);
  const pageSize = Math.min(q.pageSize ? parseInt(q.pageSize, 10) : 20, 100);

  try {
    const db = c.get('tenantDb');
    const conditions: ReturnType<typeof eq>[] = [isNull(smsTemplates.deletedAt)];

    if (q.search) {
      const term = `%${q.search}%`;
      conditions.push(or(like(smsTemplates.name, term), like(smsTemplates.message, term))!);
    }
    if (q.isActive !== undefined) conditions.push(eq(smsTemplates.isActive, q.isActive === 'true'));
    if (q.triggerEvent) conditions.push(eq(smsTemplates.triggerEvent, q.triggerEvent));

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(smsTemplates)
      .where(and(...conditions));

    const totalCount = countRow?.count ?? 0;
    const rows = await db
      .select()
      .from(smsTemplates)
      .where(and(...conditions))
      .orderBy(desc(smsTemplates.createdAt))
      .limit(pageSize)
      .offset(pageOffset(page, pageSize));

    return c.json({
      data: {
        templates: rows.map((t) => ({ ...t, createdAt: t.createdAt?.toISOString(), updatedAt: t.updatedAt?.toISOString(), lastUsedAt: t.lastUsedAt?.toISOString() })),
        pagination: { page, pageSize, totalCount, totalPages: Math.ceil(totalCount / pageSize), hasMore: page * pageSize < totalCount },
      },
    });
  } catch (err) {
    console.error('[app-api/parcel-notifications] list sms templates failed:', err);
    return error.internal(c, 'Failed to fetch SMS templates');
  }
});

app.get('/sms/:id', requirePermission('orders:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const [row] = await db
      .select()
      .from(smsTemplates)
      .where(and(eq(smsTemplates.id, id), isNull(smsTemplates.deletedAt)))
      .limit(1);
    if (!row) return error.notFound(c, 'SMS template', id);
    return success(c, { ...row, createdAt: row.createdAt?.toISOString(), updatedAt: row.updatedAt?.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() });
  } catch (err) {
    console.error('[app-api/parcel-notifications] get sms template failed:', err);
    return error.internal(c, 'Failed to fetch SMS template');
  }
});

app.post('/sms', requirePermission('orders:read'), zValidator('json', createSmsTemplateSchema), async (c) => {
  const data = c.req.valid('json');
  const id = generateId('stpl');
  const now = new Date();
  try {
    const db = c.get('tenantDb');
    await db.insert(smsTemplates).values({
      id,
      name: data.name,
      message: data.message,
      maxLength: data.maxLength,
      variables: data.variables,
      triggerEvent: data.triggerEvent,
      isActive: data.isActive,
      isDefault: data.isDefault,
      description: data.description,
      tags: data.tags,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof smsTemplates.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'notification_template',
      entityId: id,
      action: 'created',
      data: { id, templateType: 'sms', name: data.name },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/parcel-notifications] create sms template failed:', err);
    return error.internal(c, 'Failed to create SMS template');
  }
});

app.put('/sms/:id', requirePermission('orders:read'), zValidator('json', updateSmsTemplateSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const db = c.get('tenantDb');
    const [existing] = await db.select({ id: smsTemplates.id }).from(smsTemplates).where(and(eq(smsTemplates.id, id), isNull(smsTemplates.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'SMS template', id);
    await db.update(smsTemplates).set({ ...data, updatedAt: new Date() }).where(and(eq(smsTemplates.id, id), isNull(smsTemplates.deletedAt)));
    publishEntityEvent({ c, entityType: 'notification_template', entityId: id, action: 'updated', data: { id, templateType: 'sms' } });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/parcel-notifications] update sms template failed:', err);
    return error.internal(c, 'Failed to update SMS template');
  }
});

app.patch('/sms/:id/toggle', requirePermission('orders:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const [current] = await db.select({ isActive: smsTemplates.isActive }).from(smsTemplates).where(and(eq(smsTemplates.id, id), isNull(smsTemplates.deletedAt))).limit(1);
    if (!current) return error.notFound(c, 'SMS template', id);
    await db.update(smsTemplates).set({ isActive: !current.isActive, updatedAt: new Date() }).where(and(eq(smsTemplates.id, id), isNull(smsTemplates.deletedAt)));
    publishEntityEvent({ c, entityType: 'notification_template', entityId: id, action: 'updated', data: { id, templateType: 'sms', isActive: !current.isActive } });
    return success(c, { id, isActive: !current.isActive });
  } catch (err) {
    console.error('[app-api/parcel-notifications] toggle sms template failed:', err);
    return error.internal(c, 'Failed to toggle SMS template status');
  }
});

app.delete('/sms/:id', requirePermission('orders:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const [existing] = await db.select({ id: smsTemplates.id }).from(smsTemplates).where(and(eq(smsTemplates.id, id), isNull(smsTemplates.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'SMS template', id);
    await db.update(smsTemplates).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(smsTemplates.id, id), isNull(smsTemplates.deletedAt)));
    publishEntityEvent({ c, entityType: 'notification_template', entityId: id, action: 'deleted', data: { id, templateType: 'sms' } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/parcel-notifications] delete sms template failed:', err);
    return error.internal(c, 'Failed to delete SMS template');
  }
});

// ── WhatsApp Templates ────────────────────────────────────────────────────────

app.get('/whatsapp', requirePermission('orders:read'), async (c) => {
  const q = c.req.query();
  const page = Math.max(1, q.page ? parseInt(q.page, 10) : 1);
  const pageSize = Math.min(q.pageSize ? parseInt(q.pageSize, 10) : 20, 100);

  try {
    const db = c.get('tenantDb');
    const conditions: ReturnType<typeof eq>[] = [isNull(whatsAppTemplates.deletedAt)];

    if (q.search) {
      const term = `%${q.search}%`;
      conditions.push(or(like(whatsAppTemplates.name, term), like(whatsAppTemplates.message, term))!);
    }
    if (q.isActive !== undefined) conditions.push(eq(whatsAppTemplates.isActive, q.isActive === 'true'));
    if (q.triggerEvent) conditions.push(eq(whatsAppTemplates.triggerEvent, q.triggerEvent));
    if (q.approvalStatus) conditions.push(eq(whatsAppTemplates.approvalStatus, q.approvalStatus));

    const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(whatsAppTemplates).where(and(...conditions));
    const totalCount = countRow?.count ?? 0;
    const rows = await db
      .select()
      .from(whatsAppTemplates)
      .where(and(...conditions))
      .orderBy(desc(whatsAppTemplates.createdAt))
      .limit(pageSize)
      .offset(pageOffset(page, pageSize));

    return c.json({
      data: {
        templates: rows.map((t) => ({ ...t, createdAt: t.createdAt?.toISOString(), updatedAt: t.updatedAt?.toISOString(), lastUsedAt: t.lastUsedAt?.toISOString() })),
        pagination: { page, pageSize, totalCount, totalPages: Math.ceil(totalCount / pageSize), hasMore: page * pageSize < totalCount },
      },
    });
  } catch (err) {
    console.error('[app-api/parcel-notifications] list whatsapp templates failed:', err);
    return error.internal(c, 'Failed to fetch WhatsApp templates');
  }
});

app.get('/whatsapp/:id', requirePermission('orders:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const [row] = await db.select().from(whatsAppTemplates).where(and(eq(whatsAppTemplates.id, id), isNull(whatsAppTemplates.deletedAt))).limit(1);
    if (!row) return error.notFound(c, 'WhatsApp template', id);
    return success(c, { ...row, createdAt: row.createdAt?.toISOString(), updatedAt: row.updatedAt?.toISOString(), lastUsedAt: row.lastUsedAt?.toISOString() });
  } catch (err) {
    console.error('[app-api/parcel-notifications] get whatsapp template failed:', err);
    return error.internal(c, 'Failed to fetch WhatsApp template');
  }
});

app.post('/whatsapp', requirePermission('orders:read'), zValidator('json', createWhatsAppTemplateSchema), async (c) => {
  const data = c.req.valid('json');
  const id = generateId('wtpl');
  const now = new Date();
  try {
    const db = c.get('tenantDb');
    await db.insert(whatsAppTemplates).values({
      id,
      name: data.name,
      message: data.message,
      headerText: data.headerText,
      footerText: data.footerText,
      variables: data.variables,
      mediaType: data.mediaType,
      mediaUrl: data.mediaUrl,
      buttons: data.buttons,
      triggerEvent: data.triggerEvent,
      isActive: data.isActive,
      isDefault: data.isDefault,
      approvalStatus: 'pending',
      description: data.description,
      tags: data.tags,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof whatsAppTemplates.$inferInsert);
    publishEntityEvent({ c, entityType: 'notification_template', entityId: id, action: 'created', data: { id, templateType: 'whatsapp', name: data.name } });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/parcel-notifications] create whatsapp template failed:', err);
    return error.internal(c, 'Failed to create WhatsApp template');
  }
});

app.put('/whatsapp/:id', requirePermission('orders:read'), zValidator('json', updateWhatsAppTemplateSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const db = c.get('tenantDb');
    const [existing] = await db.select({ id: whatsAppTemplates.id }).from(whatsAppTemplates).where(and(eq(whatsAppTemplates.id, id), isNull(whatsAppTemplates.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'WhatsApp template', id);
    await db.update(whatsAppTemplates).set({ ...data, updatedAt: new Date() }).where(and(eq(whatsAppTemplates.id, id), isNull(whatsAppTemplates.deletedAt)));
    publishEntityEvent({ c, entityType: 'notification_template', entityId: id, action: 'updated', data: { id, templateType: 'whatsapp' } });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/parcel-notifications] update whatsapp template failed:', err);
    return error.internal(c, 'Failed to update WhatsApp template');
  }
});

app.patch('/whatsapp/:id/toggle', requirePermission('orders:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const [current] = await db.select({ isActive: whatsAppTemplates.isActive }).from(whatsAppTemplates).where(and(eq(whatsAppTemplates.id, id), isNull(whatsAppTemplates.deletedAt))).limit(1);
    if (!current) return error.notFound(c, 'WhatsApp template', id);
    await db.update(whatsAppTemplates).set({ isActive: !current.isActive, updatedAt: new Date() }).where(and(eq(whatsAppTemplates.id, id), isNull(whatsAppTemplates.deletedAt)));
    publishEntityEvent({ c, entityType: 'notification_template', entityId: id, action: 'updated', data: { id, templateType: 'whatsapp', isActive: !current.isActive } });
    return success(c, { id, isActive: !current.isActive });
  } catch (err) {
    console.error('[app-api/parcel-notifications] toggle whatsapp template failed:', err);
    return error.internal(c, 'Failed to toggle WhatsApp template status');
  }
});

app.delete('/whatsapp/:id', requirePermission('orders:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const [existing] = await db.select({ id: whatsAppTemplates.id }).from(whatsAppTemplates).where(and(eq(whatsAppTemplates.id, id), isNull(whatsAppTemplates.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'WhatsApp template', id);
    await db.update(whatsAppTemplates).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(whatsAppTemplates.id, id), isNull(whatsAppTemplates.deletedAt)));
    publishEntityEvent({ c, entityType: 'notification_template', entityId: id, action: 'deleted', data: { id, templateType: 'whatsapp' } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/parcel-notifications] delete whatsapp template failed:', err);
    return error.internal(c, 'Failed to delete WhatsApp template');
  }
});

// ── Webhooks ──────────────────────────────────────────────────────────────────

app.get('/webhooks', requirePermission('orders:read'), async (c) => {
  const q = c.req.query();
  const page = Math.max(1, q.page ? parseInt(q.page, 10) : 1);
  const pageSize = Math.min(q.pageSize ? parseInt(q.pageSize, 10) : 20, 100);
  const statusFilter = q.status;

  try {
    const db = c.get('tenantDb');
    const conditions: ReturnType<typeof eq>[] = [isNull(externalWebhooks.deletedAt)];
    if (statusFilter && statusFilter !== 'all') conditions.push(eq(externalWebhooks.status, statusFilter));

    const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(externalWebhooks).where(and(...conditions));
    const totalCount = countRow?.count ?? 0;

    const rows = await db
      .select()
      .from(externalWebhooks)
      .where(and(...conditions))
      .orderBy(desc(externalWebhooks.createdAt))
      .limit(pageSize)
      .offset(pageOffset(page, pageSize));

    return c.json({
      data: {
        webhooks: rows.map((w) => ({
          id: w.id,
          name: w.name,
          description: w.description,
          url: w.url,
          events: w.events ?? [],
          status: w.status,
          isActive: w.status === 'active',
          callCount: w.totalDeliveries ?? 0,
          totalDeliveries: w.totalDeliveries ?? 0,
          totalFailures: w.totalFailures ?? 0,
          consecutiveFailures: w.consecutiveFailures ?? 0,
          lastDeliveredAt: w.lastDeliveredAt?.toISOString(),
          lastFailedAt: w.lastFailedAt?.toISOString(),
          createdAt: w.createdAt?.toISOString(),
          updatedAt: w.updatedAt?.toISOString(),
        })),
        pagination: { page, pageSize, totalCount, totalPages: Math.ceil(totalCount / pageSize), hasMore: page * pageSize < totalCount },
      },
    });
  } catch (err) {
    console.error('[app-api/parcel-notifications] list webhooks failed:', err);
    return error.internal(c, 'Failed to fetch webhooks');
  }
});

app.get('/webhooks/:id', requirePermission('orders:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const [w] = await db.select().from(externalWebhooks).where(and(eq(externalWebhooks.id, id), isNull(externalWebhooks.deletedAt))).limit(1);
    if (!w) return error.notFound(c, 'Webhook', id);
    return success(c, {
      id: w.id, name: w.name, description: w.description, url: w.url,
      events: w.events ?? [], status: w.status, isActive: w.status === 'active',
      headers: w.headers,
      totalDeliveries: w.totalDeliveries ?? 0, totalFailures: w.totalFailures ?? 0,
      consecutiveFailures: w.consecutiveFailures ?? 0,
      lastDeliveredAt: w.lastDeliveredAt?.toISOString(),
      lastFailedAt: w.lastFailedAt?.toISOString(),
      lastFailureReason: w.lastFailureReason,
      createdAt: w.createdAt?.toISOString(), updatedAt: w.updatedAt?.toISOString(),
    });
  } catch (err) {
    console.error('[app-api/parcel-notifications] get webhook failed:', err);
    return error.internal(c, 'Failed to fetch webhook');
  }
});

app.post('/webhooks', requirePermission('orders:read'), zValidator('json', createWebhookSchema), async (c) => {
  const userId = c.get('userId');
  const data = c.req.valid('json');
  const id = generateId('whk');
  const secret = data.secret ?? generateId('whksec');
  const now = new Date();
  try {
    const db = c.get('tenantDb');
    await db.insert(externalWebhooks).values({
      id,
      createdBy: userId,
      name: data.name,
      url: data.url,
      events: data.events,
      secret,
      description: data.description,
      headers: data.headers,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof externalWebhooks.$inferInsert);
    publishEntityEvent({ c, entityType: 'notification_template', entityId: id, action: 'created', data: { id, templateType: 'webhook', name: data.name } });
    return success(c, { id, secret }, 201);
  } catch (err) {
    console.error('[app-api/parcel-notifications] create webhook failed:', err);
    return error.internal(c, 'Failed to create webhook');
  }
});

app.put('/webhooks/:id', requirePermission('orders:read'), zValidator('json', updateWebhookSchema), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const db = c.get('tenantDb');
    const [existing] = await db.select({ id: externalWebhooks.id }).from(externalWebhooks).where(and(eq(externalWebhooks.id, id), isNull(externalWebhooks.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Webhook', id);
    await db.update(externalWebhooks).set({ ...data, updatedAt: new Date() }).where(and(eq(externalWebhooks.id, id), isNull(externalWebhooks.deletedAt)));
    publishEntityEvent({ c, entityType: 'notification_template', entityId: id, action: 'updated', data: { id, templateType: 'webhook' } });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/parcel-notifications] update webhook failed:', err);
    return error.internal(c, 'Failed to update webhook');
  }
});

app.patch('/webhooks/:id/enable', requirePermission('orders:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const [existing] = await db.select({ id: externalWebhooks.id }).from(externalWebhooks).where(and(eq(externalWebhooks.id, id), isNull(externalWebhooks.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Webhook', id);
    await db.update(externalWebhooks).set({ status: 'active', updatedAt: new Date() }).where(and(eq(externalWebhooks.id, id), isNull(externalWebhooks.deletedAt)));
    publishEntityEvent({ c, entityType: 'notification_template', entityId: id, action: 'updated', data: { id, templateType: 'webhook', status: 'active' } });
    return success(c, { id, status: 'active' });
  } catch (err) {
    console.error('[app-api/parcel-notifications] enable webhook failed:', err);
    return error.internal(c, 'Failed to enable webhook');
  }
});

app.patch('/webhooks/:id/disable', requirePermission('orders:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const [existing] = await db.select({ id: externalWebhooks.id }).from(externalWebhooks).where(and(eq(externalWebhooks.id, id), isNull(externalWebhooks.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Webhook', id);
    await db.update(externalWebhooks).set({ status: 'paused', updatedAt: new Date() }).where(and(eq(externalWebhooks.id, id), isNull(externalWebhooks.deletedAt)));
    publishEntityEvent({ c, entityType: 'notification_template', entityId: id, action: 'updated', data: { id, templateType: 'webhook', status: 'paused' } });
    return success(c, { id, status: 'paused' });
  } catch (err) {
    console.error('[app-api/parcel-notifications] disable webhook failed:', err);
    return error.internal(c, 'Failed to disable webhook');
  }
});

app.post('/webhooks/:id/test', requirePermission('orders:read'), async (c) => {
  const webhookId = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const [webhook] = await db.select().from(externalWebhooks).where(and(eq(externalWebhooks.id, webhookId), isNull(externalWebhooks.deletedAt))).limit(1);
    if (!webhook) return error.notFound(c, 'Webhook', webhookId);

    const testPayload = { event: 'test', timestamp: new Date().toISOString(), data: { message: 'This is a test webhook delivery' } };
    const deliveryId = generateId('whdel');

    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      webhookId,
      eventType: 'test',
      eventId: `test_${Date.now()}`,
      payload: testPayload,
      status: 'pending',
      createdAt: new Date(),
    } as unknown as typeof webhookDeliveries.$inferInsert);

    const startTime = Date.now();
    try {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey('raw', encoder.encode(webhook.secret ?? ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const payloadStr = JSON.stringify(testPayload);
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadStr));
      const sigHex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Event': 'test', 'X-Webhook-Signature': sigHex, ...(webhook.headers as Record<string, string> ?? {}) },
        body: payloadStr,
      });
      const responseTimeMs = Date.now() - startTime;
      const responseBody = await response.text().catch(() => '');

      if (response.ok) {
        await Promise.all([
          db.update(webhookDeliveries).set({ status: 'delivered', responseStatus: response.status, responseBody, responseTimeMs, deliveredAt: new Date() }).where(eq(webhookDeliveries.id, deliveryId)),
          db.update(externalWebhooks).set({ lastDeliveredAt: new Date(), totalDeliveries: (webhook.totalDeliveries ?? 0) + 1, consecutiveFailures: 0, updatedAt: new Date() }).where(eq(externalWebhooks.id, webhookId)),
        ]);
        return success(c, { delivered: true, status: response.status, responseTimeMs });
      } else {
        await Promise.all([
          db.update(webhookDeliveries).set({ status: 'failed', responseStatus: response.status, responseBody, responseTimeMs, errorMessage: `HTTP ${response.status}` }).where(eq(webhookDeliveries.id, deliveryId)),
          db.update(externalWebhooks).set({ lastFailedAt: new Date(), lastFailureReason: `HTTP ${response.status}`, totalFailures: (webhook.totalFailures ?? 0) + 1, consecutiveFailures: (webhook.consecutiveFailures ?? 0) + 1, updatedAt: new Date() }).where(eq(externalWebhooks.id, webhookId)),
        ]);
        return success(c, { delivered: false, status: response.status, error: responseBody });
      }
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : 'Network error';
      await Promise.all([
        db.update(webhookDeliveries).set({ status: 'failed', errorMessage: msg }).where(eq(webhookDeliveries.id, deliveryId)),
        db.update(externalWebhooks).set({ lastFailedAt: new Date(), lastFailureReason: msg, totalFailures: (webhook.totalFailures ?? 0) + 1, consecutiveFailures: (webhook.consecutiveFailures ?? 0) + 1, updatedAt: new Date() }).where(eq(externalWebhooks.id, webhookId)),
      ]);
      return success(c, { delivered: false, error: msg });
    }
  } catch (err) {
    console.error('[app-api/parcel-notifications] webhook test failed:', err);
    return error.internal(c, 'Failed to test webhook');
  }
});

app.get('/webhooks/:id/logs', requirePermission('orders:read'), async (c) => {
  const webhookId = c.req.param('id');
  const q = c.req.query();
  const page = Math.max(1, q.page ? parseInt(q.page, 10) : 1);
  const pageSize = Math.min(q.pageSize ? parseInt(q.pageSize, 10) : 20, 100);

  try {
    const db = c.get('tenantDb');
    const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, webhookId));
    const totalCount = countRow?.count ?? 0;

    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(pageSize)
      .offset(pageOffset(page, pageSize));

    return c.json({
      data: {
        items: rows.map((d) => ({
          id: d.id, eventType: d.eventType, eventId: d.eventId, status: d.status,
          responseStatus: d.responseStatus, responseTimeMs: d.responseTimeMs,
          errorMessage: d.errorMessage, attemptNumber: d.attemptNumber,
          createdAt: d.createdAt?.toISOString(), deliveredAt: d.deliveredAt?.toISOString(),
        })),
        meta: { page, limit: pageSize, total: totalCount, totalPages: Math.ceil(totalCount / pageSize) },
      },
    });
  } catch (err) {
    console.error('[app-api/parcel-notifications] webhook logs failed:', err);
    return error.internal(c, 'Failed to fetch webhook logs');
  }
});

app.delete('/webhooks/:id', requirePermission('orders:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const db = c.get('tenantDb');
    const [existing] = await db.select({ id: externalWebhooks.id }).from(externalWebhooks).where(and(eq(externalWebhooks.id, id), isNull(externalWebhooks.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Webhook', id);
    await db.update(externalWebhooks).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(externalWebhooks.id, id), isNull(externalWebhooks.deletedAt)));
    publishEntityEvent({ c, entityType: 'notification_template', entityId: id, action: 'deleted', data: { id, templateType: 'webhook' } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/parcel-notifications] delete webhook failed:', err);
    return error.internal(c, 'Failed to delete webhook');
  }
});

export const parcelNotificationsRoutes = app;
