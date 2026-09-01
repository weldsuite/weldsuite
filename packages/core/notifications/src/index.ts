/**
 * `@weldsuite/notifications` — shared multi-channel notification service
 * for both `apps/api-worker` and `apps/workers/app-api`.
 *
 *   - Orchestrator: `createAndDeliverNotification`
 *   - Per-event helpers: `sendTaskAssignmentNotification`,
 *     `sendChatMentionNotification`, `sendChatThreadReplyNotification`,
 *     `sendChatDmNotification`, `sendMissedCallNotification`,
 *     `sendWeldAgentReplyNotification`, `sendWeldAgentRunNotification`.
 *
 * Each helper inserts a `notifications` row, fans out via @weldsuite/realtime (in-app),
 * Resend (email — template-aware), and Expo (push), respecting the
 * recipient's `notificationPreferences`.
 */

export { createAndDeliverNotification, appCodesForCategory } from './orchestrator';
export { sendTaskAssignmentNotification } from './helpers/task-assignment';
export {
  sendChatMentionNotification,
  sendChatThreadReplyNotification,
  sendChatDmNotification,
  sendMissedCallNotification,
  sendIncomingCallNotification,
} from './helpers/chat';
export {
  sendWeldAgentReplyNotification,
  sendWeldAgentRunNotification,
  weldagentChatActionUrl,
  weldagentRunActionUrl,
} from './helpers/weldagent';
export type {
  NotificationEnv,
  ChannelPreferences,
  CreateNotificationParams,
  NotificationCategory,
  NotificationType,
  NotificationSeverity,
} from './types';
