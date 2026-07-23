import type { Database } from './db';
import type { ResolvedPermissions } from '@weldsuite/permissions/types';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { FlagContext, FlagshipBinding } from '@weldsuite/feature-flags/server';

/**
 * App API worker — Cloudflare bindings.
 *
 * Routes are organised by object (customers, contacts, ...) so the URL
 * surface mirrors the object-based permission model. This worker serves
 * both the platform SPA and the WeldSuite mobile apps.
 */
export interface Env {
  DATABASE_URL_MASTER: string;
  WORKSPACE_CACHE: KVNamespace;
  ENVIRONMENT: string;
  CLERK_SECRET_KEY: string;
  CLERK_JWT_KEY?: string;
  /** Clerk M2M machine secret (ak_…) — mints tokens for the legacy public
   *  workspace-worker /api/onboard HTTP path. No longer needed for
   *  create-workspace, which now uses the WORKSPACE_WORKER service binding. */
  CLERK_MACHINE_SECRET_KEY?: string;
  /** workspace-worker base URL — legacy public HTTP target (M2M). Superseded by
   *  the WORKSPACE_WORKER RPC binding for server-side org+workspace creation. */
  WORKSPACE_WORKER_URL?: string;
  /**
   * RPC service binding to workspace-worker's `WorkspaceOnboardEntrypoint`.
   * Binding-only (never public), so no M2M token is required. Used by
   * /api/onboarding/create-workspace to provision org + workspace + database.
   */
  WORKSPACE_WORKER?: {
    onboard(input: unknown): Promise<{
      success: boolean;
      workspaceId?: string;
      clerkOrgId?: string;
      alreadyProvisioned?: boolean;
      /** True when a warm pool slot made the workspace fully usable already
       *  (instant provisioning) — no database-status polling needed. */
      ready?: boolean;
      error?: string;
      status?: number;
    }>;
  };
  NEON_API_KEY: string;
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
  NEON_DEFAULT_REGION?: string;
  CF_ACCOUNT_ID?: string;

  // --- AI (@weldsuite/ai) — Cloudflare AI Gateway ---------------------------
  // See packages/core/ai/src/config.ts for the full list of recognised keys.
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

  // --- WeldBooks Digipoort (Belastingdienst SBR filing) --------------------
  /** simulated (default) | preprod | production — gates real transmission. */
  DIGIPOORT_MODE?: string;
  /** mTLS certificate binding presenting the PKIoverheid SBR services server
   *  certificate to Digipoort (wrangler.toml `mtls_certificates`). */
  DIGIPOORT_CERT?: Fetcher;
  /** Cloudflare RealtimeKit app id — used by WeldChat calls (@weldsuite/cloudflare-realtime). */
  CF_REALTIME_APP_ID?: string;
  /** Cloudflare RealtimeKit app secret — used by WeldChat calls (@weldsuite/cloudflare-realtime). */
  CF_REALTIME_APP_SECRET?: string;
  /**
   * Shared token guarding the RealtimeKit webhook receiver. When set, inbound
   * `/api/webhooks/cloudflare-realtime` requests must carry a matching
   * `?token=`, and POST /setup registers the webhook URL with it. Unset =
   * legacy no-check. (RTK's post-Dyte HMAC signature scheme is undocumented,
   * so we gate on a URL secret we control instead.)
   */
  CF_REALTIME_WEBHOOK_TOKEN?: string;
  /**
   * Shared token guarding the MeetingBaas webhook receiver. When set, inbound
   * `/api/webhooks/meeting-bot` requests must carry a matching `?token=`
   * (append it to the URL registered with MeetingBaas). Unset = legacy no-check.
   */
  MEETINGBAAS_WEBHOOK_TOKEN?: string;

  // --- Project analytics (R2 SQL / Iceberg) ---------------------------------
  /** Bearer token for the Cloudflare R2 SQL REST API. */
  R2_SQL_API_TOKEN?: string;
  /** Name of the R2 bucket that holds the Iceberg analytics catalog. */
  R2_ANALYTICS_BUCKET?: string;

  // --- WeldHost (Cloudflare Registrar + Zones + Stripe checkout) ----------
  /** Cloudflare API token with Zone/Registrar scopes — used by /api/domains. */
  CLOUDFLARE_API_TOKEN?: string;
  /** Cloudflare account that owns the registrar + zones surface. Preferred
   *  over the legacy `CF_ACCOUNT_ID` name; both are accepted at runtime. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Stripe secret key used to mint domain registration Checkout Sessions. */
  STRIPE_SECRET_KEY?: string;

