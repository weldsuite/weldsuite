/**
 * Helpdesk settings routes — /api/helpdesk-settings/* surface.
 * Singleton workspace-level config stored in `helpdeskSettings`.
 * Multi-widget management stored in `helpdeskWidgetSettings` (one per widget).
 * Widget creation/deletion also updates the master `widgetRegistry`.
 *
 * Permissions: settings:read | settings:create | settings:update | settings:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { getMasterDb, masterSchema, schema } from '../../db';
import type { TicketSettings, SatisfactionSettings } from '@weldsuite/db/schema/helpdesk-settings';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// Schemas
// ============================================================================

const notificationSettingsSchema = z.object({
  emailNotifications: z.boolean(),
  pushNotifications: z.boolean(),
  smsNotifications: z.boolean(),
  notifyOnNewTicket: z.boolean().optional(),
  notifyOnAssignment: z.boolean().optional(),
  notifyOnStatusChange: z.boolean().optional(),
  notifyOnCustomerReply: z.boolean().optional(),
  notifyOnSLABreach: z.boolean().optional(),
});

const automationSettingsSchema = z.object({
  enabled: z.boolean(),
  slaBreachAction: z.enum(['escalate_and_notify', 'notify_only', 'none']).optional(),
  priorityAlertThreshold: z.array(z.enum(['urgent', 'high'])).optional(),
});

const ticketSettingsSchema = z.object({
  autoAssignment: z.boolean().optional(),
  requireApproval: z.boolean().optional(),
  allowCustomerCreation: z.boolean().optional(),
  defaultPriority: z.string().optional(),
  defaultStatus: z.string().optional(),
  autoCloseAfterDays: z.number().optional(),
  mergeThreshold: z.number().optional(),
  assignmentStrategy: z.enum(['round_robin', 'least_busy', 'manual']).optional(),
});

const satisfactionSettingsSchema = z.object({
  enableSurveys: z.boolean().optional(),
  sendAfterResolution: z.boolean().optional(),
  delayMinutes: z.number().optional(),
  surveyTemplate: z.string().optional(),
  thankYouMessage: z.string().optional(),
});

const widgetSettingsSchema = z.object({
  widgetName: z.string().optional(),
  pageHome: z.boolean().optional(),
  pageChat: z.boolean().optional(),
  pageHelp: z.boolean().optional(),
  pageParcelTracking: z.boolean().optional(),
  pageChangelog: z.boolean().optional(),
  pageNews: z.boolean().optional(),
  pageFeedback: z.boolean().optional(),
  pageAnnouncements: z.boolean().optional(),
  pageEventSignUp: z.boolean().optional(),
  colorPrimary: z.string().optional(),
  colorButton: z.string().optional(),
  colorButtonText: z.string().optional(),
  colorLauncher: z.string().optional(),
  colorHeader: z.string().optional(),
  colorAccent: z.string().optional(),
  borderRadius: z.string().optional(),
  fontSize: z.string().optional(),
  typographyText: z.string().optional(),
  typographyBackground: z.string().optional(),
  startingPage: z.string().optional(),
  position: z.string().optional(),
  autoOpen: z.boolean().optional(),
  showWelcomeMessage: z.boolean().optional(),
  welcomeMessage: z.string().optional(),
  companyLogoUrl: z.string().optional(),
  chatBackgroundColor: z.string().optional(),
  userBubbleColor: z.string().optional(),
  userBubbleTextColor: z.string().optional(),
  agentBubbleColor: z.string().optional(),
  agentBubbleTextColor: z.string().optional(),
  showBranding: z.boolean().optional(),
  emailCollection: z.enum(['none', 'outside_office_hours', 'always']).optional(),
});

// ============================================================================
// GET / — fetch all settings (singleton + primary widget)
// ============================================================================

app.get('/', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskSettings, helpdeskWidgetSettings } = schema;
  try {
    const [settingsResult, widgetResult] = await Promise.all([
      db.select().from(helpdeskSettings).where(isNull(helpdeskSettings.deletedAt)).limit(1),
      db.select().from(helpdeskWidgetSettings).where(isNull(helpdeskWidgetSettings.deletedAt)).limit(1),
    ]);
    return success(c, {
      settings: settingsResult[0] ?? null,
      widgetSettings: widgetResult[0] ?? null,
    });
  } catch (err) {
    console.error('[app-api/helpdesk-settings] get failed:', err);
    return error.internal(c, 'Failed to fetch helpdesk settings');
  }
});

// ============================================================================
// PUT /notifications
// ============================================================================

app.put('/notifications', requirePermission('settings:update'), zValidator('json', notificationSettingsSchema), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskSettings } = schema;
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select().from(helpdeskSettings).where(isNull(helpdeskSettings.deletedAt)).limit(1);
    const notifs = {
      emailNotifications: data.emailNotifications,
      pushNotifications: data.pushNotifications,
      smsNotifications: data.smsNotifications,
      notifyOnNewTicket: data.notifyOnNewTicket ?? true,
      notifyOnAssignment: data.notifyOnAssignment ?? true,
      notifyOnStatusChange: data.notifyOnStatusChange ?? true,
      notifyOnCustomerReply: data.notifyOnCustomerReply ?? true,
      notifyOnSLABreach: data.notifyOnSLABreach ?? true,
    };
    if (existing) {
      await db.update(helpdeskSettings).set({ notifications: notifs, updatedAt: new Date() }).where(eq(helpdeskSettings.id, existing.id));
      publishEntityEvent({ c, entityType: 'helpdesk_settings', entityId: existing.id, action: 'updated', data: { notifications: notifs } });
    } else {
      const id = generateId('hds');
      await db.insert(helpdeskSettings).values({ id, notifications: notifs, createdAt: new Date(), updatedAt: new Date() } as unknown as typeof helpdeskSettings.$inferInsert);
      publishEntityEvent({ c, entityType: 'helpdesk_settings', entityId: id, action: 'updated', data: { notifications: notifs } });
    }
    return success(c, { success: true });
  } catch (err) {
    console.error('[app-api/helpdesk-settings] update notifications failed:', err);
    return error.internal(c, 'Failed to update notification settings');
  }
});

// ============================================================================
// PUT /automation
// ============================================================================

app.put('/automation', requirePermission('settings:update'), zValidator('json', automationSettingsSchema), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskSettings } = schema;
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select().from(helpdeskSettings).where(isNull(helpdeskSettings.deletedAt)).limit(1);
    if (existing) {
      await db.update(helpdeskSettings).set({ automation: data, updatedAt: new Date() }).where(eq(helpdeskSettings.id, existing.id));
      publishEntityEvent({ c, entityType: 'helpdesk_settings', entityId: existing.id, action: 'updated', data: { automation: data } });
    } else {
      const id = generateId('hds');
      await db.insert(helpdeskSettings).values({ id, automation: data, createdAt: new Date(), updatedAt: new Date() } as unknown as typeof helpdeskSettings.$inferInsert);
      publishEntityEvent({ c, entityType: 'helpdesk_settings', entityId: id, action: 'updated', data: { automation: data } });
    }
    return success(c, { success: true });
  } catch (err) {
    console.error('[app-api/helpdesk-settings] update automation failed:', err);
    return error.internal(c, 'Failed to update automation settings');
  }
});

// ============================================================================
// PUT /tickets
// ============================================================================

app.put('/tickets', requirePermission('settings:update'), zValidator('json', ticketSettingsSchema), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskSettings } = schema;
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select().from(helpdeskSettings).where(isNull(helpdeskSettings.deletedAt)).limit(1);
    if (existing) {
      const merged = { ...((existing.tickets as unknown as Record<string, unknown>) ?? {}), ...data } as TicketSettings;
      await db.update(helpdeskSettings).set({ tickets: merged, updatedAt: new Date() }).where(eq(helpdeskSettings.id, existing.id));
      publishEntityEvent({ c, entityType: 'helpdesk_settings', entityId: existing.id, action: 'updated', data: { tickets: data } });
    } else {
      const id = generateId('hds');
      await db.insert(helpdeskSettings).values({ id, tickets: data, createdAt: new Date(), updatedAt: new Date() } as unknown as typeof helpdeskSettings.$inferInsert);
      publishEntityEvent({ c, entityType: 'helpdesk_settings', entityId: id, action: 'updated', data: { tickets: data } });
    }
    return success(c, { success: true });
  } catch (err) {
    console.error('[app-api/helpdesk-settings] update tickets failed:', err);
    return error.internal(c, 'Failed to update ticket settings');
  }
});

// ============================================================================
// PUT /satisfaction
// ============================================================================

app.put('/satisfaction', requirePermission('settings:update'), zValidator('json', satisfactionSettingsSchema), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskSettings } = schema;
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select().from(helpdeskSettings).where(isNull(helpdeskSettings.deletedAt)).limit(1);
    if (existing) {
      const merged = { ...((existing.satisfaction as unknown as Record<string, unknown>) ?? {}), ...data } as SatisfactionSettings;
      await db.update(helpdeskSettings).set({ satisfaction: merged, updatedAt: new Date() }).where(eq(helpdeskSettings.id, existing.id));
      publishEntityEvent({ c, entityType: 'helpdesk_settings', entityId: existing.id, action: 'updated', data: { satisfaction: data } });
    } else {
      const id = generateId('hds');
      await db.insert(helpdeskSettings).values({ id, satisfaction: data, createdAt: new Date(), updatedAt: new Date() } as unknown as typeof helpdeskSettings.$inferInsert);
      publishEntityEvent({ c, entityType: 'helpdesk_settings', entityId: id, action: 'updated', data: { satisfaction: data } });
    }
    return success(c, { success: true });
  } catch (err) {
    console.error('[app-api/helpdesk-settings] update satisfaction failed:', err);
    return error.internal(c, 'Failed to update satisfaction settings');
  }
});

// ============================================================================
// GET /widget — primary widget (auto-creates if absent)
// ============================================================================

app.get('/widget', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const { helpdeskWidgetSettings } = schema;
  try {
    const result = await db.select().from(helpdeskWidgetSettings).where(isNull(helpdeskWidgetSettings.deletedAt)).limit(1);
    let widgetSettings = result[0] ?? null;

    if (!widgetSettings) {
      const id = generateId('wgt');
      const widgetId = generateId('widget');
      await db.insert(helpdeskWidgetSettings).values({
        id,
        widgetId,
        widgetName: 'Default Widget',
        pageHome: true,
        pageChat: true,
        pageHelp: true,
        pageParcelTracking: false,
        pageChangelog: true,
        pageNews: true,
        pageFeedback: true,
        pageAnnouncements: true,
        pageEventSignUp: false,
        autoOpen: false,
        showWelcomeMessage: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as typeof helpdeskWidgetSettings.$inferInsert);
      // Register in master widgetRegistry
      try {
        const masterDb = getMasterDb(c.env);
        await masterDb.insert(masterSchema.widgetRegistry).values({
          id: generateId('wr'),
          widgetId,
          workspaceId: orgId!,
          widgetName: 'Default Widget',
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as typeof masterSchema.widgetRegistry.$inferInsert);
      } catch { /* registry may already exist */ }
      const [created] = await db.select().from(helpdeskWidgetSettings).where(eq(helpdeskWidgetSettings.id, id)).limit(1);
      widgetSettings = created;
    } else if (!widgetSettings.widgetId) {
      const widgetId = generateId('widget');
      await db.update(helpdeskWidgetSettings).set({ widgetId, updatedAt: new Date() }).where(eq(helpdeskWidgetSettings.id, widgetSettings.id));
      try {
        const masterDb = getMasterDb(c.env);
        await masterDb.insert(masterSchema.widgetRegistry).values({
          id: generateId('wr'),
          widgetId,
          workspaceId: orgId!,
          widgetName: widgetSettings.widgetName ?? 'Default Widget',
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as typeof masterSchema.widgetRegistry.$inferInsert);
      } catch { /* registry may already exist */ }
      widgetSettings = { ...widgetSettings, widgetId };
    }

    return success(c, widgetSettings);
  } catch (err) {
    console.error('[app-api/helpdesk-settings] get widget failed:', err);
    return error.internal(c, 'Failed to fetch widget settings');
  }
});

