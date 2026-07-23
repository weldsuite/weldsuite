/**
 * Social settings routes — /api/social-settings/* singleton config.
 * Ported from apps/api-worker/src/routes/social/settings.ts.
 *
 * Backed by the `customSettings.social` JSONB key on `workspaceSettings`
 * (same pattern as parcel-settings). This is a singleton — GET / + PUT /
 * only; no resource /:id lifecycle. Registered as EXEMPT in
 * _event-coverage.test.ts with a one-line reason.
 *
 * The PUT / mutation publishes a `social_settings:updated` entity event.
 *
 * Permissions: accounts:read (reads) | accounts:update (mutations).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { updateSocialSettingsSchema } from '@weldsuite/app-api-client/schemas/social-settings';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const { workspaceSettings } = schema;

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Australia/Sydney',
] as const;

/**
 * GET / — Retrieve social module settings (social sub-key of customSettings).
 */
app.get('/', requirePermission('accounts:read'), async (c) => {
  try {
    const db = c.get('tenantDb');
    const workspaceId = c.get('workspaceId');

    const [settings] = await db
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.id, workspaceId))
      .limit(1);

    const custom = (settings?.customSettings ?? {}) as Record<string, unknown>;
    const social = (custom.social ?? {}) as Record<string, unknown>;

    return success(c, {
      defaultTimezone: (social.defaultTimezone as string | undefined) ?? 'UTC',
      defaultApprovalRequired: (social.defaultApprovalRequired as boolean | undefined) ?? false,
      autoScheduleEnabled: (social.autoScheduleEnabled as boolean | undefined) ?? false,
      bestTimeToPost: (social.bestTimeToPost as { enabled: boolean; times: Array<{ day: number; hour: number }> } | undefined) ?? {
        enabled: false,
        times: [],
      },
      hashtagSuggestions: (social.hashtagSuggestions as boolean | undefined) ?? true,
      linkShortening: (social.linkShortening as boolean | undefined) ?? false,
      utmTracking: (social.utmTracking as { enabled: boolean; source: string; medium: string; campaign: string } | undefined) ?? {
        enabled: false,
        source: '',
        medium: 'social',
        campaign: '',
      },
      notifications: (social.notifications as { publishedPosts: boolean; failedPosts: boolean; approvalRequests: boolean; weeklyReport: boolean } | undefined) ?? {
        publishedPosts: true,
        failedPosts: true,
        approvalRequests: true,
        weeklyReport: false,
      },
    });
  } catch (err) {
    console.error('[app-api/social-settings] get failed:', err);
    return error.internal(c, 'Failed to fetch social settings');
  }
});

/**
 * PUT / — Update social module settings (merges into customSettings.social).
 */
app.put(
  '/',
  requirePermission('accounts:update'),
  zValidator('json', updateSocialSettingsSchema),
  async (c) => {
    const data = c.req.valid('json');
    try {
      const db = c.get('tenantDb');
      const workspaceId = c.get('workspaceId');

      const [existing] = await db
        .select()
        .from(workspaceSettings)
        .where(eq(workspaceSettings.id, workspaceId))
        .limit(1);

      const custom = ((existing?.customSettings ?? {}) as Record<string, unknown>);
      const currentSocial = (custom.social ?? {}) as Record<string, unknown>;

      const newCustomSettings = {
        ...custom,
        social: { ...currentSocial, ...(data as Record<string, unknown>) },
      };

      const now = new Date();
      if (existing) {
        await db
          .update(workspaceSettings)
          .set({ customSettings: newCustomSettings, updatedAt: now })
          .where(eq(workspaceSettings.id, workspaceId));
      } else {
        await db.insert(workspaceSettings).values({
          id: workspaceId,
          customSettings: newCustomSettings,
          createdAt: now,
          updatedAt: now,
        } as unknown as typeof workspaceSettings.$inferInsert);
      }

      publishEntityEvent({
        c,
        entityType: 'social_settings',
        entityId: workspaceId,
        action: 'updated',
        data: data as unknown as Record<string, unknown>,
      });

      return success(c, { message: 'Social settings updated successfully' });
    } catch (err) {
      console.error('[app-api/social-settings] update failed:', err);
      return error.internal(c, 'Failed to update social settings');
    }
  },
);

/**
 * GET /timezones — Return supported timezone list.
 */
app.get('/timezones', requirePermission('accounts:read'), async (c) => {
  return success(c, TIMEZONES);
});

export const socialSettingsRoutes = app;
