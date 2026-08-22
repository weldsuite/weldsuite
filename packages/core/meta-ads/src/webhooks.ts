import type { MetaWebhookChangeEvent } from './types';

export async function verifyMetaWebhookSignature(
  body: string,
  signatureHeader: string | null | undefined,
  appSecret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expectedHex = signatureHeader.slice('sha256='.length).toLowerCase();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const actualHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return timingSafeEqual(actualHex, expectedHex);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: Record<string, unknown>;
    }>;
  }>;
}

export function parseMetaAdsWebhook(payload: MetaWebhookPayload): MetaWebhookChangeEvent[] {
  const events: MetaWebhookChangeEvent[] = [];
  for (const entry of payload.entry ?? []) {
    const platformAccountId = entry.id ? String(entry.id) : '';
    if (!platformAccountId) continue;
    for (const change of entry.changes ?? []) {
      const field = change.field ?? 'unknown';
      const value = change.value ?? {};
      events.push({
        platformAccountId,
        objectType: mapObjectType(field),
        objectId: extractObjectId(field, value),
        changeType: typeof value.status === 'string' ? value.status : undefined,
        rawValue: value,
      });
    }
  }
  return events;
}

function mapObjectType(field: string): MetaWebhookChangeEvent['objectType'] {
  if (field === 'campaigns' || field === 'campaign') return 'campaign';
  if (field === 'adsets' || field === 'adset') return 'adset';
  if (field === 'ads' || field === 'ad') return 'ad';
  return 'unknown';
}

function extractObjectId(field: string, value: Record<string, unknown>): string | undefined {
  if (typeof value.campaign_id === 'string' || typeof value.campaign_id === 'number') {
    return String(value.campaign_id);
  }
  if (typeof value.adset_id === 'string' || typeof value.adset_id === 'number') {
    return String(value.adset_id);
  }
  if (typeof value.ad_id === 'string' || typeof value.ad_id === 'number') {
    return String(value.ad_id);
  }
  if (typeof value.id === 'string' || typeof value.id === 'number') {
    return String(value.id);
  }
  if (field === 'campaigns' && value.id != null) return String(value.id);
  return undefined;
}
