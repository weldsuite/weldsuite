import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * call-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the call module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /** Secret the realtime-worker requires on every /publish/* request (service-binding callers included). */
  REALTIME_INTERNAL_SECRET?: string;

  /** R2 bucket for files and documents (number-porting documents, r2-port-docs.ts). */
  STORAGE?: R2Bucket;

  /** Shared secret for service-to-service calls. Verifier side of the PUBLIC
   *  /api/internal/telephony mount (billing-worker's phone-number fulfilment
   *  bearer). billing-worker now calls the `CallInternal` entrypoint (no
   *  secret); the public mount stays until it does everywhere. Must be SET with
   *  the same value the caller sends while it does. */
  INTERNAL_API_SECRET?: string;

  /** Stripe secret key (same value as billing-worker in the same env). Used
   *  only to re-read the Checkout Session that /api/internal/telephony/
   *  fulfill-number is asked to fulfil, so a number is never bought on the
   *  caller's word alone. Unset = every fulfilment is refused (503). */
  STRIPE_SECRET_KEY?: string;

  /** Optional override for app-api's public base URL (e.g. a dev tunnel). The
   *  Telnyx AI assistant's lookup_crm tool URL (lib/desk-phone-tools
   *  `lookupCrmUrl`) maps the per-environment app-api host to call-api's own
   *  host; an override it cannot map is used as is and app-api forwards. */
  APP_API_PUBLIC_URL?: string;

  // --- Telephony (Telnyx) — /api/telephony, /api/porting, Telnyx webhook ---
  /** Telnyx API key (Bearer) — all Telnyx REST calls. */
  TELNYX_API_KEY?: string;
  /** Telnyx Programmable Voice app id (call routing, phone numbers). */
  TELNYX_CONNECTION_ID?: string;
  /** Telnyx WebRTC credential connection id (SIP token generation). */
  TELNYX_SIP_CONNECTION_ID?: string;
  /** Legacy secret slot carried over from api-worker (declared, never used there). */
  TELNYX_WEBHOOK_SECRET?: string;
  /** Telnyx account public key (base64 Ed25519). REQUIRED:
   *  /public/webhooks/telnyx verifies every webhook signature and rejects all
   *  requests (401) while this is unset (fail closed). */
  TELNYX_PUBLIC_KEY?: string;
}

export type Variables = KitVariables;
