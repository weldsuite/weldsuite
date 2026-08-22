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

export type MetaCampaignStatus = 'ACTIVE' | 'PAUSED';

export type MetaCampaignObjective =
  | 'OUTCOME_TRAFFIC'
  | 'OUTCOME_SALES'
  | 'OUTCOME_LEADS'
  | 'OUTCOME_AWARENESS'
  | 'OUTCOME_ENGAGEMENT'
  | 'OUTCOME_APP_PROMOTION';

export interface CreateMetaCampaignInput {
  name: string;
  objective: MetaCampaignObjective;
  status?: MetaCampaignStatus;
  dailyBudget?: number;
  lifetimeBudget?: number;
}

export interface UpdateMetaCampaignInput {
  name?: string;
  objective?: MetaCampaignObjective;
  status?: MetaCampaignStatus;
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
}

export interface MetaWebhookChangeEvent {
  platformAccountId: string;
  objectType: 'campaign' | 'adset' | 'ad' | 'unknown';
  objectId?: string;
  changeType?: string;
  rawValue?: Record<string, unknown>;
}

export type FetchImpl = typeof fetch;
