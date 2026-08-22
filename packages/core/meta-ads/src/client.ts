import type {
  CreateMetaCampaignInput,
  MetaAdAccount,
  MetaCampaign,
  MetaCampaignMetrics,
  UpdateMetaCampaignInput,
  FetchImpl,
} from './types';

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface MetaMarketingClientOptions {
  accessToken: string;
}

export class MetaMarketingClient {
  constructor(
    private readonly options: MetaMarketingClientOptions,
    private readonly fetchImpl: FetchImpl = fetch,
  ) {}

  private async graphGet<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const params = new URLSearchParams({ ...query, access_token: this.options.accessToken });
    const res = await this.fetchImpl(`${GRAPH_BASE}${path}?${params.toString()}`);
    const json = (await res.json()) as T & { error?: { message?: string } };
    if (!res.ok) throw new Error(json.error?.message ?? `Meta API error (${res.status})`);
    return json;
  }

  private async graphPost<T>(path: string, body: Record<string, string>): Promise<T> {
    const params = new URLSearchParams({ ...body, access_token: this.options.accessToken });
    const res = await this.fetchImpl(`${GRAPH_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const json = (await res.json()) as T & { error?: { message?: string } };
    if (!res.ok) throw new Error(json.error?.message ?? `Meta API error (${res.status})`);
    return json;
  }

  async listAdAccounts(): Promise<MetaAdAccount[]> {
    const json = await this.graphGet<{ data: Array<Record<string, unknown>> }>('/me/adaccounts', {
      fields: 'id,name,account_status,currency,timezone_name',
      limit: '200',
    });
    return (json.data ?? []).map((row) => ({
      platformAccountId: String(row.id),
      name: String(row.name ?? row.id),
      currency: row.currency ? String(row.currency) : undefined,
      timezone: row.timezone_name ? String(row.timezone_name) : undefined,
      status: row.account_status != null ? String(row.account_status) : undefined,
    }));
  }

  async getCampaign(platformAccountId: string, campaignId: string): Promise<MetaCampaign | null> {
    const accountId = platformAccountId.startsWith('act_') ? platformAccountId : `act_${platformAccountId}`;
    try {
      const row = await this.graphGet<Record<string, unknown>>(`/${campaignId}`, {
        fields: 'id,name,status,objective,daily_budget,lifetime_budget',
      });
      const metrics = await this.fetchCampaignInsights(accountId, campaignId);
      return mapCampaignRow(row, metrics);
    } catch {
      return null;
    }
  }

  async listCampaignsWithInsights(platformAccountId: string): Promise<MetaCampaign[]> {
    const accountId = platformAccountId.startsWith('act_') ? platformAccountId : `act_${platformAccountId}`;
    const json = await this.graphGet<{ data: Array<Record<string, unknown>> }>(`/${accountId}/campaigns`, {
      fields: 'id,name,status,objective,daily_budget,lifetime_budget',
      limit: '500',
    });
    const campaigns = json.data ?? [];
    if (campaigns.length === 0) return [];

    const insightsJson = await this.graphGet<{ data: Array<Record<string, unknown>> }>(
      `/${accountId}/insights`,
      {
        level: 'campaign',
        fields: 'campaign_id,spend,impressions,clicks,ctr,cpc,reach,date_start,date_stop',
        date_preset: 'last_30d',
        limit: '500',
      },
    );
    const insightsByCampaign = new Map<string, MetaCampaignMetrics>();
    for (const row of insightsJson.data ?? []) {
      const campaignId = row.campaign_id ? String(row.campaign_id) : undefined;
      if (!campaignId) continue;
      insightsByCampaign.set(campaignId, mapMetricsRow(row));
    }

    return campaigns.map((row) => {
      const campaignId = String(row.id);
      return mapCampaignRow(row, insightsByCampaign.get(campaignId));
    });
  }

  private async fetchCampaignInsights(accountId: string, campaignId: string): Promise<MetaCampaignMetrics | undefined> {
    const json = await this.graphGet<{ data: Array<Record<string, unknown>> }>(`/${accountId}/insights`, {
      level: 'campaign',
      fields: 'campaign_id,spend,impressions,clicks,ctr,cpc,reach,date_start,date_stop',
      date_preset: 'last_30d',
      filtering: JSON.stringify([{ field: 'campaign.id', operator: 'EQUAL', value: campaignId }]),
      limit: '1',
    });
    const row = json.data?.[0];
    return row ? mapMetricsRow(row) : undefined;
  }

  async createCampaign(platformAccountId: string, input: CreateMetaCampaignInput): Promise<MetaCampaign> {
    const accountId = normalizeAccountId(platformAccountId);
    if (!input.dailyBudget && !input.lifetimeBudget) {
      throw new Error('A daily or lifetime budget is required to create a campaign');
    }

    const body: Record<string, string> = {
      name: input.name,
      objective: input.objective,
      status: input.status ?? 'PAUSED',
      special_ad_categories: '[]',
    };
    if (input.dailyBudget != null) body.daily_budget = String(input.dailyBudget);
    if (input.lifetimeBudget != null) body.lifetime_budget = String(input.lifetimeBudget);

    const json = await this.graphPost<{ id?: string }>(`/${accountId}/campaigns`, body);
    if (!json.id) throw new Error('Meta did not return a campaign id');

    const campaign = await this.getCampaign(accountId, json.id);
    if (!campaign) throw new Error('Failed to load created campaign');
    return campaign;
  }

  async updateCampaign(
    platformAccountId: string,
    platformCampaignId: string,
    input: UpdateMetaCampaignInput,
  ): Promise<MetaCampaign> {
    const accountId = normalizeAccountId(platformAccountId);
    const body: Record<string, string> = {};
    if (input.name != null) body.name = input.name;
    if (input.objective != null) body.objective = input.objective;
    if (input.status != null) body.status = input.status;
    if (input.dailyBudget !== undefined) {
      body.daily_budget = input.dailyBudget == null ? '0' : String(input.dailyBudget);
    }
    if (input.lifetimeBudget !== undefined) {
      body.lifetime_budget = input.lifetimeBudget == null ? '0' : String(input.lifetimeBudget);
    }
    if (Object.keys(body).length === 0) {
      throw new Error('No campaign fields to update');
    }

    await this.graphPost<{ success?: boolean }>(`/${platformCampaignId}`, body);
    const campaign = await this.getCampaign(accountId, platformCampaignId);
    if (!campaign) throw new Error('Failed to load updated campaign');
    return campaign;
  }

  async subscribeAdAccountWebhooks(platformAccountId: string, callbackUrl: string, verifyToken: string) {
    const accountId = platformAccountId.startsWith('act_') ? platformAccountId : `act_${platformAccountId}`;
    return this.graphGet<{ success?: boolean }>(`/${accountId}/subscribed_apps`, {
      subscribed_fields: 'campaigns,adsets,ads',
      callback_url: callbackUrl,
      verify_token: verifyToken,
    });
  }

  async unsubscribeAdAccountWebhooks(platformAccountId: string) {
    const accountId = platformAccountId.startsWith('act_') ? platformAccountId : `act_${platformAccountId}`;
    return this.graphDelete(`/${accountId}/subscribed_apps`);
  }

  private async graphDelete<T>(path: string): Promise<T> {
    const params = new URLSearchParams({ access_token: this.options.accessToken });
    const res = await this.fetchImpl(`${GRAPH_BASE}${path}?${params.toString()}`, { method: 'DELETE' });
    const json = (await res.json()) as T & { error?: { message?: string } };
    if (!res.ok) throw new Error(json.error?.message ?? `Meta API error (${res.status})`);
    return json;
  }
}

function normalizeAccountId(platformAccountId: string): string {
  return platformAccountId.startsWith('act_') ? platformAccountId : `act_${platformAccountId}`;
}

function mapCampaignRow(row: Record<string, unknown>, metrics?: MetaCampaignMetrics): MetaCampaign {
  return {
    platformCampaignId: String(row.id),
    name: String(row.name ?? row.id),
    status: row.status ? String(row.status) : undefined,
    objective: row.objective ? String(row.objective) : undefined,
    dailyBudget: row.daily_budget != null ? Number(row.daily_budget) : undefined,
    lifetimeBudget: row.lifetime_budget != null ? Number(row.lifetime_budget) : undefined,
    metrics,
  };
}

function mapMetricsRow(row: Record<string, unknown>): MetaCampaignMetrics {
  return {
    spend: row.spend != null ? String(row.spend) : undefined,
    impressions: row.impressions != null ? String(row.impressions) : undefined,
    clicks: row.clicks != null ? String(row.clicks) : undefined,
    ctr: row.ctr != null ? String(row.ctr) : undefined,
    cpc: row.cpc != null ? String(row.cpc) : undefined,
    reach: row.reach != null ? String(row.reach) : undefined,
    dateStart: row.date_start ? String(row.date_start) : undefined,
    dateEnd: row.date_stop ? String(row.date_stop) : undefined,
  };
}
