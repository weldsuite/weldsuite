/**
 * WeldSuite sign-api — WeldSign's API worker (electronic signatures).
 *
 * Members work on envelopes under /api/sign (Clerk, `apiAuth()`); signers
 * will reach /public/sign-portal through sign-portal (phase 2 of
 * docs/plans/weldsign.md). The prefixes it owns are listed in
 * @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import type { Env, Variables } from './types';
import envelopesRoutes from './routes/envelopes';

const app = createModuleApi<Env, Variables>({ service: 'sign-api' });

// Public routes (the signer portal) mount here, above the auth guard.

app.use('/api/*', ...apiAuth());

app.route('/api/sign/envelopes', envelopesRoutes);

export default {
  fetch: app.fetch,
};
