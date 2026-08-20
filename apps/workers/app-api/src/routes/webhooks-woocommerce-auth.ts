/**
 * WooCommerce Application Authentication callback — PUBLIC (no Clerk).
 *
 * The shop POSTs generated REST API keys here after the merchant clicks
 * Approve. WooCommerce requires HTTP 200 or it deletes the keys and shows
 * "unable to send the consumer data". Auth is the HMAC `user_id` minted by
 * POST /api/connectors/authorize.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { completeWooCommerceAppAuth } from '../../services/connectors/auth';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/auth', async (c) => {
  const rawBody = await c.req.text();
  try {
    const result = await completeWooCommerceAppAuth({
      env: c.env,
      rawBody,
      waitUntil: (promise) => c.executionCtx.waitUntil(promise),
    });
    return c.json({ data: { message: result.message } }, result.status as 200 | 400 | 500);
  } catch (err) {
    console.error('[app-api/woocommerce-auth] callback failed:', err);
    return c.json({ error: { message: 'Failed to complete WooCommerce connection' } }, 500);
  }
});

export const woocommerceAuthWebhookRoutes = app;
