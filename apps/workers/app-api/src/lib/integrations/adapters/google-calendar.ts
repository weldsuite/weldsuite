/**
 * Google Calendar Sync Adapter
 *
 * Implements CrmSyncAdapter for Google Calendar with bidirectional sync.
 * Handles OAuth, event fetching/pushing, and Google Watch API webhooks.
 * Uses hardcoded transforms (no configurable field mappings).
 *
 * Ported verbatim from api-worker (`src/lib/integrations/adapters/google-calendar.ts`)
 * as part of W5b. Only the `OAuthTokens` import is adapted (api-worker's local
 * `../types` duplicate → the canonical `@weldsuite/db/schema` export); every
 * transform, URL, scope and status-code branch is unchanged.
 *
 * app-api currently drives only the outbound push path (see
 * `../sync/outbound-calendar-sync.ts`). The inbound fetch/webhook methods are
 * carried over intact so the class still satisfies `CrmSyncAdapter` and so the
 * inbound orchestrator can be ported later without re-deriving this file.
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
import type { OAuthTokens } from '@weldsuite/db/schema';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// ============================================================================
// Google Calendar event types
// ============================================================================

interface GoogleDatetime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface GoogleAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
}

interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  start?: GoogleDatetime;
  end?: GoogleDatetime;
  location?: string;
  attendees?: GoogleAttendee[];
  status?: string;
  htmlLink?: string;
  hangoutLink?: string;
  recurringEventId?: string;
  recurrence?: string[];
  updated?: string;
}

// ============================================================================
// Hardcoded transforms — Google ↔ Internal
// ============================================================================

/**
 * Transform a Google Calendar event into internal calendarEvents fields.
 * Returns data keyed by internal column names.
 */
function mapFromGoogle(event: GoogleEvent): Record<string, unknown> {
  const start = event.start;
  const end = event.end;
  const allDay = !!(start?.date && !start?.dateTime);

  const result: Record<string, unknown> = {
    title: event.summary || '(No title)',
    description: event.description || null,
    location: event.location || null,
    status: event.status || 'confirmed',
    meetingUrl: event.hangoutLink || null,
  };

  // Start time
  if (allDay && start?.date) {
    result.startTime = new Date(start.date);
    result.allDay = true;
  } else if (start?.dateTime) {
    result.startTime = new Date(start.dateTime);
    result.allDay = false;
  }

  // End time
  if (allDay && end?.date) {
    result.endTime = new Date(end.date);
  } else if (end?.dateTime) {
    result.endTime = new Date(end.dateTime);
  }

  // Timezone
  if (start?.timeZone) {
    result.timezone = start.timeZone;
  }

  // Attendees — reshape to internal JSONB format
  if (event.attendees) {
    result.attendees = event.attendees.map((a) => ({
      email: a.email,
      name: a.displayName || undefined,
      status: a.responseStatus || undefined,
      role: a.organizer ? 'organizer' : undefined,
    }));
  }

  // Recurrence
  if (event.recurrence && event.recurrence.length > 0) {
    result.recurrenceRule = event.recurrence[0]; // RRULE string
  }
  if (event.recurringEventId) {
    result.recurrenceId = event.recurringEventId;
  }

  return result;
}

/**
 * Transform internal calendarEvents fields into Google Calendar API format.
 */
function mapToGoogle(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (data.title != null) result.summary = data.title;
  if (data.description != null) result.description = data.description;
  if (data.location != null) result.location = data.location;
  if (data.status != null) result.status = data.status;

  // Start time
  if (data.startTime) {
    const allDay = data.allDay === true;
    if (allDay) {
      const d = new Date(data.startTime as string);
      result.start = { date: d.toISOString().split('T')[0] };
    } else {
      const startObj: GoogleDatetime = { dateTime: new Date(data.startTime as string).toISOString() };
      if (data.timezone) startObj.timeZone = data.timezone as string;
      result.start = startObj;
    }
  }

  // End time
  if (data.endTime) {
    const allDay = data.allDay === true;
    if (allDay) {
      const d = new Date(data.endTime as string);
      result.end = { date: d.toISOString().split('T')[0] };
    } else {
      const endObj: GoogleDatetime = { dateTime: new Date(data.endTime as string).toISOString() };
      if (data.timezone) endObj.timeZone = data.timezone as string;
      result.end = endObj;
    }
  }

  // Attendees — reshape to Google format
  if (Array.isArray(data.attendees)) {
    result.attendees = (data.attendees as Array<{ email: string; name?: string; status?: string; role?: string }>).map((a) => ({
      email: a.email,
      displayName: a.name,
      responseStatus: a.status || 'needsAction',
    }));
  }

  // Recurrence
  if (data.recurrenceRule) {
    result.recurrence = [data.recurrenceRule as string];
  }

  return result;
}

// ============================================================================
// Adapter
// ============================================================================

export class GoogleCalendarSyncAdapter implements CrmSyncAdapter {
  readonly provider = 'google_calendar';
  readonly supportedEntities: SyncEntityType[] = ['calendar_event'];

  // ---------- Field Mappings (empty — uses hardcoded transforms) ----------

