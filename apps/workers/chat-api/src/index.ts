/**
 * WeldSuite chat-api — the WeldChat (channels, channel members, messages,
 * DMs, bookmarks, drafts, sections, status, activity, directories, search,
 * entity channels, clips and calls) module's API worker, plus the
 * UnpinExpiredMessage workflow.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { channelMembersRoutes } from './routes/channel-members';
import { channelsRoutes } from './routes/channels';
import { chatActivityRoutes } from './routes/chat-activity';
import { chatBookmarksRoutes } from './routes/chat-bookmarks';
import { chatCallsRoutes } from './routes/chat-calls';
import { chatClipsRoutes } from './routes/chat-clips';
import { chatDirectoriesRoutes } from './routes/chat-directories';
import { chatDmRoutes } from './routes/chat-dm';
import { chatDraftsRoutes } from './routes/chat-drafts';
import { chatEntityChannelsRoutes } from './routes/chat-entity-channels';
import { chatMessagesRoutes } from './routes/chat-messages';
import { chatSearchRoutes } from './routes/chat-search';
import { chatSectionsRoutes } from './routes/chat-sections';
import { chatStatusRoutes } from './routes/chat-status';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'chat-api' });

// Auth + tenant DB + feature flags for everything under /api/*
app.use('/api/*', ...apiAuth());

// Object-based routes, in app-api's mount order.
app.route('/api/channel-members', channelMembersRoutes);
app.route('/api/channels', channelsRoutes);
app.route('/api/chat-activity', chatActivityRoutes);
app.route('/api/chat-bookmarks', chatBookmarksRoutes);
app.route('/api/chat-calls', chatCallsRoutes);
app.route('/api/chat-clips', chatClipsRoutes);
app.route('/api/chat-directories', chatDirectoriesRoutes);
app.route('/api/chat-dm', chatDmRoutes);
app.route('/api/chat-drafts', chatDraftsRoutes);
app.route('/api/chat-entity-channels', chatEntityChannelsRoutes);
app.route('/api/chat-messages', chatMessagesRoutes);
app.route('/api/chat-search', chatSearchRoutes);
app.route('/api/chat-sections', chatSectionsRoutes);
app.route('/api/chat-status', chatStatusRoutes);

// Cloudflare Workflow classes hosted by this worker (bound in wrangler.toml).
// Chat pin auto-expiry, under the `unpin-expired-message-v3*` names: app-api
// keeps `unpin-expired-message-v2*` only while its in-flight instances drain.
export { UnpinExpiredMessageWorkflow } from '@weldsuite/chat-domain/workflows/unpin-expired-message';

export default {
  fetch: app.fetch,
};
