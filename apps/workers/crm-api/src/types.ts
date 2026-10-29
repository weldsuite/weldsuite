import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';
import type { OutboundGuardEnv } from '@weldsuite/mail-domain/outbound';
import type { MailboxStoreObject } from '@weldsuite/mail-domain/mailbox-object';
import type { MailIndex } from '@weldsuite/mail-domain/mail-index';
import type { UsageMeterEnv } from '@weldsuite/credits/meters';

/**
 * crm-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the crm module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /** Secret the realtime-worker requires on every /publish/* request (service-binding callers included). */
  REALTIME_INTERNAL_SECRET?: string;
  /** chat-api service binding: company and person chats are forwarded there
   *  (lib/record-chat-forward.ts). */
  CHAT_API?: Fetcher;

  /** R2 bucket used for customer/contact avatars (lib/logo-fetch.ts). */
  STORAGE?: R2Bucket;
  /** Public hostname that serves objects in the STORAGE bucket. */
  R2_PUBLIC_URL?: string;

  /** CF Workflow for CRM sequence step execution. Hosted in this worker
   *  (class re-exported from src/index.ts) under the `execute-sequence-v3*`
   *  workflow names — app-api's old `execute-sequence-v2*` names keep
   *  draining (docs/plans/app-api-module-split.md). */
  EXECUTE_SEQUENCE?: Workflow<{
    /** Clerk org id (the workflow's realtime and tenant lookups key on it). */
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

  // --- Outbound mail guard (@weldsuite/mail-domain/outbound) ---------------
  /** mail-api's `OutboundLedger` Durable Object (`script_name` binding). Unset: the guard skips the ledger. */
  OUTBOUND_LEDGER?: OutboundGuardEnv['OUTBOUND_LEDGER'];
  /** mail-api's `OutboundPlatformBudget` Durable Object. */
  OUTBOUND_PLATFORM?: OutboundGuardEnv['OUTBOUND_PLATFORM'];
  /** Per-sender burst limit the guard falls back on when the ledger is unreachable. */
  OUTBOUND_BACKSTOP?: OutboundGuardEnv['OUTBOUND_BACKSTOP'];

  // --- Mailbox store (docs/plans/weldmail-mailbox-store-design.md, task D7) -
  /**
   * mail-api's mailbox Durable Object, bound by `script_name` (design §8).
   * Reached only through `@weldsuite/mail-domain/store`'s `getWorkspaceMail`
   * (`lib/mail-store-context.ts`) — nothing in this worker calls `idFromName`
   * on it directly.
   */
  MAILBOX_STORE?: DurableObjectNamespace<MailboxStoreObject>;
  /**
   * mail-api's per-workspace address index Durable Object, bound by
   * `script_name`. `recentAddresses` (the only mail-store call this worker
   * makes) reads one mailbox directly and never needs the index, but
   * `MailStoreEnv`'s object-mode client declares it, the same reason
   * `MAILBOX_STORE` is wired ahead of actual use.
   */
  MAIL_INDEX?: DurableObjectNamespace<MailIndex>;
  /**
   * EU-jurisdiction bucket for mail bodies and raw MIME (decision 7):
   * `weldsuite-mail`(-test), NOT the `STORAGE` bucket above (customer/contact
   * avatars). `recentAddresses` never touches a body; bound anyway because
   * `MailStoreEnv`'s object-mode client declares it required, the same reason
   * `MAILBOX_STORE` needs to be bound at deploy time even though this worker
   * never reads or writes a message body directly.
   */
  MAIL_STORAGE?: R2Bucket;
  // --- Usage meters (@weldsuite/credits/meters) ----------------------------
  /** mail-api's `UsageMeter` Durable Object (`script_name` binding): plan allowances
   *  and overage per workspace. Unset: metering fails open. */
  USAGE_METER?: UsageMeterEnv['USAGE_METER'];

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
