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

/** @deprecated Import from `./billing-worker` — re-exported for existing call sites. */
export { billingWorkerUrl } from './billing-worker';

// ============================================================================
// Call Control helpers
// ============================================================================

export function encodeClientState(state: Record<string, string>): string {
  return btoa(JSON.stringify(state));
}

async function callControlAction(
  env: TelnyxEnv,
  callControlId: string,
  action: string,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  return telnyxRequest(env, `/calls/${callControlId}/actions/${action}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function telnyxAnswer(
  env: TelnyxEnv,
  callControlId: string,
  opts?: { clientState?: string },
): Promise<unknown> {
  return callControlAction(env, callControlId, 'answer', {
    ...(opts?.clientState ? { client_state: opts.clientState } : {}),
  });
}

export async function telnyxHangup(
  env: TelnyxEnv,
  callControlId: string,
  opts?: { clientState?: string },
): Promise<unknown> {
  return callControlAction(env, callControlId, 'hangup', {
    ...(opts?.clientState ? { client_state: opts.clientState } : {}),
  });
}

export async function telnyxTransfer(
  env: TelnyxEnv,
  callControlId: string,
  to: string,
  opts?: { clientState?: string; from?: string },
): Promise<unknown> {
  return callControlAction(env, callControlId, 'transfer', {
    to,
    ...(opts?.from ? { from: opts.from } : {}),
    ...(opts?.clientState ? { client_state: opts.clientState } : {}),
  });
}

export async function telnyxRecordStart(
  env: TelnyxEnv,
  callControlId: string,
  opts?: { channels?: 'single' | 'dual'; format?: 'mp3' | 'wav' },
): Promise<unknown> {
  return callControlAction(env, callControlId, 'record_start', {
    channels: opts?.channels ?? 'dual',
    format: opts?.format ?? 'mp3',
  });
}

export async function telnyxAiAssistantStart(
  env: TelnyxEnv,
  callControlId: string,
  assistantId: string,
  opts?: { clientState?: string },
): Promise<unknown> {
  return callControlAction(env, callControlId, 'ai_assistant_start', {
    assistant: { id: assistantId },
    ...(opts?.clientState ? { client_state: opts.clientState } : {}),
  });
}

export async function telnyxAiAssistantStop(
  env: TelnyxEnv,
  callControlId: string,
): Promise<unknown> {
  return callControlAction(env, callControlId, 'ai_assistant_stop', {});
}

// ============================================================================
// AI Assistants CRUD
// ============================================================================

export interface TelnyxAssistantInput {
  name: string;
  instructions: string;
  greeting?: string | null;
  model?: string | null;
  voice?: string | null;
  /** E.164 cold-transfer target exposed as the Transfer tool. */
  transferToE164?: string | null;
}

function buildAssistantTools(transferToE164?: string | null): unknown[] {
  const tools: unknown[] = [{ type: 'hangup' }];
  if (transferToE164) {
    tools.push({
      type: 'transfer',
      transfer: {
        from: null,
        targets: [{ name: 'Human', to: transferToE164 }],
      },
    });
  }
  return tools;
}

function assistantPayload(input: TelnyxAssistantInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: input.name,
    instructions: input.instructions,
    model: input.model || 'meta-llama/Meta-Llama-3.1-70B-Instruct',
    enabled_features: ['telephony'],
    tools: buildAssistantTools(input.transferToE164),
  };
  if (input.greeting) {
    payload.greeting = input.greeting;
  }
  if (input.voice) {
    payload.voice_settings = { voice: input.voice };
  }
  return payload;
}

export async function telnyxCreateAssistant(
  env: TelnyxEnv,
  input: TelnyxAssistantInput,
): Promise<{ id: string }> {
  const resp = await telnyxRequest<{ data: { id: string } }>(env, '/ai/assistants', {
    method: 'POST',
    body: JSON.stringify(assistantPayload(input)),
  });
  return { id: resp.data.id };
}

export async function telnyxUpdateAssistant(
  env: TelnyxEnv,
  assistantId: string,
  input: TelnyxAssistantInput,
): Promise<{ id: string }> {
  const resp = await telnyxRequest<{ data: { id: string } }>(
    env,
    `/ai/assistants/${assistantId}`,
    {
      method: 'POST',
      body: JSON.stringify(assistantPayload(input)),
    },
  );
  return { id: resp.data?.id ?? assistantId };
}

export async function telnyxDeleteAssistant(
  env: TelnyxEnv,
  assistantId: string,
): Promise<void> {
  await telnyxRequest(env, `/ai/assistants/${assistantId}`, { method: 'DELETE' });
}

// ============================================================================
// Webhook signature verification (Ed25519)
// ============================================================================

/** Max allowed clock skew between the Telnyx timestamp header and now. */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
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
