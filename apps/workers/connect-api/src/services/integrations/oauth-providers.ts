/**
 * Integration OAuth providers — the OAuth / webhook-registration subset of the
 * legacy api-worker CRM sync adapters (apps/api-worker/src/lib/integrations/*).
 *
 * app-api only owns the connect/disconnect lifecycle: building authorize URLs,
 * exchanging codes, refreshing tokens, (de)registering provider webhooks and
 * seeding default field mappings. The actual record sync runs in the
 * CrmSyncWorkflow HOSTED BY integration-webhook-worker (crm-sync-int*), which
 * app-api dispatches via the cross-script CRM_SYNC workflow binding.
 */

import type { FieldMappingDirection, FieldTransformType } from '@weldsuite/db/schema';

// ============================================================================
// Types
// ============================================================================

export type SyncEntityType =
  | 'contact'
  | 'customer'
  | 'lead'
  | 'opportunity'
  | 'activity'
  | 'calendar_event'
  | 'pipeline';

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
}

export interface WebhookRegistration {
  webhookId: string;
  secret: string;
}

export interface FieldMappingDefinition {
  externalFieldPath: string;
  internalFieldPath: string;
  direction: FieldMappingDirection;
  transformType: FieldTransformType;
  transformConfig?: Record<string, unknown>;
  isRequired?: boolean;
}

/** OAuth + webhook lifecycle surface an integration provider must implement. */
export interface IntegrationOAuthAdapter {
  readonly provider: string;
  readonly supportedEntities: SyncEntityType[];

  /** Default field mappings seeded on initial connect. */
  getDefaultFieldMappings(entityType: SyncEntityType): FieldMappingDefinition[];

  /** Build the OAuth authorization URL. */
  getAuthorizeUrl(clientId: string, redirectUri: string, state: string): string;

  /** Exchange an authorization code for tokens. */
  exchangeCodeForTokens(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<OAuthTokens>;

  /** Refresh an expired access token. */
  refreshAccessToken(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): Promise<OAuthTokens>;

  /** Register webhooks at the provider, pointing at integration-webhook-worker. */
  registerWebhooks(
    accessToken: string,
    targetUrl: string,
    entityTypes: SyncEntityType[],
  ): Promise<WebhookRegistration>;

  /** Remove registered webhooks / watch channels. */
  deleteWebhooks(accessToken: string, webhookId: string, webhookSecret?: string): Promise<void>;
}

// ============================================================================
// Attio
// ============================================================================

const ATTIO_AUTHORIZE_URL = 'https://app.attio.com/authorize';
const ATTIO_TOKEN_URL = 'https://app.attio.com/oauth/token';
const ATTIO_API_BASE = 'https://api.attio.com/v2';

class AttioOAuthAdapter implements IntegrationOAuthAdapter {
  readonly provider = 'attio';
  readonly supportedEntities: SyncEntityType[] = ['customer', 'contact'];

  getDefaultFieldMappings(entityType: SyncEntityType): FieldMappingDefinition[] {
    switch (entityType) {
      case 'customer':
        return [
          { externalFieldPath: 'companyName', internalFieldPath: 'companyName', direction: 'inbound', transformType: 'direct' },
          { externalFieldPath: 'email', internalFieldPath: 'email', direction: 'inbound', transformType: 'direct', isRequired: true },
          { externalFieldPath: 'website', internalFieldPath: 'website', direction: 'inbound', transformType: 'direct' },
          { externalFieldPath: 'phone', internalFieldPath: 'phone', direction: 'inbound', transformType: 'direct' },
          { externalFieldPath: 'notes', internalFieldPath: 'notes', direction: 'inbound', transformType: 'direct' },
          { externalFieldPath: 'tags', internalFieldPath: 'tags', direction: 'inbound', transformType: 'direct' },
          { externalFieldPath: 'type', internalFieldPath: 'type', direction: 'inbound', transformType: 'direct' },
          { externalFieldPath: 'status', internalFieldPath: 'status', direction: 'inbound', transformType: 'direct' },
          { externalFieldPath: 'source', internalFieldPath: 'source', direction: 'inbound', transformType: 'direct' },
        ];
      case 'contact':
        return [
          { externalFieldPath: 'firstName', internalFieldPath: 'firstName', direction: 'inbound', transformType: 'direct' },
          { externalFieldPath: 'lastName', internalFieldPath: 'lastName', direction: 'inbound', transformType: 'direct' },
          { externalFieldPath: 'fullName', internalFieldPath: 'fullName', direction: 'inbound', transformType: 'direct' },
          { externalFieldPath: 'email', internalFieldPath: 'email', direction: 'inbound', transformType: 'direct', isRequired: true },
          { externalFieldPath: 'phone', internalFieldPath: 'directPhone', direction: 'inbound', transformType: 'direct' },
          { externalFieldPath: 'title', internalFieldPath: 'title', direction: 'inbound', transformType: 'direct' },
          { externalFieldPath: 'status', internalFieldPath: 'status', direction: 'inbound', transformType: 'direct' },
        ];
      default:
        return [];
    }
  }

  getAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
    // NOTE: Attio's /authorize accepts only client_id/response_type/redirect_uri/state.
    // Scopes are NOT a query param — they are configured on the OAuth app in the
    // build.attio.com dashboard (records, object configuration, user management,
    // tasks, notes, webhooks). Do NOT add a `scope` param here; Attio ignores it.
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
    });
    return `${ATTIO_AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<OAuthTokens> {
    const response = await fetch(ATTIO_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!response.ok) {
      throw new Error(`Attio token exchange failed (${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : undefined,
      tokenType: data.token_type || 'Bearer',
    };
  }

  async refreshAccessToken(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const response = await fetch(ATTIO_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      throw new Error(`Attio token refresh failed (${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : undefined,
      tokenType: data.token_type || 'Bearer',
    };
  }

  async registerWebhooks(accessToken: string, targetUrl: string): Promise<WebhookRegistration> {
    const response = await fetch(`${ATTIO_API_BASE}/webhooks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          target_url: targetUrl,
          subscriptions: [
            { event_type: 'record.created', filter: null },
            { event_type: 'record.updated', filter: null },
            { event_type: 'record.deleted', filter: null },
            { event_type: 'record.merged', filter: null },
            { event_type: 'note.created', filter: null },
            { event_type: 'note.updated', filter: null },
            { event_type: 'note.deleted', filter: null },
            { event_type: 'task.created', filter: null },
            { event_type: 'task.updated', filter: null },
            { event_type: 'task.deleted', filter: null },
            { event_type: 'list-entry.created', filter: null },
            { event_type: 'list-entry.updated', filter: null },
            { event_type: 'list-entry.deleted', filter: null },
          ],
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Attio webhook registration failed (${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as {
      data: { id: { webhook_id: string }; secret: string };
    };

    return { webhookId: data.data.id.webhook_id, secret: data.data.secret };
  }

  async deleteWebhooks(accessToken: string, webhookId: string): Promise<void> {
    const response = await fetch(`${ATTIO_API_BASE}/webhooks/${webhookId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`Attio webhook deletion failed (${response.status}): ${await response.text()}`);
    }
  }
}

// ============================================================================
// HubSpot
// ============================================================================

const HUBSPOT_AUTHORIZE_URL = 'https://app.hubspot.com/oauth/authorize';
const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';

interface HubSpotTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

class HubSpotOAuthAdapter implements IntegrationOAuthAdapter {
  readonly provider = 'hubspot';
  readonly supportedEntities: SyncEntityType[] = ['contact', 'customer', 'opportunity'];

  getDefaultFieldMappings(entityType: SyncEntityType): FieldMappingDefinition[] {
    switch (entityType) {
      case 'contact':
        return [
          { externalFieldPath: 'properties.firstname', internalFieldPath: 'firstName', direction: 'bidirectional', transformType: 'direct' },
          { externalFieldPath: 'properties.lastname', internalFieldPath: 'lastName', direction: 'bidirectional', transformType: 'direct' },
          { externalFieldPath: 'properties.email', internalFieldPath: 'email', direction: 'bidirectional', transformType: 'direct', isRequired: true },
          { externalFieldPath: 'properties.phone', internalFieldPath: 'directPhone', direction: 'bidirectional', transformType: 'direct' },
          { externalFieldPath: 'properties.mobilephone', internalFieldPath: 'mobile', direction: 'bidirectional', transformType: 'direct' },
          { externalFieldPath: 'properties.jobtitle', internalFieldPath: 'title', direction: 'bidirectional', transformType: 'direct' },
          {
            externalFieldPath: 'properties.lifecyclestage',
            internalFieldPath: 'status',
            direction: 'inbound',
            transformType: 'lookup',
            transformConfig: {
              lookupTable: {
                subscriber: 'active',
                lead: 'active',
                marketingqualifiedlead: 'active',
                salesqualifiedlead: 'active',
                opportunity: 'active',
                customer: 'active',
                evangelist: 'active',
                other: 'active',
              },
            },
          },
        ];
      case 'customer':
        return [
          { externalFieldPath: 'properties.name', internalFieldPath: 'companyName', direction: 'bidirectional', transformType: 'direct', isRequired: true },
          { externalFieldPath: 'properties.domain', internalFieldPath: 'website', direction: 'bidirectional', transformType: 'direct' },
          { externalFieldPath: 'properties.phone', internalFieldPath: 'phone', direction: 'bidirectional', transformType: 'direct' },
          { externalFieldPath: 'properties.industry', internalFieldPath: 'industry', direction: 'bidirectional', transformType: 'direct' },
          { externalFieldPath: 'properties.description', internalFieldPath: 'notes', direction: 'bidirectional', transformType: 'direct' },
          { externalFieldPath: 'properties.address', internalFieldPath: 'billingAddress', direction: 'inbound', transformType: 'direct' },
          { externalFieldPath: 'properties.city', internalFieldPath: 'billingCity', direction: 'inbound', transformType: 'direct' },
          { externalFieldPath: 'properties.country', internalFieldPath: 'billingCountry', direction: 'inbound', transformType: 'direct' },
        ];
      case 'opportunity':
        return [
          { externalFieldPath: 'properties.dealname', internalFieldPath: 'name', direction: 'bidirectional', transformType: 'direct', isRequired: true },
          { externalFieldPath: 'properties.amount', internalFieldPath: 'amount', direction: 'bidirectional', transformType: 'direct' },
          { externalFieldPath: 'properties.deal_currency_code', internalFieldPath: 'currency', direction: 'bidirectional', transformType: 'direct' },
          { externalFieldPath: 'properties.closedate', internalFieldPath: 'closeDate', direction: 'bidirectional', transformType: 'format_date' },
          {
            externalFieldPath: 'properties.dealstage',
            internalFieldPath: 'stage',
            direction: 'bidirectional',
            transformType: 'lookup',
            transformConfig: {
              lookupTable: {
                appointmentscheduled: 'prospecting',
                qualifiedtobuy: 'qualification',
                presentationscheduled: 'needs_analysis',
                decisionmakerboughtin: 'proposal',
                contractsent: 'negotiation',
                closedwon: 'closed_won',
                closedlost: 'closed_lost',
              },
            },
          },
          { externalFieldPath: 'properties.description', internalFieldPath: 'description', direction: 'bidirectional', transformType: 'direct' },
          { externalFieldPath: 'properties.pipeline', internalFieldPath: 'pipeline', direction: 'inbound', transformType: 'direct' },
        ];
      default:
        return [];
    }
  }

  getAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
    const scopes = [
      'crm.objects.contacts.read',
      'crm.objects.contacts.write',
      'crm.objects.companies.read',
      'crm.objects.companies.write',
      'crm.objects.deals.read',
      'crm.objects.deals.write',
      'crm.schemas.deals.read',
    ];

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      state,
    });

    return `${HUBSPOT_AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<OAuthTokens> {
    const response = await fetch(HUBSPOT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    });

    if (!response.ok) {
      throw new Error(`HubSpot token exchange failed (${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as HubSpotTokenResponse;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      tokenType: data.token_type || 'Bearer',
    };
  }

  async refreshAccessToken(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const response = await fetch(HUBSPOT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      throw new Error(`HubSpot token refresh failed (${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as HubSpotTokenResponse;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      tokenType: data.token_type || 'Bearer',
    };
  }

  async registerWebhooks(): Promise<WebhookRegistration> {
    // HubSpot webhooks are configured in the app dashboard (Developer Portal →
    // Webhooks tab), not via API. The connection stores the client secret as
    // webhookSecret for v3 signature verification instead.
    return { webhookId: 'hubspot-app-webhook', secret: '' };
  }

  async deleteWebhooks(): Promise<void> {
    // HubSpot webhooks are managed in the app dashboard — no-op.
  }
}

// ============================================================================
// Google Calendar
// ============================================================================

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

class GoogleCalendarOAuthAdapter implements IntegrationOAuthAdapter {
  readonly provider = 'google_calendar';
  readonly supportedEntities: SyncEntityType[] = ['calendar_event'];

  getDefaultFieldMappings(): FieldMappingDefinition[] {
    // Google Calendar uses hardcoded transforms — no configurable mappings.
    return [];
  }

  getAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
      scope: GOOGLE_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
    });
    return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<OAuthTokens> {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!response.ok) {
      throw new Error(`Google token exchange failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : undefined,
      tokenType: data.token_type || 'Bearer',
    };
  }

  async refreshAccessToken(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      throw new Error(`Google token refresh failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in?: number;
      token_type?: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : undefined,
      tokenType: data.token_type || 'Bearer',
    };
  }

  async registerWebhooks(accessToken: string, targetUrl: string): Promise<WebhookRegistration> {
    const channelId = crypto.randomUUID();
    const token = crypto.randomUUID();

    const response = await fetch(`${CALENDAR_API_BASE}/calendars/primary/events/watch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: channelId,
        type: 'web_hook',
        address: targetUrl,
        token,
        params: { ttl: '604800' }, // 7 days
      }),
    });

    if (!response.ok) {
      throw new Error(`Google watch registration failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as {
      id: string;
      resourceId: string;
      expiration: string;
    };

    return {
      webhookId: data.id,
      secret: JSON.stringify({
        token,
        resourceId: data.resourceId,
        expiration: data.expiration,
      }),
    };
  }

  async deleteWebhooks(accessToken: string, webhookId: string, webhookSecret?: string): Promise<void> {
    let resourceId = webhookId;
    if (webhookSecret) {
      try {
        const parsed = JSON.parse(webhookSecret) as { resourceId: string };
        resourceId = parsed.resourceId;
      } catch {
        // Fall through with webhookId
      }
    }

    const response = await fetch(`${CALENDAR_API_BASE}/channels/stop`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: webhookId, resourceId }),
    });

    // 404 = channel already expired
    if (!response.ok && response.status !== 404) {
      console.error(`[Integrations/GoogleCalendar] Failed to stop watch channel: ${response.status}`);
    }
  }
}

// ============================================================================
// Registry
// ============================================================================

const adapters: Record<string, IntegrationOAuthAdapter> = {};
for (const adapter of [
  new AttioOAuthAdapter(),
  new HubSpotOAuthAdapter(),
  new GoogleCalendarOAuthAdapter(),
]) {
  adapters[adapter.provider] = adapter;
}

/** Get the registered OAuth adapter for a provider. Throws when unknown. */
export function getOAuthAdapter(provider: string): IntegrationOAuthAdapter {
  const adapter = adapters[provider];
  if (!adapter) {
    throw new Error(`No integration OAuth adapter registered for provider: ${provider}`);
  }
  return adapter;
}

/** Check whether an OAuth adapter is registered for a provider. */
export function hasOAuthAdapter(provider: string): boolean {
  return provider in adapters;
}
