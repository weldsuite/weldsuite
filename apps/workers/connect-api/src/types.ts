import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * connect-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the connect module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;

  /** R2 bucket for files and documents (Moneybird attachment sync in the
   *  connector sync / webhook ingest, @weldsuite/connect-domain). */
  STORAGE?: R2Bucket;

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
  /** CRM sync engine — CrmSyncWorkflow hosted by integration-webhook-worker
   *  (workflow names crm-sync-int*); bound cross-script via `script_name`,
   *  same pattern as the GITHUB_PROJECT_SYNC bindings. */
  CRM_SYNC?: Workflow;

  /** Shared secret for internal service-to-service auth. Consumed by
   *  /api/internal/workflow-actions (workflow-worker create_customer bearer),
   *  the internal /api/integrations router (X-Internal-Secret from
   *  integration-sync-worker and integration-webhook-worker) and the
   *  WooCommerce connect HMAC `user_id`. Must be SET with the same value those
   *  callers (and app-api / commerce-api) use. */
  INTERNAL_API_SECRET?: string;
  /**
   * Public HTTPS origin of integration-webhook-worker, used as the delivery
   * URL when registering WooCommerce / Shopify webhooks. Defaults from ENVIRONMENT.
   */
  CONNECTOR_WEBHOOK_BASE_URL?: string;
  /** Absolute base URL of the platform SPA, e.g. `https://app.weldsuite.org`
   *  (workflow-integrations OAuth redirect_uri, workflow webhook URLs,
   *  connector return URLs). */
  PUBLIC_APP_URL?: string;

  // --- GitHub App integration (workflow-github) --------------------------
  /** GitHub App ID (numeric). */
  GITHUB_APP_ID?: string;
  /** GitHub App slug — used to build the install URL. */
  GITHUB_APP_SLUG?: string;
  /** GitHub App private key (PEM) — signs app JWTs. */
  GITHUB_APP_PRIVATE_KEY?: string;
  /** CF Workflow that re-syncs a repo end-to-end (class hosted in core-api). */
  GITHUB_FULL_SYNC?: Workflow;
  /** CF Workflow that syncs one GitHub Project (v2) link end-to-end
   *  (Projects-v2 model). Class hosted in integration-webhook-worker; bound
   *  here via `script_name`. */
  GITHUB_PROJECT_SYNC?: Workflow;

  // --- WeldConnect integration OAuth (@weldsuite/workflow-integrations) ---
  /** Slack app OAuth client id/secret — slack.* integration. */
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  /** Google OAuth client id/secret — google_sheets/gmail/calendar integrations. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  // --- Integrations (CRM / calendar OAuth apps, first-party connectors) ----
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

  // --- AI (@weldsuite/ai) — Cloudflare AI Gateway, /api/workflows/generate ---
  // See packages/core/ai/src/config.ts for the full list of recognised keys.
  CF_ACCOUNT_ID?: string;
  /** Optional; must be `cloudflare` (the only gateway). */
  AI_GATEWAY_PROVIDER?: string;
  /** Default canonical model id; falls back to the free Workers AI default. */
  AI_DEFAULT_MODEL?: string;
  /** Cloudflare API token (Workers AI + AI Gateway Run) → `Authorization`. */
  AI_GATEWAY_API_TOKEN?: string;
  /** Fallback AI token when AI_GATEWAY_API_TOKEN is unset (@weldsuite/ai config). */
  CLOUDFLARE_API_TOKEN?: string;
  /** AI Gateway id (`cf-aig-gateway-id`). Omit to use the account default. */
  CF_AI_GATEWAY?: string;
  /** Gateway auth token (`cf-aig-authorization`), for "Authenticated" gateways. */
  CF_AIG_TOKEN?: string;
}

export type Variables = KitVariables;
