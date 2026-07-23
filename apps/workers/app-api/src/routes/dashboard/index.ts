/**
 * Dashboard routes — read-only /api/dashboard/* surface for the platform
 * workspace home. Ported from apps/api-worker/src/routes/dashboard/index.ts.
 *
 * Aggregates cross-module data (orders/tickets chart, installed apps,
 * recent activity, sidebar badges, onboarding checklist). These are
 * workspace-home reads that span every module, so they are not gated on a
 * single object permission prefix — authentication + tenant resolution is
 * enforced by the `/api/*` Clerk + workspace-db middleware. The single
 * mutation (`POST /onboarding-checklist/dismiss`) only flips a JSONB flag in
 * workspace_settings and is not an entity-object lifecycle event.
 */

import { Hono } from 'hono';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// GET /chart — orders + tickets + revenue over the last 30 days
// ============================================================================

app.get('/chart', async (c) => {
  try {
    const db = c.get('tenantDb');
    const { orders } = schema;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const chartData = await db
      .select({
        date: sql<string>`to_char(${orders.createdAt}, 'YYYY-MM-DD')`,
        orders: sql<number>`count(*)::int`,
        revenue: sql<number>`coalesce(sum(${orders.total}::numeric), 0)::numeric`,
      })
      .from(orders)
      .where(and(isNull(orders.deletedAt), gte(orders.createdAt, thirtyDaysAgo)))
      .groupBy(sql`to_char(${orders.createdAt}, 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(${orders.createdAt}, 'YYYY-MM-DD')`);

    const ticketCountsByDate: Record<string, number> = {};
    try {
      const { helpdeskTickets } = schema;
      const ticketData = await db
        .select({
          date: sql<string>`to_char(${helpdeskTickets.createdAt}, 'YYYY-MM-DD')`,
          tickets: sql<number>`count(*)::int`,
        })
        .from(helpdeskTickets)
        .where(and(isNull(helpdeskTickets.deletedAt), gte(helpdeskTickets.createdAt, thirtyDaysAgo)))
        .groupBy(sql`to_char(${helpdeskTickets.createdAt}, 'YYYY-MM-DD')`);
      for (const row of ticketData) ticketCountsByDate[row.date] = row.tickets;
    } catch {
      // helpdeskTickets table may not exist; ignore.
    }

    const result = chartData.map((row) => ({
      date: row.date,
      orders: row.orders,
      tickets: ticketCountsByDate[row.date] || 0,
      revenue: Number(row.revenue),
    }));

    return success(c, result);
  } catch (err) {
    console.error('[app-api/dashboard] chart failed:', err);
    return success(c, []);
  }
});

// ============================================================================
// GET /installed-apps — installed app codes scoped to the caller's role
// ============================================================================

