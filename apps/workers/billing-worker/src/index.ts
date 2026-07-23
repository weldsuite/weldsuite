/**
 * WeldSuite Billing Worker
 *
 * Dedicated Cloudflare Worker for Stripe billing:
 * - Stripe webhook handling (subscriptions, invoices, product/price sync)
 * - Billing API (checkout, portal, seats, invoices, plan limits)
 * - Seat-based billing with pre-purchase model
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { webhookRoutes } from './routes/webhooks';
import { billingRoutes } from './routes/billing';
import { phoneBillingRoutes } from './routes/phone-billing';
import { agentBillingRoutes } from './routes/agent-billing';
import { creditTopupRoutes } from './routes/credit-topup';
import { pricingSyncRoutes } from './routes/pricing-sync';
import { backfillRoutes } from './routes/backfill';
import { appSubscriptionsRoutes } from './routes/app-subscriptions';
import { appDeveloperAccountsRoutes } from './routes/app-developer-accounts';
import { sql } from 'drizzle-orm';
import { getMasterDb } from './lib/db';

export interface Env {
  // Hyperdrive binding for master database
  HYPERDRIVE_MASTER: Hyperdrive;
  // Direct database URL for local development
  DATABASE_URL_MASTER?: string;
  // General config
  ENVIRONMENT: string;
  // Stripe (also used for Stripe Connect — WeldApps marketplace developer
  // payouts reuse this same platform secret key; destination charges via
  // application_fee_percent/transfer_data don't require a separate secret)
  STRIPE_SECRET_KEY: string;
  STRIPE_BILLING_WEBHOOK_SECRET: string;
  // Clerk (for JWT verification on API routes)
  CLERK_SECRET_KEY: string;
  CLERK_JWT_KEY: string;
  // Clerk M2M authentication (machine-to-machine tokens)
  CLERK_MACHINE_SECRET_KEY: string;
  // Neon (for tenant DB access for credits)
  NEON_API_KEY: string;
  // Encryption key for stored database connection strings
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
  // KV namespace for workspace caching
  WORKSPACE_CACHE: KVNamespace;
  // Cloudflare Registrar API — required for domain registration after checkout
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
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
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Robots.txt — disallow all indexing
app.get('/robots.txt', (c) => {
  return c.text('User-agent: *\nDisallow: /\n');
});

// Health check
app.get('/health', async (c) => {
  const timestamp = new Date().toISOString();
  let dbStatus: 'pass' | 'warn' | 'fail' = 'fail';
  let dbTime = 0;
  let dbError: string | undefined;
  let httpStatus: 200 | 503 = 503;

  try {
    const db = getMasterDb(c.env);
    const start = Date.now();
    await Promise.race([
      db.execute(sql`SELECT 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    dbTime = Date.now() - start;
    dbStatus = dbTime > 1000 ? 'warn' : 'pass';
    httpStatus = 200;
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'unknown error';
  }

  return c.json({
    status: httpStatus === 200 ? dbStatus : 'fail',
    service: 'billing-worker',
    environment: c.env.ENVIRONMENT,
    timestamp,
    checks: {
      master_db: {
        status: dbStatus,
        componentType: 'datastore',
        observedValue: dbTime,
        observedUnit: 'ms',
        ...(dbError && { error: dbError }),
      },
    },
  }, httpStatus, { 'Cache-Control': 'no-cache, no-store' });
});

// Stripe webhook handler (signature verification, no auth)
app.route('/api/webhooks/stripe', webhookRoutes);

// Phone billing API routes (Clerk JWT auth) — mount before general billing routes
app.route('/api/billing/phone', phoneBillingRoutes);

// Agent-package billing (Clerk JWT + admin-only)
app.route('/api/billing/agents', agentBillingRoutes);

// Prepaid credit topups (Clerk JWT auth)
app.route('/api/billing/credits', creditTopupRoutes);

// WeldApps marketplace — paid app subscriptions (Clerk JWT + org-admin auth)
// — mounted before general billing routes, same as phone/agents/credits above
app.route('/api/billing/app-subscriptions', appSubscriptionsRoutes);

// WeldApps marketplace — developer payout accounts / Stripe Connect (Clerk JWT auth)
app.route('/api/billing/app-developer-accounts', appDeveloperAccountsRoutes);

// Billing API routes (Clerk JWT auth)
app.route('/api/billing', billingRoutes);

// Internal pricing sync routes (M2M token auth)
app.route('/api/internal/pricing', pricingSyncRoutes);

// Internal backfill routes (M2M token auth)
app.route('/api/internal/backfill', backfillRoutes);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found', path: c.req.path }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('[Billing Worker] Error:', err);
  return c.json({
    error: 'Internal Server Error',
    message: c.env.ENVIRONMENT === 'production' ? undefined : err.message,
  }, 500);
});

export default app;
