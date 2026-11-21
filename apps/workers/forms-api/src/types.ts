import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { OutboundGuardEnv } from '@weldsuite/mail-domain/outbound';
import type { DeferredEmailParams } from '@weldsuite/notifications/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';
import type { FormCounters } from './durable-objects/form-counters';
import type { ProcessResponseParams } from './workflows/process-params';

/**
 * forms-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * WeldForms uses. Add a binding here and in wrangler.toml together.
 *
 * `OUTBOUND_LEDGER`, `OUTBOUND_PLATFORM` and `OUTBOUND_BACKSTOP` are the
 * outbound mail guard's (hosted by mail-api, all optional because the guard
 * fails open). Emails to respondents count against the workspace (source
 * `forms`, added with the invitation routes).
 */
export interface Env extends KitEnv, Pick<OutboundGuardEnv, 'OUTBOUND_LEDGER' | 'OUTBOUND_PLATFORM' | 'OUTBOUND_BACKSTOP'> {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /** Sent as x-internal-secret on every realtime-worker /publish/* call. */
  REALTIME_INTERNAL_SECRET?: string;

  /** Respondent uploads and signatures (`weldforms/pending/…`, then `workspaces/<org>/weldforms/…`). */
  PRIVATE_STORAGE: R2Bucket;
  /** Images and videos authors put on questions and themes; public because respondents see them. */
  STORAGE: R2Bucket;
  /** Public origin of `STORAGE` (`R2_PUBLIC_URL`). */
  R2_PUBLIC_URL?: string;

  /** Cloudflare Email Service binding; mail no-ops without it (see `workerTransport`). */
  SEND_EMAIL?: SendEmail;
  /** Migration switch: "resend" sends through Resend instead of Cloudflare. */
  EMAIL_TRANSPORT?: string;
  RESEND_API_KEY?: string;
  SYSTEM_EMAIL_FROM?: string;

  /** Views per day, rate-limit windows and wrong-code counts: one Durable Object per form. */
  FORM_COUNTERS: DurableObjectNamespace<FormCounters>;
  /** Runs the steps after a response was submitted. Without it, they run in `waitUntil`. */
  PROCESS_RESPONSE?: Workflow<ProcessResponseParams>;
  /** Due index of the reminder and digest sweeps (kinds `forms_reminders`, `forms_digest`). */
  SCHEDULE_INDEX?: D1Database;

  /** Origin of apps/web/forms-portal; links are `${FORMS_PORTAL_URL}/f/<publicId>`. */
  FORMS_PORTAL_URL?: string;
  /** Holds a notification email until the member has been away a while (app-api's workflow, bound cross-script in test/production). */
  DEFERRED_NOTIFICATION_EMAIL?: Workflow<DeferredEmailParams>;

  /** Origin of the platform SPA; the members-only fill page lives there. */
  PLATFORM_URL?: string;
  /** `turnstile` | `altcha` | `none` (default `none`). */
  BOT_CHECK_PROVIDER?: string;
  /** Turnstile site key, sent to the portal in the public form payload. */
  TURNSTILE_SITE_KEY?: string;
  /** Test seam: overrides `FORM_LIMITS.minFillMs` (the minimum time between start and submit). */
  FORMS_MIN_FILL_MS?: string;

  // --- AI (@weldsuite/ai through the Cloudflare AI Gateway; absent = 503 `ai_unavailable`) ---
  /** The Cloudflare account the gateway runs in (a var). */
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  /** `anthropic` so the ops ledger books gateway BYOK calls without the Unified Billing fee. */
  AI_BYOK_PROVIDERS?: string;
  AI_FALLBACK_MODEL?: string;

  // --- Secrets (scripts/secrets/manifest.ts → "forms-api") ---------------------
  /** AI gateway token (else `CLOUDFLARE_API_TOKEN`). */
  AI_GATEWAY_API_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  /** The portal's key on /public/forms/* (X-Forms-Portal-Key); 503 while unset. */
  FORMS_PORTAL_SECRET?: string;
  /** HMAC key of respondent sessions, verification tokens and the stored form of emailed codes. */
  FORMS_SESSION_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  ALTCHA_HMAC_KEY?: string;
}

export type Variables = KitVariables;
