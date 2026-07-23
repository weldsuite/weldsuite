/**
 * HubSpot integration provider for the webhook worker.
 *
 * HubSpot sends all webhook events to a single URL (not per-connection).
 * Events include a `portalId` field that identifies which HubSpot account
 * the event came from. We use this to look up the correct connection.
 *
 * Webhook payload format:
 * [
 *   {
 *     "appId": 12345,
 *     "eventId": 1,
 *     "subscriptionId": 67890,
 *     "portalId": 148170870,
 *     "occurredAt": 1680000000000,
 *     "subscriptionType": "object.creation",
 *     "attemptNumber": 0,
 *     "objectId": 123,
 *     "objectTypeId": "0-1",
 *     "changeSource": "CRM",
 *     "propertyName": "email",
 *     "propertyValue": "test@example.com"
 *   }
 * ]
 */

import type {
  IntegrationProvider,
  ExternalRecord,
  ExternalNote,
  ExternalTask,
  ExternalList,
  ExternalListEntry,
  ParsedWebhookPayload,
  ParsedWebhookEvent,
  MappedCompany,
  MappedPerson,
  SyncEntityType,
  GenericExternalEntity,
} from '../../types';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';

/**
 * HubSpot object type IDs to entity types.
 */
const OBJECT_TYPE_MAP: Record<string, SyncEntityType> = {
  '0-1': 'person',      // contacts
  '0-2': 'company',     // companies
  '0-3': 'opportunity', // deals
  // Slug aliases must resolve to the SAME internal entity types the ingress
  // handler branches on ('person' / 'company'), not HubSpot's own labels.
  'contact': 'person',
  'company': 'company',
  'deal': 'opportunity',
};

/**
 * HubSpot object type IDs to API slugs.
 */
const OBJECT_TYPE_SLUGS: Record<string, string> = {
  '0-1': 'contacts',
  '0-2': 'companies',
  '0-3': 'deals',
  'contact': 'contacts',
  'company': 'companies',
  'deal': 'deals',
};

const HUBSPOT_PROPERTIES: Record<string, string[]> = {
  contacts: [
    'firstname', 'lastname', 'email', 'phone', 'mobilephone',
    'jobtitle', 'company', 'website', 'lifecyclestage',
  ],
  companies: [
    'name', 'domain', 'phone', 'industry', 'description',
    'numberofemployees', 'annualrevenue', 'website',
  ],
  deals: [
    'dealname', 'amount', 'dealstage', 'pipeline',
    'closedate', 'description', 'deal_currency_code',
  ],
};

interface HubSpotWebhookEvent {
  appId: number;
  eventId: number;
  subscriptionId: number;
  portalId: number;
  occurredAt: number;
  subscriptionType: string;
  attemptNumber: number;
  objectId: number;
  objectTypeId?: string;
  changeSource?: string;
  propertyName?: string;
  propertyValue?: string;
}

interface HubSpotRecord {
  id: string;
  properties: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
}

export class HubSpotProvider implements IntegrationProvider {
  // ---------- Webhook signature verification ----------

  async verifyWebhookSignature(
    body: string,
    headers: Record<string, string>,
    secret: string,
  ): Promise<boolean> {
    // HubSpot v3 signature: SHA-256(clientSecret + requestBody)
    const signature = headers['x-hubspot-signature-v3'] || headers['x-hubspot-signature'];
    if (!signature) return false;

    try {
      const sourceString = secret + body;
      const encoded = new TextEncoder().encode(sourceString);
      const hash = await crypto.subtle.digest('SHA-256', encoded);
      const expected = Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      // Constant-time comparison
      if (signature.length !== expected.length) return false;
      let mismatch = 0;
      for (let i = 0; i < signature.length; i++) {
        mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
      }
      return mismatch === 0;
    } catch {
      return false;
    }
  }

  // ---------- Parse webhook payload ----------

  parseWebhookPayload(body: string): ParsedWebhookPayload {
    const events = JSON.parse(body) as HubSpotWebhookEvent[];

    return {
      webhookId: '',
      events: events.map(event => {
        const objectType = event.objectTypeId || '';
        const entityType = OBJECT_TYPE_MAP[objectType] || 'contact';
        const subscriptionType = event.subscriptionType || '';

        let eventType: ParsedWebhookEvent['eventType'];
        if (subscriptionType.includes('creation') || subscriptionType.includes('.created')) {
          eventType = 'record.created';
        } else if (subscriptionType.includes('deletion') || subscriptionType.includes('.deleted')) {
          eventType = 'record.deleted';
        } else {
          eventType = 'record.updated';
        }

        return {
          eventType,
          objectId: objectType,
          objectType: OBJECT_TYPE_SLUGS[objectType] || 'contacts',
          recordId: String(event.objectId),
        };
      }),
    };
  }

