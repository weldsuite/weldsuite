import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { OutboundGuardEnv } from '@weldsuite/mail-domain/outbound';
import type { DbEnv } from '@weldsuite/worker-kit';
import type { UsageMeterEnv } from '@weldsuite/credits/meters';
import type { SignCodeAttempts } from './code-attempts';

/**
 * The bindings WeldSign's domain code uses. Two Workers run it: sign-api (the
 * workspace-facing API, `Env = KitEnv & SignEnv`) and apps/web/sign-portal
 * (the signer portal, which reads and writes the tenant DB itself). Add a
 * binding here and in both wrangler configs together.
 *
 * Built on `DbEnv`, not `KitEnv`: the portal has no Clerk. `OUTBOUND_LEDGER`,
 * `OUTBOUND_PLATFORM` and `OUTBOUND_BACKSTOP` are the outbound mail guard's
 * (hosted by mail-api, all optional because the guard fails open). Signing
 * emails count against the workspace (source `sign`). `USAGE_METER` (also
 * mail-api's, optional: metering fails open) counts requests sent against the
 * plan; only sign-api sends, so the portal does not bind it.
 */
export interface SignEnv
  extends DbEnv,
    Pick<OutboundGuardEnv, 'OUTBOUND_LEDGER' | 'OUTBOUND_PLATFORM' | 'OUTBOUND_BACKSTOP'>,
    UsageMeterEnv {
  /** "development" | "test" | "production". */
  ENVIRONMENT?: string;
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /** Sent as x-internal-secret on every realtime-worker /publish/* call. */
  REALTIME_INTERNAL_SECRET?: string;
  /**
   * WeldSign files (private bucket, `workspaces/<org>/weldsign/<envelopeId>/…`),
   * ADR SIGN-004, and the signed copies filed into WeldDrive.
   */
  PRIVATE_STORAGE: R2Bucket;
  /** The public bucket, read only: WeldDrive files from before the private bucket (`getStoredObject`). */
  STORAGE?: R2Bucket;

  // --- Signing ---------------------------------------------------------------
  /** Origin of apps/web/sign-portal; signing links are `${SIGN_PORTAL_URL}/r/<token>`. */
  SIGN_PORTAL_URL?: string;
  /**
   * HMAC key for signer sessions and for the stored hash of access and email
   * codes. sign-api hashes access codes with it and the portal checks them, so
   * both Workers need the same value. Without it the portal cannot open a link.
   */
  SIGN_SESSION_SECRET?: string;
  /**
   * Wrong access/email code counts, one Durable Object per signing link
   * (./code-attempts.ts). Hosted by sign-api; the portal binds it by `script_name`.
   */
  SIGN_CODE_ATTEMPTS: DurableObjectNamespace<SignCodeAttempts>;
  /**
   * Builds the signed PDF once the last signer has signed (sign-api's
   * FinalizeEnvelopeWorkflow; the portal binds it by `script_name`). Without
   * it, finalizing runs in `waitUntil`.
   */
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

export interface FinalizeEnvelopeParams {
  clerkOrgId: string;
  /** Master `workspaces.id` (link registry). */
  workspaceId: string;
  envelopeId: string;
}
