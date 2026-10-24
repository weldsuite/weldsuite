/**
 * WeldDesk auto-assignment settings — /api/desk/assignment/*
 *
 * Stored in `helpdesk_settings.automation.deskAssignment`; the assignment
 * itself runs where customer messages arrive (helpdesk-widget-api,
 * mail-inbound-worker) via `@weldsuite/db/lib/desk-assignment`.
 *
 *   GET  /       settings + whether the caller is in the rotation / away
 *   PUT  /       mode, roster, cap            (settings:update)
 *   POST /away   the caller marks themselves away or back (conversations:update)
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  setDeskAwaySchema,
  updateDeskAssignmentSchema,
} from '@weldsuite/core-api-client/schemas/desk-assignment';
import {
  getDeskAssignmentSettings,
  saveDeskAssignmentSettings,
  setDeskMemberAway,
  type DeskAssignmentSettings,
} from '@weldsuite/db/lib/desk-assignment';
import { error, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function withMe(settings: DeskAssignmentSettings, userId: string) {
  return {
    ...settings,
    me: {
      inRotation: settings.memberIds.includes(userId),
      away: settings.awayMemberIds.includes(userId),
    },
  };
}

app.get('/', requirePermission('conversations:read'), async (c) => {
  try {
    const { settings } = await getDeskAssignmentSettings(c.get('tenantDb'));
    return success(c, withMe(settings, c.get('userId')));
  } catch (err) {
    console.error('[desk-api/desk-assignment] get failed:', err);
    return error.internal(c, 'Failed to load assignment settings');
  }
});

app.put('/', requirePermission('settings:update'), zValidator('json', updateDeskAssignmentSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const settings = await saveDeskAssignmentSettings(db, generateId, {
      mode: data.mode,
      memberIds: Array.from(new Set(data.memberIds)),
      maxOpenPerMember: data.maxOpenPerMember,
    });
    const { settingsId } = await getDeskAssignmentSettings(db);
    if (settingsId) {
      publishEntityEvent({
        c,
        entityType: 'helpdesk_settings',
        action: 'updated',
        entityId: settingsId,
        data: { deskAssignment: settings },
      });
    }
    return success(c, withMe(settings, c.get('userId')));
  } catch (err) {
    console.error('[desk-api/desk-assignment] update failed:', err);
    return error.internal(c, 'Failed to save assignment settings');
  }
});

app.post('/away', requirePermission('conversations:update'), zValidator('json', setDeskAwaySchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const { away } = c.req.valid('json');
  try {
    const settings = await setDeskMemberAway(db, generateId, userId, away);
    const { settingsId } = await getDeskAssignmentSettings(db);
    if (settingsId) {
      publishEntityEvent({
        c,
        entityType: 'helpdesk_settings',
        action: 'updated',
        entityId: settingsId,
        data: { deskAssignment: { awayMemberIds: settings.awayMemberIds } },
      });
    }
    return success(c, withMe(settings, userId));
  } catch (err) {
    console.error('[desk-api/desk-assignment] away failed:', err);
    return error.internal(c, 'Failed to update away status');
  }
});

export { app as deskAssignmentRoutes };
