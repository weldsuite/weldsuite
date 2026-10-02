import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { MeetingAiParams } from '@weldsuite/meet-domain/workflows/meeting-ai';
import type { BackfillLegacyRecordingsParams } from '@weldsuite/meet-domain/workflows/backfill-legacy-recordings';
import type { CopyMeetingRecordingParams } from '@weldsuite/meet-domain/workflows/copy-meeting-recording';
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

  // --- Recordings, transcripts, summaries (@weldsuite/meet-domain) ----------
  /**
   * PRIVATE R2 bucket for meeting recordings, raw transcripts and nothing else:
   * `weldsuite-meeting-recordings` (dev + production) /
   * `weldsuite-meeting-recordings-test`. It has no public domain; objects are
   * only served by `GET /public/meeting-recordings/:token` below. Keys are
   * `{orgId}/{sessionId}/{rtkRecordingId}.{mp4|mp3}`. Do NOT use STORAGE here.
   */
  MEETING_RECORDINGS?: R2Bucket;
  /** Copies a finished RealtimeKit recording into MEETING_RECORDINGS. Hosted here
   *  (class re-exported from src/index.ts), dispatched by the `recording.statusUpdate`
   *  webhook with instance id `rec-{rtkRecordingId}`. */
  MEETING_RECORDING_COPY?: Workflow<CopyMeetingRecordingParams>;
  /** Post-meeting AI: ingest RealtimeKit's transcript/summary, Whisper over the
   *  stored audio, summarize. Hosted here, dispatched by the webhook and the
   *  `recording/transcribe|summarize` routes. */
  MEETING_AI?: Workflow<MeetingAiParams>;
  /** One-off, operator-started: moves legacy (pre-RealtimeKit-recorder) recordings still
   *  inside RealtimeKit's 7-day window into MEETING_RECORDINGS and marks the rest
   *  `unavailable`. Dispatched per workspace by POST
   *  /api/webhooks/cloudflare-realtime/backfill-recordings. */
  MEETING_RECORDING_BACKFILL?: Workflow<BackfillLegacyRecordingsParams>;
  /**
   * Cloudflare API token. `@weldsuite/ai` uses it (Workers AI Whisper REST +
   * summary model through the AI Gateway) when there is no `AI_GATEWAY_API_TOKEN`.
   * Needs Workers AI + AI Gateway Run. Same value as app-api / mail-api.
   */
  CLOUDFLARE_API_TOKEN?: string;
  /** Optional dedicated AI Gateway token; wins over CLOUDFLARE_API_TOKEN in @weldsuite/ai. */
  AI_GATEWAY_API_TOKEN?: string;
  /** Optional AI Gateway id (`cf-aig-gateway-id`); omit for the account default. */
  CF_AI_GATEWAY?: string;

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
