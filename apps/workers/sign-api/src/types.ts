import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { OutboundGuardEnv } from '@weldsuite/mail-domain/outbound';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';
import type { FinalizeEnvelopeParams } from './workflows/finalize-envelope';

/**
 * sign-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the sign module uses. Add a binding here and in wrangler.toml together.
 *
 * `OUTBOUND_LEDGER`, `OUTBOUND_PLATFORM` and `OUTBOUND_BACKSTOP` are the
 * outbound mail guard's (hosted by mail-api, all optional because the guard
 * fails open). Signing emails count against the workspace (source `sign`).
 */
export interface Env
  extends KitEnv,
    Pick<OutboundGuardEnv, 'OUTBOUND_LEDGER' | 'OUTBOUND_PLATFORM' | 'OUTBOUND_BACKSTOP'> {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /** Sent as x-internal-secret on every realtime-worker /publish/* call. */
  REALTIME_INTERNAL_SECRET?: string;
  /** WeldSign files (private bucket, `workspaces/<org>/weldsign/<envelopeId>/…`), ADR SIGN-004. */
  PRIVATE_STORAGE: R2Bucket;

  // --- Signing ---------------------------------------------------------------
  /** Origin of apps/web/sign-portal; signing links are `${SIGN_PORTAL_URL}/r/<token>`. */
  SIGN_PORTAL_URL?: string;
  /**
   * HMAC key for signer sessions and for the stored hash of access and email
   * codes. Without it the signer portal answers 503 and access codes cannot be set.
   */
  SIGN_SESSION_SECRET?: string;
  /**
   * Shared with apps/web/sign-portal, which sends it as `X-Sign-Portal-Key`.
   * Only a request carrying it may report the signer's IP (`X-Signer-Ip`) for
   * the evidence trail; any other caller is recorded by `cf-connecting-ip`.
   */
  SIGN_PORTAL_SECRET?: string;
  /** Builds the signed PDF once the last signer has signed. Without it, sign-api finalizes in `waitUntil`. */
  FINALIZE_ENVELOPE?: Workflow<FinalizeEnvelopeParams>;
  /**
   * Schedule-index D1 (`workspace_due_index`, kind `sign_lifecycle`): which
   * workspaces have a reminder or an expiry coming due, so the lifecycle
   * sweep opens only those tenant DBs. Without it the sweep skips its tick.
   */
  SCHEDULE_INDEX?: D1Database;

  // --- System mail (@weldsuite/emails) -----------------------------------------
  /** Cloudflare Email Service binding; signing emails no-op without it (see `workerTransport`). */
  SEND_EMAIL?: SendEmail;
  /** Migration switch: "resend" sends through Resend instead of Cloudflare. */
  EMAIL_TRANSPORT?: string;
  /** Resend API key, the fallback transport while EMAIL_TRANSPORT="resend". */
  RESEND_API_KEY?: string;
  /** Migration-only sender override; see `workerTransport`. */
  SYSTEM_EMAIL_FROM?: string;
}

export type Variables = KitVariables;
