import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * meet-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the meet module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;

  /** R2 bucket for files, documents and generated avatars (participant-resolver.ts). */
  STORAGE?: R2Bucket;
  /** Public hostname that serves objects in the STORAGE bucket. */
  R2_PUBLIC_URL?: string;

  // --- Cloudflare RealtimeKit (@weldsuite/cloudflare-realtime) --------------
  CF_ACCOUNT_ID?: string;
  /** Cloudflare RealtimeKit app id — meeting sessions (@weldsuite/cloudflare-realtime). */
  CF_REALTIME_APP_ID?: string;
  /** Cloudflare RealtimeKit app secret — meeting sessions (@weldsuite/cloudflare-realtime). */
  CF_REALTIME_APP_SECRET?: string;
  /**
   * Operator bearer token for POST /api/webhooks/cloudflare-realtime/setup
   * (`Authorization: Bearer <token>`). Unset = /setup refuses. Deliveries to
   * the receiver itself are authenticated by their `rtk-signature`, not this.
   */
  CF_REALTIME_WEBHOOK_TOKEN?: string;
  /**
   * Shared token guarding the MeetingBaas webhook receiver: inbound
   * `/api/webhooks/meeting-bot` requests must carry a matching `?token=`
   * (append it to the URL registered with MeetingBaas). Unset = every
   * request is rejected.
   */
  MEETINGBAAS_WEBHOOK_TOKEN?: string;

  /** CF Workflow that transcribes a meeting recording. Hosted in this worker
   *  (class re-exported from src/index.ts, @weldsuite/meet-domain) under the
   *  `transcribe-recording-v3*` workflow names — app-api's old
   *  `transcribe-recording-v2*` names keep draining
   *  (docs/plans/app-api-module-split.md). Dispatched by
   *  POST /api/meetings/:id/recording/transcribe. */
  TRANSCRIBE_RECORDING?: Workflow<{
    transcriptionId: string;
    fileKey?: string;
    fileUrl?: string;
    language?: string;
    estimatedMinutes: number;
    creditRate: number;
    entityId: string;
    workspaceId: string;
  }>;
  /** AssemblyAI API key — used by TranscribeRecordingWorkflow. */
  ASSEMBLYAI_API_KEY?: string;

  // --- WeldChat call end from the RTK webhook (@weldsuite/chat-domain) ------
  // endChatCall sends the missed-call notification (@weldsuite/notifications).
  /** Resend API key — the notification email channel. Optional locally. */
  RESEND_API_KEY?: string;
  /** Resend template id for the task-assignment email (NotificationEnv). */
  RESEND_TEMPLATE_TASK_ASSIGNED?: string;
  /** Public meeting portal (`apps/web/meeting-portal`) that the join links in
   *  meeting invitation emails point at. Defaults to https://meet.weldsuite.org. */
  MEETING_PORTAL_URL?: string;
  /** Absolute base URL for links in notification emails / push payloads,
   *  e.g. `https://app.weldsuite.org`. */
  PUBLIC_APP_URL?: string;
  /** CF Workflow that holds a notification email until the recipient has been
   *  away for the defer window. Hosted in app-api (`deferred-notification-email*`
   *  names), bound here cross-script via `script_name` in test/production. */
  DEFERRED_NOTIFICATION_EMAIL?: Workflow<{
    workspaceId: string;
    userId: string;
    notificationId: string;
    to: string;
    subject: string;
    fallbackText: string;
    sendAfter: string;
    template?: { id: string; variables: Record<string, string | number | boolean> };
  }>;
}

export type Variables = KitVariables;
