/**
 * Attio CRM Sync Adapter
 *
 * Implements CrmSyncAdapter for Attio CRM. Handles OAuth, data fetching,
 * webhook management, and field mapping defaults.
 *
 * Refactored from the Trigger.dev task at apps/web/platform/trigger/integrations/crm-sync.ts
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

const ATTIO_API_BASE = 'https://api.attio.com/v2';
const ATTIO_AUTHORIZE_URL = 'https://app.attio.com/authorize';
const ATTIO_TOKEN_URL = 'https://app.attio.com/oauth/token';
const PAGE_SIZE = 500;

// ============================================================================
// Attio-specific helpers
// ============================================================================

function getAttrValue(values: Record<string, unknown>, key: string): string | undefined {
  const arr = values[key] as Array<Record<string, unknown>> | undefined;
  if (!arr || arr.length === 0) return undefined;
  const item = arr[0];
  if (item.value !== undefined && item.value !== null) return String(item.value);
  if (item.original) return String(item.original);
  return undefined;
}

function getEmail(values: Record<string, unknown>): string | undefined {
  const arr = values['email_addresses'] as Array<{ email_address?: string }> | undefined;
  if (!arr || arr.length === 0) return undefined;
  return arr[0]?.email_address;
}

function getPhone(values: Record<string, unknown>): string | undefined {
  const arr = values['phone_numbers'] as Array<{ original_phone_number?: string; phone_number?: string }> | undefined;
  if (!arr || arr.length === 0) return undefined;
  return arr[0]?.original_phone_number || arr[0]?.phone_number;
}

function getCompanyName(values: Record<string, unknown>): string | undefined {
  const arr = values['name'] as Array<{ value?: string }> | undefined;
  if (!arr || arr.length === 0) return undefined;
  return arr[0]?.value;
}

function getPersonName(values: Record<string, unknown>): { firstName?: string; lastName?: string; fullName?: string } {
  const arr = values['name'] as Array<{ first_name?: string; last_name?: string; full_name?: string }> | undefined;
  if (!arr || arr.length === 0) return {};
  return {
    firstName: arr[0].first_name || undefined,
    lastName: arr[0].last_name || undefined,
    fullName: arr[0].full_name || undefined,
  };
}

function getDomain(values: Record<string, unknown>): string | undefined {
  const arr = values['domains'] as Array<{ domain?: string }> | undefined;
  if (!arr || arr.length === 0) return undefined;
  return arr[0]?.domain;
}

function getDescription(values: Record<string, unknown>): string | undefined {
  const arr = values['description'] as Array<{ value?: string }> | undefined;
  if (!arr || arr.length === 0) return undefined;
  return arr[0]?.value;
}

function getCategories(values: Record<string, unknown>): string[] | undefined {
  const arr = values['categories'] as Array<{ option?: { title?: string } }> | undefined;
  if (!arr || arr.length === 0) return undefined;
  return arr.map(c => c.option?.title).filter(Boolean) as string[];
}

function getCompanyRecordId(values: Record<string, unknown>): string | undefined {
  const arr = values['company'] as Array<{ target_record_id?: string }> | undefined;
  if (!arr || arr.length === 0) return undefined;
  return arr[0]?.target_record_id;
}

/**
 * Map Attio record values to a flat data object for the external entity.
 */
function mapCompanyValues(values: Record<string, unknown>): Record<string, unknown> {
  const domain = getDomain(values);
  return {
    companyName: getCompanyName(values) || 'Unknown Company',
    email: getEmail(values),
    website: domain ? `https://${domain}` : undefined,
    notes: getDescription(values),
    tags: getCategories(values),
    phone: getPhone(values),
    type: 'b2b',
    status: 'active',
    source: 'attio',
  };
}

function mapPersonValues(values: Record<string, unknown>): Record<string, unknown> {
  const { firstName, lastName, fullName } = getPersonName(values);
  const companyExtId = getCompanyRecordId(values);
  return {
    firstName: firstName || 'Unknown',
    lastName: lastName || 'Unknown',
    fullName,
    email: getEmail(values),
    phone: getPhone(values),
    title: getAttrValue(values, 'job_title'),
    status: 'active',
    _companyExternalId: companyExtId, // Internal hint for parent resolution
  };
}

// ============================================================================
// Attio API calls
// ============================================================================

interface AttioRecordPage {
  data: Array<{
    id: { record_id: string };
    values: Record<string, unknown>;
    created_at?: string;
  }>;
  next_page_token?: string;
}

async function fetchAttioRecords(
  accessToken: string,
  objectSlug: string,
  offset: number = 0,
): Promise<AttioRecordPage> {
  const response = await fetch(`${ATTIO_API_BASE}/objects/${objectSlug}/records/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ limit: PAGE_SIZE, offset }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Attio API error ${response.status}: ${errorText}`);
  }

  return await response.json() as AttioRecordPage;
}

