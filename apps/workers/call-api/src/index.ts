/**
 * WeldSuite call-api — the call module's API worker: calls, call
 * intelligence, the WeldDesk phone channel (/api/desk/phone), telephony
 * (phone numbers), number porting, the Telnyx Call Control webhook and
 * billing-worker's internal phone-number fulfilment endpoint.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { callIntelligenceRoutes } from './routes/call-intelligence';
import { callsRoutes } from './routes/calls';
import { deskPhoneRoutes } from './routes/desk-phone';
import { internalTelephonyRoutes } from './routes/internal-telephony';
import { portingRoutes } from './routes/porting';
import { telephonyRoutes } from './routes/telephony';
import { telnyxWebhookRoutes } from './routes/webhooks-telnyx';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'call-api' });

// Internal service-to-service phone-number fulfilment — PUBLIC mount (no
// Clerk). Auth is the in-route `Authorization: Bearer <INTERNAL_API_SECRET>`
// check. Caller: billing-worker, now over CallInternal (below); this mount
// stays for the transition. Must stay ABOVE the /api/* guard.
app.route('/api/internal/telephony', internalTelephonyRoutes);

// Telnyx Call Control webhook — PUBLIC (no Clerk). Server-to-server events
// from Telnyx; Ed25519 signature enforcement applies when TELNYX_PUBLIC_KEY
// is set. Must stay ABOVE the /api/* guard.
app.route('/public/webhooks/telnyx', telnyxWebhookRoutes);

// Auth + tenant DB + feature flags for everything under /api/*
app.use('/api/*', ...apiAuth());

// Object-based routes, in app-api's mount order.
app.route('/api/calls', callsRoutes);
app.route('/api/call-intelligence', callIntelligenceRoutes);
app.route('/api/desk/phone', deskPhoneRoutes);
app.route('/api/porting', portingRoutes);
app.route('/api/telephony', telephonyRoutes);

export default {
  fetch: app.fetch,
};

// Internal entrypoint — bound as `CALL_INTERNAL` (entrypoint = "CallInternal") by
// billing-worker. A named entrypoint is only reachable over a service binding,
// so it is trusted by topology: the telephony router accepts `internalTrusted`
// instead of the INTERNAL_API_SECRET bearer. Only that router is mounted here,
// at the same path as on the public app, which stays until every caller uses
// the entrypoint (docs/plans/app-api-module-split.md, rollout item 7).
const internalApp = createModuleApi<Env, Variables>({ service: 'call-api' });
internalApp.use('*', async (c, next) => {
  c.set('internalTrusted', true);
  await next();
});
internalApp.route('/api/internal/telephony', internalTelephonyRoutes);

export class CallInternal extends WorkerEntrypoint<Env> {
  fetch(request: Request): Promise<Response> | Response {
    return internalApp.fetch(request, this.env, this.ctx);
  }
}