// ============================================================================
// PUT /widget — upsert primary widget
// ============================================================================

app.put('/widget', requirePermission('settings:update'), zValidator('json', widgetSettingsSchema), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const { helpdeskWidgetSettings } = schema;
  const data = c.req.valid('json');
  try {
    const [existing] = await db.select().from(helpdeskWidgetSettings).where(isNull(helpdeskWidgetSettings.deletedAt)).limit(1);
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) updateData[k] = v;

    if (existing) {
      await db.update(helpdeskWidgetSettings).set(updateData).where(eq(helpdeskWidgetSettings.id, existing.id));
      publishEntityEvent({ c, entityType: 'helpdesk_settings', entityId: existing.id, action: 'updated', data: { id: existing.id, widgetId: existing.widgetId, ...data } });
      return success(c, { id: existing.id, widgetId: existing.widgetId, isNew: false });
    } else {
      const id = generateId('wgt');
      const widgetId = generateId('widget');
      await db.insert(helpdeskWidgetSettings).values({
        id,
        widgetId,
        widgetName: data.widgetName ?? 'Default Widget',
        pageHome: data.pageHome ?? true,
        pageChat: data.pageChat ?? true,
        pageHelp: data.pageHelp ?? true,
        pageParcelTracking: data.pageParcelTracking ?? false,
        pageChangelog: data.pageChangelog ?? true,
        pageNews: data.pageNews ?? true,
        pageFeedback: data.pageFeedback ?? true,
        pageAnnouncements: data.pageAnnouncements ?? true,
        pageEventSignUp: data.pageEventSignUp ?? false,
        autoOpen: data.autoOpen ?? false,
        showWelcomeMessage: data.showWelcomeMessage ?? true,
        showBranding: data.showBranding ?? true,
        emailCollection: data.emailCollection ?? 'none',
        ...updateData,
        createdAt: new Date(),
      } as unknown as typeof helpdeskWidgetSettings.$inferInsert);
      try {
        const masterDb = getMasterDb(c.env);
        await masterDb.insert(masterSchema.widgetRegistry).values({
          id: generateId('wr'),
          widgetId,
          workspaceId: orgId!,
          widgetName: data.widgetName ?? 'Default Widget',
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as typeof masterSchema.widgetRegistry.$inferInsert);
      } catch { /* registry may already exist */ }
      publishEntityEvent({ c, entityType: 'helpdesk_settings', entityId: id, action: 'updated', data: { id, widgetId, ...data } });
      return success(c, { id, widgetId, isNew: true }, 201);
    }
  } catch (err) {
    console.error('[app-api/helpdesk-settings] update widget failed:', err);
    return error.internal(c, 'Failed to update widget settings');
  }
});

