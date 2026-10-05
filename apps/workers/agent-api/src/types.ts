import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { WeldAgentJob } from '@weldsuite/agent-domain/jobs';
import type { DeferredEmailParams } from '@weldsuite/notifications/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * agent-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the agent module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). The WeldAgent runtime also
   *  publishes the records agents create. */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding — agent chat replies to the ChatRoom DO,
   *  live WorkspaceHub fan-out and in-app notifications. */
  REALTIME?: Fetcher;
  /**
   * D1 schedule index (shared with workflow-worker). Holds the WeldAgent
   * routine index (@weldsuite/agent-domain/routine-index) the hourly routine
   * sweep reads, kept in sync on routine / agent writes.
   */
  SCHEDULE_INDEX?: D1Database;
  /** CF Workflow that runs WeldAgent background work (chat replies, routine
   *  and WeldChat room runs) beyond the ~30s `waitUntil` budget. Hosted in
   *  this worker (class re-exported from src/index.ts, @weldsuite/agent-domain)
   *  under the `weldagent-job-v2*` names — app-api's old `weldagent-job*`
   *  names keep draining (docs/plans/app-api-module-split.md). */
  WELDAGENT_JOB?: Workflow<WeldAgentJob>;

  // --- AI (@weldsuite/ai) — Cloudflare AI Gateway ---------------------------
  // See packages/core/ai/src/config.ts for the full list of recognised keys.
  CF_ACCOUNT_ID?: string;
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

  // --- WeldAgent cloud computer (agent-runtime worker) ----------------------
  /**
   * agent-runtime `AgentRuntimeInternal` entrypoint (service binding). Preferred
   * path for computer/browser calls (no secret); the URL + bearer below is the
   * fallback while the binding is unbound or the entrypoint is not deployed.
   */
  AGENT_RUNTIME?: Fetcher;
  /**
   * Base URL for weldsuite-agent-runtime (Cloudflare Sandbox + Browser Run).
   * Fallback path only. Example: http://localhost:8795 or
   * https://agent-runtime-test.weldsuite.org
   */
  AGENT_RUNTIME_URL?: string;
  /** When "false", computer/browser tools refuse calls. Default enabled if a binding or URL is set. */
  AGENT_COMPUTER_ENABLED?: string;
  /** Fallback path only: shared secret the agent-runtime worker checks on the
   *  public computer/browser HTTP calls (must match agent-runtime's
   *  INTERNAL_API_SECRET). */
  INTERNAL_API_SECRET?: string;

  // --- Notifications (`@weldsuite/notifications`) ------------------------
  // Agent run / chat reply notifications. In-app delivery uses the REALTIME
  // service binding declared above.
  /** Resend API key — the notification email channel. Optional locally. */
  RESEND_API_KEY?: string;
  /** Migration switch: `resend` sends system email through Resend instead of
   *  the SEND_EMAIL binding (@weldsuite/emails workerTransport). Removed
   *  together with Resend at the end of the migration
   *  (docs/plans/system-email-cloudflare.md). */
  EMAIL_TRANSPORT?: string;
  /** Cloudflare `[[send_email]]` binding — the notification email channel. */
  SEND_EMAIL?: SendEmail;
  /** Absolute base URL for links in notification emails / push payloads,
   *  e.g. `https://app.weldsuite.org`. */
  PUBLIC_APP_URL?: string;
  /** CF Workflow that holds a notification email until the recipient has been
   *  away for the defer window. Hosted in app-api (`deferred-notification-email*`
   *  names), bound here cross-script via `script_name` in test/production. */
  DEFERRED_NOTIFICATION_EMAIL?: Workflow<DeferredEmailParams>;
}

export type Variables = KitVariables;
