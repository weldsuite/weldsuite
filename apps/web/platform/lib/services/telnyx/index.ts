/**
 * Telnyx Service Client
 *
 * Provides integration with Telnyx for VoIP calling (Call Control API),
 * WebRTC token generation, and phone number management.
 */

// ============================================================================
// Configuration Check
// ============================================================================

export function isTelnyxConfigured(): boolean {
  return Boolean(process.env.TELNYX_API_KEY);
}

function getTelnyxConfigStatus(): {
  configured: boolean;
  hasApiKey: boolean;
  hasConnectionId: boolean;
  hasSipAppId: boolean;
} {
  return {
    configured: isTelnyxConfigured(),
    hasApiKey: Boolean(process.env.TELNYX_API_KEY),
    hasConnectionId: Boolean(process.env.TELNYX_CONNECTION_ID),
    hasSipAppId: Boolean(process.env.TELNYX_SIP_APP_ID),
  };
}

// ============================================================================
// Telnyx API Client
// ============================================================================

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

async function telnyxRequest<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error('Telnyx API key is not configured');
  }

  const url = endpoint.startsWith('http') ? endpoint : `${TELNYX_API_BASE}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as Record<string, any>;
    const errorMsg = error?.errors?.[0]?.detail || error?.errors?.[0]?.title || response.statusText;
    throw new Error(`Telnyx API error: ${response.status} - ${errorMsg}`);
  }

  // 204 No Content
  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

// ============================================================================
// WebRTC Token Generation
// ============================================================================

/**
 * Generate a WebRTC credential token for browser-based calling.
 * Creates a short-lived credential via the Telnyx Telephony Credentials API.
 */
async function generateWebRtcToken(
  userId: string,
  workspaceId: string,
): Promise<string | null> {
  if (!isTelnyxConfigured()) {
    console.warn('[Telnyx] Not configured, cannot generate WebRTC token');
    return null;
  }

  const connectionId = process.env.TELNYX_CONNECTION_ID;
  if (!connectionId) {
    console.warn('[Telnyx] TELNYX_CONNECTION_ID is not set');
    return null;
  }

  try {
    const resp = await telnyxRequest<{
      data: { id: string; token: string; sip_username: string };
    }>('/telephony_credentials', {
      method: 'POST',
      body: JSON.stringify({
        connection_id: connectionId,
        name: `${workspaceId}-${userId}`,
        tag: `ws:${workspaceId}`,
      }),
    });

    // Create a short-lived JWT token for this credential
    const tokenResp = await telnyxRequest<{
      data: string; // The JWT token string
    }>(`/telephony_credentials/${resp.data.id}/token`, {
      method: 'POST',
    });

    return tokenResp.data;
  } catch (error) {
    console.error('[Telnyx] Failed to generate WebRTC token:', error);
    return null;
  }
}

// ============================================================================
// Call Control
// ============================================================================

interface TelnyxCallResponse {
  data: {
    call_control_id: string;
    call_session_id: string;
    call_leg_id: string;
    is_alive: boolean;
    record_type: string;
  };
}

interface DialCallOptions {
  connectionId: string;
  from: string;
  to: string;
  webhookUrl?: string;
  clientState?: string;
  enableRecording?: boolean;
  timeout?: number;
}

/**
 * Initiate an outbound call via Telnyx Call Control API
 */
async function dialCall(options: DialCallOptions): Promise<{
  callControlId: string;
  callSessionId: string;
  callLegId: string;
} | null> {
  if (!isTelnyxConfigured()) {
    console.warn('[Telnyx] Not configured, cannot dial call');
    return null;
  }

  try {
    const body: Record<string, any> = {
      connection_id: options.connectionId,
      from: options.from,
      to: options.to,
      timeout_secs: options.timeout || 30,
    };

    if (options.webhookUrl) {
      body.webhook_url = options.webhookUrl;
    }

    if (options.clientState) {
      body.client_state = btoa(options.clientState);
    }

    if (options.enableRecording) {
      body.record = 'record-from-answer';
      body.record_channels = 'dual';
      body.record_format = 'mp3';
    }

    const response = await telnyxRequest<TelnyxCallResponse>('/calls', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return {
      callControlId: response.data.call_control_id,
      callSessionId: response.data.call_session_id,
      callLegId: response.data.call_leg_id,
    };
  } catch (error) {
    console.error('[Telnyx] Failed to dial call:', error);
    throw error;
  }
}

/**
 * Answer an incoming call
 */
async function answerCall(callControlId: string): Promise<boolean> {
  try {
    await telnyxRequest(`/calls/${callControlId}/actions/answer`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return true;
  } catch (error) {
    console.error('[Telnyx] Failed to answer call:', error);
    return false;
  }
}

/**
 * Hang up a call
 */
async function hangupCall(callControlId: string): Promise<boolean> {
  try {
    await telnyxRequest(`/calls/${callControlId}/actions/hangup`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return true;
  } catch (error) {
    console.error('[Telnyx] Failed to hangup call:', error);
    return false;
  }
}

/**
 * Put call on hold
 */
async function holdCall(callControlId: string, audioUrl?: string): Promise<boolean> {
  try {
    const body: Record<string, any> = {};
    if (audioUrl) {
      body.audio_url = audioUrl;
    }
    await telnyxRequest(`/calls/${callControlId}/actions/hold`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return true;
  } catch (error) {
    console.error('[Telnyx] Failed to hold call:', error);
    return false;
  }
}

/**
 * Resume call from hold
 */
async function unholdCall(callControlId: string): Promise<boolean> {
  try {
    await telnyxRequest(`/calls/${callControlId}/actions/unhold`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return true;
  } catch (error) {
    console.error('[Telnyx] Failed to unhold call:', error);
    return false;
  }
}

/**
 * Start recording a call
 */
async function startRecording(
  callControlId: string,
  options?: { channels?: 'single' | 'dual'; format?: 'mp3' | 'wav' },
): Promise<boolean> {
  try {
    await telnyxRequest(`/calls/${callControlId}/actions/record_start`, {
      method: 'POST',
      body: JSON.stringify({
        channels: options?.channels || 'dual',
        format: options?.format || 'mp3',
      }),
    });
    return true;
  } catch (error) {
    console.error('[Telnyx] Failed to start recording:', error);
    return false;
  }
}

/**
 * Stop recording a call
 */
async function stopRecording(callControlId: string): Promise<boolean> {
  try {
    await telnyxRequest(`/calls/${callControlId}/actions/record_stop`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return true;
  } catch (error) {
    console.error('[Telnyx] Failed to stop recording:', error);
    return false;
  }
}

/**
 * Send DTMF tones
 */
async function sendDtmf(callControlId: string, digits: string): Promise<boolean> {
  try {
    await telnyxRequest(`/calls/${callControlId}/actions/send_dtmf`, {
      method: 'POST',
      body: JSON.stringify({ digits }),
    });
    return true;
  } catch (error) {
    console.error('[Telnyx] Failed to send DTMF:', error);
    return false;
  }
}

// ============================================================================
// Phone Number Management
// ============================================================================

interface TelnyxPhoneNumber {
  id: string;
  record_type: string;
  phone_number: string;
  status: string;
  connection_id: string | null;
  connection_name: string | null;
  billing_group_id: string | null;
  tags: string[];
  purchased_at: string;
  created_at: string;
  updated_at: string;
}

interface TelnyxPhoneNumbersResponse {
  data: TelnyxPhoneNumber[];
  meta: { total_pages: number; total_results: number; page_number: number; page_size: number };
}

/**
 * List phone numbers from Telnyx account
 */
async function listPhoneNumbers(connectionId?: string): Promise<TelnyxPhoneNumber[]> {
  if (!isTelnyxConfigured()) return [];

  try {
    const params = new URLSearchParams();
    params.set('page[size]', '250');
    if (connectionId) {
      params.set('filter[connection_id]', connectionId);
    }
    params.set('filter[status]', 'active');

    const response = await telnyxRequest<TelnyxPhoneNumbersResponse>(
      `/phone_numbers?${params.toString()}`,
    );
    return response.data || [];
  } catch (error) {
    console.error('[Telnyx] Failed to list phone numbers:', error);
    return [];
  }
}

/**
 * Get a specific phone number
 */
async function getPhoneNumber(phoneNumberId: string): Promise<TelnyxPhoneNumber | null> {
  if (!isTelnyxConfigured()) return null;

  try {
    const response = await telnyxRequest<{ data: TelnyxPhoneNumber }>(
      `/phone_numbers/${phoneNumberId}`,
    );
    return response.data;
  } catch (error) {
    console.error('[Telnyx] Failed to get phone number:', error);
    return null;
  }
}

// ============================================================================
// Available Phone Numbers (Search & Order)
// ============================================================================

interface TelnyxAvailableNumber {
  phone_number: string;
  vanity_format: string | null;
  region_information: Array<{ region_name: string; region_type: string }>;
  cost_information: { currency: string; monthly_cost: string; upfront_cost: string };
  features: Array<{ name: string }>;
  record_type: string;
  phone_number_type: string;
}

interface TelnyxAvailableNumbersResponse {
  data: TelnyxAvailableNumber[];
  meta: { total_results: number; best_effort_results: number };
}

interface SearchPhoneNumbersOptions {
  country: string;
  areaCode?: string;
  contains?: string;
  type?: 'local' | 'toll-free' | 'mobile';
  limit?: number;
}

/**
 * Search for available phone numbers to purchase
 */
async function searchAvailablePhoneNumbers(
  options: SearchPhoneNumbersOptions,
): Promise<TelnyxAvailableNumber[]> {
  if (!isTelnyxConfigured()) return [];

  const { country, areaCode, contains, type = 'local', limit = 20 } = options;

  try {
    const params = new URLSearchParams();
    params.set('filter[country_code]', country);
    params.set('filter[limit]', String(limit));

    // Map type to Telnyx phone_number_type
    if (type === 'toll-free') {
      params.set('filter[phone_number_type]', 'toll_free');
    } else if (type === 'mobile') {
      params.set('filter[phone_number_type]', 'mobile');
    } else {
      params.set('filter[phone_number_type]', 'local');
    }

    if (areaCode) {
      params.set('filter[national_destination_code]', areaCode);
    }
    if (contains) {
      params.set('filter[phone_number][contains]', contains);
    }

    params.set('filter[features][]', 'voice');

    const response = await telnyxRequest<TelnyxAvailableNumbersResponse>(
      `/available_phone_numbers?${params.toString()}`,
    );

    return response.data || [];
  } catch (error) {
    console.error('[Telnyx] Failed to search phone numbers:', error);
    return [];
  }
}

export interface OrderPhoneNumberOptions {
  phoneNumber: string;
  connectionId?: string;
}

interface TelnyxNumberOrderResponse {
  data: {
    id: string;
    status: string;
    phone_numbers: Array<{
      id: string;
      phone_number: string;
      status: string;
      regulatory_requirements: any[];
    }>;
    created_at: string;
  };
}

/**
 * Order (purchase) a phone number from Telnyx
 */
export async function orderPhoneNumber(
  options: OrderPhoneNumberOptions,
): Promise<TelnyxNumberOrderResponse['data'] | null> {
  if (!isTelnyxConfigured()) {
    console.warn('[Telnyx] Not configured, cannot order phone number');
    return null;
  }

  try {
    const connectionId = options.connectionId || process.env.TELNYX_CONNECTION_ID;

    const response = await telnyxRequest<TelnyxNumberOrderResponse>('/number_orders', {
      method: 'POST',
      body: JSON.stringify({
        phone_numbers: [{ phone_number: options.phoneNumber }],
        connection_id: connectionId || undefined,
      }),
    });

    return response.data;
  } catch (error) {
    console.error('[Telnyx] Failed to order phone number:', error);
    throw error;
  }
}

/**
 * Release (delete) a phone number
 */
async function releasePhoneNumber(phoneNumberId: string): Promise<boolean> {
  if (!isTelnyxConfigured()) return false;

  try {
    await telnyxRequest(`/phone_numbers/${phoneNumberId}`, { method: 'DELETE' });
    return true;
  } catch (error) {
    console.error('[Telnyx] Failed to release phone number:', error);
    return false;
  }
}

/**
 * Update a phone number's configuration
 */
async function updatePhoneNumber(
  phoneNumberId: string,
  options: {
    connectionId?: string;
    tags?: string[];
  },
): Promise<TelnyxPhoneNumber | null> {
  if (!isTelnyxConfigured()) return null;

  try {
    const body: Record<string, any> = {};
    if (options.connectionId) body.connection_id = options.connectionId;
    if (options.tags) body.tags = options.tags;

    const response = await telnyxRequest<{ data: TelnyxPhoneNumber }>(
      `/phone_numbers/${phoneNumberId}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    );
    return response.data;
  } catch (error) {
    console.error('[Telnyx] Failed to update phone number:', error);
    return null;
  }
}