  // --- Help center custom domains on Vercel (apps/web/helpcenter) -------------
  /** Vercel API token with project domain scope. */
  VERCEL_API_TOKEN?: string;
  /** Vercel project id of the apps/web/helpcenter deployment. */
  VERCEL_HELPCENTER_PROJECT_ID?: string;
  /** Vercel team id, when the helpcenter project lives under a team. */
  VERCEL_TEAM_ID?: string;

  /** R2 bucket used for customer/contact avatars (logo-fetch.ts). */
  STORAGE?: R2Bucket;
  /** Public hostname that serves objects in the STORAGE bucket. */
  R2_PUBLIC_URL?: string;
  /** Base URL of the external-api worker (third-party surface). Returned to
   *  user-created apps by /api/user-apps/code/:code/session-token so the
   *  iframe bridge knows where to send wsat_-authenticated requests.
   *  Defaults to https://api.weldsuite.org when unset. */
  EXTERNAL_API_URL?: string;

  // --- Entity-event publishing -------------------------------------------
  /** Audit-log queue consumer — fed by publishEntityEvent. */
  AUDIT_EVENTS?: Queue<EntityEventMessage>;
  /** Workflow-event queue consumer — fed by publishEntityEvent. */
  WORKFLOW_EVENTS?: Queue<EntityEventMessage>;
  /** Analytics queue consumer — fed by publishEntityEvent. */
  ANALYTICS_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /**
   * D1 schedule index (shared with workflow-worker). Kept in sync by the
   * workflow-schedules service on schedule create/update/toggle/delete so the
   * schedule sweep can poll D1 instead of fanning out to every tenant DB.
   */
  SCHEDULE_INDEX?: D1Database;
  /** CF Workflow for WeldConnect entity_event triggers (hosted in workflow-worker). */
  EXECUTE_WORKFLOW?: Workflow;
  /** CF Workflow for CRM sequence step execution. Hosted in app-api itself
   *  (class exported from src/index.ts) under the `execute-sequence-v2*`
   *  workflow names — api-worker's old `execute-sequence*` names keep
   *  draining until W7. */
  EXECUTE_SEQUENCE?: Workflow<{
    workspaceId: string;
    userId: string;
    sequenceId: string;
    enrollmentId: string;
    customerId: string;
  }>;
  /** CF Workflow that purges trashed drive files after 30 days. Hosted in
   *  app-api itself under the `trash-cleanup-v2*` workflow names —
   *  api-worker's old names keep draining until W7. */
  TRASH_CLEANUP?: Workflow<{
    workspaceId: string;
    fileId: string;
    fileKey: string;
    deletedAt: string;
    purgeAt: string;
  }>;
  /** CF Workflow that auto-unpins a chat message when its pin expiry passes.
   *  Hosted in app-api itself under the `unpin-expired-message-v2*` names;
   *  dispatched from the routes/chat-messages pin endpoints with the
   *  messageId as instance id so manual unpin can abort it. */
  UNPIN_EXPIRED_MESSAGE?: Workflow<{
    workspaceId: string;
    channelId: string;
    messageId: string;
    expiresAt: string;
  }>;
  /** CF Workflow that sends one user's daily task digest email. Hosted in
   *  app-api itself under the `send-digest-v2*` names; dispatched by the
   *  hourly digest sweep cron (src/cron/digest-sweep.ts). */
  SEND_DIGEST?: Workflow<{
    workspaceId: string;
    userId: string;
    email: string;
    name: string;
    timezone: string;
  }>;
  /** CF Workflow that bulk-imports project tasks from an R2 JSON payload.
   *  Hosted in app-api itself under the `import-tasks-v2*` names; dispatched
   *  by POST /api/projects/:projectId/tasks/import-jobs. */
  IMPORT_TASKS?: Workflow<{
    jobId: string;
    workspaceId: string;
    userId: string;
    projectId: string;
    r2Key: string;
  }>;
  /** CF Workflow that sleeps until `scheduledFor` then dispatches a
   *  scheduled email via the Cloudflare send binding. Hosted in app-api itself
   *  (class exported from src/index.ts). */
  SEND_SCHEDULED_EMAIL?: Workflow<{
    workspaceId: string;
    userId: string;
    messageId: string;
    accountId: string;
    scheduledFor: string;
  }>;
  /** CF Workflow that runs a WeldData enrichment column across leads in the
   *  background. Hosted in app-api itself (class exported from src/index.ts). */
  WELDDATA_ENRICH?: Workflow<{
    workspaceId: string;
    userId: string;
    listId: string;
    columnId: string;
    leadIds: string[];
  }>;
  /** CF Workflow that transcribes a meeting (or CRM call) recording.
   *  Hosted in app-api itself under the `transcribe-recording-v2*` workflow
   *  names — api-worker's old names keep draining until W7. Dispatched by
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
  /** Shared secret for internal service-to-service auth. Consumed by
   *  /api/internal (workflow-worker send_email bearer) and the internal
   *  /api/integrations router (X-Internal-Secret from integration-sync-worker
   *  and integration-webhook-worker). Must be SET with the same value those
   *  callers send. */
  INTERNAL_API_SECRET?: string;

