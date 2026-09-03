/**
 * Public types for `@weldsuite/notifications`.
 *
 * The package is worker-agnostic — both `apps/api-worker` and `apps/workers/app-api`
 * use it. Anything that depends on a specific worker's Env shape comes in
 * via the structural `NotificationEnv` interface below.
 */

import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type * as schema from '@weldsuite/db/schema';
import type { ModulePreferencesMap } from '@weldsuite/db/schema/notification-preferences';
import type {
  NotificationCategory,
  NotificationType,
  NotificationSeverity,
} from '@weldsuite/db/schema/notifications';

/** Tenant Drizzle handle — same shape both workers construct from
 *  `@weldsuite/db/schema`. */
export type Database = NeonHttpDatabase<typeof schema>;

export type {
  ModulePreferencesMap,
  NotificationCategory,
  NotificationType,
  NotificationSeverity,
};

/** Structural shape of the Cloudflare service binding we use to publish
 *  in-app notifications via realtime-worker. */
export interface RealtimeBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Structural env shape — both workers' `Env` types satisfy this. Any
 * binding/secret the notification service reads goes here.
 */
/**
 * Structural shape of a Cloudflare Workflow binding, narrowed to the one
 * method the orchestrator calls. Declared here rather than importing
 * `Workflow` from `cloudflare:workers` so the package stays buildable outside
 * a Worker (tests, tooling) and worker-agnostic as promised above.
 */
export interface DeferredEmailWorkflow {
  create(options: {
    id?: string;
    params: DeferredEmailParams;
  }): Promise<unknown>;
}

/** Payload handed to the deferred-email workflow. */
export interface DeferredEmailParams {
  workspaceId: string;
  userId: string;
  /** Row in `notifications`; re-read on wake to check it is still unread. */
  notificationId: string;
  to: string;
  subject: string;
  fallbackText: string;
  /** ISO timestamp the workflow sleeps until before re-checking. */
  sendAfter: string;
  template?: {
    id: string;
    variables: Record<string, string | number | boolean>;
  };
}

export interface NotificationEnv {
  /** realtime-worker service binding — fans in-app notifications out to the
   *  user's WorkspaceHub personal topic. Optional: when missing (local dev
   *  without realtime-worker running), in-app delivery becomes a no-op. */
  REALTIME?: RealtimeBinding;
  RESEND_API_KEY?: string;
  /** Resend template id for task-assignment emails. When unset, the email
   *  falls back to plain text. */
  RESEND_TEMPLATE_TASK_ASSIGNED?: string;
  /** Absolute base URL for action links in email/push, e.g.
   *  `https://app.weldsuite.org`. */
  PUBLIC_APP_URL?: string;
  /**
   * CF Workflow that holds a notification email back until the recipient has
   * been away for `EMAIL_DEFER_MINUTES`, then sends only if they are still
   * away and the notification is still unread. Optional: a worker that does
   * not bind it falls back to sending immediately (the presence gate still
   * applies, so an online user is never mailed either way).
   */
  DEFERRED_NOTIFICATION_EMAIL?: DeferredEmailWorkflow;
}

export interface ChannelPreferences {
  inApp: boolean;
  email: boolean;
  push: boolean;
}

export interface CreateNotificationParams<Env extends NotificationEnv = NotificationEnv> {
  db: Database;
  // (Database is also re-exported from this module for downstream callers.)
  env: Env;
  /** Workspace this notification belongs to — needed to publish on the
   *  correct WorkspaceHub Durable Object. */
  workspaceId: string;
  userId: string;
  title: string;
  body: string;
  category: NotificationCategory;
  notificationType: NotificationType;
  entityType: string;
  entityId: string;
  actionUrl: string;
  severity: NotificationSeverity;
  /** Who triggered the notification — drives the avatar shown in the panel. */
  actorType?: 'user' | 'contact' | 'system';
  /** userId for actorType='user', contactId for 'contact', null for 'system'. */
  actorId?: string | null;
  /**
   * Optional Resend template override. When provided AND
   * `env.RESEND_API_KEY` is set, the email path uses `sendTemplateEmail`
   * instead of plain text. The template `id` is typically pulled from
   * an env binding so different environments can point at different
   * templates.
   */
  emailTemplate?: {
    id: string;
    variables: Record<string, string | number | boolean>;
  };
  /**
   * Channels this notification must never deliver on, regardless of the
   * recipient's preferences. Used for inherently real-time notifications
   * (e.g. an incoming/missed call ring) where a channel like email is
   * pointless — the event is over long before the mail arrives. Excluding a
   * channel here is subtractive: it can only turn a channel off, never on.
   */
  excludeChannels?: Array<keyof ChannelPreferences>;
  /**
   * Extra Expo push `data` fields (string values only — Expo payload
   * requirement). Merged with the standard `actionUrl` / `entityType` /
   * `entityId` / `notificationType` keys. Used for mobile deep links
   * (e.g. `projectId` + `taskId` for WeldFlow).
   */
  data?: Record<string, string>;
}
