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
    // calls the Cloudflare Registrar directly to register the paid-for domain.
    // Without these it bails before registering, leaving the customer charged
    // and the domain row stuck in pending_payment.
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
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

  "mail-inbound-worker": [
    ["BETTERSTACK_TOKEN_MAIL_INBOUND_WORKER", "BETTERSTACK_TOKEN"],
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
    // WeldHost domains. routes/domains/index.ts builds its Cloudflare Registrar
    // client from CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (falling back to
    // the CF_ACCOUNT_ID var) and returns 503 on /search, /check and /checkout
    // when either is missing. STRIPE_SECRET_KEY is checked separately by
    // /checkout — app-api creates the Checkout Session itself, so billing-worker
    // holding the key is not sufficient.
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "STRIPE_SECRET_KEY",
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
