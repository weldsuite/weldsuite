import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';
import type { OutboundGuardEnv } from '@weldsuite/mail-domain/outbound';

/**
 * desk-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the desk module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /** Secret the realtime-worker requires on every /publish/* request (service-binding callers included). */
  REALTIME_INTERNAL_SECRET?: string;

  // --- Email (@weldsuite/worker-email) — desk email replies + channel dispatch ---
  /** Cloudflare `[[send_email]]` binding for outbound mail. */
  SEND_EMAIL?: SendEmail;

  // --- Outbound mail guard (@weldsuite/mail-domain/outbound) ---------------
  /** mail-api's `OutboundLedger` Durable Object (`script_name` binding). Unset: the guard skips the ledger. */
  OUTBOUND_LEDGER?: OutboundGuardEnv['OUTBOUND_LEDGER'];
  /** mail-api's `OutboundPlatformBudget` Durable Object. */
  OUTBOUND_PLATFORM?: OutboundGuardEnv['OUTBOUND_PLATFORM'];
  /** Per-sender burst limit the guard falls back on when the ledger is unreachable. */
  OUTBOUND_BACKSTOP?: OutboundGuardEnv['OUTBOUND_BACKSTOP'];

  // --- Help center custom domains (helpcenter-settings) ---------------------
  /** Cloudflare API token with Zone scopes (help center DNS records). */
  CLOUDFLARE_API_TOKEN?: string;
  /** Vercel API token with project domain scope. */
  VERCEL_API_TOKEN?: string;
  /** Vercel project id of the apps/web/helpcenter deployment. */
  VERCEL_HELPCENTER_PROJECT_ID?: string;
  /** Vercel team id, when the helpcenter project lives under a team. */
  VERCEL_TEAM_ID?: string;
  /** `sandbox` on test: help center records go to the WeldHost DNS sandbox (DNS_SANDBOX). */
  WELDHOST_DNS_MODE?: string;
  /** Test-only D1 holding WeldHost sandbox zones and records. Never bound in production. */
  DNS_SANDBOX?: D1Database;

  // --- Helpdesk analytics (R2 SQL / Iceberg, @weldsuite/core-domain/analytics-query) ---
  CF_ACCOUNT_ID?: string;
  /** Bearer token for the Cloudflare R2 SQL REST API. */
  R2_SQL_API_TOKEN?: string;
  /** Name of the R2 bucket that holds the Iceberg analytics catalog. */
  R2_ANALYTICS_BUCKET?: string;

  // --- Helpdesk workflow engine (apps/workers/helpdesk-workflow-worker) -----------
  /** Service binding to helpdesk-workflow-worker — used by
   *  POST /api/helpdesk-workflows/executions/:executionId/resume to forward
   *  customer responses to its /respond endpoint. The worker has no public
   *  hostname: it only answers service bindings. */
  HELPDESK_WORKFLOW?: Fetcher;

  // --- Helpdesk Discord/Slack channel integrations -------------------------
  /** Discord OAuth app credentials + bot token — WeldDesk helpdesk Discord
   *  channel integration ( /api/integrations/helpdesk/discord/callback ). */
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_BOT_TOKEN?: string;
  /** Slack app OAuth client id/secret — the helpdesk Slack OAuth callback
   *  ( /api/integrations/helpdesk/slack/callback ) reuses the WeldConnect
   *  slack.* integration app. */
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  /** Absolute base URL of the platform SPA (redirect target after OAuth),
   *  e.g. `https://app.weldsuite.org`. Defaults per ENVIRONMENT. */
  PUBLIC_APP_URL?: string;
  /** Optional override for app-api's public base URL — used to build the
   *  OAuth redirect_uri values (helpdesk Discord/Slack callbacks). Defaults to
   *  the per-environment app-api hostname when unset, so the redirect URIs
   *  registered with Discord/Slack keep pointing at app-api, whose forwarder
   *  hands /api/integrations/helpdesk/* to this worker. */
  APP_API_PUBLIC_URL?: string;
}

export type Variables = KitVariables;
