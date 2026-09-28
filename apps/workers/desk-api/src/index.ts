/**
 * WeldSuite desk-api — the WeldDesk (helpdesk) module's API worker: tickets,
 * ticket messages/notes/types, conversations (incl. the unified desk inbox and
 * widget settings), helpdesk agents, departments, contacts, analytics, email,
 * integrations (Discord/Slack + their OAuth callbacks), workflows, SLAs,
 * satisfaction surveys, canned responses, knowledge-base articles, the help
 * center settings and the public help-center feed.
 *
 * Split out of app-api (docs/plans/app-api-module-split.md). It serves the
 * same /api/<object> paths app-api served for this module; the prefixes it
 * owns are listed in @weldsuite/api-modules and checked by its ownership test.
 */

import { apiAuth, createModuleApi } from '@weldsuite/worker-kit';
import { articleFoldersRoutes } from './routes/article-folders';
import { articlesRoutes } from './routes/articles';
import { cannedResponsesRoutes } from './routes/canned-responses';
import { conversationsRoutes } from './routes/conversations';
import { deskConversationsRoutes } from './routes/desk-conversations';
import { deskWidgetRoutes } from './routes/desk-widget';
import { helpcenterSettingsRoutes } from './routes/helpcenter-settings';
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
import { integrationsHelpdeskOAuthRoutes } from './routes/integrations/helpdesk-oauth';
import { publicHelpcenterRoutes } from './routes/public-helpcenter';
import { satisfactionSurveysRoutes } from './routes/satisfaction-surveys';
import { slasRoutes } from './routes/slas';
import { ticketMessagesRoutes } from './routes/ticket-messages';
import { ticketNotesRoutes } from './routes/ticket-notes';
import { ticketTypesRoutes } from './routes/ticket-types';
import { ticketsRoutes } from './routes/tickets';
import type { Env, Variables } from './types';

const app = createModuleApi<Env, Variables>({ service: 'desk-api' });

// Public help-center feed consumed by the apps/web/helpcenter renderer. No Clerk
// JWT — the tenant DB is resolved from the `?domain=` param by the router's
// own middleware. Must stay ABOVE the app.use('/api/*', ...) guard below.
app.route('/public/helpcenter', publicHelpcenterRoutes);

// Helpdesk Discord/Slack OAuth callbacks — PUBLIC (browser redirects carry no
// Clerk JWT; auth is the one-time KV state nonce minted by the authorize
// endpoints). Must stay ABOVE the /api/* guard. The registered redirect URIs
// point at app-api (getHelpdeskWorkerUrl), whose forwarder hands
// /api/integrations/helpdesk/* to this worker.
app.route('/api/integrations/helpdesk', integrationsHelpdeskOAuthRoutes);

// Auth + tenant DB + feature flags for everything under /api/*
app.use('/api/*', ...apiAuth());

// Object-based routes, in app-api's mount order.
app.route('/api/article-folders', articleFoldersRoutes);
app.route('/api/articles', articlesRoutes);
app.route('/api/canned-responses', cannedResponsesRoutes);
app.route('/api/conversations', conversationsRoutes);
app.route('/api/desk/conversations', deskConversationsRoutes);
app.route('/api/desk/widget', deskWidgetRoutes);
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
app.route('/api/satisfaction-surveys', satisfactionSurveysRoutes);
app.route('/api/slas', slasRoutes);
app.route('/api/ticket-messages', ticketMessagesRoutes);
app.route('/api/ticket-notes', ticketNotesRoutes);
app.route('/api/ticket-types', ticketTypesRoutes);
app.route('/api/tickets', ticketsRoutes);

export default {
  fetch: app.fetch,
};
