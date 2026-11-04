/** WeldSocial (social-api) response schemas. Spread into ROUTES by conformance-schemas.ts. */
import {
  postpeerWebhookAckSchema,
  socialAccountSchema,
  socialAnalyticsOverviewSchema,
  socialAnalyticsSyncSchema,
  socialApprovalApprovedSchema,
  socialApprovalCreatedSchema,
  socialApprovalDecidedSchema,
  socialApprovalSchema,
  socialCampaignSchema,
  socialCancelResultSchema,
  socialConnectResultSchema,
  socialDashboardStatsSchema,
  socialIdRefSchema,
  socialMediaSchema,
  socialPostSchema,
  socialPublishResultSchema,
  socialSearchResultSchema,
  socialSettingsSavedSchema,
  socialSettingsSchema,
  socialSyncResultSchema,
  socialTeamMemberSchema,
  socialTimezoneSchema,
} from '@weldsuite/app-api-client/schemas/social-responses';
import type { RouteSchema } from './conformance-schemas';

/** The CRUD routes of one object: list, read, create, update. */
function crud(base: string, item: RouteSchema['data']): RouteSchema[] {
  return [
    { method: 'GET', route: base, envelope: 'list', data: item },
    { method: 'GET', route: `${base}/:id`, envelope: 'single', data: item },
    { method: 'POST', route: base, envelope: 'single', data: socialIdRefSchema },
    { method: 'PATCH', route: `${base}/:id`, envelope: 'single', data: socialIdRefSchema },
  ];
}

export const SOCIAL_ROUTES: RouteSchema[] = [
  ...crud('/api/social-accounts', socialAccountSchema),
  { method: 'POST', route: '/api/social-accounts/connect', envelope: 'single', data: socialConnectResultSchema },
  { method: 'POST', route: '/api/social-accounts/sync', envelope: 'single', data: socialSyncResultSchema },
  ...crud('/api/social-posts', socialPostSchema),
  { method: 'POST', route: '/api/social-posts/:id/publish', envelope: 'single', data: socialPublishResultSchema },
  { method: 'POST', route: '/api/social-posts/:id/schedule', envelope: 'single', data: socialPublishResultSchema },
  { method: 'POST', route: '/api/social-posts/:id/reschedule', envelope: 'single', data: socialPublishResultSchema },
  { method: 'POST', route: '/api/social-posts/:id/cancel', envelope: 'single', data: socialCancelResultSchema },
  ...crud('/api/social-campaigns', socialCampaignSchema),
  ...crud('/api/social-media', socialMediaSchema),
  ...crud('/api/social-team-members', socialTeamMemberSchema),
  { method: 'GET', route: '/api/social-approvals', envelope: 'list', data: socialApprovalSchema },
  { method: 'GET', route: '/api/social-approvals/:id', envelope: 'single', data: socialApprovalSchema },
  { method: 'POST', route: '/api/social-approvals', envelope: 'single', data: socialApprovalCreatedSchema },
  { method: 'PATCH', route: '/api/social-approvals/:id', envelope: 'single', data: socialIdRefSchema },
  { method: 'POST', route: '/api/social-approvals/:id/approve', envelope: 'single', data: socialApprovalApprovedSchema },
  { method: 'POST', route: '/api/social-approvals/:id/reject', envelope: 'single', data: socialApprovalDecidedSchema },
  { method: 'GET', route: '/api/social-analytics/overview', envelope: 'single', data: socialAnalyticsOverviewSchema },
  { method: 'GET', route: '/api/social-analytics/stats', envelope: 'single', data: socialDashboardStatsSchema },
  { method: 'GET', route: '/api/social-analytics/search', envelope: 'array', data: socialSearchResultSchema },
  { method: 'POST', route: '/api/social-analytics/:postId/sync', envelope: 'single', data: socialAnalyticsSyncSchema },
  { method: 'GET', route: '/api/social-settings', envelope: 'single', data: socialSettingsSchema },
  { method: 'PUT', route: '/api/social-settings', envelope: 'single', data: socialSettingsSavedSchema },
  { method: 'GET', route: '/api/social-settings/timezones', envelope: 'array', data: socialTimezoneSchema },
  { method: 'POST', route: '/public/social/postpeer/webhook', envelope: 'body', data: postpeerWebhookAckSchema },
];
