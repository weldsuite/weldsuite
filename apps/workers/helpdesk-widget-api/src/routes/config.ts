import { Hono } from 'hono';
import { and, isNotNull, sql } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { success } from '../lib/response';
import { schema } from '../db';

export const configRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Up to three teammate faces for the messenger header ("the team"). */
async function loadTeam(c: { get: (key: 'tenantDb') => Variables['tenantDb'] }) {
  try {
    const { workspaceMembers } = schema;
    const rows = await c
      .get('tenantDb')
      .select({ name: workspaceMembers.name, picture: workspaceMembers.picture })
      .from(workspaceMembers)
      .where(
        and(
          isNotNull(workspaceMembers.picture),
          sql`upper(${workspaceMembers.status}) = 'ACTIVE'`,
          sql`upper(${workspaceMembers.memberType}) = 'INTERNAL'`,
        ),
      )
      .limit(3);
    return rows.map((row) => ({
      name: row.name?.trim().split(/\s+/)[0] || 'Support',
      avatar: row.picture,
    }));
  } catch (err) {
    console.error('[widget-api] team lookup failed:', err);
    return [];
  }
}

configRoutes.get('/', async (c) => {
  const widgetConfig = c.get('widgetConfig');
  const branding = widgetConfig.branding ?? {};
  const team = await loadTeam(c);
  return success(c, {
    widgetId: widgetConfig.widgetId,
    name: widgetConfig.widgetName ?? null,
    enabled: widgetConfig.enabled,
    greeting: widgetConfig.greeting ?? 'Hi — how can we help?',
    branding: {
      primaryColor: branding.primaryColor ?? '#2563eb',
      backgroundColor: branding.backgroundColor ?? '#ffffff',
      position: branding.position ?? 'right',
    },
    showBranding: !c.get('removeBranding'),
    realtimeUrl: c.env.REALTIME_PUBLIC_URL ?? null,
    team,
  });
});
