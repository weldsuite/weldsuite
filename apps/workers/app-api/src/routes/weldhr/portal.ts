/**
 * /api/weldhr/portal — workforce portal settings and access grants (back office).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { inviteHrPortalAccessSchema, updateHrPortalSettingsSchema } from '@weldsuite/app-api-client/schemas/weldhr';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import {
  deletePortalAccess,
  invitePortalAccess,
  listPortalAccess,
  loadPortalSettings,
  requirePortalAccess,
  setPortalAccessStatus,
  updatePortalSettings,
} from '../../services/weldhr/portal';
import { HostTakenError, claimPortalHost, sendHrPortalInviteEmail } from '../../services/weldhr/portal-mail';
import { recordHrAudit } from '../../services/weldhr/shared';
import { actor, clientIp, db, emitPortalConfig, param } from './helpers';

export const portalRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

portalRoutes.get('/settings', requirePermission('employees:read'), async (c) => {
  const settings = await loadPortalSettings(db(c));
  return success(c, settings);
});

portalRoutes.put('/settings', requirePermission('employees:manage'), zValidator('json', updateHrPortalSettingsSchema), async (c) => {
  const input = c.req.valid('json');
  if (input.customDomain !== undefined) {
    const current = await loadPortalSettings(db(c));
    try {
      await claimPortalHost(c.env, c.get('workspaceId'), current.customDomain, input.customDomain);
    } catch (err) {
      if (err instanceof HostTakenError) return error.conflict(c, err.message);
      throw err;
    }
  }
  const row = await updatePortalSettings(db(c), input);
  emitPortalConfig(c, 'hr_portal_settings', row.id);
  await recordHrAudit(db(c), {
    actorId: actor(c),
    action: 'portal.settings_updated',
    metadata: { fields: Object.keys(input) },
    ip: clientIp(c),
  });
  return success(c, row);
});

portalRoutes.get('/access', requirePermission('employees:manage'), async (c) => {
  const q = c.req.query();
  return success(
    c,
    await listPortalAccess(db(c), {
      kind: q.kind || undefined,
      companyId: q.companyId || undefined,
      employeeId: q.employeeId || undefined,
    }),
  );
});

portalRoutes.post('/access', requirePermission('employees:manage'), zValidator('json', inviteHrPortalAccessSchema), async (c) => {
  const database = db(c);
  const { access, created } = await invitePortalAccess(database, c.req.valid('json'), actor(c));
  await recordHrAudit(database, {
    actorId: actor(c),
    action: 'portal.access_invited',
    employeeId: access.employeeId,
    metadata: { accessId: access.id, kind: access.kind, companyId: access.companyId },
    ip: clientIp(c),
  });
  const settings = await loadPortalSettings(database);
  const emailed = settings.isEnabled
    ? await sendHrPortalInviteEmail(c, { access, settings })
    : false;
  return success(c, { ...access, emailed }, created ? 201 : 200);
});

portalRoutes.post('/access/:accessId/revoke', requirePermission('employees:manage'), async (c) => {
  const row = await setPortalAccessStatus(db(c), param(c, 'accessId'), 'revoked');
  await recordHrAudit(db(c), {
    actorId: actor(c),
    action: 'portal.access_revoked',
    employeeId: row.employeeId,
    metadata: { accessId: row.id },
    ip: clientIp(c),
  });
  return success(c, row);
});

portalRoutes.post('/access/:accessId/restore', requirePermission('employees:manage'), async (c) => {
  const row = await setPortalAccessStatus(db(c), param(c, 'accessId'), 'invited');
  await recordHrAudit(db(c), {
    actorId: actor(c),
    action: 'portal.access_restored',
    employeeId: row.employeeId,
    metadata: { accessId: row.id },
    ip: clientIp(c),
  });
  return success(c, row);
});

portalRoutes.delete('/access/:accessId', requirePermission('employees:manage'), async (c) => {
  const row = await requirePortalAccess(db(c), param(c, 'accessId'));
  await deletePortalAccess(db(c), row.id);
  await recordHrAudit(db(c), {
    actorId: actor(c),
    action: 'portal.access_revoked',
    employeeId: row.employeeId,
    metadata: { accessId: row.id, deleted: true },
    ip: clientIp(c),
  });
  return noContent(c);
});