// ============================================================================
// Address Management (for regulatory compliance)
// ============================================================================

interface TelnyxAddress {
  id: string;
  first_name: string;
  last_name: string;
  business_name: string;
  street_address: string;
  extended_address?: string;
  locality: string;
  administrative_area: string;
  postal_code: string;
  country_code: string;
  address_book: boolean;
  validated: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * List all addresses
 */
async function listAddresses(): Promise<TelnyxAddress[]> {
  if (!isTelnyxConfigured()) return [];

  try {
    const response = await telnyxRequest<{ data: TelnyxAddress[] }>('/addresses');
    return response.data || [];
  } catch (error) {
    console.error('[Telnyx] Failed to list addresses:', error);
    return [];
  }
}

interface CreateAddressOptions {
  businessName: string;
  firstName: string;
  lastName: string;
  streetAddress: string;
  extendedAddress?: string;
  locality: string;
  administrativeArea: string;
  postalCode: string;
  countryCode: string;
}

/**
 * Create a new address for regulatory compliance
 */
async function createAddress(options: CreateAddressOptions): Promise<TelnyxAddress | null> {
  if (!isTelnyxConfigured()) return null;

  try {
    const response = await telnyxRequest<{ data: TelnyxAddress }>('/addresses', {
      method: 'POST',
      body: JSON.stringify({
        business_name: options.businessName,
        first_name: options.firstName,
        last_name: options.lastName,
        street_address: options.streetAddress,
        extended_address: options.extendedAddress,
        locality: options.locality,
        administrative_area: options.administrativeArea,
        postal_code: options.postalCode,
        country_code: options.countryCode,
        address_book: true,
      }),
    });
    return response.data;
  } catch (error) {
    console.error('[Telnyx] Failed to create address:', error);
    throw error;
  }
}

/**
 * Delete an address
 */
async function deleteAddress(addressId: string): Promise<boolean> {
  if (!isTelnyxConfigured()) return false;

  try {
    await telnyxRequest(`/addresses/${addressId}`, { method: 'DELETE' });
    return true;
  } catch (error) {
    console.error('[Telnyx] Failed to delete address:', error);
    return false;
  }
}

/**
 * Get regulatory requirements for a country
 */
async function listRequirements(
  countryCode: string,
  phoneNumberType?: string,
): Promise<any[]> {
  if (!isTelnyxConfigured()) return [];

  try {
    const params = new URLSearchParams();
    params.set('filter[country_code]', countryCode);
    if (phoneNumberType) {
      params.set('filter[phone_number_type]', phoneNumberType);
    }

    const response = await telnyxRequest<{ data: any[] }>(
      `/phone_number_regulatory_requirements?${params.toString()}`,
    );
    return response.data || [];
  } catch (error) {
    console.error('[Telnyx] Failed to list requirements:', error);
    return [];
  }
}

/**
 * Countries that typically require address/regulatory documents for phone numbers
 */
const COUNTRIES_REQUIRING_ADDRESS = [
  'NL', 'DE', 'BE', 'AT', 'CH', 'FR', 'ES', 'IT', 'PT',
  'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'HU', 'IE', 'LU',
] as const;

/**
 * Check if a country requires address for phone number purchase
 */
function requiresAddress(isoCountry: string): boolean {
  return COUNTRIES_REQUIRING_ADDRESS.includes(isoCountry as any);
}
