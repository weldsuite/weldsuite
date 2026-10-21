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
 * Each helper inserts a `notifications` row, fans out via @weldsuite/realtime
 * (in-app), @weldsuite/emails (email — template-aware), and Expo (push),
 * respecting the recipient's `notificationPreferences`.
 */

export { createAndDeliverNotification, appCodesForCategory, EMAIL_DEFER_MINUTES } from './orchestrator';
export { resolveEmailPresence, presenceFromStatus, type EmailPresence } from './presence';
// Exported for the deferred-email workflow, which sends the same mail on the
// same `from` address minutes later — it must not grow its own copy.
export { sendNotificationEmail, type SendNotificationEmailParams } from './channels/email';
export {
  sendExpoPush,
  isExpoPushToken,
  formatExpoHttpError,
  type ExpoPushMessage,
  type SendExpoPushResult,
} from './channels/push';
export {
  cancelIncomingCallPush,
  isCallToken,
  callTokenDeviceId,
  CALL_DEVICE_SUFFIX,
  CALL_RING_TTL_MS,
  type CallCancelReason,
  type CallTokenType,
  type CancelIncomingCallParams,
} from './channels/call-push';
export { getChannelPreferences } from './preferences';
export { sendTaskAssignmentNotification } from './helpers/task-assignment';
export {
  sendTaskCommentNotification,
  extractMentionedUserIds,
  taskCommentRecipients,
} from './helpers/task-comment';
export { sendNewEmailNotification } from './helpers/mail';
export {
  sendTicketAssignedNotification,
  sendTicketReplyNotification,
  isHelpdeskNotificationEnabled,
  helpdeskPreview,
  type HelpdeskEntityKind,
} from './helpers/helpdesk';
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
  NotificationEmailOverride,
  ChannelPreferences,
  CreateNotificationParams,
  NotificationCategory,
  NotificationType,
  NotificationSeverity,
} from './types';
