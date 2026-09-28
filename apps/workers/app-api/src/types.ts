import type { Database } from './db';
import type { ResolvedPermissions } from '@weldsuite/permissions/types';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { FlagContext, FlagshipBinding } from '@weldsuite/feature-flags/server';
import type { CustomObjectRow } from './services/custom-objects';

/**
 * App API worker — Cloudflare bindings.
 *
 * Routes are organised by object (customers, contacts, ...) so the URL
 * surface mirrors the object-based permission model. This worker serves
 * both the platform SPA and the WeldSuite mobile apps.
 */
export interface Env {
  /**
   * Modules that moved to their own worker and are forwarded there
   * (comma-separated ids from @weldsuite/api-modules, e.g. `pass,host`).
   * Each also needs its service binding (`PASS_API`, …); see
   * @weldsuite/worker-kit/forward and docs/plans/app-api-module-split.md.
   */
  API_FORWARD_MODULES?: string;
  DATABASE_URL_MASTER: string;
  WORKSPACE_CACHE: KVNamespace;
  ENVIRONMENT: string;
  /**
   * "true" enforces per-app permission checks: a key refused in the request's
   * app is a 403 even when another app grants it. Anything else only logs
   * those refusals. See @weldsuite/permissions app-scope.ts.
   */
  PERMISSIONS_APP_ENFORCE?: string;
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

  // --- Module workers (docs/plans/app-api-module-split.md) ---------------
  /** pass-api (WeldPass). Target of the forwarder for /api/weldpass. */
  PASS_API?: Fetcher;
  /** flow-api. Target of the forwarder for the flow module's paths. */
  FLOW_API?: Fetcher;
  /** mail-api. Target of the forwarder for the mail module's paths. */
  MAIL_API?: Fetcher;
  /** desk-api. Target of the forwarder for the desk module's paths. */
  DESK_API?: Fetcher;
  /** call-api. Target of the forwarder for the call module's paths. */
  CALL_API?: Fetcher;
  /** meet-api. Target of the forwarder for the meet module's paths. */
  MEET_API?: Fetcher;
  /** calendar-api. Target of the forwarder for the calendar module's paths. */
  CALENDAR_API?: Fetcher;
  /** books-api. Target of the forwarder for the books module's paths. */
  BOOKS_API?: Fetcher;
  /** data-api. Target of the forwarder for the data module's paths. */
  DATA_API?: Fetcher;
  /** crm-api. Target of the forwarder for the crm module's paths. */
  CRM_API?: Fetcher;
  /** commerce-api. Target of the forwarder for the commerce module's paths. */
  COMMERCE_API?: Fetcher;
  /** stash-api. Target of the forwarder for the stash module's paths. */
  STASH_API?: Fetcher;
  /** hr-api. Target of the forwarder for the hr module's paths. */
  HR_API?: Fetcher;
  /** ads-api. Target of the forwarder for the ads module's paths. */
  ADS_API?: Fetcher;
  /** social-api. Target of the forwarder for the social module's paths. */
  SOCIAL_API?: Fetcher;
  /** host-api. Target of the forwarder for the host module's paths. */
  HOST_API?: Fetcher;
  /** know-api. Target of the forwarder for the know module's paths. */
  KNOW_API?: Fetcher;

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

  // (WeldBooks' DIGIPOORT_MODE / DIGIPOORT_CERT moved to books-api.)
  /** Cloudflare RealtimeKit app id — used by WeldChat calls (@weldsuite/cloudflare-realtime). */
  CF_REALTIME_APP_ID?: string;
  /** Cloudflare RealtimeKit app secret — used by WeldChat calls (@weldsuite/cloudflare-realtime). */
  CF_REALTIME_APP_SECRET?: string;
  // (CF_REALTIME_WEBHOOK_TOKEN / MEETINGBAAS_WEBHOOK_TOKEN moved to meet-api
  // with the WeldMeet webhooks.)

  // (Project analytics' R2_SQL_API_TOKEN / R2_ANALYTICS_BUCKET moved to
  // flow-api and crm-api.)

