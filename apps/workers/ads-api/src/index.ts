/**
 * WeldSuite ads-api — the WeldAds (Meta ad connections, ad accounts, ad
 * campaigns) module's API worker.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 *
 * The integration workers' ad sync endpoints (/api/integrations/ad-events and
 * /api/integrations/ad-connections/:id/sync) stay on app-api with the connect
 * module; both workers share the sync code through @weldsuite/ads-domain.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { adAccountsRoutes } from './routes/ad-accounts';
import { adCampaignsRoutes } from './routes/ad-campaigns';
import { adConnectionsRoutes } from './routes/ad-connections';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'ads-api' });

app.use('/api/*', ...apiAuth());

app.route('/api/ad-accounts', adAccountsRoutes);
app.route('/api/ad-campaigns', adCampaignsRoutes);
app.route('/api/ad-connections', adConnectionsRoutes);

export default {
  fetch: app.fetch,
};
