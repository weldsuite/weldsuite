/**
 * The push (and in-app notification) that goes out when HR publishes an
 * announcement with "notify" on. One notification per audience member who is
 * linked to a workspace member; it reaches the WeldHR app (category `weldhr`)
 * and the bell in the platform. Never email: announcements can go to the
 * whole company, and they are there to read in the app.
 */

import { createAndDeliverNotification, type CreateNotificationParams, type NotificationEnv } from '@weldsuite/notifications';
import type { Database } from '@weldsuite/worker-kit/db';
import type { HrAnnouncement } from '@weldsuite/db/schema';
import { announcementRecipients, markAnnouncementNotified } from './announcements';

/** Recipients notified at once; each one is a few queries and an Expo request. */
const BATCH = 10;
const PREVIEW_LENGTH = 160;

/** Where the notification opens: My HR → Announcements on the web, the Announcements tab in the app. */
export function announcementActionUrl(id: string) {
  return `/weldhr/me/announcements?announcement=${id}`;
}

export function announcementPreview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH - 1)}…` : flat;
}

export async function notifyAnnouncement(
  db: Database,
  env: NotificationEnv,
  workspaceId: string,
  announcement: HrAnnouncement,
  actorId: string,
): Promise<number> {
  const recipients = (await announcementRecipients(db, announcement)).filter((userId) => userId !== actorId);
  const base: Omit<CreateNotificationParams, 'userId'> = {
    // The kit's tenant handle is the same Drizzle client the package types as NeonHttpDatabase.
    db: db as unknown as CreateNotificationParams['db'],
    env,
    workspaceId,
    title: announcement.title,
    body: announcementPreview(announcement.body),
    category: 'weldhr',
    notificationType: 'hr_announcement',
    entityType: 'hr_announcement',
    entityId: announcement.id,
    actionUrl: announcementActionUrl(announcement.id),
    severity: 'info',
    actorType: 'user',
    actorId,
    excludeChannels: ['email'],
    data: { announcementId: announcement.id },
  };
  for (let i = 0; i < recipients.length; i += BATCH) {
    await Promise.all(
      recipients.slice(i, i + BATCH).map((userId) =>
        createAndDeliverNotification({ ...base, userId }).catch((err) => {
          console.error('[weldhr] announcement notification failed:', err);
        }),
      ),
    );
  }
  await markAnnouncementNotified(db, announcement.id);
  return recipients.length;
}