  // --- WeldMail (Cloudflare Email Routing + Email Sending) ----------------
  /** Cloudflare `[[send_email]]` binding for outbound mail. */
  SEND_EMAIL?: SendEmail;
  /** Worker name the customer's zone catch-all rule routes inbound mail to.
   *  Defaults to `weldsuite-mail-inbound` when unset. */
  MAIL_INBOUND_WORKER_NAME?: string;

  // --- GitHub App integration (workflow-github) --------------------------
  /** GitHub App ID (numeric). */
  GITHUB_APP_ID?: string;
  /** GitHub App slug — used to build the install URL. */
  GITHUB_APP_SLUG?: string;
  /** GitHub App private key (PEM) — signs app JWTs. */
  GITHUB_APP_PRIVATE_KEY?: string;
  /** Webhook secret for the GitHub App. */
  GITHUB_APP_WEBHOOK_SECRET?: string;
  /** CF Workflow that re-syncs a repo end-to-end (class hosted in core-api). */
  GITHUB_FULL_SYNC?: Workflow;
  /** CF Workflow that pushes a task mutation to its linked GitHub issue
   *  (outbound sync). Class hosted in core-api; bound here via `script_name`. */
  GITHUB_OUTBOUND_SYNC?: Workflow;
  /** CF Workflow that syncs one GitHub Project (v2) link end-to-end
   *  (Projects-v2 model). Class hosted in core-api; bound here via `script_name`. */
  GITHUB_PROJECT_SYNC?: Workflow;
  /** CF Workflow that pushes a task mutation to its linked GitHub Project item
   *  (Projects-v2 outbound). Class hosted in core-api; bound here via `script_name`. */
  GITHUB_PROJECT_OUTBOUND?: Workflow;

  // --- Notifications (`@weldsuite/notifications`) ------------------------
  // In-app delivery uses the REALTIME service binding declared above.
  /** Resend API key — used by the email channel and the task digest workflow.
   *  Optional locally. */
  RESEND_API_KEY?: string;
  /** AssemblyAI API key — used by TranscribeRecordingWorkflow (meeting/call
   *  recording transcription). Copy the value from api-worker per env via
   *  `wrangler secret put ASSEMBLYAI_API_KEY [--env …]`. Optional locally. */
  ASSEMBLYAI_API_KEY?: string;
  /** Lemlist API key — WeldData lead database. Shared WeldSuite key, set via
   *  `wrangler secret put LEMLIST_API_KEY`. Optional locally. */
  LEMLIST_API_KEY?: string;
  /** Findymail API key — WeldData email-finder enrichment action. Set via
   *  `wrangler secret put FINDYMAIL_API_KEY`. Optional locally. */
  FINDYMAIL_API_KEY?: string;
  /** Prospeo API key — WeldData email-finder enrichment action. Set via
   *  `wrangler secret put PROSPEO_API_KEY`. Optional locally. */
  PROSPEO_API_KEY?: string;
  /** Resend template id for the task-assignment email. When unset, the
   *  helper falls back to a plain-text email. */
  RESEND_TEMPLATE_TASK_ASSIGNED?: string;
  /** Resend template ids for the calendar attendee emails (invite /
   *  reschedule / cancel), read by services/calendar-mail.ts. Each is
   *  independently optional: when one is unset that mail falls back to the
   *  inline HTML template, matching the legacy api-worker behaviour. Mail
   *  no-ops entirely when RESEND_API_KEY is unset. */
  RESEND_MEETING_INVITE_TEMPLATE_ID?: string;
  RESEND_MEETING_UPDATE_TEMPLATE_ID?: string;
  RESEND_MEETING_CANCEL_TEMPLATE_ID?: string;
  /** Absolute base URL for links in notification emails / push payloads,
   *  e.g. `https://app.weldsuite.org`. */
  PUBLIC_APP_URL?: string;

