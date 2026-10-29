/**
 * WeldSuite Workspace Worker
 *
 * Dedicated Cloudflare Worker for workspace lifecycle operations:
 * - Onboarding (org creation + provisioning)
 * - Clerk webhook handling (org/membership/invitation/user events)
 * - Database provisioning with encrypted connection string storage
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { onboardRoutes, runOnboard, onboardSchema, type OnboardResult } from './routes/onboard';
import { clerkWebhookRoutes } from './routes/webhooks/clerk';
import { backfillMailRoutes } from './routes/backfill-mail';
import { adminDatabaseRoutes } from './routes/admin-databases';
import { triggerPoolRefill } from './workflows/refill-pool';
import { sweepScheduledDeletions } from './services/deletion-sweep';
import { runDatabaseMoveSweep } from './services/database-move-sweep';
import { sweepUnfinishedTeardowns } from './services/teardown-sweep';
import { repairWorkspaceMailDomains } from './services/mail-repair-sweep';
import { onboardPartnerWorkspace } from './services/partner-onboarding';
import type { PartnerOnboardResult } from '@weldsuite/core-domain/partners';
import type { MailboxStoreObject } from '@weldsuite/mail-domain/mailbox-object';
import type { MailIndex } from '@weldsuite/mail-domain/mail-index';

export interface Env {
  // Neon serverless connection string for the master database (replaces Hyperdrive)
  DATABASE_URL_MASTER: string;
  // KV namespace for workspace caching
  WORKSPACE_CACHE: KVNamespace;
  // Cloudflare Workflow for async workspace provisioning
  PROVISION_WORKSPACE: Workflow;
  // Cloudflare Workflow that keeps the warm database pool topped up
  REFILL_POOL?: Workflow;
  // Cloudflare Workflow that moves a workspace's tenant database between a
  // shared shard and a dedicated Neon project (TASK-1150). Instance id = the
  // `workspace_database_moves` row id.
  MOVE_DATABASE: Workflow;
  // KV namespace external-api and mcp-server cache the workspace in (the same
  // namespace app-api binds). A database move purges its entries
  // (`ws:<workspaceId>`, `mcp:org:<clerkOrgId>`) so they stop serving the old
  // database URL. Absent in local dev: those entries then expire on their TTL.
  API_CACHE?: KVNamespace;
  // Days the OLD database stays (read-only) after a move before the retention
  // sweep drops it (number as string — wrangler var). Defaults to 7.
  DATABASE_MOVE_RETENTION_DAYS?: string;
  // Shared secret (32+ chars) of the admin console's calls to
  // /api/internal/admin/* (database moves, live shard state). The console
  // (apps/web/admin) holds the same value. Unset: those routes answer 503.
  WORKSPACE_ADMIN_SECRET?: string;
  // Warm-pool watermarks (numbers as strings — wrangler vars). Shared slots
  // serve free workspaces, dedicated projects serve paid ones.
  POOL_TARGET_SHARED?: string;
  POOL_TARGET_DEDICATED?: string;
  // Neon database provisioning
  NEON_API_KEY: string;
  NEON_ORG_ID?: string;
  NEON_DEFAULT_REGION?: string;
  // Clerk Backend API
  CLERK_SECRET_KEY: string;
  CLERK_WEBHOOK_SECRET: string;
  // Stripe billing
  STRIPE_SECRET_KEY?: string;
  // Clerk M2M authentication (machine-to-machine tokens)
  CLERK_MACHINE_SECRET_KEY: string;
  // AES-256 key for encrypting connection strings (64-char hex)
  DATABASE_ENCRYPTION_KEY: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
  // "1" → new `workspaces.database_url` values are sealed AAD-bound (v3). Leave
  // unset until EVERY reader is deployed; see packages/core/db/src/lib/crypto.ts.
  FIELD_ENCRYPTION_AAD_WRITES?: string;
  // Cloudflare API token + account id for Email Routing provisioning.
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  // Worker name to deliver inbound mail to via Email Routing rules — this
  // environment's mail-inbound worker. Set explicitly per environment.
  MAIL_INBOUND_WORKER_NAME?: string;
  // Apex zone the shared {slug}.{apex} workspace mail domains live on:
  // weldmail.com in production, weldmail.org on test (each zone has one
  // catch-all, so the environments cannot share one).
  WELDMAIL_DOMAIN?: string;
  // --- Workspace invitation email (@weldsuite/emails, 'workspace.invitation') ---
  // Cloudflare `[[send_email]]` binding — the workspace invitation email,
  // sent when Clerk's organizationInvitation.created webhook fires.
  SEND_EMAIL?: SendEmail;
  // Migration switch: `resend` sends through Resend instead of the SEND_EMAIL
  // binding. Removed together with Resend at the end of the migration
  // (docs/plans/system-email-cloudflare.md).
  EMAIL_TRANSPORT?: string;
  // Resend API key — the migration-window fallback for the invitation email.
  RESEND_API_KEY?: string;
  // Public URL of the platform SPA, used to build the invitation accept link
  // shown in the email when Clerk doesn't return a ticket URL.
  APP_URL?: string;

  // --- Mailbox store (docs/plans/weldmail-mailbox-store-design.md, task D8) ---
  // One SQLite Durable Object per mailbox and one per workspace, both owned
  // and hosted by mail-api; reached here by `script_name` only to destroy a
  // deleted workspace's mail held outside Postgres
  // (services/workspace-mail-destroy.ts). Optional: an environment without
  // these bound (an older deploy, local `wrangler dev` without mail-api
  // running) just skips that step rather than failing the teardown.
  MAILBOX_STORE?: DurableObjectNamespace<MailboxStoreObject>;
  MAIL_INDEX?: DurableObjectNamespace<MailIndex>;

  // General config
  ENVIRONMENT: string;
}

const app = new Hono<{ Bindings: Env }>();

// Global middleware
app.use('*', logger());
app.use('*', cors({
  origin: [
    'https://app.weldsuite.org',
    'https://app-test.weldsuite.org',
    'https://app-preview.weldsuite.org',
    'http://localhost:3000',
  ],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Robots.txt — disallow all indexing
app.get('/robots.txt', (c) => {
  return c.text('User-agent: *\nDisallow: /\n');
});

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'workspace-worker',
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
  });
});

// Onboarding endpoint (internal API key auth)
app.route('/api/onboard', onboardRoutes);

// Clerk webhook handler (Svix signature verification)
app.route('/api/webhooks/clerk', clerkWebhookRoutes);

// Backfill endpoints (M2M auth)
app.route('/api/backfill', backfillMailRoutes);

// Admin console API: database moves and live shard state (shared secret + admin identity, see
// middleware/admin-auth.ts)
app.route('/api/internal/admin', adminDatabaseRoutes);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found', path: c.req.path }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('[Workspace Worker] Error:', err);
  return c.json({
    error: 'Internal Server Error',
    message: c.env.ENVIRONMENT === 'production' ? undefined : err.message,
  }, 500);
});

// Daily cron expression for the scheduled-deletion sweep (see wrangler.toml
// [triggers] crons — kept in sync with the string there). The */5 * * * *
// trigger keeps doing pool-refill; this one runs the "pay or be deleted"
// deletion sweep instead.
const DELETION_SWEEP_CRON = '0 3 * * *';

