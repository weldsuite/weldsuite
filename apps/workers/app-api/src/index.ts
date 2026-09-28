/**
 * WeldSuite App API Worker
 *
 * Unified first-party API for the platform SPA and all WeldSuite mobile
 * apps. Successor to core-api, api-worker, and mobile-api-worker. Routes
 * are organised by object (customers, ...) to mirror the object-based
 * permission model, so one canonical endpoint backs every surface across
 * the platform.
 *
 * Hostname pair:
 *   app-api.weldsuite.org   — this worker (first-party clients)
 *   api.weldsuite.org       — external-api worker (third-party integrations)
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { apiKeysRoutes } from './routes/api-keys';
import { workspaceApiKeysRoutes } from './routes/workspace-api-keys';
import { auditLogsRoutes } from './routes/audit-logs';
import { objectTemplatesRoutes } from './routes/object-templates';
import { driveRoutes } from './routes/drive';
import { featureFlagsRoutes } from './routes/feature-flags';
import { filesRoutes } from './routes/files';
import { foldersRoutes } from './routes/folders';
import { storageRoutes, storageUploadTokenRoute } from './routes/storage';
import { meRoutes } from './routes/me';
import { notificationPreferencesRoutes } from './routes/notification-preferences';
import { notificationsRoutes } from './routes/notifications';
import { rolesRoutes } from './routes/roles';
import { settingsProfileRoutes } from './routes/settings-profile';
import { customFieldsRoutes } from './routes/custom-fields';
import { customObjectsRoutes } from './routes/custom-objects';
import { customObjectRecordsRoutes } from './routes/custom-object-records';
import {
  customObjectLinkDefinitionRoutes,
  customObjectLinkTraversalRoutes,
  customObjectReverseRoutes,
} from './routes/custom-object-links';
import { dashboardRoutes } from './routes/dashboard';
import { appCatalogRoutes } from './routes/app-catalog';
import { creditsRoutes } from './routes/credits';
import { accessRequestsRoutes } from './routes/access-requests';
import { searchRoutes } from './routes/search';
import { workspaceSettingsRoutes } from './routes/workspace-settings';
import { authDesktopRoutes } from './routes/auth-desktop';
import { cliAuthRoutes } from './routes/cli-auth';
import { accountRoutes } from './routes/account';
import { onboardingRoutes } from './routes/onboarding';
import { teamMembersRoutes } from './routes/team-members';
import { userAppsRoutes } from './routes/user-apps';
import { userPreferencesRoutes } from './routes/user-preferences';
import { pushTokensRoutes } from './routes/push-tokens';
import { workspacesRoutes } from './routes/workspaces';
import { testFixturesRoutes } from './routes/_test-fixtures';
import { publicUserAppsRoutes } from './routes/public-user-apps';
// Legacy api-worker phase-out (W3/W4) — surfaces ported from apps/api-worker.
import { appstoreRoutes } from './routes/appstore';
import { authSessionsRoutes } from './routes/auth-sessions';
import { billingRoutes } from './routes/billing';
import { featureRequestsRoutes } from './routes/feature-requests';
import { gridViewsRoutes } from './routes/grid-views';
import { internalRoutes } from './routes/internal';
import { invitationsRoutes } from './routes/invitations';
import { memberLimitsRoutes } from './routes/member-limits';
import { myRoleRoutes } from './routes/my-role';
import { prepaidSeatsRoutes } from './routes/prepaid-seats';
import { supportRoutes } from './routes/support';
import type { Env, Variables } from './types';

// (The entity-event → workspace agent dispatch runner, registered for the
// entity-agents* queue consumer, moved to agent-api with WeldAgent.)

// Global middleware (request id, logger, CORS, X-Weld-App), /robots.txt,
// /health, the JSON notFound/onError envelope and the permission queries all
// come from the kit, so every API worker behaves the same. `forwardModules`
// hands paths of modules that moved to their own worker (API_FORWARD_MODULES)
// to that worker before anything else runs.
const app = createModuleApi<Env, Variables>({ service: 'app-api', forwardModules: true });

// Token-authenticated R2 upload — must be registered BEFORE the /api/* Clerk
// guard. The upload token (KV-backed, 10-min TTL) is the auth; there is no
// Clerk JWT on this request path.
app.route('/', storageUploadTokenRoute);

// CI-only test-fixtures router. Two-layer guard inside the router blocks
// requests in production (env check) and without a valid X-Test-Token
// header (token check). Mounted outside /api/* so no Clerk JWT is needed.
app.route('/test-fixtures', testFixturesRoutes);

// The public help-center feed (/public/helpcenter, consumed by the
// apps/web/helpcenter renderer) moved to desk-api with WeldDesk; the kit's
// forwarder (first middleware) hands it over DESK_API.

// Public WeldApps bundle host — PUBLIC (no Clerk). Serves the live R2 bundle
// of a user-created app so the platform can iframe it at /apps/{code}. Must
// stay ABOVE the app.use('/api/*', ...) guard below.
app.route('/public/user-apps', publicUserAppsRoutes);

// Clerk-authenticated but org-LESS: minting a desktop sign-in ticket must work
// before the user has selected a workspace. The route applies clerkMiddleware()
// itself; mounting here (BEFORE the global /api/* workspaceDb guard) skips the
// org requirement. Must stay ABOVE the app.use('/api/*', ...) line below.
app.route('/api/auth-desktop', authDesktopRoutes);

// CLI device-code login — PUBLIC for /device + /token; /approve applies Clerk
// + workspace itself. Must stay ABOVE the global /api/* workspaceDb guard.
app.route('/api/cli-auth', cliAuthRoutes);

// Account self-service (deletion) — Clerk-authenticated but org-LESS: a user
// without any workspace must still be able to delete their account (Google
// Play / GDPR). The router applies clerkMiddleware() itself; mounting here
// (BEFORE the global /api/* guard) skips the org requirement. Must stay ABOVE
// the app.use('/api/*', ...) line below.
app.route('/api/account', accountRoutes);

// The org-less mailbox directory (/api/mailboxes, clerkMiddleware only) moved
// to mail-api with WeldMail; the kit's forwarder (first middleware) hands it
// over MAIL_API.

// The GitHub App install callback (/api/weldconnect/github) moved to
// connect-api with WeldConnect; the kit's forwarder (first middleware) hands
// it over CONNECT_API.

// Onboarding — Clerk-authenticated but org-LESS: creating a NEW workspace must
// work without an active org (and would resolve the wrong tenant DB if it ran
// through workspaceDbMiddleware). The router applies clerkMiddleware() itself;
// mounting here (BEFORE the global /api/* guard) skips the org requirement.
// Must stay ABOVE the app.use('/api/*', ...) line below.
app.route('/api/onboarding', onboardingRoutes);

// Invitations — Clerk-authenticated but org-LESS: an invited user may have NO
// active org yet, so this must not pass through workspaceDbMiddleware. The
// router applies clerkMiddleware() itself; mounting here (BEFORE the global
// /api/* guard) skips the org requirement.
app.route('/api/invitations', invitationsRoutes);

// Internal service-to-service email dispatch — PUBLIC mount (no Clerk). Auth
// is the in-route `Authorization: Bearer <INTERNAL_API_SECRET>` check. Caller:
// workflow-worker's send_email action. Must stay ABOVE the /api/* guard.
app.route('/api/internal', internalRoutes);

// The Telnyx Call Control webhook (/public/webhooks/telnyx) and billing-worker's
// /api/internal/telephony/fulfill-number moved to call-api with the call
// module; the kit's forwarder (first middleware) hands them over CALL_API.

// The public WeldConnect trigger webhooks (/api/workflows/webhook) and
// workflow-worker's /api/internal/workflow-actions moved to connect-api with
// WeldConnect; the kit's forwarder (first middleware) hands them over
// CONNECT_API.

// The MeetingBaas (/api/webhooks/meeting-bot) and Cloudflare Realtime
// (/api/webhooks/cloudflare-realtime) webhooks moved to meet-api with WeldMeet;
// the kit's forwarder (first middleware) hands them over MEET_API.

// The helpdesk Discord/Slack OAuth callbacks (/api/integrations/helpdesk) moved
// to desk-api with WeldDesk; the redirect URIs registered with Discord/Slack
// keep pointing here and the kit's forwarder hands them over DESK_API.

// The internal (service-binding, X-Internal-Secret) and Clerk-authed
// /api/integrations routers moved to connect-api with WeldConnect.
// integration-sync-worker and integration-webhook-worker still call this
// worker over their APP_API binding; the kit's forwarder hands those paths
// over CONNECT_API.

// Auth + tenant DB + feature flags for everything under /api/*
app.use('/api/*', ...apiAuth());

// Object-based routes — one mount per object, ordered alphabetically so
// collisions surface during review.
// WeldBooks (accounting-*, invoices, bills, payments, bank-*, gl-accounts,
// journal-entries, tax-rates, vat-returns, …) moved to books-api; the kit's
// forwarder hands those paths to it over the BOOKS_API binding
// (API_FORWARD_MODULES in wrangler.toml).
app.route('/api/api-keys', apiKeysRoutes);
app.route('/api/workspace-api-keys', workspaceApiKeysRoutes);
app.route('/api/appstore', appstoreRoutes);
app.route('/api/audit-logs', auditLogsRoutes);
app.route('/api/auth-sessions', authSessionsRoutes);
app.route('/api/billing', billingRoutes);
// WeldCalendar (booking-pages, bookings, calendar-events, calendars,
// working-hours) moved to calendar-api; the kit's forwarder hands those paths
// to it over the CALENDAR_API binding (API_FORWARD_MODULES in wrangler.toml).
app.route('/api/object-templates', objectTemplatesRoutes);
// Calls, call intelligence, the WeldDesk phone channel (/api/desk/phone),
// porting and telephony moved to call-api; the kit's forwarder hands those
// paths to it over the CALL_API binding (API_FORWARD_MODULES in wrangler.toml).
// WeldChat (channels, channel-members, chat-*) moved to chat-api; the kit's
// forwarder hands those paths to it over the CHAT_API binding
// (API_FORWARD_MODULES in wrangler.toml).
app.route('/api/drive', driveRoutes);
app.route('/api/feature-flags', featureFlagsRoutes);
app.route('/api/feature-requests', featureRequestsRoutes);
app.route('/api/files', filesRoutes);
app.route('/api/folders', foldersRoutes);
app.route('/api/storage', storageRoutes);
app.route('/api/grid-views', gridViewsRoutes);
// WeldDesk (tickets, ticket-*, conversations, desk/conversations, desk/widget,
// helpdesk-*, helpcenter-settings, articles, article-folders, canned-responses,
// slas, satisfaction-surveys) moved to desk-api; the kit's forwarder hands those
// paths to it over the DESK_API binding (API_FORWARD_MODULES in wrangler.toml).
// WeldConnect (workflow*, workflows, integrations, connectors,
// external-webhooks, github-*) moved to connect-api; the kit's forwarder hands
// those paths to it over the CONNECT_API binding (API_FORWARD_MODULES in
// wrangler.toml).
// WeldFlow (projects, project-*, tasks, task-*, my-tasks, sprints, milestones,
// goals, whiteboards, documents, time-entries, digest-settings) moved to
// flow-api; the kit's forwarder hands those paths to it over the FLOW_API
// binding (API_FORWARD_MODULES in wrangler.toml).
// WeldMail (mail-*) moved to mail-api; the kit's forwarder hands those paths
// to it over the MAIL_API binding (API_FORWARD_MODULES in wrangler.toml).
// WeldMeet (meetings, meeting-*, transcriptions) moved to meet-api; the kit's
// forwarder hands those paths to it over the MEET_API binding
// (API_FORWARD_MODULES in wrangler.toml).
app.route('/api/member-limits', memberLimitsRoutes);
app.route('/api/notification-preferences', notificationPreferencesRoutes);
app.route('/api/notifications', notificationsRoutes);
app.route('/api/prepaid-seats', prepaidSeatsRoutes);
app.route('/api/roles', rolesRoutes);
// WeldCRM (companies, people, leads, opportunities, pipelines, activities,
// lists, sequences, …) moved to crm-api; the kit's forwarder hands those paths
// to it over the CRM_API binding (API_FORWARD_MODULES in wrangler.toml).
app.route('/api/settings/profile', settingsProfileRoutes);
app.route('/api/support', supportRoutes);
app.route('/api/custom-fields', customFieldsRoutes);
// WeldObjects — definition surface (weldobjects:manage) and record data
// surface (weldobjects:<slug>:<action>) are separate mounts on purpose.
// Link routes mount onto the SAME two prefixes; Hono merges the route tables,
// and the link paths (/:id/links, /:slug/records/:id/links) don't collide with
// the base routes above.
app.route('/api/custom-objects', customObjectsRoutes);
app.route('/api/custom-objects', customObjectLinkDefinitionRoutes);
app.route('/api/objects', customObjectRecordsRoutes);
app.route('/api/objects', customObjectLinkTraversalRoutes);
app.route('/api/related', customObjectReverseRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/app-catalog', appCatalogRoutes);
// WeldCommerce (products, orders, parcels, …, /public/commerce-portal and
// /webhooks/woocommerce) moved to commerce-api; the kit's forwarder hands those
// paths to it over the COMMERCE_API binding (API_FORWARD_MODULES in wrangler.toml).
app.route('/api/credits', creditsRoutes);
// WeldAgent (/api/ai, /api/ai-models, /api/chat-agent, /api/weldagent) moved
// to agent-api; the kit's forwarder hands those paths to it over the
// AGENT_API binding (API_FORWARD_MODULES in wrangler.toml).
app.route('/api/my-role', myRoleRoutes);
app.route('/api/access-requests', accessRequestsRoutes);
app.route('/api/search', searchRoutes);
app.route('/api/workspace-settings', workspaceSettingsRoutes);
app.route('/api/team-members', teamMembersRoutes);
app.route('/api/me', meRoutes);
app.route('/api/user-apps', userAppsRoutes);
app.route('/api/user-preferences', userPreferencesRoutes);
app.route('/api/push-tokens', pushTokensRoutes);
app.route('/api/workspaces', workspacesRoutes);
// WeldData (/api/welddata, /api/enrichments, /api/enrich-fields) moved to
// data-api; the kit's forwarder hands those paths to it over the DATA_API
// binding (API_FORWARD_MODULES in wrangler.toml).
// WeldPass (/api/weldpass) moved to pass-api; the kit's forwarder hands those
// paths to it over the PASS_API binding (API_FORWARD_MODULES in wrangler.toml).

// Cloudflare Workflow classes hosted by this worker (bound in wrangler.toml).
// The *-v2 names re-host api-worker's workflow classes (W4 legacy-worker
// phase-out); api-worker keeps the old names while in-flight instances drain.
// Draining: in-flight instances only; remove once no welddata-enrich* instance
// is running (they finish within minutes). data-api runs new ones as
// welddata-enrich-v2*.
export { WelddataEnrichWorkflow } from '@weldsuite/data-domain/workflows/welddata-enrich';
// Draining: in-flight instances only; remove once no send-scheduled-email-v2*
// instance is left (scheduled sends are at most MAX_SCHEDULE_DAYS = 7 days
// out). mail-api runs new ones as send-scheduled-email-v3*.
export { SendScheduledEmailWorkflow } from '@weldsuite/mail-domain/workflows/send-scheduled-email';
// Draining: in-flight instances only; remove after the longest sequence
// schedule has passed (check the dashboard for running execute-sequence-v2*
// instances). crm-api runs new ones as execute-sequence-v3*.
export { ExecuteSequenceWorkflow } from '@weldsuite/crm-domain/workflows/execute-sequence';
export { TrashCleanupWorkflow } from './workflows/trash-cleanup';
// Draining: in-flight instances only; remove once no transcribe-recording-v2*
// instance is running (they finish within minutes). meet-api runs new ones as
// transcribe-recording-v3*.
export { TranscribeRecordingWorkflow } from '@weldsuite/meet-domain/workflows/transcribe-recording';
// Draining: in-flight instances only; remove after the latest pin expiry set
// before the chat-api cutover has passed (check the dashboard for running
// unpin-expired-message-v2* instances). chat-api runs new ones as
// unpin-expired-message-v3*.
export { UnpinExpiredMessageWorkflow } from '@weldsuite/chat-domain/workflows/unpin-expired-message';
export { DeferredNotificationEmailWorkflow } from './workflows/deferred-notification-email';
// Draining: in-flight instances only; remove once no weldagent-job* instance
// is running (they finish within minutes: one step, 10-minute timeout).
// agent-api runs new ones as weldagent-job-v2*.
export { WeldAgentJobWorkflow } from '@weldsuite/agent-domain/workflows/weldagent-job';
// Draining: in-flight instances only; remove once no send-digest-v2* or
// import-tasks-v2* instance is running (they finish within minutes). flow-api
// runs new ones as send-digest-v3* / import-tasks-v3*.
export { SendDigestWorkflow } from '@weldsuite/flow-domain/workflows/send-digest';
export { ImportTasksWorkflow } from '@weldsuite/flow-domain/workflows/import-tasks';

// No cron sweeps left here: the hourly WeldAgent routine sweep moved to
// agent-api, the hourly task digest to flow-api, the daily calendar replan to
// calendar-api and the WeldHost domain auto-renew to host-api.
import { handleSearchIndexBatch } from './queue/search-index-consumer';
import type { EntityEventMessage } from '@weldsuite/entity-events';

export default {
  fetch: app.fetch,
  /**
   * Queue consumers:
   * - search-index* — semantic index (Phase 2 hub SUB_SEARCH)
   * (entity-agents* — WeldAgent eventSubscriptions — is consumed by agent-api.)
   */
  queue: async (batch: MessageBatch<EntityEventMessage>, env: Env) => {
    if (batch.queue.startsWith('search-index')) {
      await handleSearchIndexBatch(batch, env);
      return;
    }
    console.warn(`[app-api] no consumer registered for queue "${batch.queue}"`);
  },
};
