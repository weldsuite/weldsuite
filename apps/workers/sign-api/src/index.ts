/**
 * WeldSuite sign-api — WeldSign's API worker (electronic signatures).
 *
 * Members work on requests under /api/sign (Clerk, `apiAuth()`); signers use
 * /public/sign-portal through apps/web/sign-portal, with a signing link and
 * then a signer session (ADR SIGN-002). The prefixes it owns are listed in
 * @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import type { Env, Variables } from './types';
import envelopesRoutes from './routes/envelopes';
import signPortalRoutes from './routes/public-sign-portal';

export { FinalizeEnvelopeWorkflow } from './workflows/finalize-envelope';

const app = createModuleApi<Env, Variables>({ service: 'sign-api' });

// The signer portal mounts above the auth guard: signers have no Clerk session.
app.route('/public/sign-portal', signPortalRoutes);

app.use('/api/*', ...apiAuth());

app.route('/api/sign/envelopes', envelopesRoutes);

export default {
  fetch: app.fetch,
};