  getDefaultFieldMappings(_entityType: SyncEntityType): FieldMappingDefinition[] {
    return [];
  }

  // ---------- Data Fetching ----------

  async fetchEntities(
    accessToken: string,
    _entityType: SyncEntityType,
    cursor?: string,
    updatedSince?: Date,
  ): Promise<FetchPageResult> {
    const params = new URLSearchParams({
      maxResults: '250',
      singleEvents: 'true',
      orderBy: 'updated',
    });

    if (cursor) {
      params.set('pageToken', cursor);
    }

    if (updatedSince) {
      params.set('updatedMin', updatedSince.toISOString());
    } else {
      // Default: fetch events from 30 days ago
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      params.set('timeMin', thirtyDaysAgo.toISOString());
    }

    const response = await fetch(
      `${CALENDAR_API_BASE}/calendars/primary/events?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!response.ok) {
      throw new Error(`Google Calendar API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      items?: GoogleEvent[];
      nextPageToken?: string;
    };

    const entities: ExternalEntity[] = (data.items || []).map((event) => ({
      id: event.id,
      type: 'calendar_event' as SyncEntityType,
      data: mapFromGoogle(event),
      updatedAt: event.updated || new Date().toISOString(),
      raw: event,
    }));

    return {
      entities,
      nextCursor: data.nextPageToken,
      hasMore: !!data.nextPageToken,
    };
  }

  async fetchEntity(
    accessToken: string,
    _entityType: SyncEntityType,
    externalId: string,
  ): Promise<ExternalEntity> {
    const response = await fetch(
      `${CALENDAR_API_BASE}/calendars/primary/events/${externalId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!response.ok) {
      throw new Error(`Google Calendar API error: ${response.status} ${response.statusText}`);
    }

    const event = await response.json() as GoogleEvent;

    return {
      id: event.id,
      type: 'calendar_event',
      data: mapFromGoogle(event),
      updatedAt: event.updated || new Date().toISOString(),
      raw: event,
    };
  }

  // ---------- Data Pushing (Outbound) ----------

  async pushEntity(
    accessToken: string,
    _entityType: SyncEntityType,
    data: Record<string, unknown>,
    externalId?: string,
  ): Promise<PushResult> {
    const googleEvent = mapToGoogle(data);

    const url = externalId
      ? `${CALENDAR_API_BASE}/calendars/primary/events/${externalId}`
      : `${CALENDAR_API_BASE}/calendars/primary/events`;

    const method = externalId ? 'PATCH' : 'POST';

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(googleEvent),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { externalId: externalId || '', success: false, error: `${response.status}: ${errText}` };
    }

    const result = await response.json() as { id: string };
    return { externalId: result.id, success: true };
  }

  async deleteEntity(
    accessToken: string,
    _entityType: SyncEntityType,
    externalId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const response = await fetch(
      `${CALENDAR_API_BASE}/calendars/primary/events/${externalId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    // 404/410 = already deleted on Google side
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      return { success: false, error: `${response.status} ${response.statusText}` };
    }
    return { success: true };
  }

  // ---------- OAuth ----------

  getAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
      scope: SCOPES,
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
      const errText = await response.text();
      throw new Error(`Google token exchange failed: ${response.status} ${errText}`);
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
      const errText = await response.text();
      throw new Error(`Google token refresh failed: ${response.status} ${errText}`);
    }

    const data = await response.json() as {
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

  // ---------- Webhooks (Google Watch API) ----------

  async verifyWebhookSignature(
    _body: string,
    headers: Record<string, string>,
    secret: string,
  ): Promise<boolean> {
    try {
      const parsed = JSON.parse(secret) as { token: string };
      return headers['x-goog-channel-token'] === parsed.token;
    } catch {
      return false;
    }
  }

  parseWebhookPayload(_body: string): ParsedWebhookPayload {
    // Google push notifications carry no event data in the body.
    // The webhook handler checks X-Goog-Resource-State from headers and
    // triggers an incremental sync — no per-entity events to parse.
    return { webhookId: '', events: [] };
  }

  async registerWebhooks(
    accessToken: string,
    targetUrl: string,
    _entityTypes: SyncEntityType[],
  ): Promise<WebhookRegistration> {
    const channelId = crypto.randomUUID();
    const token = crypto.randomUUID();

    const response = await fetch(
      `${CALENDAR_API_BASE}/calendars/primary/events/watch`,
      {
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
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Google watch registration failed: ${response.status} ${errText}`);
    }

    const data = await response.json() as {
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

  async deleteWebhooks(
    accessToken: string,
    webhookId: string,
    webhookSecret?: string,
  ): Promise<void> {
    let resourceId = webhookId;
    if (webhookSecret) {
      try {
        const parsed = JSON.parse(webhookSecret) as { resourceId: string };
        resourceId = parsed.resourceId;
      } catch {
        // Fall through with webhookId
      }
    }

    const response = await fetch(
      `${CALENDAR_API_BASE}/channels/stop`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: webhookId,
          resourceId,
        }),
      },
    );

    // 404 = channel already expired
    if (!response.ok && response.status !== 404) {
      console.error(`[GoogleCalendar] Failed to stop watch channel: ${response.status}`);
    }
  }
}