app.get('/installed-apps', async (c) => {
  try {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const { workspaceInstalledApps, workspaceMembers, userAppAssignments } = schema;

    const apps = await db
      .select({ appCode: workspaceInstalledApps.appCode })
      .from(workspaceInstalledApps)
      .where(and(eq(workspaceInstalledApps.isActive, true), isNull(workspaceInstalledApps.deletedAt)));

    const allAppCodes = apps.map((a) => a.appCode);

    const memberResult = await db
      .select({ role: workspaceMembers.role, roleId: workspaceMembers.roleId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
      .limit(1);

    const role = memberResult[0]?.role?.toUpperCase();

    if (role === 'OWNER' || role === 'ADMIN') {
      return success(c, allAppCodes);
    }

    if (allAppCodes.length === 0) {
      return success(c, []);
    }

    // A member's effective apps = the workspace's installed apps intersected
    // with (apps granted by their role) ∪ (per-user app assignments). Role
    // apps are derived live — editing a role's apps instantly changes what its
    // members can open, with no per-user writes.
    const effective = new Set<string>();

    const roleId = memberResult[0]?.roleId ?? null;
    if (roleId) {
      const { roles } = schema;
      const [roleRow] = await db
        .select({ apps: roles.apps })
        .from(roles)
        .where(and(eq(roles.id, roleId), isNull(roles.deletedAt)))
        .limit(1);
      const installed = new Set(allAppCodes);
      for (const code of ((roleRow?.apps as string[]) || [])) {
        if (installed.has(code)) effective.add(code);
      }
    }

    const assignments = await db
      .select({ appCode: userAppAssignments.appCode })
      .from(userAppAssignments)
      .where(
        and(
          eq(userAppAssignments.userId, userId),
          eq(userAppAssignments.isActive, true),
          inArray(userAppAssignments.appCode, allAppCodes),
        ),
      );
    for (const a of assignments) effective.add(a.appCode);

    return success(c, Array.from(effective));
  } catch (err) {
    console.error('[app-api/dashboard] installed-apps failed:', err);
    return success(c, ['welddesk', 'weldcrm', 'weldstash', 'weldmail', 'parcel', 'weldflow']);
  }
});

// ============================================================================
// GET /activity — recent CRM activity as a cross-module proxy
// ============================================================================

app.get('/activity', async (c) => {
  try {
    const db = c.get('tenantDb');
    const { crmActivities } = schema;

    const activities = await db
      .select()
      .from(crmActivities)
      .where(isNull(crmActivities.deletedAt))
      .orderBy(desc(crmActivities.createdAt))
      .limit(20);

    return success(c, activities);
  } catch (err) {
    console.error('[app-api/dashboard] activity failed:', err);
    return success(c, []);
  }
});

// ============================================================================
// GET /sidebar-badges — unread / open / pending counts for nav badges
// ============================================================================

app.get('/sidebar-badges', async (c) => {
  const badges = { unreadMessages: 0, openTickets: 0, pendingOrders: 0 };

  try {
    const db = c.get('tenantDb');

    try {
      const { mailMessages } = schema;
      const [messageCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(mailMessages)
        .where(and(eq(mailMessages.isRead, false), isNull(mailMessages.deletedAt)));
      badges.unreadMessages = messageCount?.count || 0;
    } catch {
      // mailMessages table may not exist.
    }

    try {
      const { helpdeskTickets } = schema;
      const [ticketCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(helpdeskTickets)
        .where(and(eq(helpdeskTickets.status, 'open'), isNull(helpdeskTickets.deletedAt)));
      badges.openTickets = ticketCount?.count || 0;
    } catch {
      // helpdeskTickets table may not exist.
    }

    try {
      const { orders } = schema;
      const [orderCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .where(and(eq(orders.status, 'pending'), isNull(orders.deletedAt)));
      badges.pendingOrders = orderCount?.count || 0;
    } catch {
      // orders table may not exist.
    }

    return success(c, badges);
  } catch (err) {
    console.error('[app-api/dashboard] sidebar-badges failed:', err);
    return success(c, badges);
  }
});

// ============================================================================
// GET /onboarding-checklist — completion status for getting-started tasks
// ============================================================================

app.get('/onboarding-checklist', async (c) => {
  try {
    const db = c.get('tenantDb');
    const {
      workspaceSettings,
      people: contacts,
      crmPipelines,
      helpdeskDepartments,
      mailAccounts,
      projects,
      tasks,
      hostDomains,
      carriers,
      warehouses,
      accounts,
      socialAccounts,
      workspaceMembers,
    } = schema;

    let dismissedApps: string[] = [];
    let hasLogo = false;
    try {
      const [settings] = await db
        .select({ customSettings: workspaceSettings.customSettings, logoUrl: workspaceSettings.logoUrl })
        .from(workspaceSettings)
        .where(isNull(workspaceSettings.deletedAt))
        .limit(1);
      if (settings) {
        const custom = (settings.customSettings as Record<string, unknown>) || {};
        dismissedApps = (custom.onboardingChecklistDismissedApps as string[]) || [];
        hasLogo = !!settings.logoUrl && settings.logoUrl.trim() !== '';
      }
    } catch {
      // workspace_settings may not exist yet.
    }

    async function hasRows(table: any, deletedAtCol?: any): Promise<boolean> {
      try {
        const conditions = deletedAtCol ? [isNull(deletedAtCol)] : [];
        const [result] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(table)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .limit(1);
        return (result?.count || 0) > 0;
      } catch {
        return false;
      }
    }

    const [
      hasContacts,
      hasPipelines,
      hasDepartments,
      hasMailAccounts,
      hasProjects,
      hasTasks,
      hasDomains,
      hasCarriers,
      hasWarehouses,
      hasAccounts,
      hasSocialAccounts,
      memberCount,
    ] = await Promise.all([
      hasRows(contacts, contacts.deletedAt),
      hasRows(crmPipelines, crmPipelines.deletedAt),
      hasRows(helpdeskDepartments, helpdeskDepartments.deletedAt),
      hasRows(mailAccounts, mailAccounts.deletedAt),
      hasRows(projects, projects.deletedAt),
      hasRows(tasks, tasks.deletedAt),
      hasRows(hostDomains, hostDomains.deletedAt),
      hasRows(carriers, carriers.deletedAt),
      hasRows(warehouses, warehouses.deletedAt),
      hasRows(accounts, accounts.deletedAt),
      hasRows(socialAccounts, socialAccounts.deletedAt),
      (async () => {
        try {
          const [result] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(workspaceMembers)
            .where(isNull(workspaceMembers.deletedAt));
          return (result?.count || 0) > 1;
        } catch {
          return false;
        }
      })(),
    ]);

    const items: Record<string, boolean> = {
      crm_contact_created: hasContacts,
      crm_pipeline_created: hasPipelines,
      helpdesk_department_created: hasDepartments,
      mail_account_connected: hasMailAccounts,
      project_created: hasProjects,
      task_created: hasTasks,
      host_domain_added: hasDomains,
      parcel_carrier_configured: hasCarriers,
      wms_warehouse_added: hasWarehouses,
      accounting_chart_setup: hasAccounts,
      social_account_connected: hasSocialAccounts,
      workspace_member_invited: memberCount,
      workspace_logo_uploaded: hasLogo,
    };

    return success(c, { dismissedApps, items });
  } catch (err) {
    console.error('[app-api/dashboard] onboarding-checklist failed:', err);
    return success(c, { dismissedApps: [], items: {} });
  }
});

// ============================================================================
// POST /onboarding-checklist/dismiss — store dismissed app in workspace_settings
// ============================================================================

app.post('/onboarding-checklist/dismiss', async (c) => {
  try {
    const db = c.get('tenantDb');
    const { workspaceSettings } = schema;
    const { appCode } = await c.req.json<{ appCode: string }>();

    if (!appCode) return error.badRequest(c, 'appCode is required');

    const [existing] = await db
      .select()
      .from(workspaceSettings)
      .where(isNull(workspaceSettings.deletedAt))
      .limit(1);

    if (existing) {
      const custom = (existing.customSettings as Record<string, unknown>) || {};
      const dismissed = (custom.onboardingChecklistDismissedApps as string[]) || [];
      if (!dismissed.includes(appCode)) dismissed.push(appCode);
      await db
        .update(workspaceSettings)
        .set({
          customSettings: { ...custom, onboardingChecklistDismissedApps: dismissed },
          updatedAt: new Date(),
        })
        .where(eq(workspaceSettings.id, existing.id));
    } else {
      await db.insert(workspaceSettings).values({
        id: generateId('ws'),
        customSettings: { onboardingChecklistDismissedApps: [appCode] },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as typeof workspaceSettings.$inferInsert);
    }

    return success(c, { success: true });
  } catch (err) {
    console.error('[app-api/dashboard] dismiss onboarding checklist failed:', err);
    return error.internal(c, 'Failed to dismiss checklist');
  }
});

export const dashboardRoutes = app;
