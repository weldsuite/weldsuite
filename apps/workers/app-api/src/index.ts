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

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { initPermissionMiddleware, createDrizzlePermissionQueries } from '@weldsuite/permissions/server';
import { getMasterDb, schema } from './db';
import { requestId } from './middleware/request-id';
import { clerkMiddleware } from './middleware/clerk';
import { workspaceDbMiddleware } from './middleware/workspace-db';
import { featureFlagsMiddleware } from './middleware/feature-flags';
import { accountingContactsRoutes } from './routes/accounting-contacts';
import { accountingDashboardRoutes } from './routes/accounting-dashboard';
import { accountingDocumentsRoutes } from './routes/accounting-documents';
import { accountingEntitiesRoutes } from './routes/accounting-entities';
import { accountingExportsRoutes } from './routes/accounting-exports';
import { icpDeclarationsRoutes } from './routes/icp-declarations';
import { accountingReportsRoutes } from './routes/accounting-reports';
import { accountingSettingsRoutes } from './routes/accounting-settings';
import { activitiesRoutes } from './routes/activities';
import { apiKeysRoutes } from './routes/api-keys';
import { workspaceApiKeysRoutes } from './routes/workspace-api-keys';
import { auditLogsRoutes } from './routes/audit-logs';
import { articleFoldersRoutes } from './routes/article-folders';
import { articlesRoutes } from './routes/articles';
import { knowledgeRoutes } from './routes/knowledge';
import { bankAccountsRoutes } from './routes/bank-accounts';
import { bankTransactionsRoutes } from './routes/bank-transactions';
import { billsRoutes } from './routes/bills';
import { bookingPagesRoutes } from './routes/booking-pages';
import { bookingsRoutes } from './routes/bookings';
import { boxesRoutes } from './routes/boxes';
import { carriersRoutes } from './routes/carriers';
import { calendarEventsRoutes } from './routes/calendar-events';
import { calendarsRoutes } from './routes/calendars';
import { cannedResponsesRoutes } from './routes/canned-responses';
import { objectTemplatesRoutes } from './routes/object-templates';
import { callsRoutes } from './routes/calls';
import { callIntelligenceRoutes } from './routes/call-intelligence';
import { channelMembersRoutes } from './routes/channel-members';
import { channelsRoutes } from './routes/channels';
import { chatActivityRoutes } from './routes/chat-activity';
import { chatAgentRoutes } from './routes/chat-agent';
import { chatBookmarksRoutes } from './routes/chat-bookmarks';
import { chatCallsRoutes } from './routes/chat-calls';
import { chatDirectoriesRoutes } from './routes/chat-directories';
import { chatDmRoutes } from './routes/chat-dm';
import { chatDraftsRoutes } from './routes/chat-drafts';
import { chatEntityChannelsRoutes } from './routes/chat-entity-channels';
import { chatMessagesRoutes } from './routes/chat-messages';
import { chatSearchRoutes } from './routes/chat-search';
import { chatSectionsRoutes } from './routes/chat-sections';
import { chatStatusRoutes } from './routes/chat-status';
import { categoriesRoutes } from './routes/categories';
import { companiesRoutes } from './routes/companies';
import { crmAnalyticsRoutes } from './routes/crm-analytics';
import { customerStatusesRoutes } from './routes/customer-statuses';
import { conversationsRoutes } from './routes/conversations';
import { deskConversationsRoutes } from './routes/desk-conversations';
import { deskTeamsRoutes, deskTeammatesRoutes } from './routes/desk-teams';
import { deskViewsRoutes } from './routes/desk-views';
import { deskMacrosRoutes } from './routes/desk-macros';
import { cycleCountsRoutes } from './routes/cycle-counts';
import { documentsRoutes } from './routes/documents';
import { driveRoutes } from './routes/drive';
import { enrichmentsRoutes } from './routes/enrichments';
import { featureFlagsRoutes } from './routes/feature-flags';
import { fiscalPeriodsRoutes } from './routes/fiscal-periods';
import { fxRatesRoutes } from './routes/fx-rates';
import { githubConnectionsRoutes } from './routes/github-connections';
import { githubRepoLinksRoutes } from './routes/github-repo-links';
import { githubProjectLinksRoutes } from './routes/github-project-links';
import { githubCallbackRoutes } from './routes/public-github-callback';
import { postpeerWebhookRoutes } from './routes/public-postpeer-webhook';
import { glAccountsRoutes } from './routes/gl-accounts';
import { helpdeskAgentsRoutes } from './routes/helpdesk-agents';
import { helpdeskAnalyticsRoutes } from './routes/helpdesk-analytics';
import { helpdeskAnnouncementsRoutes } from './routes/helpdesk-announcements';
import { helpdeskChangelogRoutes } from './routes/helpdesk-changelog';
import { helpdeskContactsRoutes } from './routes/helpdesk-contacts';
import { helpdeskDepartmentsRoutes } from './routes/helpdesk-departments';
import { helpdeskEmailRoutes } from './routes/helpdesk-email';
import { helpdeskFaqsRoutes } from './routes/helpdesk-faqs';
import { helpdeskFeedbackRoutes } from './routes/helpdesk-feedback';
import { helpdeskIntegrationsRoutes } from './routes/helpdesk-integrations';
import { helpdeskNewsRoutes } from './routes/helpdesk-news';
import { helpdeskReviewsRoutes } from './routes/helpdesk-reviews';
import { helpdeskSettingsRoutes } from './routes/helpdesk-settings';
import { helpdeskStatsRoutes } from './routes/helpdesk-stats';
import { helpdeskWeldagentRoutes } from './routes/helpdesk-weldagent';
import { helpdeskWorkflowsRoutes } from './routes/helpdesk-workflows';
import { helpcenterSettingsRoutes } from './routes/helpcenter-settings';
import { dnsRecordsRoutes } from './routes/dns-records';
import { dnsZonesRoutes } from './routes/dns-zones';
import { domainTransfersRoutes } from './routes/domain-transfers';
import { domainsRoutes } from './routes/domains';
import { emailForwardsRoutes } from './routes/email-forwards';
import { externalWebhooksRoutes } from './routes/external-webhooks';
import { filesRoutes } from './routes/files';
import { foldersRoutes } from './routes/folders';
import { storageRoutes, storageUploadTokenRoute } from './routes/storage';
import { integrationsRoutes } from './routes/integrations';
import { invoicesRoutes } from './routes/invoices';
import { journalEntriesRoutes } from './routes/journal-entries';
import { leadsRoutes } from './routes/leads';
import { milestonesRoutes } from './routes/milestones';
import { goalsRoutes } from './routes/goals';
import { inventoryRoutes } from './routes/inventory';
import { inventoryMovementsRoutes } from './routes/inventory-movements';
import { listsRoutes } from './routes/lists';
import { mailAccountsRoutes } from './routes/mail-accounts';
import { mailAiRoutes } from './routes/mail-ai';
import { mailAttachmentsRoutes } from './routes/mail-attachments';
import { mailCampaignsRoutes } from './routes/mail-campaigns';
import { mailDomainsRoutes } from './routes/mail-domains';
import { mailDraftsRoutes } from './routes/mail-drafts';
import { mailFoldersRoutes } from './routes/mail-folders';
import { mailLabelsRoutes } from './routes/mail-labels';
import { mailMessagesRoutes } from './routes/mail-messages';
import { mailRulesRoutes } from './routes/mail-rules';
import { mailScheduledRoutes } from './routes/mail-scheduled';
import { mailSignaturesRoutes } from './routes/mail-signatures';
import { mailSnoozeRoutes } from './routes/mail-snooze';
import { mailSyncRoutes } from './routes/mail-sync';
import { mailTemplatesRoutes } from './routes/mail-templates';
import { mailThreadsRoutes } from './routes/mail-threads';
import { mailWeldMailRoutes } from './routes/mail-weldmail';
import { meRoutes } from './routes/me';
import { meetingBotSessionsRoutes } from './routes/meeting-bot-sessions';
import { meetingMessagesRoutes } from './routes/meeting-messages';
import { meetingSessionsRoutes } from './routes/meeting-sessions';
import { meetingWaitlistRoutes } from './routes/meeting-waitlist';
import { meetingsRoutes } from './routes/meetings';
import { notificationPreferencesRoutes } from './routes/notification-preferences';
import { notificationsRoutes } from './routes/notifications';
import { opportunitiesRoutes } from './routes/opportunities';
import { ordersRoutes } from './routes/orders';
import { peopleRoutes } from './routes/people';
import { personCompaniesRoutes } from './routes/person-companies';
import { parcelsRoutes } from './routes/parcels';
import { parcelAnalyticsRoutes } from './routes/parcel-analytics';
import { parcelNotificationsRoutes } from './routes/parcel-notifications';
import { parcelRatesRoutes } from './routes/parcel-rates';
import { parcelSettingsRoutes } from './routes/parcel-settings';
import { parcelWalletRoutes } from './routes/parcel-wallet';
import { paymentsRoutes } from './routes/payments';
import { pickersRoutes } from './routes/pickers';
import { pickListsRoutes } from './routes/pick-lists';
import { pickupsRoutes } from './routes/pickups';
import { pipelineFieldVisibilityRoutes } from './routes/pipeline-field-visibility';
import { pipelineStagesRoutes } from './routes/pipeline-stages';
import { pipelinesRoutes } from './routes/pipelines';
import { productsRoutes } from './routes/products';
import { projectAnalyticsRoutes } from './routes/project-analytics';
import { projectFilesRoutes } from './routes/project-files';
import { projectLabelsRoutes } from './routes/project-labels';
import { projectDocumentsRoutes } from './routes/project-documents';
import { projectMembersRoutes } from './routes/project-members';
import { projectMessagesRoutes } from './routes/project-messages';
import { projectPipelineStagesRoutes } from './routes/project-pipeline-stages';
import { projectSheetsRoutes } from './routes/project-sheets';
import { projectsRoutes } from './routes/projects';
import { purchaseOrdersRoutes } from './routes/purchase-orders';
import { reconciliationRulesRoutes } from './routes/reconciliation-rules';
import { recurringInvoicesRoutes } from './routes/recurring-invoices';
import { returnReasonsRoutes } from './routes/return-reasons';
import { returnRulesRoutes } from './routes/return-rules';
import { returnsRoutes } from './routes/returns';
import { rolesRoutes } from './routes/roles';
import { satisfactionSurveysRoutes } from './routes/satisfaction-surveys';
import { customerSequencesRoutes, sequencesRoutes } from './routes/sequences';
import { settingsProfileRoutes } from './routes/settings-profile';
import { shipmentsRoutes } from './routes/shipments';
import { shippingPricesRoutes } from './routes/shipping-prices';
import { shippingRulesRoutes } from './routes/shipping-rules';
import { slasRoutes } from './routes/slas';
import { socialAccountsRoutes } from './routes/social-accounts';
import { socialAnalyticsRoutes } from './routes/social-analytics';
import { socialApprovalsRoutes } from './routes/social-approvals';
import { socialCampaignsRoutes } from './routes/social-campaigns';
import { socialMediaRoutes } from './routes/social-media';
import { socialPostsRoutes } from './routes/social-posts';
import { socialSettingsRoutes } from './routes/social-settings';
import { socialTeamMembersRoutes } from './routes/social-team-members';
import { sprintsRoutes } from './routes/sprints';
import { taskCommentsRoutes } from './routes/task-comments';
import { taskProjectsRoutes } from './routes/task-projects';
import { taskTagsRoutes } from './routes/task-tags';
import { tasksRoutes } from './routes/tasks';
import { taxRatesRoutes } from './routes/tax-rates';
import { vatReturnsRoutes } from './routes/vat-returns';
import { warehouseLocationsRoutes } from './routes/warehouse-locations';
import { warehousesRoutes } from './routes/warehouses';
import { warehouseZonesRoutes } from './routes/warehouse-zones';
import { wmsSuppliersRoutes } from './routes/wms-suppliers';
import { wmsActivityRoutes } from './routes/wms-activity';
import { customFieldsRoutes } from './routes/custom-fields';
import { enrichFieldsRoutes } from './routes/enrich-fields';
import { digestSettingsRoutes } from './routes/digest-settings';
import { dashboardRoutes } from './routes/dashboard';
import { appCatalogRoutes } from './routes/app-catalog';
import { printNodeRoutes } from './routes/printnode';
import { creditsRoutes } from './routes/credits';
import { aiModelsRoutes } from './routes/ai-models';
import { aiRoutes } from './routes/ai';
import { myTasksRoutes } from './routes/my-tasks';
import { accessRequestsRoutes } from './routes/access-requests';
import { searchRoutes } from './routes/search';
import { workspaceSettingsRoutes } from './routes/workspace-settings';
import { authDesktopRoutes } from './routes/auth-desktop';
import { accountRoutes } from './routes/account';
import { onboardingRoutes } from './routes/onboarding';
import { stockAdjustmentsRoutes } from './routes/stock-adjustments';
import { teamMembersRoutes } from './routes/team-members';
import { transcriptionsRoutes } from './routes/transcriptions';
import { ticketMessagesRoutes } from './routes/ticket-messages';
import { ticketNotesRoutes } from './routes/ticket-notes';
import { ticketTypesRoutes } from './routes/ticket-types';
import { ticketsRoutes } from './routes/tickets';
import { timeEntriesRoutes } from './routes/time-entries';
import { userAppsRoutes } from './routes/user-apps';
import { userPreferencesRoutes } from './routes/user-preferences';
import { pushTokensRoutes } from './routes/push-tokens';
import { workspacesRoutes } from './routes/workspaces';
import { weldagentRoutes } from './routes/weldagent';
import { welddataRoutes } from './routes/welddata';
import { whiteboardsRoutes } from './routes/whiteboards';
import { workflowBuilderRoutes } from './routes/workflow-builder';
import { workflowDashboardRoutes } from './routes/workflow-dashboard';
import { workflowExecutionsRoutes } from './routes/workflow-executions';
import { workflowGithubRoutes } from './routes/workflow-github';
import { workflowIntegrationsRoutes } from './routes/workflow-integrations';
import { workflowSchedulesRoutes } from './routes/workflow-schedules';
import { workflowTemplatesRoutes } from './routes/workflow-templates';
import { workflowTriggersRoutes } from './routes/workflow-triggers';
import { workflowVariablesRoutes } from './routes/workflow-variables';
import { workflowWebhooksRoutes } from './routes/workflow-webhooks';
import { workflowsRoutes } from './routes/workflows';
import { testFixturesRoutes } from './routes/_test-fixtures';
import { publicHelpcenterRoutes } from './routes/public-helpcenter';
import { publicUserAppsRoutes } from './routes/public-user-apps';
// Legacy api-worker phase-out (W3/W4) — surfaces ported from apps/api-worker.
import { appstoreRoutes } from './routes/appstore';
import { authSessionsRoutes } from './routes/auth-sessions';
import { billingRoutes } from './routes/billing';
import { chatClipsRoutes } from './routes/chat-clips';
import { featureRequestsRoutes } from './routes/feature-requests';
import { gridViewsRoutes } from './routes/grid-views';
import { integrationsHelpdeskOAuthRoutes } from './routes/integrations/helpdesk-oauth';
import { integrationsInternalRoutes } from './routes/integrations/internal';
import { internalRoutes } from './routes/internal';
import { invitationsRoutes } from './routes/invitations';
import { memberLimitsRoutes } from './routes/member-limits';
import { myRoleRoutes } from './routes/my-role';
import { portingRoutes } from './routes/porting';
import { prepaidSeatsRoutes } from './routes/prepaid-seats';
import { publicWorkflowWebhookRoutes } from './routes/public-workflow-webhook';
import { putawayRoutes } from './routes/putaway';
import { supportRoutes } from './routes/support';
import { telephonyRoutes } from './routes/telephony';
import { telnyxWebhookRoutes } from './routes/webhooks-telnyx';
import { webhooksCloudflareRealtimeRoutes } from './routes/webhooks-cloudflare-realtime';
import { webhooksMeetingBotRoutes } from './routes/webhooks-meeting-bot';
import { workingHoursRoutes } from './routes/working-hours';
import type { Env, Variables } from './types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

