import 'server-only';

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

export function getAdminTelnyxApiKey(): string | null {
  return process.env.TELNYX_API_KEY?.trim() || null;
}

export async function telnyxAdminRequest<T>(
  apiKey: string,
  endpoint: string,
): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : `${TELNYX_API_BASE}${endpoint}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as {
      errors?: Array<{ detail?: string; title?: string }>;
    };
    const message = err.errors?.[0]?.detail || err.errors?.[0]?.title || response.statusText;
    throw new Error(`Telnyx API error: ${response.status} - ${message}`);
  }
  if (response.status === 204) return {} as T;
  return response.json() as Promise<T>;
}
