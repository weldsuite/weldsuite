/**
 * HubSpot CRM Sync Adapter
 *
 * Implements CrmSyncAdapter for HubSpot CRM.
 * Uses HubSpot CRM API v3 for contacts, companies, deals, and engagements.
 *
 * HubSpot API docs: https://developers.hubspot.com/docs/api/crm
 *
 * Entity mapping:
 *   HubSpot contacts  → WeldSuite contacts
 *   HubSpot companies → WeldSuite customers (b2b)
 *   HubSpot deals     → WeldSuite opportunities
 *   HubSpot notes     → WeldSuite activities (type: 'note')
 */

import type {
  CrmSyncAdapter,
  SyncEntityType,
  ExternalEntity,
  FetchPageResult,
  PushResult,
  FieldMappingDefinition,
  ParsedWebhookPayload,
  WebhookRegistration,
} from '../sync/types';
import type { OAuthTokens } from '../types';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const HUBSPOT_AUTHORIZE_URL = 'https://app.hubspot.com/oauth/authorize';
const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const PAGE_SIZE = 100; // HubSpot max is 100

// ============================================================================
// HubSpot object type mapping
// ============================================================================

const ENTITY_TO_HUBSPOT_OBJECT: Record<string, string> = {
  contact: 'contacts',
  customer: 'companies',
  opportunity: 'deals',
  activity: 'notes',
};

const HUBSPOT_OBJECT_TO_ENTITY: Record<string, SyncEntityType> = {
  contact: 'contact',
  company: 'customer',
  deal: 'opportunity',
  note: 'activity',
};

// ============================================================================
// Properties to fetch per object type
// ============================================================================

const HUBSPOT_PROPERTIES: Record<string, string[]> = {
  contacts: [
    'firstname', 'lastname', 'email', 'phone', 'mobilephone',
    'jobtitle', 'company', 'website', 'lifecyclestage',
    'hs_lead_status', 'address', 'city', 'state', 'zip', 'country',
  ],
  companies: [
    'name', 'domain', 'phone', 'industry', 'description',
    'numberofemployees', 'annualrevenue', 'website', 'city',
    'state', 'zip', 'country', 'address',
  ],
  deals: [
    'dealname', 'amount', 'dealstage', 'pipeline',
    'closedate', 'hs_lastmodifieddate', 'description',
    'deal_currency_code',
  ],
  notes: [
    'hs_timestamp', 'hs_note_body',
  ],
};

// ============================================================================
// Adapter implementation
// ============================================================================

export class HubSpotSyncAdapter implements CrmSyncAdapter {
  readonly provider = 'hubspot';
  readonly supportedEntities: SyncEntityType[] = ['contact', 'customer', 'opportunity'];