// ============================================================================
// PATCH /widget/enabled — toggle widget chat page
// ============================================================================

app.patch('/widget/enabled', requirePermission('settings:update'), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const { helpdeskWidgetSettings } = schema;
  const body = await c.req.json<{ enabled: boolean }>().catch(() => ({ enabled: false }));
  try {
    const [existing] = await db.select().from(helpdeskWidgetSettings).where(isNull(helpdeskWidgetSettings.deletedAt)).limit(1);
    if (existing) {
      await db.update(helpdeskWidgetSettings).set({ pageChat: body.enabled, updatedAt: new Date() }).where(eq(helpdeskWidgetSettings.id, existing.id));
      publishEntityEvent({ c, entityType: 'helpdesk_settings', entityId: existing.id, action: 'updated', data: { id: existing.id, pageChat: body.enabled } });
      return success(c, { id: existing.id, widgetId: existing.widgetId, isNew: false });
    } else {
      const id = generateId('wgt');
      const widgetId = generateId('widget');
      await db.insert(helpdeskWidgetSettings).values({
        id, widgetId, pageChat: body.enabled, pageHome: true, pageHelp: true, widgetName: 'Default Widget', createdAt: new Date(), updatedAt: new Date(),
      } as unknown as typeof helpdeskWidgetSettings.$inferInsert);
      publishEntityEvent({ c, entityType: 'helpdesk_settings', entityId: id, action: 'updated', data: { id, widgetId, pageChat: body.enabled } });
      return success(c, { id, widgetId, isNew: true }, 201);
    }
  } catch (err) {
    console.error('[app-api/helpdesk-settings] toggle widget enabled failed:', err);
    return error.internal(c, 'Failed to update widget enabled status');
  }
});

