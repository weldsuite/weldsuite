/**
 * Public Mailpool webhook, mounted at /public/reach/webhooks (above the auth
 * guard): POST /mailpool.
 *
 * Authenticated by signature, not by Clerk: `X-Signature` is the hex
 * HMAC-SHA256 of `JSON.stringify(parsed body)` under MAILPOOL_WEBHOOK_SECRET.
 * A bad or missing signature is a 401 and nothing is read from the body.
 * Unknown ids and events are acknowledged with 200 so Mailpool does not retry
 * them; a failure on our side is a 5xx so it does.
 *
 * It is not a CRUD route and changes rows only on behalf of Mailpool, so the
 * mailbox / domain events it publishes come from the service
 * (services/mailpool-webhooks.ts), as system events.
 */

import { Hono } from 'hono';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { error } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { openTenantDb } from '../../lib/tenant';
import { createMailpoolClient, type MailpoolClient } from '../../lib/mailpool/client';
import { MailpoolNotConfiguredError } from '../../lib/mailpool/errors';
import {
  handleMailpoolWebhook,
  parseMailpoolWebhook,
  verifyMailpoolSignature,
} from '../../services/mailpool-webhooks';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function optionalMailpoolClient(env: Env): MailpoolClient | null {
  try {
    return createMailpoolClient(env);
  } catch (err) {
    if (err instanceof MailpoolNotConfiguredError) return null;
    throw err;
  }
}

app.post('/mailpool', async (c) => {
  const secret = c.env.MAILPOOL_WEBHOOK_SECRET;
  if (!secret) return error.unavailable(c, 'Mailpool webhooks are not configured.');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // The signature covers the parsed body, so an unparseable one cannot be verified.
    return error.badRequest(c, 'Body must be JSON.');
  }

  if (!(await verifyMailpoolSignature(secret, c.req.header('X-Signature'), body))) {
    return error.unauthorized(c, 'Invalid signature.');
  }

  const message = parseMailpoolWebhook(body);
  if (!message) return c.json({ data: { handled: false, reason: 'unrecognised_payload' } });

  const outcome = await handleMailpoolWebhook(
    {
      env: c.env,
      master: getMasterDb(c.env),
      openTenant: (clerkOrgId) => openTenantDb(c.env, clerkOrgId),
      mailpool: optionalMailpoolClient(c.env),
    },
    message,
  );
  return c.json({ data: outcome });
});

export default app;
