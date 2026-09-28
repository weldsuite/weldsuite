import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * crm-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the crm module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;

  /** R2 bucket used for customer/contact avatars (lib/logo-fetch.ts). */
  STORAGE?: R2Bucket;
  /** Public hostname that serves objects in the STORAGE bucket. */
  R2_PUBLIC_URL?: string;

  /** CF Workflow for CRM sequence step execution. Hosted in this worker
   *  (class re-exported from src/index.ts) under the `execute-sequence-v3*`
   *  workflow names — app-api's old `execute-sequence-v2*` names keep
   *  draining (docs/plans/app-api-module-split.md). */
  EXECUTE_SEQUENCE?: Workflow<{
    workspaceId: string;
    userId: string;
    sequenceId: string;
    enrollmentId: string;
    customerId: string;
  }>;

  // --- CRM analytics (R2 SQL / Iceberg, @weldsuite/core-domain) -------------
  /** Bearer token for the Cloudflare R2 SQL REST API. */
  R2_SQL_API_TOKEN?: string;
  /** Name of the R2 bucket that holds the Iceberg analytics catalog. */
  R2_ANALYTICS_BUCKET?: string;
  CF_ACCOUNT_ID?: string;

  // --- ExecuteSequenceWorkflow step runners (@weldsuite/crm-domain) ---------
  /** Cloudflare `[[send_email]]` binding for the send_email step. */
  SEND_EMAIL?: SendEmail;

  // --- AI (@weldsuite/ai) — Cloudflare AI Gateway, ai_generate / ai_classify
  // steps. See packages/core/ai/src/config.ts for the full list of recognised keys.
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