// ============================================================================
// GET /widgets — list all widgets
// ============================================================================

app.get('/widgets', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskWidgetSettings } = schema;
  try {
    const widgets = await db.select().from(helpdeskWidgetSettings).where(isNull(helpdeskWidgetSettings.deletedAt));
    return success(c, widgets);
  } catch (err) {
    console.error('[app-api/helpdesk-settings] list widgets failed:', err);
    return error.internal(c, 'Failed to list widgets');
  }
});

// ============================================================================
// POST /widgets — create new widget
// ============================================================================

app.post('/widgets', requirePermission('settings:create'), zValidator('json', widgetSettingsSchema), async (c) => {
  const db = c.get('tenantDb');
  const orgId = c.get('orgId');
  const { helpdeskWidgetSettings } = schema;
  const data = c.req.valid('json');
  const id = generateId('wgt');
  const widgetId = generateId('widget');
  const now = new Date();
  try {
    await db.insert(helpdeskWidgetSettings).values({
      id,
      widgetId,
      widgetName: data.widgetName ?? 'New Widget',
      pageHome: data.pageHome ?? true,
      pageChat: data.pageChat ?? true,
      pageHelp: data.pageHelp ?? true,
      pageParcelTracking: data.pageParcelTracking ?? false,
      pageChangelog: data.pageChangelog ?? true,
      pageNews: data.pageNews ?? true,
      pageFeedback: data.pageFeedback ?? true,
      pageAnnouncements: data.pageAnnouncements ?? true,
      pageEventSignUp: data.pageEventSignUp ?? false,
      colorPrimary: data.colorPrimary,
      colorButton: data.colorButton,
      colorButtonText: data.colorButtonText,
      colorLauncher: data.colorLauncher,
      colorHeader: data.colorHeader,
      colorAccent: data.colorAccent,
      borderRadius: data.borderRadius,
      fontSize: data.fontSize,
      typographyText: data.typographyText,
      typographyBackground: data.typographyBackground,
      startingPage: data.startingPage,
      position: data.position,
      autoOpen: data.autoOpen ?? false,
      showWelcomeMessage: data.showWelcomeMessage ?? true,
      welcomeMessage: data.welcomeMessage,
      companyLogoUrl: data.companyLogoUrl,
      showBranding: data.showBranding ?? true,
      chatBackgroundColor: data.chatBackgroundColor,
      userBubbleColor: data.userBubbleColor,
      userBubbleTextColor: data.userBubbleTextColor,
      agentBubbleColor: data.agentBubbleColor,
      agentBubbleTextColor: data.agentBubbleTextColor,
      emailCollection: data.emailCollection ?? 'none',
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof helpdeskWidgetSettings.$inferInsert);
    try {
      const masterDb = getMasterDb(c.env);
      await masterDb.insert(masterSchema.widgetRegistry).values({
        id: generateId('wr'),
        widgetId,
        workspaceId: orgId!,
        widgetName: data.widgetName ?? 'New Widget',
        isActive: true,
        createdAt: now,
        updatedAt: now,
      } as unknown as typeof masterSchema.widgetRegistry.$inferInsert);
    } catch { /* registry error is non-fatal */ }
    publishEntityEvent({
      c,
      entityType: 'helpdesk_widget',
      entityId: id,
      action: 'created',
      data: { id, widgetId, widgetName: data.widgetName ?? 'New Widget' },
    });
    return success(c, { id, widgetId, widgetName: data.widgetName ?? 'New Widget' }, 201);
  } catch (err) {
    console.error('[app-api/helpdesk-settings] create widget failed:', err);
    return error.internal(c, 'Failed to create widget');
  }
});

// ============================================================================
// GET /widgets/:widgetId
// ============================================================================

app.get('/widgets/:widgetId', requirePermission('settings:read'), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskWidgetSettings } = schema;
  const widgetId = c.req.param('widgetId');
  try {
    const [widget] = await db
      .select()
      .from(helpdeskWidgetSettings)
      .where(and(eq(helpdeskWidgetSettings.widgetId, widgetId), isNull(helpdeskWidgetSettings.deletedAt)))
      .limit(1);
    if (!widget) return error.notFound(c, 'Widget', widgetId);
    return success(c, widget);
  } catch (err) {
    console.error('[app-api/helpdesk-settings] get widget by id failed:', err);
    return error.internal(c, 'Failed to fetch widget');
  }
});