// ============================================================================
// Adapter implementation
// ============================================================================

export class AttioSyncAdapter implements CrmSyncAdapter {
  readonly provider = 'attio';
  readonly supportedEntities: SyncEntityType[] = ['customer', 'contact'];

  // ---------- Field Mappings ----------

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

  // ---------- Data Fetching ----------

  async fetchEntities(
    accessToken: string,
    entityType: SyncEntityType,
    cursor?: string,
  ): Promise<FetchPageResult> {
    const offset = cursor ? parseInt(cursor, 10) : 0;

    if (entityType === 'customer') {
      const page = await fetchAttioRecords(accessToken, 'companies', offset);
      return {
        entities: page.data.map(record => ({
          id: record.id.record_id,
          type: 'customer' as SyncEntityType,
          data: mapCompanyValues(record.values),
          updatedAt: record.created_at || new Date().toISOString(),
          raw: record.values,
        })),
        nextCursor: page.data.length === PAGE_SIZE ? String(offset + page.data.length) : undefined,
        hasMore: page.data.length === PAGE_SIZE,
      };
    }

    if (entityType === 'contact') {
      const page = await fetchAttioRecords(accessToken, 'people', offset);

      const entities: ExternalEntity[] = [];
      for (const record of page.data) {
        const data = mapPersonValues(record.values);
        const hasCompany = !!data._companyExternalId;

        entities.push({
          id: record.id.record_id,
          type: hasCompany ? 'contact' : 'customer',
          data: hasCompany
            ? { ...data, _companyExternalId: undefined }
            : {
                type: 'b2c',
                firstName: data.firstName,
                lastName: data.lastName,
                fullName: data.fullName,
                email: data.email,
                phone: data.phone,
                status: 'active',
                source: 'attio',
              },
          updatedAt: record.created_at || new Date().toISOString(),
          raw: record.values,
        });
      }

      return {
        entities,
        nextCursor: page.data.length === PAGE_SIZE ? String(offset + page.data.length) : undefined,
        hasMore: page.data.length === PAGE_SIZE,
      };
    }

    return { entities: [], hasMore: false };
  }

  async fetchEntity(
    accessToken: string,
    entityType: SyncEntityType,
    externalId: string,
  ): Promise<ExternalEntity> {
    const objectSlug = entityType === 'customer' ? 'companies' : 'people';
    const response = await fetch(`${ATTIO_API_BASE}/objects/${objectSlug}/records/${externalId}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Attio fetch entity error ${response.status}: ${await response.text()}`);
    }

    const { data } = await response.json() as { data: { id: { record_id: string }; values: Record<string, unknown>; created_at?: string } };
    const mapFn = entityType === 'customer' ? mapCompanyValues : mapPersonValues;

    return {
      id: data.id.record_id,
      type: entityType,
      data: mapFn(data.values),
      updatedAt: data.created_at || new Date().toISOString(),
      raw: data.values,
    };
  }

  // ---------- Data Pushing (not supported for Attio in initial implementation) ----------

  async pushEntity(): Promise<PushResult> {
    throw new Error('Outbound sync not implemented for Attio');
  }

  async deleteEntity(): Promise<{ success: boolean; error?: string }> {
    throw new Error('Outbound delete not implemented for Attio');
  }

  // ---------- OAuth ----------

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

    const data = await response.json() as {
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

    const data = await response.json() as {
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

  // ---------- Webhooks ----------

  async verifyWebhookSignature(): Promise<boolean> {
    // Attio webhook signatures are verified in the integration-webhook-worker
    // (HMAC-SHA256 over the raw body, see providers/attio/index.ts). This
    // adapter is only used for OAuth + outbound sync, never to receive
    // webhooks — so this must never be called. Throw rather than silently
    // return `true`, which would wave through unsigned payloads if some future
    // caller wired webhooks through the adapter by mistake.
    throw new Error('Attio webhook verification is delegated to integration-webhook-worker; do not call this on the adapter');
  }

  parseWebhookPayload(body: string): ParsedWebhookPayload {
    const payload = JSON.parse(body);
    // Delegate to webhook worker's parser — this is a simplified version
    return {
      webhookId: payload.data?.webhook_id || '',
      events: (payload.data?.events || []).map((event: any) => ({
        eventType: event.event_type?.split('.')[1] || 'updated',
        entityType: event.object_type === 'companies' ? 'customer' : 'contact',
        externalEntityId: event.record_id || '',
      })),
    };
  }

  async registerWebhooks(
    accessToken: string,
    targetUrl: string,
  ): Promise<WebhookRegistration> {
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

    const data = await response.json() as {
      data: { id: { webhook_id: string }; secret: string };
    };

    return {
      webhookId: data.data.id.webhook_id,
      secret: data.data.secret,
    };
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