  // ---------- Resolve entity type from webhook event (generic interface) ----------

  resolveEntityType(event: ParsedWebhookEvent): SyncEntityType | undefined {
    // objectId here contains the objectTypeId from parseWebhookPayload
    return OBJECT_TYPE_MAP[event.objectId] || OBJECT_TYPE_MAP[event.objectType] || undefined;
  }

  // ---------- Fetch entity (generic interface) ----------

  async fetchEntityGeneric(
    accessToken: string,
    entityType: SyncEntityType,
    externalId: string,
  ): Promise<GenericExternalEntity> {
    const slugMap: Record<string, string> = {
      contact: 'contacts',
      customer: 'companies',
      opportunity: 'deals',
    };
    const slug = slugMap[entityType];
    if (!slug) throw new Error(`Unsupported entity type for HubSpot: ${entityType}`);

    const properties = HUBSPOT_PROPERTIES[slug] || [];
    const params = new URLSearchParams({ properties: properties.join(',') });

    const response = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/${slug}/${externalId}?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`HubSpot fetch error ${response.status}: ${await response.text()}`);
    }

    const record = await response.json() as HubSpotRecord;

    return {
      id: record.id,
      type: entityType,
      data: { properties: record.properties },
      updatedAt: record.updatedAt || record.createdAt || new Date().toISOString(),
      raw: record,
    };
  }

  // ---------- Legacy interface methods (for Attio-style processing) ----------
  // HubSpot uses the generic interface (resolveEntityType + fetchEntityGeneric)
  // These are stubs to satisfy the IntegrationProvider interface.

  async resolveObjectSlug(_accessToken: string, objectId: string): Promise<string> {
    return OBJECT_TYPE_SLUGS[objectId] || objectId;
  }

  async fetchRecord(accessToken: string, objectType: string, recordId: string): Promise<ExternalRecord> {
    const properties = HUBSPOT_PROPERTIES[objectType] || [];
    const params = new URLSearchParams({ properties: properties.join(',') });

    const response = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/${objectType}/${recordId}?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });

    if (!response.ok) throw new Error(`HubSpot fetch error ${response.status}`);

    const record = await response.json() as HubSpotRecord;
    return {
      id: record.id,
      type: objectType === 'companies' ? 'company' : objectType === 'deals' ? 'deal' : 'person',
      data: record.properties as Record<string, unknown>,
      raw: record,
    };
  }

  async fetchNote(): Promise<ExternalNote> {
    throw new Error('HubSpot notes are not synced via webhooks');
  }

  async fetchTask(): Promise<ExternalTask> {
    throw new Error('HubSpot tasks are not synced via webhooks');
  }

  async fetchLists(): Promise<ExternalList[]> {
    return [];
  }

  async fetchListEntry(): Promise<ExternalListEntry> {
    throw new Error('HubSpot list entries are not synced via webhooks');
  }

  mapCompany(record: ExternalRecord): MappedCompany {
    const props = record.data as Record<string, string | null>;
    const name = props.name || 'Unknown Company';
    return {
      data: {
        name,
        displayName: name,
        email: `noemail-${record.id}@placeholder.local`,
        website: props.domain || undefined,
        phone: props.phone || undefined,
        notes: props.description || undefined,
        status: 'active',
        source: 'hubspot',
      },
    };
  }

  mapPerson(record: ExternalRecord): MappedPerson {
    const props = record.data as Record<string, string | null>;
    const firstName = props.firstname || null;
    const lastName = props.lastname || null;
    const fullName = [firstName, lastName].filter(Boolean).join(' ') || null;
    const email = props.email || `noemail-${record.id}@placeholder.local`;
    const displayName = fullName || email || 'Unknown';
    return {
      data: {
        firstName,
        lastName,
        fullName,
        displayName,
        email,
        directPhone: props.phone || undefined,
        title: props.jobtitle || undefined,
        status: 'active',
        source: 'hubspot',
      },
    };
  }
}

/**
 * Extract portalId from a HubSpot webhook payload.
 * Used to look up the connection for this event.
 */
export function extractPortalId(body: string): number | null {
  try {
    const events = JSON.parse(body) as HubSpotWebhookEvent[];
    if (events.length > 0 && events[0].portalId) {
      return events[0].portalId;
    }
  } catch {}
  return null;
}
