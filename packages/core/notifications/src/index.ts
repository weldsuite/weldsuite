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

export { createAndDeliverNotification, appCodesForCategory, EMAIL_DEFER_MINUTES } from './orchestrator';
export { resolveEmailPresence, presenceFromStatus, type EmailPresence } from './presence';
// Exported for the deferred-email workflow, which sends the same mail on the
// same `from` address minutes later — it must not grow its own copy.
export { sendNotificationEmail } from './channels/email';
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
  DeferredEmailWorkflow,
  DeferredEmailParams,
  ChannelPreferences,
  CreateNotificationParams,
  NotificationCategory,
  NotificationType,
  NotificationSeverity,
} from './types';
