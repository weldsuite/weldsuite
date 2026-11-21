import { Hono } from 'hono';
import { and, asc, isNull, sql } from 'drizzle-orm';
import type { Env, Variables } from '../index';
import { success } from '../lib/response';
import { schema } from '../db';
import { officeHoursAvailability } from '../lib/office-hours';
import { accountPicture, loadAccountPictures } from '../lib/account-pictures';

export const configRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Members looked at for the header; the first three with an account picture are shown. */
const TEAM_CANDIDATES = 50;

/**
 * Up to three teammate faces for the messenger header ("the team"): active
 * internal members, oldest first, whose account has a picture.
 */
async function loadTeam(c: { env: Env; get: (key: 'tenantDb') => Variables['tenantDb'] }) {
  try {
    const { workspaceMembers } = schema;
    const rows = await c
      .get('tenantDb')
      .select({ userId: workspaceMembers.userId, name: workspaceMembers.name })
      .from(workspaceMembers)
      .where(
        and(
          isNull(workspaceMembers.deletedAt),
          sql`upper(${workspaceMembers.status}) = 'ACTIVE'`,
          sql`upper(${workspaceMembers.memberType}) = 'INTERNAL'`,
        ),
      )
      .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.id))
      .limit(TEAM_CANDIDATES);
    const pictures = await loadAccountPictures(c.env, rows.map((row) => row.userId));
    return rows
      .map((row) => ({ name: row.name?.trim().split(/\s+/)[0] || 'Support', avatar: accountPicture(pictures, row.userId) }))
      .filter((member): member is { name: string; avatar: string } => member.avatar !== null)
      .slice(0, 3);
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
    availability: officeHoursAvailability(widgetConfig.officeHours, widgetConfig.timezone),
    awayMessage: widgetConfig.awayMessage?.trim() || null,
    expectedReplyTime: widgetConfig.expectedReplyTime ?? null,
  });
});
