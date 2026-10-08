import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * host-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the host module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** Schedule-index D1: `workspace_due_index` rows (kind `domain_renew`)
   *  telling the daily auto-renew sweep which workspaces to open. */
  SCHEDULE_INDEX?: D1Database;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;

  CF_ACCOUNT_ID?: string;

  // --- WeldHost (Realtime Register + Cloudflare Zones + Stripe checkout) --
  /** Cloudflare API token with Zone (+ legacy Registrar) scopes. */
  CLOUDFLARE_API_TOKEN?: string;
  /** Cloudflare account that owns zones (and legacy registrar domains).
   *  Preferred over the legacy `CF_ACCOUNT_ID` name; both are accepted. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Realtime Register API key (`Authorization: ApiKey …`). */
  REALTIME_REGISTER_API_KEY?: string;
  /** Realtime Register customer handle (single WeldSuite account). */
  REALTIME_REGISTER_CUSTOMER?: string;
  /** When `"true"`, use the RTR OTE (test) API base URL. */
  REALTIME_REGISTER_OTE?: string;
  /**
   * ADAC (Advanced Domain Availability Checker) API key from the ADAC
   * management panel. Different from `REALTIME_REGISTER_API_KEY`. Required
   * for `/api/domains/search` and `/api/domains/check`.
   */
  REALTIME_REGISTER_ADAC_API_KEY?: string;
  /** Optional ADAC TLD-set token. Omit to use the account default set. */
  REALTIME_REGISTER_ADAC_TLD_SET_TOKEN?: string;
  /** Optional platform contact handles for ADMIN/TECH/BILLING roles. */
  REALTIME_REGISTER_CONTACT_ADMIN?: string;
  REALTIME_REGISTER_CONTACT_TECH?: string;
  REALTIME_REGISTER_CONTACT_BILLING?: string;
  /** Shared secret for `/public/webhooks/realtime-register` (`?token=`). */
  REALTIME_REGISTER_WEBHOOK_SECRET?: string;
  /** Stripe secret key used to mint domain registration Checkout Sessions. */
  STRIPE_SECRET_KEY?: string;
}

export type Variables = KitVariables;
