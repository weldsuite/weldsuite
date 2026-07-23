/**
 * Mail Inbound Worker
 *
 * Receives inbound emails via Cloudflare Email Routing, which invokes the
 * `email(message, env, ctx)` runtime handler. Messages are parsed and run
 * through the `processInboundEmail` / `processAccountingInboxEmail` /
 * `processHelpdeskInboxEmail` storage pipeline.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import {
  processInboundEmail,
  processAccountingInboxEmail,
  processHelpdeskInboxEmail,
  collectRecipientEmails,
} from './lib/email-storage';
import { adaptCloudflareEmail } from './lib/cf-email-adapter';
import type { ForwardableEmailMessage } from '@weldsuite/email/providers/cloudflare';
import { sql } from 'drizzle-orm';
import { getMasterDb } from './db';

// Environment bindings
export interface Env {
  // Master DB connection (Neon HTTP) — set via `wrangler secret put DATABASE_URL_MASTER`
  DATABASE_URL_MASTER: string;
  // KV namespace for workspace URL caching
  WORKSPACE_CACHE: KVNamespace;
  // Neon API key for on-demand tenant connection resolution
  NEON_API_KEY: string;
  // R2 storage for mail attachments
  STORAGE: R2Bucket;
  R2_PUBLIC_URL?: string;
  // Service bindings
  REALTIME: Fetcher;
  ENVIRONMENT: string;
  // Encryption key for stored database connection strings
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
  // AI Gateway (for semantic email classification)
  CF_ACCOUNT_ID?: string;
  CF_AIG_TOKEN?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use('*', cors());

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
    service: 'mail-inbound-worker',
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

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found', path: c.req.path }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Worker Error:', err);
  return c.json(
    {
      error: 'Internal Server Error',
      message: c.env.ENVIRONMENT === 'production' ? undefined : err.message,
    },
    500
  );
});

/**
 * Cloudflare Email Routing entry point. The Email Routing infrastructure
 * invokes this whenever a routing rule with `actions: [{ type: 'worker' }]`
 * matches. Parses via @weldsuite/email's CloudflareReceiveProvider, adapts
 * to the worker-local ParsedEmail shape, then runs the storage pipeline.
 */
async function emailHandler(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  console.log(`[Email] Inbound from ${message.from} to ${message.to} (${message.rawSize} bytes)`);

  let adapted: Awaited<ReturnType<typeof adaptCloudflareEmail>>;
  try {
    adapted = await adaptCloudflareEmail(message);
  } catch (err) {
    console.error('[Email] Failed to parse incoming message:', err);
    message.setReject('Could not parse message');
    return;
  }

  const { email, attachments } = adapted;

  try {
    const result = await processInboundEmail(env, email, attachments);
    console.log(`[Email] Processed: ${result.stored} stored, ${result.notified} notified`);

    // Run downstream specialised inboxes in parallel — failures here must
    // not reject the message, since the main mail pipeline already accepted it.
    ctx.waitUntil(
      Promise.allSettled([
        processAccountingInboxEmail(env, email, attachments).then((r) => {
          if (r.processed) {
            console.log(`[Email] Accounting inbox: ${r.documentIds.length} documents created`);
          }
        }),
        processHelpdeskInboxEmail(env, email).then((r) => {
          if (r.processed) {
            console.log(`[Email] Helpdesk inbox: ${r.conversationIds.length} conversations updated/created`);
          }
        }),
      ]),
    );

    if (result.recipients === 0) {
      // No matching mailbox in our registry — reject with a 5xx so CF retries
      // briefly before bouncing. (Don't `setReject` permanently — the address
      // may have just been provisioned and the registry cache hasn't caught up.)
      console.warn(`[Email] No recipients matched: ${collectRecipientEmails(email).join(', ')}`);
    }
  } catch (err) {
    console.error('[Email] Storage pipeline failed:', err);
    // Re-throw so CF marks the delivery as failed and retries.
    throw err;
  }
}

export default {
  fetch: app.fetch,
  email: emailHandler,
};
