/**
 * Telnyx core API client — shared by the telephony routes and the Telnyx
 * webhook receiver. Ported from apps/api-worker/src/routes/settings/telephony.ts
 * (helpers section) as part of the legacy-worker phase-out (W3).
 *
 * `TelnyxEnv` locally extends the app-api `Env` with the Telnyx secrets until
 * they are added to src/types.ts by the integrator — the extension is
 * harmless (identical optional members) once that lands.
 */

import type { Env } from '../types';

export const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

export type TelnyxEnv = Env & {
  /** Telnyx API key (Bearer) — all Telnyx REST calls. */
  TELNYX_API_KEY?: string;
  /** Programmable Voice app ID (call routing, phone numbers). */
  TELNYX_CONNECTION_ID?: string;
  /** Credential connection ID (WebRTC token generation). */
  TELNYX_SIP_CONNECTION_ID?: string;
  /** Legacy secret slot carried over from api-worker (declared, never used there). */
  TELNYX_WEBHOOK_SECRET?: string;
  /**
   * Telnyx account public key (base64 Ed25519) for webhook signature
   * verification. When set, /public/webhooks/telnyx enforces signatures;
   * when unset, the receiver accepts unsigned requests (legacy parity —
   * api-worker performed no verification).
   */
  TELNYX_PUBLIC_KEY?: string;
};

export function isTelnyxConfigured(env: TelnyxEnv): boolean {
  return Boolean(env.TELNYX_API_KEY);
}

export async function telnyxRequest<T>(
  env: TelnyxEnv,
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const apiKey = env.TELNYX_API_KEY;
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
    const err = (await response.json().catch(() => ({}))) as Record<string, any>;
    const errorMsg = err?.errors?.[0]?.detail || err?.errors?.[0]?.title || response.statusText;
    throw new Error(`Telnyx API error: ${response.status} - ${errorMsg}`);
  }

  if (response.status === 204) return {} as T;
  return response.json() as Promise<T>;
}

/** Countries whose numbers require a verified Telnyx address before purchase. */
export const COUNTRIES_REQUIRING_ADDRESS = [
  'NL', 'DE', 'BE', 'AT', 'CH', 'FR', 'ES', 'IT', 'PT', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'HU', 'IE', 'LU',
];

/**
 * Resolve the billing-worker base URL for the current environment. Mirrors
 * the hardcoded selection the legacy api-worker telephony/porting routes used.
 */
export function billingWorkerUrl(env: Env): string {
  return env.ENVIRONMENT === 'production'
    ? 'https://billing.weldsuite.org'
    : env.ENVIRONMENT === 'preview'
      ? 'https://billing-preview.weldsuite.org'
      : 'http://localhost:8788';
}

// ============================================================================
// Webhook signature verification (Ed25519)
// ============================================================================

/** Max allowed clock skew between the Telnyx timestamp header and now. */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Verify a Telnyx webhook signature.
 *
 * Telnyx signs `${telnyx-timestamp}|${rawBody}` with the account's Ed25519
 * private key; the public key is shown in the Telnyx portal. Headers:
 * `telnyx-signature-ed25519` (base64) + `telnyx-timestamp` (unix seconds).
 *
 * Returns true when the signature is valid and the timestamp is within
 * tolerance. Any structural/crypto failure returns false (fail closed —
 * callers only invoke this when a public key is configured).
 */
export async function verifyTelnyxSignature(args: {
  publicKeyB64: string;
  rawBody: string;
  signatureB64: string | null;
  timestamp: string | null;
}): Promise<boolean> {
  const { publicKeyB64, rawBody, signatureB64, timestamp } = args;
  if (!signatureB64 || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > SIGNATURE_TOLERANCE_SECONDS) return false;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      base64ToBytes(publicKeyB64),
      // Workers runtime supports the standard 'Ed25519' algorithm name.
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const message = new TextEncoder().encode(`${timestamp}|${rawBody}`);
    return await crypto.subtle.verify('Ed25519', key, base64ToBytes(signatureB64), message);
  } catch (err) {
    console.error('[telnyx] signature verification errored:', err);
    return false;
  }
}