  // --- E2E test fixtures -------------------------------------------------
  /** Secret that authorizes /test-fixtures/* requests. Set ONLY in
   *  test/preview envs — never in production. The router also enforces
   *  `ENVIRONMENT !== 'production'` as a belt-and-braces check. */
  TEST_FIXTURES_TOKEN?: string;
  /** Clerk org id of the SHARED E2E workspace. The teardown-workspace
   *  fixture refuses to destroy this org so a misfiring spec can never
   *  nuke the workspace every other spec depends on. test/preview only. */
  TEST_WORKSPACE_ID?: string;

  // --- WeldConnect integration OAuth (@weldsuite/workflow-integrations) ---
  /** Slack app OAuth client id/secret — slack.* integration. */
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  /** Google OAuth client id/secret — google_sheets/gmail/calendar integrations. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  // --- WeldSocial (PostPeer unified social publishing) -------------------
  /** PostPeer API key (single WeldSuite-level key, sent as `x-access-key`).
   *  Set via `wrangler secret put POSTPEER_API_KEY`. Optional locally — when
   *  unset, provider actions return a configuration error and CRUD still works. */
  POSTPEER_API_KEY?: string;
  /** Override the PostPeer REST base URL. Defaults to https://api.postpeer.dev/v1. */
  POSTPEER_BASE_URL?: string;
  /** Shared secret used to verify PostPeer webhook signatures. */
  POSTPEER_WEBHOOK_SECRET?: string;

  // --- Cloudflare Flagship (feature flags) -------------------------------
  /** Flagship Worker binding — `env.FLAGSHIP.getBooleanValue(key, default, ctx)`.
   *  Configured via `[[flagship]]` in wrangler.toml (test/preview/production).
   *  Absent in local dev, where every flag resolves to its catalog default. */
  FLAGSHIP?: FlagshipBinding;

  // --- Telephony (Telnyx) — /api/telephony, /api/porting, Telnyx webhook ---
  /** Telnyx API key (Bearer) — all Telnyx REST calls. */
  TELNYX_API_KEY?: string;
  /** Telnyx Programmable Voice app id (call routing, phone numbers). */
  TELNYX_CONNECTION_ID?: string;
  /** Telnyx WebRTC credential connection id (SIP token generation). */
  TELNYX_SIP_CONNECTION_ID?: string;
  /** Legacy secret slot carried over from api-worker (declared, never used there). */
  TELNYX_WEBHOOK_SECRET?: string;
  /** Telnyx account public key (base64 Ed25519). When set,
   *  /public/webhooks/telnyx enforces webhook signatures (recommended);
   *  when unset, the receiver accepts unsigned requests (api-worker parity). */
  TELNYX_PUBLIC_KEY?: string;

  // --- Helpdesk workflow engine (apps/workers/helpdesk-workflow-worker) -----------
  /** Base URL of helpdesk-workflow-worker — used by
   *  POST /api/helpdesk-workflows/executions/:executionId/resume to forward
   *  customer responses to its /respond endpoint. */
  HELPDESK_WORKFLOW_WORKER_URL?: string;

  // --- Integrations (CRM / calendar OAuth apps + helpdesk channels) -------
  /** Attio OAuth app credentials. */
  ATTIO_CLIENT_ID?: string;
  ATTIO_CLIENT_SECRET?: string;
  /** HubSpot OAuth app credentials. */
  HUBSPOT_CLIENT_ID?: string;
  HUBSPOT_CLIENT_SECRET?: string;
  /** Google Calendar OAuth app credentials (distinct from GOOGLE_CLIENT_ID,
   *  which belongs to the WeldConnect workflow-integrations app). */
  GOOGLE_CALENDAR_CLIENT_ID?: string;
  GOOGLE_CALENDAR_CLIENT_SECRET?: string;
  /** Discord OAuth app credentials + bot token — WeldDesk helpdesk Discord
   *  channel integration ( /api/integrations/helpdesk/discord/callback ). */
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_BOT_TOKEN?: string;
  /** CRM sync engine — CrmSyncWorkflow hosted by integration-webhook-worker
   *  (workflow names crm-sync-int*); bound cross-script via `script_name`,
   *  same pattern as the GITHUB_PROJECT_SYNC bindings. */
  CRM_SYNC?: Workflow;
  /** Optional override for this worker's public base URL — used to build
   *  OAuth redirect_uri values (helpdesk Discord/Slack callbacks). Defaults
   *  to the per-environment app-api hostname when unset. */
  APP_API_PUBLIC_URL?: string;
}

/**
 * Hono context variables set by middleware.
 */
export type Variables = {
  requestId: string;
  userId: string;
  orgId: string | null;
  sessionId: string;
  tenantDb: Database;
  workspaceId: string;
  userPermissions?: ResolvedPermissions;
  flags?: FlagContext;
};
