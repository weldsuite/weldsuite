/**
 * Worker → secrets manifest.
 * Defines which Doppler secrets each Cloudflare Worker needs.
 * Update this file when adding new workers or new secrets.
 *
 * Entry formats:
 *   "SECRET_NAME"                     — shared: same key in Doppler and the worker
 *   ["DOPPLER_KEY", "WORKER_SECRET"]  — mapped: Doppler key → worker secret name
 *
 * Use mapped entries when the same secret name needs a unique value per worker.
 * Example: each worker has its own BetterStack source token, so in Doppler
 * you store BETTERSTACK_TOKEN_API_WORKER, BETTERSTACK_TOKEN_BILLING, etc.
 * and map each to BETTERSTACK_TOKEN for that worker.
 */

export type SecretEntry = string | [dopplerKey: string, workerSecret: string];

export const manifest: Record<string, SecretEntry[]> = {
  "billing-worker": [
    "STRIPE_SECRET_KEY",
    "STRIPE_BILLING_WEBHOOK_SECRET",
    "CLERK_JWT_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_MACHINE_SECRET_KEY",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    // Fulfils WeldHost domain purchases: the checkout.session.completed handler
    // creates a Cloudflare DNS zone then registers via Realtime Register.
    // CLOUDFLARE_* still needed for zone creation (DNS stays on CF).
    // Without RTR credentials it bails before registering, leaving the customer
    // charged and the domain row stuck in pending_payment.
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "REALTIME_REGISTER_API_KEY",
    "REALTIME_REGISTER_CUSTOMER",
    "REALTIME_REGISTER_OTE",
    "REALTIME_REGISTER_CONTACT_ADMIN",
    "REALTIME_REGISTER_CONTACT_TECH",
    "REALTIME_REGISTER_CONTACT_BILLING",
    ["BETTERSTACK_TOKEN_BILLING_WORKER", "BETTERSTACK_TOKEN"],
  ],

  "workspace-worker": [
    "CLERK_SECRET_KEY",
    "CLERK_WEBHOOK_SECRET",
    "NEON_API_KEY",
    "CLERK_MACHINE_SECRET_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "STRIPE_SECRET_KEY",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    ["BETTERSTACK_TOKEN_WORKSPACE_WORKER", "BETTERSTACK_TOKEN"],
  ],

  // Inbound mail for BOTH tenancies. Workspace mail resolves a per-workspace
  // Neon URL (NEON_API_KEY + DATABASE_URL_MASTER + the encryption keys);
  // consumer WeldMail writes to the single shared personal DB, so without
  // DATABASE_URL_PERSONAL every @weldmail.com delivery fails to store.
  "mail-inbound-worker": [
    "DATABASE_URL_MASTER",
    "DATABASE_URL_PERSONAL",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    // Semantic label classification for inbound workspace mail.
    "CF_ACCOUNT_ID",
    "CF_AIG_TOKEN",
    ["BETTERSTACK_TOKEN_MAIL_INBOUND_WORKER", "BETTERSTACK_TOKEN"],
  ],

  // Consumer WeldMail backend (api.weldmail.com). Personal accounts live in
  // master; their mail lives in the shared personal DB. No Neon-per-tenant
  // resolution here, so no NEON_API_KEY / encryption keys.
  "personal-api": [
    "DATABASE_URL_MASTER",
    "DATABASE_URL_PERSONAL",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
  ],

  "helpdesk-widget-api": [
    ["BETTERSTACK_TOKEN_HELPDESK_WIDGET_API", "BETTERSTACK_TOKEN"],
  ],

  "helpdesk-workflow-worker": [
    "DATABASE_URL_MASTER",
    "CF_AIG_TOKEN",
    "INTERNAL_API_SECRET",
    "NEON_API_KEY",
    "FIREBASE_SERVICE_ACCOUNT",
    "DATABASE_ENCRYPTION_KEY",
    ["BETTERSTACK_TOKEN_HELPDESK_WORKFLOW_WORKER", "BETTERSTACK_TOKEN"],
  ],

  "external-api": [
    "API_SIGNING_SECRET",
    // Auth resolves tenant DB URLs from master workspace rows via Neon API.
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    // Publishes through @weldsuite/social-publishing directly (no dependency on
    // app-api), so it needs the SAME PostPeer key as app-api and mcp-server —
    // one WeldSuite-level PostPeer account backs all three. Unset leaves
    // POST /v1/social-posts/:id/publish and /schedule answering 503.
    "POSTPEER_API_KEY",
  ],

  // Authenticates every caller with Clerk OAuth (no API keys), then serves tool
  // calls from its own copy of the v1 resource routes against the tenant DB.
  // CLERK_SECRET_KEY verifies the access token; without it every request 401s.
  // NEON_API_KEY + DATABASE_URL_MASTER + DATABASE_ENCRYPTION_KEY resolve the
  // Clerk org to its workspace and tenant connection string.
  // CLERK_PUBLISHABLE_KEY is deliberately NOT here — it is public by design and
  // lives in wrangler.toml [vars], because the OAuth discovery documents decode
  // it to derive the Clerk issuer.
  "mcp-server": [
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
    "NEON_API_KEY",
    "DATABASE_URL_MASTER",
    "DATABASE_ENCRYPTION_KEY",
    // Same PostPeer key as app-api and external-api — publish_social_post and
    // schedule_social_post go through @weldsuite/social-publishing directly.
    // Unset leaves those two tools answering 503.
    "POSTPEER_API_KEY",
  ],

  "discord-bot-worker": [
    "DISCORD_BOT_TOKEN",
    "DISCORD_PUBLIC_KEY",
    "DISCORD_APPLICATION_ID",
    "MANAGEMENT_SECRET",
    ["BETTERSTACK_TOKEN_DISCORD_BOT_WORKER", "BETTERSTACK_TOKEN"],
  ],

  "integration-webhook-worker": [
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    // Calls app-api's internal integrations router (sync / renew-watch) over the
    // APP_API service binding with an X-Internal-Secret header. Must match the
    // target app-api env's INTERNAL_API_SECRET or the router 401s.
    "INTERNAL_API_SECRET",
    // GitHub App — hosts the Projects-v2 sync workflows + the App webhook receiver.
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "FACEBOOK_APP_SECRET",
    "FACEBOOK_WEBHOOK_VERIFY_TOKEN",
    ["BETTERSTACK_TOKEN_INTEGRATION_WEBHOOK_WORKER", "BETTERSTACK_TOKEN"],
  ],

  // Cron scheduler. Its only secret: the shared internal secret used to
  // authenticate against app-api's internal integrations router.
  "integration-sync-worker": [
    "INTERNAL_API_SECRET",
  ],

  // app-api: GitHub App secrets for the install flow + callback + Projects API,
  // plus the WeldHost domain-purchase pair.
  "app-api": [
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_PRIVATE_KEY",
    "DATABASE_ENCRYPTION_KEY",
    // Verifier side of the X-Internal-Secret handshake above — routes/integrations/
    // internal.ts fails closed (401) when this is unset, so every internal caller
    // (integration-sync-worker, integration-webhook-worker) needs the SAME value
    // in the same env.
    "INTERNAL_API_SECRET",
    // WeldHost domains. New purchases use Realtime Register (search/check/
    // checkout + transfers). CLOUDFLARE_* remains for DNS zones and for
    // mutations on legacy registrar=cloudflare rows. STRIPE_SECRET_KEY is
    // checked separately by /checkout — app-api creates the Checkout Session
    // itself, so billing-worker holding the key is not sufficient.
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "REALTIME_REGISTER_API_KEY",
    "REALTIME_REGISTER_CUSTOMER",
    "REALTIME_REGISTER_OTE",
    // ADAC availability checker — different key from the registrar REST key,
    // minted in the ADAC management panel. Search/check use this; register
    // still uses REALTIME_REGISTER_API_KEY.
    "REALTIME_REGISTER_ADAC_API_KEY",
    "REALTIME_REGISTER_ADAC_TLD_SET_TOKEN",
    "REALTIME_REGISTER_CONTACT_ADMIN",
    "REALTIME_REGISTER_CONTACT_TECH",
    "REALTIME_REGISTER_CONTACT_BILLING",
    "REALTIME_REGISTER_WEBHOOK_SECRET",
    "STRIPE_SECRET_KEY",
    // WeldSocial (PostPeer). The API key must hold the SAME value here as on
    // external-api and mcp-server below — all three publish through
    // @weldsuite/social-publishing against one WeldSuite-level PostPeer
    // account. The webhook secret verifies delivery callbacks, which only land
    // on this worker. POSTPEER_APP_IDS maps platform → BYOK OAuth app id and is
    // read on the connect flow, which only this worker exposes.
    "POSTPEER_API_KEY",
    "POSTPEER_WEBHOOK_SECRET",
    "POSTPEER_APP_IDS",
    "FACEBOOK_APP_ID",
    "FACEBOOK_APP_SECRET",
    "FACEBOOK_WEBHOOK_VERIFY_TOKEN",
    // Moneybird first-party connector (WeldConnect). Test app redirect:
    // `{PUBLIC_APP_URL}/weldconnect/connectors/callback`.
    "MONEYBIRD_CLIENT_ID",
    "MONEYBIRD_CLIENT_SECRET",
  ],

  "audit-log-worker": [
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
  ],
};

// ── Helpers ──────────────────────────────────────────────────

/** Resolve a SecretEntry to { dopplerKey, workerSecret } */
export function resolveEntry(entry: SecretEntry): {
  dopplerKey: string;
  workerSecret: string;
} {
  if (typeof entry === "string") {
    return { dopplerKey: entry, workerSecret: entry };
  }
  return { dopplerKey: entry[0], workerSecret: entry[1] };
}