initPermissionMiddleware({
  createQueries: (c) =>
    createDrizzlePermissionQueries(c.get('tenantDb'), schema, { eq, and, isNull }),
});

// Global middleware
app.use('*', requestId());
app.use('*', logger());
app.use(
  '*',
  cors({
    origin: (origin) => {
      if (origin && /\.welddesk\.org$/.test(origin)) return origin;
      const allowed = [
        'https://app.weldsuite.org',
        'https://app-test.weldsuite.org',
        'https://app-preview.weldsuite.org',
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:5173',
      ];
      if (origin && allowed.includes(origin)) return origin;
      return 'https://app.weldsuite.org';
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // X-Test-Token / X-Test-Flags are the test-only seams (gated by env +
    // token in their respective middleware, inert in production). Allowing the
    // header NAMES here just lets a browser-driven E2E send them cross-origin;
    // it grants nothing on its own.
    allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Test-Token', 'X-Test-Flags', 'X-Accounting-Entity-Id'],
    exposeHeaders: ['X-Request-Id'],
    credentials: true,
  }),
);

app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));

app.get('/health', async (c) => {
  const timestamp = new Date().toISOString();
  let dbStatus: 'pass' | 'warn' | 'fail' = 'fail';
  let dbTime = 0;
  let dbError: string | undefined;
  let httpStatus: 200 | 503 = 503;

  try {
    const db = getMasterDb(c.env);
    const start = Date.now();
    await Promise.race([
      db.execute(sql`SELECT 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    dbTime = Date.now() - start;
    dbStatus = dbTime > 1000 ? 'warn' : 'pass';
    httpStatus = 200;
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'unknown error';
  }

  return c.json(
    {
      status: httpStatus === 200 ? dbStatus : 'fail',
      service: 'app-api',
      environment: c.env.ENVIRONMENT,
      timestamp,
      checks: {
        master_db: {
          status: dbStatus,
          componentType: 'datastore',
          observedValue: dbTime,
          observedUnit: 'ms',
          ...(dbError && { error: dbError }),
        },
      },
    },
    httpStatus,
    { 'Cache-Control': 'no-cache, no-store' },
  );
});

// Token-authenticated R2 upload — must be registered BEFORE the /api/* Clerk
// guard. The upload token (KV-backed, 10-min TTL) is the auth; there is no
// Clerk JWT on this request path.
app.route('/', storageUploadTokenRoute);

// CI-only test-fixtures router. Two-layer guard inside the router blocks
// requests in production (env check) and without a valid X-Test-Token
// header (token check). Mounted outside /api/* so no Clerk JWT is needed.
app.route('/test-fixtures', testFixturesRoutes);

// Public help-center feed consumed by the apps/web/helpcenter renderer. No Clerk
// JWT — the tenant DB is resolved from the `?domain=` param by the router's
// own middleware. Must stay ABOVE the app.use('/api/*', ...) guard below.
app.route('/public/helpcenter', publicHelpcenterRoutes);

// Public WeldApps bundle host — PUBLIC (no Clerk). Serves the live R2 bundle
// of a user-created app so the platform can iframe it at /apps/{code}. Must
// stay ABOVE the app.use('/api/*', ...) guard below.
app.route('/public/user-apps', publicUserAppsRoutes);

// Clerk-authenticated but org-LESS: minting a desktop sign-in ticket must work
// before the user has selected a workspace. The route applies clerkMiddleware()
// itself; mounting here (BEFORE the global /api/* workspaceDb guard) skips the
// org requirement. Must stay ABOVE the app.use('/api/*', ...) line below.
app.route('/api/auth-desktop', authDesktopRoutes);

// Account self-service (deletion) — Clerk-authenticated but org-LESS: a user
// without any workspace must still be able to delete their account (Google
// Play / GDPR). The router applies clerkMiddleware() itself; mounting here
// (BEFORE the global /api/* guard) skips the org requirement. Must stay ABOVE
// the app.use('/api/*', ...) line below.
app.route('/api/account', accountRoutes);

// GitHub App install callback — PUBLIC (no Clerk). GitHub's server-to-server
// redirect carries no session; auth is the state JWT signed at /install-url.
// Must stay ABOVE the app.use('/api/*', ...) guard below.
app.route('/api/weldconnect/github', githubCallbackRoutes);

// PostPeer social delivery webhook — PUBLIC (no Clerk). Resolves the workspace
// from a KV mapping recorded at publish time. Must stay ABOVE the /api/* guard.
app.route('/public/social/postpeer', postpeerWebhookRoutes);

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

// Telnyx Call Control webhook — PUBLIC (no Clerk). Server-to-server events
// from Telnyx; Ed25519 signature enforcement applies when TELNYX_PUBLIC_KEY
// is set. Must stay ABOVE the /api/* guard.
app.route('/public/webhooks/telnyx', telnyxWebhookRoutes);

// External workflow trigger webhooks — PUBLIC. POST /:webhookId authenticates
// per-webhook (HMAC signature / IP allowlist) inside the receiver service.
// Mounted more specifically than the authed /api/workflows router below, so
// only /api/workflows/webhook/* bypasses Clerk. Must stay ABOVE the guard.
app.route('/api/workflows/webhook', publicWorkflowWebhookRoutes);

// MeetingBaas meeting-bot webhook — PUBLIC (server-to-server, no Clerk).
app.route('/api/webhooks/meeting-bot', webhooksMeetingBotRoutes);

// Cloudflare Realtime (RTK) webhook — PUBLIC. POST /setup (re-)registers the
// webhook with Cloudflare per env.
//
// ⚠ POST / does NOT verify any RTK signature — there is no authenticity or
// replay control on the receiver. Its only gate is the `rtk-meeting:{id}` KV
// lookup, so anyone who learns a live cfMeetingId can forge a meeting.ended /
// meeting.participantLeft for that tenant. This is faithful parity with the
// api-worker original (the gap is inherited, not introduced by the port) and
// is an OPEN item for the W6 hardening pass — do not read this mount as
// evidence that the endpoint is authenticated.
app.route('/api/webhooks/cloudflare-realtime', webhooksCloudflareRealtimeRoutes);

// Helpdesk Discord/Slack OAuth callbacks — PUBLIC (browser redirects carry no
// Clerk JWT; auth is the one-time KV state nonce minted by the authorize
// endpoints). MUST be mounted before the internal integrations router below
// so /api/integrations/helpdesk/* never enters it, and above the /api/* guard.
app.route('/api/integrations/helpdesk', integrationsHelpdeskOAuthRoutes);

// Internal (service-binding) integration endpoints — X-Internal-Secret auth
// for integration-sync-worker / integration-webhook-worker. Handlers call
// next() when no internal headers are present, so normal platform traffic
// falls through to the Clerk-authed /api/integrations router mounted after
// the guard. Must stay ABOVE the /api/* guard.
app.route('/api/integrations', integrationsInternalRoutes);

// Auth + tenant DB + feature flags for everything under /api/*
app.use('/api/*', clerkMiddleware(), workspaceDbMiddleware(), featureFlagsMiddleware());

// Object-based routes — one mount per object, ordered alphabetically so
// collisions surface during review.
app.route('/api/accounting-contacts', accountingContactsRoutes);
app.route('/api/accounting-dashboard', accountingDashboardRoutes);
app.route('/api/accounting-documents', accountingDocumentsRoutes);
app.route('/api/accounting-entities', accountingEntitiesRoutes);
app.route('/api/accounting-exports', accountingExportsRoutes);
app.route('/api/icp-declarations', icpDeclarationsRoutes);
app.route('/api/accounting-reports', accountingReportsRoutes);
app.route('/api/accounting-settings', accountingSettingsRoutes);
app.route('/api/activities', activitiesRoutes);
app.route('/api/api-keys', apiKeysRoutes);
app.route('/api/workspace-api-keys', workspaceApiKeysRoutes);
app.route('/api/appstore', appstoreRoutes);
app.route('/api/audit-logs', auditLogsRoutes);
app.route('/api/auth-sessions', authSessionsRoutes);
app.route('/api/article-folders', articleFoldersRoutes);
app.route('/api/articles', articlesRoutes);
app.route('/api/knowledge', knowledgeRoutes);
app.route('/api/bank-accounts', bankAccountsRoutes);
app.route('/api/bank-transactions', bankTransactionsRoutes);
app.route('/api/bills', billsRoutes);
app.route('/api/billing', billingRoutes);
app.route('/api/booking-pages', bookingPagesRoutes);
app.route('/api/bookings', bookingsRoutes);
app.route('/api/boxes', boxesRoutes);
app.route('/api/calendar-events', calendarEventsRoutes);
app.route('/api/calendars', calendarsRoutes);
app.route('/api/canned-responses', cannedResponsesRoutes);
app.route('/api/object-templates', objectTemplatesRoutes);
app.route('/api/carriers', carriersRoutes);
app.route('/api/calls', callsRoutes);
app.route('/api/call-intelligence', callIntelligenceRoutes);
app.route('/api/categories', categoriesRoutes);
app.route('/api/channel-members', channelMembersRoutes);
app.route('/api/channels', channelsRoutes);
app.route('/api/chat-activity', chatActivityRoutes);
app.route('/api/chat-agent', chatAgentRoutes);
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
app.route('/api/companies', companiesRoutes);
app.route('/api/crm-analytics', crmAnalyticsRoutes);
app.route('/api/customer-statuses', customerStatusesRoutes);
app.route('/api/conversations', conversationsRoutes);
app.route('/api/desk/conversations', deskConversationsRoutes);
app.route('/api/desk/teams', deskTeamsRoutes);
app.route('/api/desk/teammates', deskTeammatesRoutes);
app.route('/api/desk/views', deskViewsRoutes);
app.route('/api/desk/macros', deskMacrosRoutes);
app.route('/api/cycle-counts', cycleCountsRoutes);
app.route('/api/documents', documentsRoutes);
app.route('/api/drive', driveRoutes);
app.route('/api/enrichments', enrichmentsRoutes);
app.route('/api/feature-flags', featureFlagsRoutes);
app.route('/api/feature-requests', featureRequestsRoutes);
app.route('/api/files', filesRoutes);
app.route('/api/folders', foldersRoutes);
app.route('/api/storage', storageRoutes);
app.route('/api/fiscal-periods', fiscalPeriodsRoutes);
app.route('/api/fx-rates', fxRatesRoutes);
app.route('/api/github-connections', githubConnectionsRoutes);
app.route('/api/github-repo-links', githubRepoLinksRoutes);
app.route('/api/github-project-links', githubProjectLinksRoutes);
app.route('/api/gl-accounts', glAccountsRoutes);
app.route('/api/grid-views', gridViewsRoutes);
app.route('/api/helpdesk-agents', helpdeskAgentsRoutes);
app.route('/api/helpdesk-analytics', helpdeskAnalyticsRoutes);
app.route('/api/helpdesk-announcements', helpdeskAnnouncementsRoutes);
app.route('/api/helpdesk-changelog', helpdeskChangelogRoutes);
app.route('/api/helpdesk-contacts', helpdeskContactsRoutes);
app.route('/api/helpdesk-departments', helpdeskDepartmentsRoutes);
app.route('/api/helpdesk-email', helpdeskEmailRoutes);
app.route('/api/helpdesk-faqs', helpdeskFaqsRoutes);
app.route('/api/helpdesk-feedback', helpdeskFeedbackRoutes);
// Helpdesk Discord/Slack channel integrations (integrationConnections table) —
// AUTHED. Distinct from the PUBLIC OAuth callback receiver mounted at
// /api/integrations/helpdesk above the guard; these two must not be merged.
app.route('/api/helpdesk-integrations', helpdeskIntegrationsRoutes);
app.route('/api/helpdesk-news', helpdeskNewsRoutes);
app.route('/api/helpdesk-reviews', helpdeskReviewsRoutes);
app.route('/api/helpdesk-settings', helpdeskSettingsRoutes);
app.route('/api/helpdesk-stats', helpdeskStatsRoutes);
app.route('/api/helpdesk-weldagent', helpdeskWeldagentRoutes);
app.route('/api/helpdesk-workflows', helpdeskWorkflowsRoutes);
app.route('/api/helpcenter-settings', helpcenterSettingsRoutes);
app.route('/api/dns-records', dnsRecordsRoutes);
app.route('/api/dns-zones', dnsZonesRoutes);
app.route('/api/domain-transfers', domainTransfersRoutes);
app.route('/api/domains', domainsRoutes);
app.route('/api/email-forwards', emailForwardsRoutes);
app.route('/api/external-webhooks', externalWebhooksRoutes);
app.route('/api/integrations', integrationsRoutes);
app.route('/api/invoices', invoicesRoutes);
app.route('/api/journal-entries', journalEntriesRoutes);
app.route('/api/leads', leadsRoutes);
app.route('/api/goals', goalsRoutes);
app.route('/api/inventory', inventoryRoutes);
app.route('/api/inventory-movements', inventoryMovementsRoutes);
app.route('/api/milestones', milestonesRoutes);
app.route('/api/lists', listsRoutes);
app.route('/api/mail-accounts', mailAccountsRoutes);
app.route('/api/mail-ai', mailAiRoutes);
app.route('/api/mail-attachments', mailAttachmentsRoutes);
app.route('/api/mail-campaigns', mailCampaignsRoutes);
app.route('/api/mail-domains', mailDomainsRoutes);
app.route('/api/mail-drafts', mailDraftsRoutes);
app.route('/api/mail-folders', mailFoldersRoutes);
app.route('/api/mail-labels', mailLabelsRoutes);
app.route('/api/mail-messages', mailMessagesRoutes);
app.route('/api/mail-rules', mailRulesRoutes);
app.route('/api/mail-scheduled', mailScheduledRoutes);
app.route('/api/mail-signatures', mailSignaturesRoutes);
app.route('/api/mail-snooze', mailSnoozeRoutes);
app.route('/api/mail-sync', mailSyncRoutes);
app.route('/api/mail-templates', mailTemplatesRoutes);
app.route('/api/mail-threads', mailThreadsRoutes);
app.route('/api/mail-weldmail', mailWeldMailRoutes);
app.route('/api/meeting-bot-sessions', meetingBotSessionsRoutes);
app.route('/api/meeting-messages', meetingMessagesRoutes);
app.route('/api/meeting-sessions', meetingSessionsRoutes);
app.route('/api/meeting-waitlist', meetingWaitlistRoutes);
app.route('/api/meetings', meetingsRoutes);
app.route('/api/member-limits', memberLimitsRoutes);
app.route('/api/notification-preferences', notificationPreferencesRoutes);
app.route('/api/notifications', notificationsRoutes);
app.route('/api/opportunities', opportunitiesRoutes);
app.route('/api/orders', ordersRoutes);
app.route('/api/people', peopleRoutes);
app.route('/api/person-companies', personCompaniesRoutes);
app.route('/api/parcels', parcelsRoutes);
app.route('/api/parcel-analytics', parcelAnalyticsRoutes);
app.route('/api/parcel-notifications', parcelNotificationsRoutes);
app.route('/api/parcel-rates', parcelRatesRoutes);
app.route('/api/parcel-settings', parcelSettingsRoutes);
app.route('/api/parcel-wallet', parcelWalletRoutes);
app.route('/api/payments', paymentsRoutes);
app.route('/api/pick-lists', pickListsRoutes);
app.route('/api/pickers', pickersRoutes);
app.route('/api/pickups', pickupsRoutes);
app.route('/api/pipeline-field-visibility', pipelineFieldVisibilityRoutes);
app.route('/api/pipeline-stages', pipelineStagesRoutes);
app.route('/api/pipelines', pipelinesRoutes);
app.route('/api/porting', portingRoutes);
app.route('/api/prepaid-seats', prepaidSeatsRoutes);
app.route('/api/products', productsRoutes);
app.route('/api/project-analytics', projectAnalyticsRoutes);
app.route('/api/project-files', projectFilesRoutes);
app.route('/api/project-labels', projectLabelsRoutes);
app.route('/api/project-documents', projectDocumentsRoutes);
app.route('/api/project-members', projectMembersRoutes);
app.route('/api/project-messages', projectMessagesRoutes);
app.route('/api/project-pipeline-stages', projectPipelineStagesRoutes);
app.route('/api/project-sheets', projectSheetsRoutes);
app.route('/api/projects', projectsRoutes);
app.route('/api/purchase-orders', purchaseOrdersRoutes);
app.route('/api/putaway', putawayRoutes);
app.route('/api/reconciliation-rules', reconciliationRulesRoutes);
app.route('/api/recurring-invoices', recurringInvoicesRoutes);
app.route('/api/return-reasons', returnReasonsRoutes);
app.route('/api/return-rules', returnRulesRoutes);
app.route('/api/returns', returnsRoutes);
app.route('/api/roles', rolesRoutes);
app.route('/api/satisfaction-surveys', satisfactionSurveysRoutes);
app.route('/api/sequences', sequencesRoutes);
app.route('/api/customer-sequences', customerSequencesRoutes);
app.route('/api/settings/profile', settingsProfileRoutes);
app.route('/api/shipments', shipmentsRoutes);
app.route('/api/shipping-prices', shippingPricesRoutes);
app.route('/api/shipping-rules', shippingRulesRoutes);
app.route('/api/slas', slasRoutes);
app.route('/api/social-accounts', socialAccountsRoutes);
app.route('/api/social-analytics', socialAnalyticsRoutes);
app.route('/api/social-approvals', socialApprovalsRoutes);
app.route('/api/social-campaigns', socialCampaignsRoutes);
app.route('/api/social-media', socialMediaRoutes);
app.route('/api/social-posts', socialPostsRoutes);
app.route('/api/social-settings', socialSettingsRoutes);
app.route('/api/social-team-members', socialTeamMembersRoutes);
app.route('/api/sprints', sprintsRoutes);
app.route('/api/support', supportRoutes);
app.route('/api/task-comments', taskCommentsRoutes);
app.route('/api/task-projects', taskProjectsRoutes);
app.route('/api/task-tags', taskTagsRoutes);
app.route('/api/tasks', tasksRoutes);
app.route('/api/tax-rates', taxRatesRoutes);
app.route('/api/telephony', telephonyRoutes);
app.route('/api/vat-returns', vatReturnsRoutes);
app.route('/api/warehouse-locations', warehouseLocationsRoutes);
app.route('/api/warehouses', warehousesRoutes);
app.route('/api/warehouse-zones', warehouseZonesRoutes);
app.route('/api/wms-suppliers', wmsSuppliersRoutes);
app.route('/api/wms-activity', wmsActivityRoutes);
app.route('/api/custom-fields', customFieldsRoutes);
app.route('/api/enrich-fields', enrichFieldsRoutes);
app.route('/api/digest-settings', digestSettingsRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/app-catalog', appCatalogRoutes);
// PrintNode settings (workspace_settings.customSettings.printnode) — AUTHED.
// Needs clerkMiddleware() + workspaceDbMiddleware() (reads c.get('tenantDb')),
// so this must stay BELOW the app.use('/api/*', ...) guard.
app.route('/api/printnode', printNodeRoutes);
app.route('/api/credits', creditsRoutes);
app.route('/api/ai-models', aiModelsRoutes);
app.route('/api/ai', aiRoutes);
app.route('/api/my-role', myRoleRoutes);
app.route('/api/my-tasks', myTasksRoutes);
app.route('/api/access-requests', accessRequestsRoutes);
app.route('/api/search', searchRoutes);
app.route('/api/workspace-settings', workspaceSettingsRoutes);
app.route('/api/stock-adjustments', stockAdjustmentsRoutes);
app.route('/api/team-members', teamMembersRoutes);
app.route('/api/me', meRoutes);
app.route('/api/transcriptions', transcriptionsRoutes);
app.route('/api/ticket-messages', ticketMessagesRoutes);
app.route('/api/ticket-notes', ticketNotesRoutes);
app.route('/api/ticket-types', ticketTypesRoutes);
app.route('/api/tickets', ticketsRoutes);
app.route('/api/time-entries', timeEntriesRoutes);
app.route('/api/user-apps', userAppsRoutes);
app.route('/api/user-preferences', userPreferencesRoutes);
app.route('/api/push-tokens', pushTokensRoutes);
app.route('/api/workspaces', workspacesRoutes);
app.route('/api/weldagent', weldagentRoutes);
app.route('/api/welddata', welddataRoutes);
app.route('/api/whiteboards', whiteboardsRoutes);
app.route('/api/workflow-builder', workflowBuilderRoutes);
app.route('/api/workflow-dashboard', workflowDashboardRoutes);
app.route('/api/workflow-executions', workflowExecutionsRoutes);
app.route('/api/workflow-github', workflowGithubRoutes);
app.route('/api/workflow-integrations', workflowIntegrationsRoutes);
app.route('/api/workflow-schedules', workflowSchedulesRoutes);
app.route('/api/workflow-templates', workflowTemplatesRoutes);
app.route('/api/workflow-triggers', workflowTriggersRoutes);
app.route('/api/workflow-variables', workflowVariablesRoutes);
app.route('/api/workflow-webhooks', workflowWebhooksRoutes);
app.route('/api/workflows', workflowsRoutes);
app.route('/api/working-hours', workingHoursRoutes);

app.notFound((c) =>
  c.json({ error: { code: 'NOT_FOUND', message: `${c.req.path} not found` } }, 404),
);

app.onError((err, c) => {
  console.error('App API error:', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } }, 500);
});

// Cloudflare Workflow classes hosted by this worker (bound in wrangler.toml).
// The *-v2 names re-host api-worker's workflow classes (W4 legacy-worker
// phase-out); api-worker keeps the old names while in-flight instances drain.
export { WelddataEnrichWorkflow } from './workflows/welddata-enrich';
export { SendScheduledEmailWorkflow } from './workflows/send-scheduled-email';
export { ExecuteSequenceWorkflow } from './workflows/execute-sequence';
export { TrashCleanupWorkflow } from './workflows/trash-cleanup';
export { TranscribeRecordingWorkflow } from './workflows/transcribe-recording';
export { UnpinExpiredMessageWorkflow } from './workflows/unpin-expired-message';
export { SendDigestWorkflow } from './workflows/send-digest';
export { ImportTasksWorkflow } from './workflows/import-tasks';

// Cron sweeps re-hosted from api-worker (which had them configured only in
// the Cloudflare dashboard — here they are declared in wrangler.toml
// [triggers]): hourly task digests + daily calendar replan.
import { runDigestSweep } from './cron/digest-sweep';
import { runCalendarReplanSweep } from './cron/calendar-replan';

export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    // Hourly: send task digests
    if (event.cron === '0 * * * *') {
      ctx.waitUntil(
        runDigestSweep(env).catch((err) => {
          console.error('[DigestSweep] Failed:', err);
        }),
      );
    }

    // Daily at 04:00 UTC: re-plan stale auto-scheduled calendar events
    // (tasks that were scheduled but didn't get done on the planned day)
    if (event.cron === '0 4 * * *') {
      ctx.waitUntil(
        runCalendarReplanSweep(env).catch((err) => {
          console.error('[CalendarReplan] Failed:', err);
        }),
      );
    }
  },
};
