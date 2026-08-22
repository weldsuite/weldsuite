export interface MetaOAuthTokens {
  accessToken: string;
  tokenType?: string;
  expiresAt?: string;
}

export interface MetaAdAccount {
  platformAccountId: string;
  name: string;
  currency?: string;
  timezone?: string;
  status?: string;
}

export interface MetaCampaignMetrics {
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  reach?: string;
  dateStart?: string;
  dateEnd?: string;
}

export interface MetaCampaign {
  platformCampaignId: string;
  name: string;
  status?: string;
  objective?: string;
  dailyBudget?: number;
  lifetimeBudget?: number;
  currency?: string;
  metrics?: MetaCampaignMetrics;
}

export interface MetaWebhookChangeEvent {
  platformAccountId: string;
  objectType: 'campaign' | 'adset' | 'ad' | 'unknown';
  objectId?: string;
  changeType?: string;
  rawValue?: Record<string, unknown>;
}

export type FetchImpl = typeof fetch;