  // ---------- Field Mappings ----------

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
          { externalFieldPath: 'properties.lifecyclestage', internalFieldPath: 'status', direction: 'inbound', transformType: 'lookup', transformConfig: {
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
          }},
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
          { externalFieldPath: 'properties.dealstage', internalFieldPath: 'stage', direction: 'bidirectional', transformType: 'lookup', transformConfig: {
            lookupTable: {
              appointmentscheduled: 'prospecting',
              qualifiedtobuy: 'qualification',
              presentationscheduled: 'needs_analysis',
              decisionmakerboughtin: 'proposal',
              contractsent: 'negotiation',
              closedwon: 'closed_won',
              closedlost: 'closed_lost',
            },
          }},
          { externalFieldPath: 'properties.description', internalFieldPath: 'description', direction: 'bidirectional', transformType: 'direct' },
          { externalFieldPath: 'properties.pipeline', internalFieldPath: 'pipeline', direction: 'inbound', transformType: 'direct' },
        ];

      default:
        return [];
    }
  }

  // ---------- Data Fetching ----------

  async fetchEntities(
    accessToken: string,
    entityType: SyncEntityType,
    cursor?: string,
    updatedSince?: Date,
  ): Promise<FetchPageResult> {
    const hubspotObject = ENTITY_TO_HUBSPOT_OBJECT[entityType];
    if (!hubspotObject) return { entities: [], hasMore: false };

    const properties = HUBSPOT_PROPERTIES[hubspotObject] || [];

    // Use search API for incremental sync, list API for full sync
    if (updatedSince) {
      return this.fetchEntitiesIncremental(accessToken, hubspotObject, entityType, properties, cursor, updatedSince);
    }

    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      properties: properties.join(','),
    });
    if (cursor) params.set('after', cursor);

    const response = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/${hubspotObject}?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`HubSpot API error ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as HubSpotListResponse;

    return {
      entities: data.results.map(record => this.mapToExternalEntity(record, entityType)),
      nextCursor: data.paging?.next?.after,
      hasMore: !!data.paging?.next?.after,
    };
  }

  private async fetchEntitiesIncremental(
    accessToken: string,
    hubspotObject: string,
    entityType: SyncEntityType,
    properties: string[],
    cursor?: string,
    updatedSince?: Date,
  ): Promise<FetchPageResult> {
    const body: Record<string, unknown> = {
      filterGroups: [{
        filters: [{
          propertyName: 'hs_lastmodifieddate',
          operator: 'GTE',
          value: updatedSince!.getTime().toString(),
        }],
      }],
      properties,
      limit: PAGE_SIZE,
    };
    if (cursor) body.after = cursor;

    const response = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/${hubspotObject}/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`HubSpot search API error ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as HubSpotListResponse;

    return {
      entities: data.results.map(record => this.mapToExternalEntity(record, entityType)),
      nextCursor: data.paging?.next?.after,
      hasMore: !!data.paging?.next?.after,
    };
  }

  async fetchEntity(
    accessToken: string,
    entityType: SyncEntityType,
    externalId: string,
  ): Promise<ExternalEntity> {
    const hubspotObject = ENTITY_TO_HUBSPOT_OBJECT[entityType];
    if (!hubspotObject) throw new Error(`Unsupported entity type: ${entityType}`);

    const properties = HUBSPOT_PROPERTIES[hubspotObject] || [];
    const params = new URLSearchParams({ properties: properties.join(',') });

    const response = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/${hubspotObject}/${externalId}?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`HubSpot fetch error ${response.status}: ${await response.text()}`);
    }

    const record = await response.json() as HubSpotRecord;
    return this.mapToExternalEntity(record, entityType);
  }

  // ---------- Data Pushing (Outbound) ----------

  async pushEntity(
    accessToken: string,
    entityType: SyncEntityType,
    data: Record<string, unknown>,
    externalId?: string,
  ): Promise<PushResult> {
    const hubspotObject = ENTITY_TO_HUBSPOT_OBJECT[entityType];
    if (!hubspotObject) throw new Error(`Unsupported entity type: ${entityType}`);

    // Data should already be mapped to HubSpot field paths by the field mapper
    // We need to extract the properties from the dot-notation
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      // Strip 'properties.' prefix if present
      const propName = key.startsWith('properties.') ? key.slice(11) : key;
      if (value !== undefined && value !== null) {
        properties[propName] = value;
      }
    }

    const url = externalId
      ? `${HUBSPOT_API_BASE}/crm/v3/objects/${hubspotObject}/${externalId}`
      : `${HUBSPOT_API_BASE}/crm/v3/objects/${hubspotObject}`;

    const method = externalId ? 'PATCH' : 'POST';

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { externalId: externalId || '', success: false, error: `HubSpot ${response.status}: ${errorText}` };
    }

    const result = await response.json() as HubSpotRecord;
    return { externalId: result.id, success: true };
  }

  async deleteEntity(
    accessToken: string,
    entityType: SyncEntityType,
    externalId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const hubspotObject = ENTITY_TO_HUBSPOT_OBJECT[entityType];
    if (!hubspotObject) return { success: false, error: `Unsupported entity type: ${entityType}` };

    const response = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/${hubspotObject}/${externalId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok && response.status !== 404) {
      return { success: false, error: `HubSpot delete error ${response.status}: ${await response.text()}` };
    }

    return { success: true };
  }

  // ---------- OAuth ----------

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

    const data = await response.json() as HubSpotTokenResponse;

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

    const data = await response.json() as HubSpotTokenResponse;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      tokenType: data.token_type || 'Bearer',
    };
  }

  // ---------- Webhooks ----------

  async verifyWebhookSignature(
    body: string,
    headers: Record<string, string>,
    secret: string,
  ): Promise<boolean> {
    // HubSpot v3 signature: SHA-256 hash of clientSecret + requestBody
    const signature = headers['x-hubspot-signature-v3'] || headers['x-hubspot-signature'];
    if (!signature) return false;

    const sourceString = secret + body;
    const encoded = new TextEncoder().encode(sourceString);
    const hash = await crypto.subtle.digest('SHA-256', encoded);
    const expected = Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return signature === expected;
  }

  parseWebhookPayload(body: string): ParsedWebhookPayload {
    const events = JSON.parse(body) as HubSpotWebhookEvent[];

    return {
      webhookId: '',
      events: events.map(event => {
        const entityType = HUBSPOT_OBJECT_TO_ENTITY[event.objectType] || 'contact';
        const eventTypeMap: Record<string, 'created' | 'updated' | 'deleted'> = {
          'contact.creation': 'created',
          'contact.propertyChange': 'updated',
          'contact.deletion': 'deleted',
          'company.creation': 'created',
          'company.propertyChange': 'updated',
          'company.deletion': 'deleted',
          'deal.creation': 'created',
          'deal.propertyChange': 'updated',
          'deal.deletion': 'deleted',
        };

        return {
          eventType: eventTypeMap[event.subscriptionType] || 'updated',
          entityType,
          externalEntityId: String(event.objectId),
        };
      }),
    };
  }

  async registerWebhooks(
    _accessToken: string,
    _targetUrl: string,
    _entityTypes: SyncEntityType[],
  ): Promise<WebhookRegistration> {
    // HubSpot webhooks are configured in the app dashboard, not via API.
    // The webhook URL and subscriptions are set in HubSpot Developer Portal
    // under the app's "Webhooks" tab.
    //
    // Return a placeholder — the actual webhook registration happens in the
    // HubSpot app settings UI.
    return {
      webhookId: 'hubspot-app-webhook',
      secret: '', // HubSpot uses the client secret for signature verification
    };
  }

  async deleteWebhooks(): Promise<void> {
    // HubSpot webhooks are managed in the app dashboard, not via API.
    // No-op here.
  }

  // ---------- Helpers ----------

  private mapToExternalEntity(record: HubSpotRecord, entityType: SyncEntityType): ExternalEntity {
    return {
      id: record.id,
      type: entityType,
      data: { properties: record.properties },
      updatedAt: record.updatedAt || record.createdAt || new Date().toISOString(),
      raw: record,
    };
  }
}

// ============================================================================
// HubSpot API types
// ============================================================================

interface HubSpotRecord {
  id: string;
  properties: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
}

interface HubSpotListResponse {
  results: HubSpotRecord[];
  paging?: {
    next?: {
      after: string;
      link?: string;
    };
  };
}

interface HubSpotTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface HubSpotWebhookEvent {
  objectId: number;
  objectType: string; // 'contact' | 'company' | 'deal'
  subscriptionType: string; // 'contact.creation' | 'contact.propertyChange' | etc.
  changeSource: string;
  occurredAt: number;
  propertyName?: string;
  propertyValue?: string;
}
