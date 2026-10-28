import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';
import type { RateLimitBinding } from '@weldsuite/mail-domain/outbound';
import type { OutboundLedger, OutboundPlatformBudget } from '@weldsuite/mail-domain/outbound/ledger';
import type { OutboundReviewMessage } from '@weldsuite/mail-domain/outbound/consumers';

/**
 * mail-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the mail module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;

  /** Schedule-index D1: `workspace_due_index` rows (kind `mail_snooze`) that
   *  tell the snooze sweep which workspaces have mail coming due. */
  SCHEDULE_INDEX?: D1Database;

  /** R2 bucket for mail attachments and generated contact avatars. */
  STORAGE?: R2Bucket;
  /** Private uploads (no public domain); read via @weldsuite/worker-kit/storage. */
  PRIVATE_STORAGE?: R2Bucket;
  /** EU-jurisdiction bucket for raw MIME and message bodies (mail-domain store/bodies.ts). */
  MAIL_STORAGE?: R2Bucket;
  /** Public hostname that serves objects in the STORAGE bucket. */
  R2_PUBLIC_URL?: string;

  // --- WeldMail (Cloudflare Email Routing + Email Sending) ----------------
  /** Cloudflare `[[send_email]]` binding for outbound mail. */
  SEND_EMAIL?: SendEmail;
  /** Cloudflare API token with Zone / Email Routing scopes (mail domain
   *  provisioning via @weldsuite/worker-email). Also the AI token fallback
   *  when AI_GATEWAY_API_TOKEN is unset (@weldsuite/ai config). */
  CLOUDFLARE_API_TOKEN?: string;
  /** Worker name the customer's zone catch-all rule routes inbound mail to.
   *  Defaults to `weldsuite-mail-inbound` when unset. */
  MAIL_INBOUND_WORKER_NAME?: string;
  /** Apex the shared `{slug}.{apex}` workspace domains are built on:
   *  `weldmail.com` in production, `weldmail.org` on test. */
  WELDMAIL_DOMAIN?: string;
  /** CF Workflow that sleeps until `scheduledFor` then dispatches a
   *  scheduled email via the Cloudflare send binding. Hosted in this worker
   *  (class re-exported from src/index.ts, @weldsuite/mail-domain) under the
   *  `send-scheduled-email-v3*` workflow names — app-api's old
   *  `send-scheduled-email-v2*` names keep draining
   *  (docs/plans/app-api-module-split.md). */
  SEND_SCHEDULED_EMAIL?: Workflow<{
    workspaceId: string;
    userId: string;
    messageId: string;
    accountId: string;
    scheduledFor: string;
  }>;

  // --- AI (@weldsuite/ai) — Cloudflare AI Gateway, /api/mail-ai ------------
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

  // --- Outbound guard (docs/plans/weldmail-outbound-abuse.md) ---------------
  /** Per-workspace sending ledger; the class is hosted here (src/index.ts). */
  OUTBOUND_LEDGER?: DurableObjectNamespace<OutboundLedger>;
  /** Platform-wide daily budget against the Cloudflare quota; hosted here. */
  OUTBOUND_PLATFORM?: DurableObjectNamespace<OutboundPlatformBudget>;
  /** Per-sender backstop when the ledger is unreachable (`[[ratelimits]]`). */
  OUTBOUND_BACKSTOP?: RateLimitBinding;
  /** AI template reviews queued by the ledgers; consumed by this worker. */
  MAIL_OUTBOUND_REVIEW?: Queue<OutboundReviewMessage>;
  /** Queue id that provisioned domains subscribe their Email Sending events to. */
  MAIL_SENDING_EVENTS_QUEUE_ID?: string;
  /** Staff address for outbound abuse alerts. */
  ABUSE_NOTIFY_EMAIL?: string;
  /** Admin console origin, for links in the alerts. */
  ADMIN_CONSOLE_URL?: string;
  /** The Cloudflare account's daily Email Sending quota (recipients); unset = no platform budget. */
  CF_EMAIL_DAILY_QUOTA?: string;
  /** Shared secret the admin console sends to /internal/outbound/*. */
  OUTBOUND_ADMIN_SECRET?: string;
}

export type Variables = KitVariables;