  // --- Cloudflare + Stripe (the WeldHost keys moved to host-api) ----------
  /** Cloudflare API token with Zone (+ legacy Registrar) scopes. */
  CLOUDFLARE_API_TOKEN?: string;
  /** Cloudflare account that owns zones (and legacy registrar domains).
   *  Preferred over the legacy `CF_ACCOUNT_ID` name; both are accepted. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Stripe secret key (billing, workspace settings). */
  STRIPE_SECRET_KEY?: string;

  // (The help center's VERCEL_* custom-domain keys moved to desk-api.)

  /** R2 bucket for files, documents and generated avatars (participant-resolver.ts). */
  STORAGE?: R2Bucket;
  /** Public hostname that serves objects in the STORAGE bucket. */
  R2_PUBLIC_URL?: string;
  /** Base URL of the external-api worker (third-party surface). Returned to
   *  user-created apps by /api/user-apps/code/:code/session-token so the
   *  iframe bridge knows where to send wsat_-authenticated requests.
   *  Defaults to https://api.weldsuite.org when unset. */
  EXTERNAL_API_URL?: string;
  /**
   * Service binding to external-api. The WeldApps data gateway
   * (/api/user-apps/code/:code/gateway/v1/*) forwards through it: a Worker
   * cannot reach a same-zone route with a plain fetch.
   */
  EXTERNAL_API?: Fetcher;
  /**
   * Comma-separated master workspace ids whose WeldApps are first-party.
   * Those apps skip public review and show an Official badge in the store.
   */
  WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS?: string;

  // --- Entity-event publishing -------------------------------------------
  /**
   * Hub queue (entity-events-worker). Phase 2: audit / analytics / search-index
   * fan-out happens in the hub — this worker no longer produces those queues.
   * app-api still *consumes* `search-index*` via `queue()`.
   */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /**
   * D1 schedule index (shared with workflow-worker). Kept in sync by the
   * workflow-schedules service on schedule create/update/toggle/delete so the
   * schedule sweep can poll D1 instead of fanning out to every tenant DB.
   */
  SCHEDULE_INDEX?: D1Database;
  /**
   * D1 connector catch-up index (shared with integration-sync-worker). Kept in
   * sync on connector connect/pause/resume/disconnect and after webhook ingest
   * so the sweep can probe stores without opening tenant Neon.
   */
  CONNECTOR_SYNC_INDEX?: D1Database;
  /** CF Workflow for WeldConnect entity_event triggers (hosted in workflow-worker). */
  EXECUTE_WORKFLOW?: Workflow;
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
  /** CF Workflow that holds a notification email until the recipient has been
   *  away for the defer window, then sends only if they are still away and the
   *  notification is still unread. Hosted in app-api itself under the
   *  `deferred-notification-email*` names; dispatched by
   *  `createAndDeliverNotification` in @weldsuite/notifications. */
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
  // (SEND_DIGEST and IMPORT_TASKS moved to flow-api with WeldFlow; the
  // send-digest-v2* / import-tasks-v2* [[workflows]] blocks stay only while
  // their in-flight instances drain.)
  // (SEND_SCHEDULED_EMAIL moved to mail-api with WeldMail; the
  // send-scheduled-email-v2* [[workflows]] blocks stay only while their
  // in-flight instances drain.)
  /** CF Workflow that runs WeldAgent background work (chat replies, routine
   *  and WeldChat room runs) beyond the ~30s `waitUntil` budget. Hosted in
   *  app-api (class exported from src/index.ts). */
  WELDAGENT_JOB?: Workflow<import('./services/weldagent/jobs').WeldAgentJob>;
  /** Shared secret for internal service-to-service auth. Consumed by
   *  /api/internal (workflow-worker send_email bearer) and the internal
   *  /api/integrations router (X-Internal-Secret from integration-sync-worker
   *  and integration-webhook-worker). Must be SET with the same value those
   *  callers send. */
  INTERNAL_API_SECRET?: string;
  /**
   * Public HTTPS origin of integration-webhook-worker, used as the delivery
   * URL when registering WooCommerce / Shopify webhooks. Defaults from ENVIRONMENT.
   */
  CONNECTOR_WEBHOOK_BASE_URL?: string;

  // --- Cloudflare Email Sending (internal email, digests, test fixtures) ---
  /** Cloudflare `[[send_email]]` binding for outbound mail. */
  SEND_EMAIL?: SendEmail;
  // (WeldMail's MAIL_INBOUND_WORKER_NAME moved to mail-api.)

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
  // (GITHUB_PROJECT_OUTBOUND, dispatched by the WeldFlow task routes, moved
  // to flow-api.)

