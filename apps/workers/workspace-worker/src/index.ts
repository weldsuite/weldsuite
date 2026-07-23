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
import { triggerPoolRefill } from './workflows/refill-pool';
import { sweepScheduledDeletions } from './services/deletion-sweep';

export interface Env {
  // Neon serverless connection string for the master database (replaces Hyperdrive)
  DATABASE_URL_MASTER: string;
  // KV namespace for workspace caching
  WORKSPACE_CACHE: KVNamespace;
  // Cloudflare Workflow for async workspace provisioning
  PROVISION_WORKSPACE: Workflow;
  // Cloudflare Workflow that keeps the warm database pool topped up
  REFILL_POOL?: Workflow;
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
  // Cloudflare API token + account id for Email Routing provisioning.
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  // Worker name to deliver inbound mail to via Email Routing rules.
  MAIL_INBOUND_WORKER_NAME?: string;
  // Resend API key — used to send our own workspace invitation email
  // when Clerk's organizationInvitation.created webhook fires.
  RESEND_API_KEY?: string;
  // Resend-hosted template ID for the workspace invitation email.
  RESEND_WORKSPACE_INVITATION_TEMPLATE_ID?: string;
  // Public URL of the platform SPA, used to build the invitation accept link
  // shown in the email when Clerk doesn't return a ticket URL.
  APP_URL?: string;
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

export default {
  fetch: app.fetch,

  // Cron: two triggers configured in wrangler.toml [triggers] crons.
  //  - "*/5 * * * *" — keep the warm database pool topped up so workspace
  //    creation is instant (see workflows/refill-pool.ts).
  //  - "0 3 * * *"   — sweep workspaces whose 30-day "add payment or be
  //    deleted" grace period elapsed (see services/deletion-sweep.ts).
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === DELETION_SWEEP_CRON) {
      ctx.waitUntil(sweepScheduledDeletions(env));
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
}

export { ProvisionWorkspaceWorkflow } from './workflows/provision-workspace';
export { RefillPoolWorkflow } from './workflows/refill-pool';
