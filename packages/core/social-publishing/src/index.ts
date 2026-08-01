/**
 * @weldsuite/social-publishing — the single implementation of PostPeer
 * publishing, shared by app-api, external-api and mcp-server.
 *
 * Workers own auth, routing and their own bindings; they build a
 * `SocialPublishingContext` and call in here. Nothing in this package knows
 * about Hono, Clerk or API keys.
 */

export type {
  Database,
  MasterDatabase,
  SocialPublishingContext,
} from './context';

export {
  PostPeerNotConfiguredError,
  SocialPublishConflictError,
  SocialInsufficientCreditsError,
  ensureWorkspaceProfile,
  getConnectUrl,
  syncAccounts,
  publishPost,
  cancelPost,
  resolvePostpeerPost,
  reconcileFromWebhook,
  syncAnalytics,
} from './publishing';

export type {
  PublishPostOptions,
  PublishPostResult,
  SyncAccountsResult,
  PostPeerWebhookPayload,
} from './publishing';

export {
  PostPeerClient,
  PostPeerError,
  getPostPeerClient,
  getPostPeerAppId,
  toPostPeerSchedule,
  verifyPostPeerSignature,
} from './postpeer';

export type {
  PostPeerPlatform,
  PostPeerProfile,
  PostPeerIntegration,
  PostPeerMediaItem,
  PostPeerCreatePostInput,
  PostPeerCreatePostResult,
  PostPeerPlatformResult,
} from './postpeer';
