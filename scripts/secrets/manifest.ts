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
    // Orders Telnyx numbers after phone checkout is paid (app-api /api/internal).
    "INTERNAL_API_SECRET",
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
    // Jev multi-label auto-labeling via Cloudflare AI Gateway / Workers AI.
    // CF_AI_GATEWAY is optional at runtime (defaults to `default`).
    // AI_GATEWAY_API_TOKEN is optional (enables direct /ai/run fallback).
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

  // booking-portal is a Next.js app (not a Worker). Sync does not push secrets
  // to it. Set DATABASE_URL_PERSONAL (or PERSONAL_DATABASE_URL) on the portal
  // host so `/p/{slug}` can resolve personal booking pages. Same Neon URL as
  // personal-api.

  "helpdesk-widget-api": [
    // Same value as discord-bot-worker DISCORD_PUBLIC_KEY — validates X-Bot-Secret
    // on /webhook/discord/* ingest routes.
    "DISCORD_BOT_SECRET",
    "WIDGET_TOKEN_SECRET",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "DATABASE_URL_MASTER",
    ["BETTERSTACK_TOKEN_HELPDESK_WIDGET_API", "BETTERSTACK_TOKEN"],
  ],

  "helpdesk-workflow-worker": [
    "DATABASE_URL_MASTER",
    "CF_AIG_TOKEN",
    "INTERNAL_API_SECRET",
    "NEON_API_KEY",
    "FIREBASE_SERVICE_ACCOUNT",
    "DATABASE_ENCRYPTION_KEY",
    // Outbound Discord embeds/buttons for interactive workflow steps.
    "DISCORD_BOT_TOKEN",
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

  // app-api. (The GitHub App secrets for the install flow + callback +
  // Projects API moved to "connect-api" with WeldConnect.)
  "app-api": [
    "DATABASE_ENCRYPTION_KEY",
    // Bearer of /api/internal (workflow-worker's send_email action) and of the
    // WeldAgent cloud computer (agent-runtime). The internal /api/integrations
    // router it also verified moved to "connect-api", which needs the SAME
    // value.
    "INTERNAL_API_SECRET",
    // CLOUDFLARE_API_TOKEN: the @weldsuite/ai token fallback (WeldMail's Email
    // Routing moved to "mail-api", help center custom domains to "desk-api").
    // CLOUDFLARE_ACCOUNT_ID: accepted by @weldsuite/ai as the CF_ACCOUNT_ID alias.
    // STRIPE_SECRET_KEY: /api/billing + workspace settings. (The WeldHost
    // Realtime Register secrets moved to "host-api".)
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "STRIPE_SECRET_KEY",
    // WeldSocial (PostPeer) secrets moved to "social-api".
    // WeldAds FACEBOOK_APP_ID / FACEBOOK_APP_SECRET moved to "ads-api".
    "FACEBOOK_WEBHOOK_VERIFY_TOKEN",
    // WeldDesk Discord OAuth + outbound REST moved to "desk-api".
    // The Moneybird first-party connector (WeldConnect) moved to "connect-api".
  ],

  "audit-log-worker": [
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
  ],

  // WeldAgent cloud computer (Sandbox + Browser Run). Auth is Bearer
  // INTERNAL_API_SECRET from app-api — must match the same env's app-api value.
  "agent-runtime": [
    "INTERNAL_API_SECRET",
  ],

  // pass-api: the pass module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "pass-api": [
    // WeldPass vault root key (moved here from app-api). Wraps every project
    // KEK — losing it makes every stored secret unrecoverable, so keep a
    // backup outside Doppler as well. Must be the SAME value app-api had:
    // existing vaults are wrapped with it.
    "WELDPASS_ROOT_KEY",
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
  ],

  // know-api: the know module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "know-api": [
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
  ],

  // host-api: the host module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "host-api": [
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
    // WeldHost domains (moved here from app-api). New purchases use Realtime
    // Register (search/check/checkout + transfers). CLOUDFLARE_* remains for
    // DNS zones and for mutations on legacy registrar=cloudflare rows.
    // STRIPE_SECRET_KEY is checked separately by /checkout — host-api creates
    // the Checkout Session itself (and the auto-renew invoices), so
    // billing-worker holding the key is not sufficient.
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
  ],

  // social-api: the social module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "social-api": [
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
    // WeldSocial (PostPeer, moved here from app-api). The API key must hold the
    // SAME value here as on external-api and mcp-server above — all three
    // publish through @weldsuite/social-publishing against one WeldSuite-level
    // PostPeer account. The webhook secret verifies delivery callbacks, which
    // only land on this worker. POSTPEER_APP_IDS maps platform → BYOK OAuth app
    // id and is read on the connect flow, which only this worker exposes.
    "POSTPEER_API_KEY",
    "POSTPEER_WEBHOOK_SECRET",
    "POSTPEER_APP_IDS",
  ],

  // ads-api: the ads module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "ads-api": [
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
    // WeldAds Meta OAuth (moved here from app-api): /api/ad-connections
    // authorize + callback. app-api's integration routes still run the ad
    // sync (@weldsuite/ads-domain) but never read these.
    "FACEBOOK_APP_ID",
    "FACEBOOK_APP_SECRET",
  ],

  // hr-api: the hr module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "hr-api": [
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
  ],

  // stash-api: the stash module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "stash-api": [
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
  ],

  // commerce-api: the commerce module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "commerce-api": [
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
    // WooCommerce /wc-auth/v1 callback (/webhooks/woocommerce): verifies the
    // HMAC `user_id` that app-api's POST /api/connectors/authorize signs with
    // this secret, so it must be the SAME value as app-api's in the same env.
    "INTERNAL_API_SECRET",
  ],

  // crm-api: the crm module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "crm-api": [
    // AI token for the ExecuteSequence ai_generate / ai_classify steps:
    // @weldsuite/ai uses AI_GATEWAY_API_TOKEN, else CLOUDFLARE_API_TOKEN (the
    // one app-api has), so carry the same token app-api runs on.
    "CLOUDFLARE_API_TOKEN",
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
  ],

  // data-api: the data module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "data-api": [
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
    // WeldData (moved here from app-api, where they were set by hand).
    // LEMLIST_API_KEY is the shared WeldSuite Lemlist key behind the lead
    // database; FINDYMAIL_API_KEY / PROSPEO_API_KEY back the email-finder
    // enrichment action of WelddataEnrichWorkflow. Each is optional: unset
    // leaves that search / provider unavailable.
    "LEMLIST_API_KEY",
    "FINDYMAIL_API_KEY",
    "PROSPEO_API_KEY",
  ],

  // books-api: the books module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "books-api": [
    // AI token for accounting document OCR: @weldsuite/ai uses
    // AI_GATEWAY_API_TOKEN, else CLOUDFLARE_API_TOKEN (the one app-api has),
    // so carry the same token app-api runs on.
    "CLOUDFLARE_API_TOKEN",
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
  ],

  // calendar-api: the calendar module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "calendar-api": [
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
  ],

  // meet-api: the meet module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "meet-api": [
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
  ],

  // call-api: the call module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "call-api": [
    // Verifier side of /api/internal/telephony/fulfill-number (billing-worker's
    // bearer; moved here from app-api's internal router). Must be the SAME value
    // as billing-worker (and app-api) in the same env.
    "INTERNAL_API_SECRET",
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
  ],

  // desk-api: the desk module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "desk-api": [
    // Help center custom domains (DNS records in zones), moved here from app-api.
    "CLOUDFLARE_API_TOKEN",
    // WeldDesk Discord OAuth + outbound REST (ticket panel, agent replies),
    // moved here from app-api.
    "DISCORD_CLIENT_ID",
    "DISCORD_CLIENT_SECRET",
    "DISCORD_BOT_TOKEN",
    // Bearer on the helpdesk-workflows resume forward to helpdesk-workflow-worker.
    // Must be the SAME value as app-api / helpdesk-workflow-worker in the same env.
    "INTERNAL_API_SECRET",
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
  ],

  // mail-api: the mail module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "mail-api": [
    // Mail domain provisioning through Cloudflare Email Routing
    // (@weldsuite/worker-email; moved here from app-api), and the AI token
    // /api/mail-ai runs on: @weldsuite/ai uses AI_GATEWAY_API_TOKEN, else
    // CLOUDFLARE_API_TOKEN (the one app-api has), so carry the same token.
    "CLOUDFLARE_API_TOKEN",
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
  ],

  // flow-api: the flow module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "flow-api": [
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
  ],

  // connect-api: the connect module's API worker (split from app-api). Base
  // secrets every API worker needs for Clerk auth and tenant DB resolution;
  // add the module's own secrets here as its code moves over.
  "connect-api": [
    "DATABASE_URL_MASTER",
    "NEON_API_KEY",
    "DATABASE_ENCRYPTION_KEY",
    "CLERK_SECRET_KEY",
    "CLERK_JWT_KEY",
    // GitHub App secrets for the install flow + callback + Projects API
    // (moved here from app-api).
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_PRIVATE_KEY",
    // Verifier side of the X-Internal-Secret handshake (routes/integrations/
    // internal.ts fails closed (401) when this is unset) and of the
    // /api/internal/workflow-actions bearer; also the WooCommerce connect HMAC
    // key. integration-sync-worker, integration-webhook-worker, workflow-worker,
    // app-api and commerce-api need the SAME value in the same env.
    "INTERNAL_API_SECRET",
    // Moneybird first-party connector (moved here from app-api). Test app
    // redirect: `{PUBLIC_APP_URL}/weldconnect/connectors/callback`.
    "MONEYBIRD_CLIENT_ID",
    "MONEYBIRD_CLIENT_SECRET",
    // AI token for /api/workflows/generate: @weldsuite/ai uses
    // AI_GATEWAY_API_TOKEN, else CLOUDFLARE_API_TOKEN (the one app-api has),
    // so carry the same token app-api runs on.
    "CLOUDFLARE_API_TOKEN",
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
