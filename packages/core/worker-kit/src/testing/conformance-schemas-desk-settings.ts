/** WeldDesk (desk-api) response schemas: helpdesk settings, help center settings, desk widget, desk assignment, helpdesk email, analytics. Spread into ROUTES by conformance-schemas.ts. */
import { deskIdRefSchema } from '@weldsuite/core-api-client/schemas/desk-common';
import { deskAssignmentStateSchema } from '@weldsuite/core-api-client/schemas/desk-assignment';
import { deskWidgetRefSchema, deskWidgetSettingsSchema } from '@weldsuite/core-api-client/schemas/desk-widget';
import {
  helpdeskPrimaryWidgetRefSchema,
  helpdeskSettingsOkSchema,
  helpdeskSettingsOverviewSchema,
  helpdeskWidgetCreatedSchema,
  helpdeskWidgetRefSchema,
  helpdeskWidgetSettingsRowSchema,
} from '@weldsuite/core-api-client/schemas/helpdesk-settings';
import {
  helpcenterDomainRefSchema,
  helpcenterDomainSchema,
  helpcenterDomainVerifySchema,
  helpcenterEnabledSchema,
  helpcenterHostDomainSchema,
  helpcenterSettingsSchema,
} from '@weldsuite/core-api-client/schemas/helpcenter-settings';
import {
  helpdeskEmailAddressSchema,
  helpdeskEmailConnectedSchema,
  helpdeskEmailDisconnectedSchema,
  helpdeskEmailDomainSchema,
  helpdeskEmailMailAccountSchema,
} from '@weldsuite/core-api-client/schemas/helpdesk-email';
import {
  helpdeskAnalyticsBatchDataSchema,
  helpdeskAnalyticsChartSchema,
  helpdeskAnalyticsDataPointSchema,
  helpdeskAnalyticsLayoutsUpdatedSchema,
  helpdeskAnalyticsReportSchema,
} from '@weldsuite/core-api-client/schemas/helpdesk-analytics';
import type { RouteSchema } from './conformance-schemas';

