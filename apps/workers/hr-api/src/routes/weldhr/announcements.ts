/**
 * /api/weldhr/announcements — HR's news to employees. Employees read theirs
 * under /me/announcements.
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import { createHrAnnouncementSchema, updateHrAnnouncementSchema } from '@weldsuite/app-api-client/schemas/weldhr';
import { noContent, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { notifyAnnouncement } from '../../services/weldhr/announcement-push';
import {
  announcementReads,
  announcementWithDetails,
  createAnnouncement,
  deleteAnnouncement,
  listAnnouncements,
  updateAnnouncement,
} from '../../services/weldhr/announcements';
import { actor, db, emit, hrJson, param, orgIdOf } from './helpers';

export const announcementsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

announcementsRoutes.get('/', requirePermission('announcements:read'), async (c) => success(c, await listAnnouncements(db(c))));

announcementsRoutes.post('/', requirePermission('announcements:create'), hrJson(createHrAnnouncementSchema), async (c) => {
  const { notify, ...input } = c.req.valid('json');
  const row = await createAnnouncement(db(c), input, actor(c));
  emit(c, 'hr_announcement', 'created', row.id);
  if (notify) {
    // Fan-out runs after the response; the row gets `notifiedAt` when it is done.
    c.executionCtx.waitUntil(
      notifyAnnouncement(db(c), c.env, orgIdOf(c), row, actor(c)).catch((err) => {
        console.error('[weldhr] announcement push failed:', err);
      }),
    );
  }
  return success(c, await announcementWithDetails(db(c), row.id), 201);
});

announcementsRoutes.patch(
  '/:announcementId',
  requirePermission('announcements:update'),
  hrJson(updateHrAnnouncementSchema),
  async (c) => {
    const row = await updateAnnouncement(db(c), param(c, 'announcementId'), c.req.valid('json'));
    emit(c, 'hr_announcement', 'updated', row.id);
    return success(c, await announcementWithDetails(db(c), row.id));
  },
);

announcementsRoutes.delete('/:announcementId', requirePermission('announcements:delete'), async (c) => {
  const id = param(c, 'announcementId');
  await deleteAnnouncement(db(c), id);
  emit(c, 'hr_announcement', 'deleted', id);
  return noContent(c);
});

announcementsRoutes.get('/:announcementId/reads', requirePermission('announcements:read'), async (c) =>
  success(c, await announcementReads(db(c), param(c, 'announcementId'))),
);
