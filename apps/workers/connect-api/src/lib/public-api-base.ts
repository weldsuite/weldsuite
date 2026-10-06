/**
 * The public HTTPS origin that serves THIS worker's routes to the outside
 * world — used to build absolute webhook receiver URLs
 * (`/api/workflows/webhook/:id`). The receiver is mounted in connect-api
 * itself (apps/workers/connect-api/src/routes/public-workflow-webhook), so
 * this is connect-api's own host, not the platform SPA (`PUBLIC_APP_URL`,
 * which previously — and wrongly — fed these URLs) and not
 * `CONNECTOR_WEBHOOK_BASE_URL` (integration-webhook-worker's host, for
 * outbound WooCommerce/Shopify webhook registration).
 */

import type { Env } from '../types';

export function publicApiBase(env: Env): string {
  if (env.CONNECT_API_URL) return env.CONNECT_API_URL;
  if (env.ENVIRONMENT === 'production') return 'https://connect-api.weldsuite.org';
  if (env.ENVIRONMENT === 'test') return 'https://connect-api-test.weldsuite.org';
  return 'http://localhost:8813';
}
