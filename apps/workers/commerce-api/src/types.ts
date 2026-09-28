import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';

/**
 * commerce-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the commerce module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;

  /** Cloudflare `[[send_email]]` binding for outbound mail (commerce portal
   *  magic-link / sign-in code emails). */
  SEND_EMAIL?: SendEmail;
  /**
   * Public origin of the B2B commerce portal (no trailing slash), used in
   * magic-link emails. Defaults: production `https://orders.weldsuite.org`,
   * test `https://orders-test.weldsuite.org`, otherwise `http://localhost:3021`.
   */
  COMMERCE_PORTAL_URL?: string;

  // --- WooCommerce /wc-auth/v1 callback (@weldsuite/connect-domain) --------
  /** Shared secret for internal service-to-service auth. The WooCommerce
   *  callback verifies the HMAC `user_id` minted with it by
   *  POST /api/connectors/authorize (app-api), so it must hold the same value. */
  INTERNAL_API_SECRET?: string;
  /**
   * D1 connector catch-up index (shared with integration-sync-worker). Kept in
   * sync on connector connect/pause/resume/disconnect and after webhook ingest
   * so the sweep can probe stores without opening tenant Neon.
   */
  CONNECTOR_SYNC_INDEX?: D1Database;
  /**
   * Public HTTPS origin of integration-webhook-worker, used as the delivery
   * URL when registering WooCommerce / Shopify webhooks. Defaults from ENVIRONMENT.
   */
  CONNECTOR_WEBHOOK_BASE_URL?: string;
}

export type Variables = KitVariables & {
  /** B2B commerce portal buyer session (public `/public/commerce-portal` only). */
  portalPersonId?: string;
  portalCompanyId?: string;
  portalPartyId?: string;
  portalAccessId?: string;
  portalEmail?: string;
  portalSessionToken?: string;
};
