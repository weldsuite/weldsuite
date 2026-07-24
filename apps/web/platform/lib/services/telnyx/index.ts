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

// ============================================================================
// Telnyx API Client
// ============================================================================

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

interface TelnyxErrorResponse {
  errors?: Array<{ detail?: string; title?: string }>;
}

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
    const error = await response.json().catch(() => ({})) as TelnyxErrorResponse;
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
// Phone Number Management
// ============================================================================

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
      regulatory_requirements: unknown[];
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