  // --- Notifications (`@weldsuite/notifications`) ------------------------
  // In-app delivery uses the REALTIME service binding declared above.
  /** Resend API key — used by the email channel and internal email.
   *  Optional locally. */
  RESEND_API_KEY?: string;
  /** AssemblyAI API key — used by TranscribeRecordingWorkflow (meeting/call
   *  recording transcription). New transcriptions run in meet-api; app-api
   *  still needs it while its draining `transcribe-recording-v2*` instances
   *  finish. Optional locally. */
  ASSEMBLYAI_API_KEY?: string;
  /** Resend template id for the task-assignment email. When unset, the
   *  helper falls back to a plain-text email. */
  RESEND_TEMPLATE_TASK_ASSIGNED?: string;
  // (The calendar attendee mails' RESEND_MEETING_*_TEMPLATE_ID moved to calendar-api.)
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

  // --- WeldAds (Meta Marketing API) --------------------------------------
  // FACEBOOK_APP_ID / FACEBOOK_APP_SECRET moved to ads-api with /api/ad-connections.
  /** Meta webhook verify token + X-Hub-Signature-256 verification secret. */
  FACEBOOK_WEBHOOK_VERIFY_TOKEN?: string;
  /** Public base URL for integration-webhook-worker (Meta ad webhooks). */
  INTEGRATION_WEBHOOK_BASE_URL?: string;

  // --- Cloudflare Flagship (feature flags) -------------------------------
  /** Flagship Worker binding — `env.FLAGSHIP.getBooleanValue(key, default, ctx)`.
   *  Configured via `[[flagship]]` in wrangler.toml (test/preview/production).
   *  Absent in local dev, where every flag resolves to its catalog default. */
  FLAGSHIP?: FlagshipBinding;

  // (Telephony's TELNYX_* moved to call-api.)

  // (HELPDESK_WORKFLOW_WORKER_URL moved to desk-api with /api/helpdesk-workflows.)
  /**
   * Base URL for weldsuite-agent-runtime (Cloudflare Sandbox + Browser Run).
   * Example: http://localhost:8795 or https://agent-runtime-test.weldsuite.org
   */
  AGENT_RUNTIME_URL?: string;
  /** When "false", computer/browser tools refuse calls. Default enabled if URL set. */
  AGENT_COMPUTER_ENABLED?: string;

  // --- Integrations (CRM / calendar OAuth apps + helpdesk channels) -------
  /** Attio OAuth app credentials. */
  ATTIO_CLIENT_ID?: string;
  ATTIO_CLIENT_SECRET?: string;
  /** HubSpot OAuth app credentials. */
  HUBSPOT_CLIENT_ID?: string;
  HUBSPOT_CLIENT_SECRET?: string;
  /** Moneybird OAuth app credentials (first-party WeldConnect connector). */
  MONEYBIRD_CLIENT_ID?: string;
  MONEYBIRD_CLIENT_SECRET?: string;
  /** Google Calendar OAuth app credentials (distinct from GOOGLE_CLIENT_ID,
   *  which belongs to the WeldConnect workflow-integrations app). */
  GOOGLE_CALENDAR_CLIENT_ID?: string;
  GOOGLE_CALENDAR_CLIENT_SECRET?: string;
  // (WeldDesk's DISCORD_* OAuth credentials + bot token moved to desk-api.)
  /** CRM sync engine — CrmSyncWorkflow hosted by integration-webhook-worker
   *  (workflow names crm-sync-int*); bound cross-script via `script_name`,
   *  same pattern as the GITHUB_PROJECT_SYNC bindings. */
  CRM_SYNC?: Workflow;
  // (APP_API_PUBLIC_URL, the helpdesk OAuth redirect_uri base override, moved
  // to desk-api and call-api.)
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
  /** Canonical app code from the X-Weld-App header (appContextMiddleware);
   *  requirePermission evaluates app-scoped keys against it. */
  app?: string;
  flags?: FlagContext;
  /** Set by `requireCustomObject()` — the resolved `custom_objects` row for
   *  the request's `:slug` param, so handlers never re-query it. */
  customObject?: CustomObjectRow;
};
