/** WeldAds (ads-api) response schemas: ad connections, ad accounts, ad campaigns. Spread into ROUTES by conformance-schemas.ts. */
import {
  adAccountSchema,
  adCampaignRowSchema,
  adCampaignSchema,
  adConnectionRefSchema,
  adOAuthStartSchema,
  adPlatformConnectionSchema,
  adSyncResultSchema,
} from '@weldsuite/app-api-client/schemas/weldads';
import type { RouteSchema } from './conformance-schemas';

export const ADS_ROUTES: RouteSchema[] = [
  { method: 'GET', route: '/api/ad-accounts', envelope: 'array', data: adAccountSchema },
  { method: 'PATCH', route: '/api/ad-accounts/:id', envelope: 'single', data: adAccountSchema },
  { method: 'GET', route: '/api/ad-campaigns', envelope: 'list', data: adCampaignRowSchema },
  { method: 'POST', route: '/api/ad-campaigns', envelope: 'single', data: adCampaignSchema },
  { method: 'GET', route: '/api/ad-campaigns/:id', envelope: 'single', data: adCampaignSchema },
  { method: 'PATCH', route: '/api/ad-campaigns/:id', envelope: 'single', data: adCampaignSchema },
  { method: 'GET', route: '/api/ad-connections', envelope: 'array', data: adPlatformConnectionSchema },
  { method: 'POST', route: '/api/ad-connections/facebook/authorize', envelope: 'single', data: adOAuthStartSchema },
  { method: 'POST', route: '/api/ad-connections/facebook/callback', envelope: 'single', data: adConnectionRefSchema },
  { method: 'POST', route: '/api/ad-connections/:id/sync', envelope: 'single', data: adSyncResultSchema },
];