// ============================================================================
// PUT /widgets/:widgetId
// ============================================================================

app.put('/widgets/:widgetId', requirePermission('settings:update'), zValidator('json', widgetSettingsSchema), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskWidgetSettings } = schema;
  const widgetId = c.req.param('widgetId');
  const data = c.req.valid('json');
  try {
    const [existing] = await db
      .select()
      .from(helpdeskWidgetSettings)
      .where(and(eq(helpdeskWidgetSettings.widgetId, widgetId), isNull(helpdeskWidgetSettings.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Widget', widgetId);
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) updateData[k] = v;
    await db.update(helpdeskWidgetSettings).set(updateData).where(eq(helpdeskWidgetSettings.id, existing.id));
    if (data.widgetName !== undefined) {
      try {
        const masterDb = getMasterDb(c.env);
        await masterDb
          .update(masterSchema.widgetRegistry)
          .set({ widgetName: data.widgetName, updatedAt: new Date() })
          .where(eq(masterSchema.widgetRegistry.widgetId, widgetId));
      } catch { /* registry error is non-fatal */ }
    }
    publishEntityEvent({
      c,
      entityType: 'helpdesk_widget',
      entityId: existing.id,
      action: 'updated',
      data: { id: existing.id, widgetId, ...data },
    });
    return success(c, { id: existing.id, widgetId });
  } catch (err) {
    console.error('[app-api/helpdesk-settings] update widget by id failed:', err);
    return error.internal(c, 'Failed to update widget');
  }
});