export const DESK_SETTINGS_ROUTES: RouteSchema[] = [
  // helpdesk settings: the singleton and the legacy widgets
  { method: 'GET', route: '/api/helpdesk-settings', envelope: 'single', data: helpdeskSettingsOverviewSchema },
  { method: 'PUT', route: '/api/helpdesk-settings/notifications', envelope: 'single', data: helpdeskSettingsOkSchema },
  { method: 'PUT', route: '/api/helpdesk-settings/automation', envelope: 'single', data: helpdeskSettingsOkSchema },
  { method: 'PUT', route: '/api/helpdesk-settings/tickets', envelope: 'single', data: helpdeskSettingsOkSchema },
  { method: 'PUT', route: '/api/helpdesk-settings/satisfaction', envelope: 'single', data: helpdeskSettingsOkSchema },
  { method: 'GET', route: '/api/helpdesk-settings/widget', envelope: 'single', data: helpdeskWidgetSettingsRowSchema },
  { method: 'PUT', route: '/api/helpdesk-settings/widget', envelope: 'single', data: helpdeskPrimaryWidgetRefSchema },
  { method: 'PATCH', route: '/api/helpdesk-settings/widget/enabled', envelope: 'single', data: helpdeskPrimaryWidgetRefSchema },
  { method: 'GET', route: '/api/helpdesk-settings/widgets', envelope: 'array', data: helpdeskWidgetSettingsRowSchema },
  { method: 'POST', route: '/api/helpdesk-settings/widgets', envelope: 'single', data: helpdeskWidgetCreatedSchema },
  { method: 'GET', route: '/api/helpdesk-settings/widgets/:widgetId', envelope: 'single', data: helpdeskWidgetSettingsRowSchema },
  { method: 'PUT', route: '/api/helpdesk-settings/widgets/:widgetId', envelope: 'single', data: helpdeskWidgetRefSchema },
  { method: 'DELETE', route: '/api/helpdesk-settings/widgets/:widgetId', envelope: 'single', data: helpdeskSettingsOkSchema },
  // help center settings and custom domains
  { method: 'GET', route: '/api/helpcenter-settings', envelope: 'single', data: helpcenterSettingsSchema },
  { method: 'PUT', route: '/api/helpcenter-settings', envelope: 'single', data: helpcenterSettingsSchema },
  { method: 'POST', route: '/api/helpcenter-settings/enable', envelope: 'single', data: helpcenterEnabledSchema },
  { method: 'GET', route: '/api/helpcenter-settings/domains', envelope: 'array', data: helpcenterDomainSchema },
  { method: 'GET', route: '/api/helpcenter-settings/host-domains', envelope: 'array', data: helpcenterHostDomainSchema },
  { method: 'POST', route: '/api/helpcenter-settings/domains', envelope: 'single', data: helpcenterDomainSchema },
  { method: 'POST', route: '/api/helpcenter-settings/domains/:id/verify', envelope: 'single', data: helpcenterDomainVerifySchema },
  { method: 'DELETE', route: '/api/helpcenter-settings/domains/:id', envelope: 'single', data: helpcenterDomainRefSchema },
  // WeldDesk inbox widget
  { method: 'GET', route: '/api/desk/widget', envelope: 'array', data: deskWidgetSettingsSchema },
  { method: 'POST', route: '/api/desk/widget', envelope: 'single', data: deskWidgetSettingsSchema },
  { method: 'GET', route: '/api/desk/widget/:widgetId', envelope: 'single', data: deskWidgetSettingsSchema },
  { method: 'PATCH', route: '/api/desk/widget/:widgetId', envelope: 'single', data: deskWidgetSettingsSchema },
  { method: 'DELETE', route: '/api/desk/widget/:widgetId', envelope: 'single', data: deskWidgetRefSchema },
  // WeldDesk auto-assignment
  { method: 'GET', route: '/api/desk/assignment', envelope: 'single', data: deskAssignmentStateSchema },
  { method: 'PUT', route: '/api/desk/assignment', envelope: 'single', data: deskAssignmentStateSchema },
  { method: 'POST', route: '/api/desk/assignment/away', envelope: 'single', data: deskAssignmentStateSchema },
  // helpdesk email addresses
  { method: 'GET', route: '/api/helpdesk-email/addresses', envelope: 'array', data: helpdeskEmailAddressSchema },
  { method: 'GET', route: '/api/helpdesk-email/mail-accounts', envelope: 'array', data: helpdeskEmailMailAccountSchema },
  { method: 'GET', route: '/api/helpdesk-email/domains', envelope: 'array', data: helpdeskEmailDomainSchema },
  { method: 'POST', route: '/api/helpdesk-email/addresses', envelope: 'single', data: helpdeskEmailConnectedSchema },
  { method: 'DELETE', route: '/api/helpdesk-email/addresses/:id', envelope: 'single', data: helpdeskEmailDisconnectedSchema },
  // helpdesk analytics: reports, charts, chart data
  { method: 'GET', route: '/api/helpdesk-analytics', envelope: 'array', data: helpdeskAnalyticsReportSchema },
  { method: 'GET', route: '/api/helpdesk-analytics/reports/:reportId', envelope: 'single', data: helpdeskAnalyticsReportSchema },
  { method: 'POST', route: '/api/helpdesk-analytics', envelope: 'single', data: deskIdRefSchema },
  { method: 'PATCH', route: '/api/helpdesk-analytics/:id', envelope: 'single', data: deskIdRefSchema },
  { method: 'DELETE', route: '/api/helpdesk-analytics/:id', envelope: 'single', data: deskIdRefSchema },
  { method: 'POST', route: '/api/helpdesk-analytics/reports/:reportId/duplicate', envelope: 'single', data: deskIdRefSchema },
  { method: 'GET', route: '/api/helpdesk-analytics/reports/:reportId/charts', envelope: 'array', data: helpdeskAnalyticsChartSchema },
  { method: 'POST', route: '/api/helpdesk-analytics/charts', envelope: 'single', data: deskIdRefSchema },
  { method: 'GET', route: '/api/helpdesk-analytics/charts/:chartId', envelope: 'single', data: helpdeskAnalyticsChartSchema },
  { method: 'PUT', route: '/api/helpdesk-analytics/charts/:chartId', envelope: 'single', data: deskIdRefSchema },
  { method: 'PATCH', route: '/api/helpdesk-analytics/reports/:reportId/layouts', envelope: 'single', data: helpdeskAnalyticsLayoutsUpdatedSchema },
  { method: 'DELETE', route: '/api/helpdesk-analytics/charts/:chartId', envelope: 'single', data: deskIdRefSchema },
  { method: 'POST', route: '/api/helpdesk-analytics/charts/data', envelope: 'array', data: helpdeskAnalyticsDataPointSchema },
  { method: 'POST', route: '/api/helpdesk-analytics/charts/batch-data', envelope: 'single', data: helpdeskAnalyticsBatchDataSchema },
];
