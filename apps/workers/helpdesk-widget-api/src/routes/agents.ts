/**
 * Widget Agents Routes
 *
 * Provides agent status and availability information for the widget.
 */

import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { schema } from '../db';
import { success } from '../lib/response';
import { computeAvailability } from '../lib/business-hours';

// ============================================================================
// Routes
// ============================================================================

export const agentsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /status - Get agent online status
 *
 * Returns real agent data from the database.
 */
agentsRoutes.get('/status', async (c) => {
  const db = c.get('tenantDb');

  const agents = await db
    .select({
      id: schema.helpdeskAgents.id,
      name: schema.helpdeskAgents.name,
      avatar: schema.helpdeskAgents.avatar,
      isOnline: schema.helpdeskAgents.isOnline,
    })
    .from(schema.helpdeskAgents)
    .where(
      and(
        eq(schema.helpdeskAgents.status, 'active'),
        isNull(schema.helpdeskAgents.deletedAt)
      )
    )
    .limit(10);

  const onlineAgents = agents.filter((a) => a.isOnline);

  return success(c, {
    online: onlineAgents.length > 0,
    agentCount: onlineAgents.length,
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      avatar: a.avatar || null,
      status: a.isOnline ? 'online' as const : 'offline' as const,
      availableForChats: a.isOnline ?? false,
    })),
  });
});

/**
 * GET /availability - Get detailed availability info
 *
 * Returns availability based on business hours, department settings,
 * and real agent online status.
 */
agentsRoutes.get('/availability', async (c) => {
  const db = c.get('tenantDb');

  const [settings] = await db
    .select({ general: schema.helpdeskSettings.general })
    .from(schema.helpdeskSettings)
    .where(isNull(schema.helpdeskSettings.deletedAt))
    .limit(1);

  const [defaultDepartment] = await db
    .select({
      businessHours: schema.helpdeskDepartments.businessHours,
      replyTime: schema.helpdeskDepartments.replyTime,
    })
    .from(schema.helpdeskDepartments)
    .where(
      and(
        eq(schema.helpdeskDepartments.isActive, true),
        isNull(schema.helpdeskDepartments.deletedAt)
      )
    )
    .orderBy(schema.helpdeskDepartments.sortOrder)
    .limit(1);

  const generalSettings = settings?.general;
  const businessHours = defaultDepartment?.businessHours || generalSettings?.businessHours || null;
  const { isWithinOfficeHours, nextOpenTime } = computeAvailability(businessHours);

  const agents = await db
    .select({ isOnline: schema.helpdeskAgents.isOnline })
    .from(schema.helpdeskAgents)
    .where(
      and(
        eq(schema.helpdeskAgents.status, 'active'),
        isNull(schema.helpdeskAgents.deletedAt)
      )
    )
    .limit(10);

  const onlineCount = agents.filter((a) => a.isOnline).length;

  return success(c, {
    available: isWithinOfficeHours && onlineCount > 0,
    estimatedWaitTime: onlineCount > 0 ? '< 5 minutes' : null,
    businessHours: businessHours ? {
      timezone: businessHours.timezone || 'UTC',
      schedule: {
        monday: businessHours.monday || null,
        tuesday: businessHours.tuesday || null,
        wednesday: businessHours.wednesday || null,
        thursday: businessHours.thursday || null,
        friday: businessHours.friday || null,
        saturday: businessHours.saturday || null,
        sunday: businessHours.sunday || null,
      },
    } : null,
    nextOpenTime,
    message: isWithinOfficeHours && onlineCount > 0
      ? 'Our team is ready to help!'
      : 'We are currently offline. Leave a message and we will get back to you.',
  });
});
