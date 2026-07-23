/**
 * `@weldsuite/notifications` — shared multi-channel notification service
 * for both `apps/api-worker` and `apps/workers/app-api`.
 *
 *   - Orchestrator: `createAndDeliverNotification`
 *   - Per-event helpers: `sendTaskAssignmentNotification`,
 *     `sendChatMentionNotification`, `sendChatThreadReplyNotification`,
 *     `sendChatDmNotification`, `sendMissedCallNotification`.
 *
 * Each helper inserts a `notifications` row, fans out via @weldsuite/realtime (in-app),
 * Resend (email — template-aware), and Expo (push), respecting the
 * recipient's `notificationPreferences`.
 */

export { createAndDeliverNotification } from './orchestrator';
export { sendTaskAssignmentNotification } from './helpers/task-assignment';
export {
  sendChatMentionNotification,
  sendChatThreadReplyNotification,
  sendChatDmNotification,
  sendMissedCallNotification,
  sendIncomingCallNotification,
} from './helpers/chat';
export type {
  NotificationEnv,
  ChannelPreferences,
  CreateNotificationParams,
  NotificationCategory,
  NotificationType,
  NotificationSeverity,
} from './types';