// Hourly: repair WeldMail domains that provisioning left unrouted (see
// services/mail-repair-sweep.ts). Kept off the 5-minute tick, which must not
// open a database while the pool is settled.
const MAIL_REPAIR_CRON = '17 * * * *';

export default {
  fetch: app.fetch,

  // Cron: three triggers configured in wrangler.toml [triggers] crons.
  //  - "*/5 * * * *" — keep the warm database pool topped up so workspace
  //    creation is instant (see workflows/refill-pool.ts). The 5-minute tick is
  //    for reacting quickly to a claim, NOT for polling Postgres: a settled pool
  //    is confirmed from KV and the tick opens no database at all.
  //  - "0 3 * * *"   — sweep workspaces whose 30-day "add payment or be
  //    deleted" grace period elapsed (see services/deletion-sweep.ts), retry
  //    the database teardowns of deleted workspaces that never finished (see
  //    services/teardown-sweep.ts), and drop the old databases of completed
  //    moves whose retention is over (see services/database-move-sweep.ts).
  //    The last two never throw.
  //  - "17 * * * *"  — re-provision recent workspaces whose WeldMail domain
  //    Cloudflare never routed (services/mail-repair-sweep.ts). Never throws.
  scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === DELETION_SWEEP_CRON) {
      ctx.waitUntil(sweepScheduledDeletions(env));
      ctx.waitUntil(sweepUnfinishedTeardowns(env));
      ctx.waitUntil(runDatabaseMoveSweep(env));
    } else if (event.cron === MAIL_REPAIR_CRON) {
      ctx.waitUntil(repairWorkspaceMailDomains(env));
    } else {
      ctx.waitUntil(triggerPoolRefill(env));
    }
  },
};

/**
 * RPC entrypoint for trusted in-network callers (e.g. app-api via a Cloudflare
 * service binding). Unlike the public `/api/onboard` HTTP route, RPC methods are
 * never exposed on the worker's public interface — they're only invocable over a
 * service binding — so this path is trusted by topology and requires no Clerk
 * M2M token. The public HTTP route keeps its `m2mAuth` guard for any external
 * caller. Callers reach this via `env.WORKSPACE_WORKER.onboard(payload)`.
 */
export class WorkspaceOnboardEntrypoint extends WorkerEntrypoint<Env> {
  async onboard(input: unknown): Promise<OnboardResult> {
    const parsed = onboardSchema.safeParse(input);
    if (!parsed.success) {
      console.error('[Onboard/RPC] Validation failed:', JSON.stringify(parsed.error.flatten()));
      return { success: false, error: 'Validation failed', status: 400 };
    }
    return runOnboard(this.env, this.ctx, parsed.data);
  }

  /**
   * Create a partner-managed workspace (reseller licensing): a Clerk org
   * without the partner user as a member, the customer's owner invited by email,
   * a master row with `billingMode: 'partner'` and its licence, and
   * provisioning started with the licensed apps and credits. Input:
   * `PartnerOnboardInput` from `@weldsuite/core-domain/partners`. Throws an
   * Error whose message starts with its code (`[INVALID_APPS] ...`); see
   * `PartnerOnboardError`.
   */
  async onboardPartnerWorkspace(input: unknown): Promise<PartnerOnboardResult> {
    return onboardPartnerWorkspace(this.env, input);
  }
}

export { ProvisionWorkspaceWorkflow } from './workflows/provision-workspace';
export { RefillPoolWorkflow } from './workflows/refill-pool';
export { MoveDatabaseWorkflow } from './workflows/move-database';
