/**
 * WeldSuite social-api — the WeldSocial (accounts, posts, campaigns, media,
 * approvals, analytics) module's API worker.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { postpeerWebhookRoutes } from './routes/public-postpeer-webhook';
import { socialAccountsRoutes } from './routes/social-accounts';
import { socialAnalyticsRoutes } from './routes/social-analytics';
import { socialApprovalsRoutes } from './routes/social-approvals';
import { socialCampaignsRoutes } from './routes/social-campaigns';
import { socialMediaRoutes } from './routes/social-media';
import { socialPostsRoutes } from './routes/social-posts';
import { socialSettingsRoutes } from './routes/social-settings';
import { socialTeamMembersRoutes } from './routes/social-team-members';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'social-api' });

// PostPeer social delivery webhook — PUBLIC (no Clerk). Resolves the workspace
// from a KV mapping recorded at publish time. Must stay ABOVE the /api/* guard.
app.route('/public/social/postpeer', postpeerWebhookRoutes);

app.use('/api/*', ...apiAuth());

app.route('/api/social-accounts', socialAccountsRoutes);
app.route('/api/social-analytics', socialAnalyticsRoutes);
app.route('/api/social-approvals', socialApprovalsRoutes);
app.route('/api/social-campaigns', socialCampaignsRoutes);
app.route('/api/social-media', socialMediaRoutes);
app.route('/api/social-posts', socialPostsRoutes);
app.route('/api/social-settings', socialSettingsRoutes);
app.route('/api/social-team-members', socialTeamMembersRoutes);

export default {
  fetch: app.fetch,
};
