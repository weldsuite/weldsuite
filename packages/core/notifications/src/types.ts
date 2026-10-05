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
import type { EmailBrand, EmailLocale, NotificationEmailProps, TaskAssignedEmailProps } from '@weldsuite/emails';
import type { SystemEmailEnv } from '@weldsuite/emails/transports/binding';

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

/**
 * Which `@weldsuite/emails` template a notification's email renders with, and
 * its props. A discriminated union so the props always match the template —
 * add a case here when a notification helper needs a richer email than the
 * generic `notification` one.
 */
export type NotificationEmailOverride =
  | { template: 'notification'; props: NotificationEmailProps }
  | { template: 'task.assigned'; props: TaskAssignedEmailProps };

/**
 * Payload handed to the deferred-email workflow. Every field must stay
 * JSON-serializable (the Workflow engine persists it).
 */
export interface DeferredEmailParams {
  workspaceId: string;
  userId: string;
  /** Row in `notifications`; re-read on wake to check it is still unread. */
  notificationId: string;
  to: string;
  /** Recipient's resolved locale at enqueue time. */
  locale: EmailLocale;
  /** Sender module/brand to render with. Omitted falls back to the
   *  template's own default brand. */
  brand?: EmailBrand;
  /**
   * Template + props to send. Optional only for backward compatibility: an
   * in-flight workflow instance created before this field existed wakes up
   * with just `subject`/`fallbackText` below, and the workflow falls back to
   * the generic `notification` template built from those.
   */
  email?: NotificationEmailOverride;
  /** Old-shape fields; read only as a fallback when `email` is missing. */
  subject?: string;
  fallbackText?: string;
  /** ISO timestamp the workflow sleeps until before re-checking. */
  sendAfter: string;
}

export interface NotificationEnv extends SystemEmailEnv {
  /** realtime-worker service binding — fans in-app notifications out to the
   *  user's WorkspaceHub personal topic. Optional: when missing (local dev
   *  without realtime-worker running), in-app delivery becomes a no-op. */
  REALTIME?: RealtimeBinding;
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
   * Optional email template override. When omitted, the email channel
   * renders the generic `notification` template from `title`/`body`/
   * `actionUrl`. Set this for a notification type with a richer
   * `@weldsuite/emails` template (e.g. `task.assigned`).
   */
  email?: NotificationEmailOverride;
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
  /**
   * Clerk organization id for workspace-scoped notifications. WeldCalendar
   * (and other dual-tenant apps) use this on tap so the event opens in the
   * org it belongs to rather than whichever workspace happens to be active.
   */
  clerkOrgId?: string;
}
