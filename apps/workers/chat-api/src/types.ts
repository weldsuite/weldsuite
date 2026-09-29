import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { WeldAgentJob } from '@weldsuite/agent-domain/jobs';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * chat-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the chat module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding — WeldChat fan-out to the ChatRoom DO,
   *  live WorkspaceHub fan-out and in-app notifications. */
  REALTIME?: Fetcher;

  /** R2 bucket for chat uploads and clips. */
  STORAGE?: R2Bucket;
  /** Public hostname that serves objects in the STORAGE bucket. */
  R2_PUBLIC_URL?: string;

  /** CF Workflow that auto-unpins a chat message when its pin expiry passes.
   *  Hosted in this worker (class re-exported from src/index.ts,
   *  @weldsuite/chat-domain) under the `unpin-expired-message-v3*` names —
   *  app-api's old `unpin-expired-message-v2*` names keep draining
   *  (docs/plans/app-api-module-split.md). Dispatched from the
   *  routes/chat-messages pin endpoints with the messageId as instance id so
   *  manual unpin can abort it. */
  UNPIN_EXPIRED_MESSAGE?: Workflow<{
    workspaceId: string;
    channelId: string;
    messageId: string;
    expiresAt: string;
  }>;

  // --- WeldChat calls (@weldsuite/cloudflare-realtime) ---------------------
  CF_ACCOUNT_ID?: string;
  /** Cloudflare RealtimeKit app id — used by WeldChat calls (@weldsuite/cloudflare-realtime). */
  CF_REALTIME_APP_ID?: string;
  /** Cloudflare RealtimeKit app secret — used by WeldChat calls (@weldsuite/cloudflare-realtime). */
  CF_REALTIME_APP_SECRET?: string;

  // --- Notifications (`@weldsuite/notifications`) ------------------------
  // Chat message / DM / missed-call notifications. In-app delivery uses the
  // REALTIME service binding declared above.
  /** Resend API key — the notification email channel. Optional locally. */
  RESEND_API_KEY?: string;
  /** Resend template id for the task-assignment email (NotificationEnv). */
  RESEND_TEMPLATE_TASK_ASSIGNED?: string;
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

  // --- WeldAgent room replies (@weldsuite/agent-domain) --------------------
  // An @-mention of an agent in a channel hands a `chat-room` job to the
  // WeldAgent runtime. It runs in agent-api's WeldAgentJob workflow; without
  // that binding (local dev) the runtime runs inline here, so the keys it
  // reads are carried too.
  /** CF Workflow that runs WeldAgent background work. Hosted in agent-api
   *  (`weldagent-job-v2*` names), bound here cross-script via `script_name`
   *  in test/production. */
  WELDAGENT_JOB?: Workflow<WeldAgentJob>;
  /**
   * D1 schedule index (shared with workflow-worker). Agent routine writes
   * keep it in sync (@weldsuite/agent-domain/routine-index).
   */
  SCHEDULE_INDEX?: D1Database;
  /** Optional; must be `cloudflare` (the only gateway). */
  AI_GATEWAY_PROVIDER?: string;
  /** Default canonical model id; falls back to the free Workers AI default. */
  AI_DEFAULT_MODEL?: string;
  /** Cloudflare API token (Workers AI + AI Gateway Run) → `Authorization`. */
  AI_GATEWAY_API_TOKEN?: string;
  /** AI Gateway id (`cf-aig-gateway-id`). Omit to use the account default. */
  CF_AI_GATEWAY?: string;
  /** Gateway auth token (`cf-aig-authorization`), for "Authenticated" gateways. */
  CF_AIG_TOKEN?: string;
  /** The @weldsuite/ai token fallback when AI_GATEWAY_API_TOKEN is unset. */
  CLOUDFLARE_API_TOKEN?: string;
  /** Accepted by @weldsuite/ai as an alias of CF_ACCOUNT_ID. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /**
   * Base URL for weldsuite-agent-runtime (Cloudflare Sandbox + Browser Run).
   * Example: http://localhost:8795 or https://agent-runtime-test.weldsuite.org
   */
  AGENT_RUNTIME_URL?: string;
  /** When "false", computer/browser tools refuse calls. Default enabled if URL set. */
  AGENT_COMPUTER_ENABLED?: string;
  /** Shared secret the agent-runtime worker checks on computer/browser calls. */
  INTERNAL_API_SECRET?: string;
}

export type Variables = KitVariables;
