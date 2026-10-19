/**
 * Dashboard routes — read-only /api/dashboard/* surface for the platform
 * workspace home. Ported from apps/api-worker/src/routes/dashboard/index.ts.
 *
 * Aggregates cross-module data (orders/tickets chart, installed apps,
 * recent activity, sidebar badges, onboarding checklist). These are
 * workspace-home reads that span every module, so there is no single route
 * gate; instead each section is gated on the object it reads and comes back
 * empty/zero for a member without it (`orders:read` for order counts and
 * revenue, `tickets:read` for ticket counts, `activities:read` for the CRM
 * activity feed). The mail badge counts only mailboxes the member may open.
 * Authentication + tenant resolution is the `/api/*` Clerk + workspace-db
 * middleware. The single
 * mutation (`POST /onboarding-checklist/dismiss`) only flips a JSONB flag in
 * workspace_settings and is not an entity-object lifecycle event.
 */

import { Hono } from 'hono';
import { and, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Env, Variables } from '../../types';
import { hasContextPermission } from '@weldsuite/permissions/server';
import { error, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import { listAccessibleAccountIds } from '@weldsuite/mail-domain/access';
import { listMemberAppCodes } from '../../services/member-apps';
import { ensureMemberLinked } from '../../services/member-link';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// GET /chart — orders + tickets + revenue over the last 30 days
// ============================================================================

type ChartPoint = { date: string; orders: number; tickets: number; revenue: number };

app.get('/chart', async (c) => {
  try {
    const db = c.get('tenantDb');
    const { orders } = schema;
    const [canReadOrders, canReadTickets] = await Promise.all([
      hasContextPermission(c, 'orders:read'),
      hasContextPermission(c, 'tickets:read'),
    ]);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Order counts and revenue only for members who may read orders.
    const chartData = canReadOrders
      ? await db
          .select({
            date: sql<string>`to_char(${orders.createdAt}, 'YYYY-MM-DD')`,
            orders: sql<number>`count(*)::int`,
            revenue: sql<number>`coalesce(sum(${orders.total}::numeric), 0)::numeric`,
          })
          .from(orders)
          .where(and(isNull(orders.deletedAt), gte(orders.createdAt, thirtyDaysAgo)))
          .groupBy(sql`to_char(${orders.createdAt}, 'YYYY-MM-DD')`)
          .orderBy(sql`to_char(${orders.createdAt}, 'YYYY-MM-DD')`)
      : [];

    const ticketCountsByDate: Record<string, number> = {};
    try {
      const { helpdeskTickets } = schema;
      const ticketData = canReadTickets
        ? await db
            .select({
              date: sql<string>`to_char(${helpdeskTickets.createdAt}, 'YYYY-MM-DD')`,
              tickets: sql<number>`count(*)::int`,
            })
            .from(helpdeskTickets)
            .where(and(isNull(helpdeskTickets.deletedAt), gte(helpdeskTickets.createdAt, thirtyDaysAgo)))
            .groupBy(sql`to_char(${helpdeskTickets.createdAt}, 'YYYY-MM-DD')`)
        : [];
      for (const row of ticketData) ticketCountsByDate[row.date] = row.tickets;
    } catch {
      // helpdeskTickets table may not exist; ignore.
    }

    const byDate = new Map<string, ChartPoint>();
    for (const row of chartData) {
      byDate.set(row.date, { date: row.date, orders: row.orders, tickets: 0, revenue: Number(row.revenue) });
    }
    // Without orders:read the ticket days still need a point of their own.
    for (const [date, tickets] of Object.entries(ticketCountsByDate)) {
      const point = byDate.get(date) ?? { date, orders: 0, tickets: 0, revenue: 0 };
      point.tickets = tickets;
      byDate.set(date, point);
    }
    const result = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

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
    const orgId = c.get('orgId');
    // Same repair as GET /api/me/permissions: the platform asks for both on
    // load, in parallel, and either may run first.
    if (orgId) await ensureMemberLinked(c.env, db, orgId, c.get('userId'));
    return success(c, await listMemberAppCodes(db, c.get('userId')));
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
    if (!(await hasContextPermission(c, 'activities:read'))) return success(c, []);
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
      // Only the mailboxes this member may open: the count of a colleague's
      // private mailbox is theirs alone.
      const accountIds = await listAccessibleAccountIds(db, c.get('userId'));
      if (accountIds.length > 0) {
        const [messageCount] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(mailMessages)
          .where(
            and(
              eq(mailMessages.isRead, false),
              isNull(mailMessages.deletedAt),
              inArray(mailMessages.accountId, accountIds),
            ),
          );
        badges.unreadMessages = messageCount?.count || 0;
      }
    } catch {
      // mailMessages table may not exist.
    }

    // Ticket and order counts only for members who may read those objects.
    const [canReadTickets, canReadOrders] = await Promise.all([
      hasContextPermission(c, 'tickets:read'),
      hasContextPermission(c, 'orders:read'),
    ]);

    try {
      const { helpdeskTickets } = schema;
      if (canReadTickets) {
        const [ticketCount] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(helpdeskTickets)
          .where(and(eq(helpdeskTickets.status, 'open'), isNull(helpdeskTickets.deletedAt)));
        badges.openTickets = ticketCount?.count || 0;
      }
    } catch {
      // helpdeskTickets table may not exist.
    }

    try {
      const { orders } = schema;
      if (canReadOrders) {
        const [orderCount] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(orders)
          .where(and(eq(orders.status, 'pending'), isNull(orders.deletedAt)));
        badges.pendingOrders = orderCount?.count || 0;
      }
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
      companies,
      people,
      crmActivities,
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

    async function hasRows(table: any, deletedAtCol?: any, ...extra: any[]): Promise<boolean> {
      try {
        const conditions = [...(deletedAtCol ? [isNull(deletedAtCol)] : []), ...extra];
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
      hasCrmCompanies,
      hasCrmPeople,
      hasCrmNotes,
      hasCrmTasks,
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
      // CRM checklist items count CRM data only: companies, people flagged
      // `in_crm` (never mail/helpdesk auto-created contacts or WeldBooks
      // accounting contacts), `note` activities and tasks linked to a
      // company or person (the CRM My Tasks scope).
      hasRows(companies, companies.deletedAt),
      hasRows(people, people.deletedAt, eq(people.inCrm, true)),
      hasRows(crmActivities, crmActivities.deletedAt, eq(crmActivities.type, 'note')),
      hasRows(
        tasks,
        tasks.deletedAt,
        or(isNotNull(tasks.customerId), isNotNull(tasks.personId), isNotNull(tasks.contactId)),
      ),
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
      crm_customer_created: hasCrmCompanies,
      crm_contact_created: hasCrmPeople,
      crm_note_created: hasCrmNotes,
      crm_task_created: hasCrmTasks,
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