// ============================================================================
// DELETE /widgets/:widgetId — soft-delete, prevent last widget deletion
// ============================================================================

app.delete('/widgets/:widgetId', requirePermission('settings:delete'), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskWidgetSettings } = schema;
  const widgetId = c.req.param('widgetId');
  try {
    const [existing] = await db
      .select()
      .from(helpdeskWidgetSettings)
      .where(and(eq(helpdeskWidgetSettings.widgetId, widgetId), isNull(helpdeskWidgetSettings.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Widget', widgetId);

    const [countRes] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(helpdeskWidgetSettings)
      .where(isNull(helpdeskWidgetSettings.deletedAt));
    if ((countRes?.count ?? 0) <= 1) {
      return c.json({ success: false, error: 'Cannot delete the last widget.' }, 400);
    }

    await db
      .update(helpdeskWidgetSettings)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(helpdeskWidgetSettings.id, existing.id));
    try {
      const masterDb = getMasterDb(c.env);
      await masterDb.update(masterSchema.widgetRegistry).set({ isActive: false, updatedAt: new Date() }).where(eq(masterSchema.widgetRegistry.widgetId, widgetId));
    } catch { /* registry error is non-fatal */ }
    publishEntityEvent({
      c,
      entityType: 'helpdesk_widget',
      entityId: existing.id,
      action: 'deleted',
      data: { id: existing.id, widgetId },
    });
    return success(c, { success: true });
  } catch (err) {
    console.error('[app-api/helpdesk-settings] delete widget failed:', err);
    return error.internal(c, 'Failed to delete widget');
  }
});

export const helpdeskSettingsRoutes = app;
