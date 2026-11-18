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
   * verification. Required: /public/webhooks/telnyx enforces signatures and
   * rejects every request (401) while this is unset (fail closed).
   */
  TELNYX_PUBLIC_KEY?: string;
};

export function isTelnyxConfigured(env: TelnyxEnv): boolean {
  return Boolean(env.TELNYX_API_KEY);
}

/**
 * Resolve `endpoint` against the Telnyx API base and make sure the result
 * still points inside it. `new URL` collapses `..` segments (raw or
 * percent-encoded), so a caller-supplied id like `../../other` cannot climb
 * out of `/v2/` or redirect the request (and its bearer token) to another host.
 */
function resolveTelnyxUrl(endpoint: string): string {
  const raw = endpoint.startsWith('http') ? endpoint : `${TELNYX_API_BASE}${endpoint}`;
  const base = new URL(TELNYX_API_BASE);
  const url = new URL(raw);
  if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/`)) {
    throw new Error('Telnyx API endpoint is outside the API base');
  }
  return url.toString();
}

/** A Telnyx REST answer outside 2xx; `status` is the HTTP status. */
export class TelnyxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TelnyxApiError';
  }
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

  const url = resolveTelnyxUrl(endpoint);
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as Record<string, any>;
    const errorMsg = err?.errors?.[0]?.detail || err?.errors?.[0]?.title || response.statusText;
    throw new TelnyxApiError(`Telnyx API error: ${response.status} - ${errorMsg}`, response.status);
  }

  if (response.status === 204) return {} as T;
  return response.json() as Promise<T>;
}

/** Countries whose numbers require a verified Telnyx address before purchase. */
export const COUNTRIES_REQUIRING_ADDRESS = [
  'NL', 'DE', 'BE', 'AT', 'CH', 'FR', 'ES', 'IT', 'PT', 'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'HU', 'IE', 'LU',
];

/** @deprecated Import from `@weldsuite/worker-kit/billing-worker` — re-exported for existing call sites. */
export { billingWorkerUrl } from '@weldsuite/worker-kit/billing-worker';

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
  return telnyxRequest(env, `/calls/${encodeURIComponent(callControlId)}/actions/${encodeURIComponent(action)}`, {
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
  opts?: {
    channels?: 'single' | 'dual';
    format?: 'mp3' | 'wav';
    /** A beep before recording starts (voicemail). */
    playBeep?: boolean;
    /** Longest recording, seconds. */
    maxLength?: number;
    clientState?: string;
  },
): Promise<unknown> {
  return callControlAction(env, callControlId, 'record_start', {
    channels: opts?.channels ?? 'dual',
    format: opts?.format ?? 'mp3',
    ...(opts?.playBeep ? { play_beep: true } : {}),
    ...(opts?.maxLength ? { max_length: opts.maxLength } : {}),
    ...(opts?.clientState ? { client_state: opts.clientState } : {}),
  });
}

export async function telnyxAiAssistantStart(
  env: TelnyxEnv,
  callControlId: string,
  assistantId: string,
  opts?: {
    clientState?: string;
    sendMessageHistoryUpdates?: boolean;
    instructions?: string;
    greeting?: string | null;
    tools?: unknown[];
    dynamicVariables?: Record<string, string | number | boolean>;
  },
): Promise<unknown> {
  const assistant: Record<string, unknown> = { id: assistantId };
  if (opts?.instructions) assistant.instructions = opts.instructions;
  if (opts?.greeting) assistant.greeting = opts.greeting;
  if (opts?.tools) assistant.tools = opts.tools;
  if (opts?.dynamicVariables) assistant.dynamic_variables = opts.dynamicVariables;

  return callControlAction(env, callControlId, 'ai_assistant_start', {
    assistant,
    ...(opts?.sendMessageHistoryUpdates ? { send_message_history_updates: true } : {}),
    ...(opts?.clientState ? { client_state: opts.clientState } : {}),
  });
}

export async function telnyxAiAssistantStop(
  env: TelnyxEnv,
  callControlId: string,
): Promise<unknown> {
  return callControlAction(env, callControlId, 'ai_assistant_stop', {});
}

/** The three ids Telnyx answers a dial with. */
export interface TelnyxDialed {
  callControlId: string | null;
  callLegId: string | null;
  callSessionId: string | null;
}

/**
 * `POST /v2/calls`: dial `to` (E.164 or `sip:<username>@sip.telnyx.com`) on a
 * Call Control connection. `clientState` rides on every webhook of the new leg.
 */
export async function telnyxDial(
  env: TelnyxEnv,
  args: {
    connectionId: string;
    to: string;
    from: string;
    timeoutSecs?: number;
    clientState?: string;
  },
): Promise<TelnyxDialed> {
  const resp = await telnyxRequest<{
    data?: { call_control_id?: string; call_leg_id?: string; call_session_id?: string };
  }>(env, '/calls', {
    method: 'POST',
    body: JSON.stringify({
      connection_id: args.connectionId,
      to: args.to,
      from: args.from,
      ...(args.timeoutSecs ? { timeout_secs: args.timeoutSecs } : {}),
      ...(args.clientState ? { client_state: args.clientState } : {}),
    }),
  });
  return {
    callControlId: resp.data?.call_control_id ?? null,
    callLegId: resp.data?.call_leg_id ?? null,
    callSessionId: resp.data?.call_session_id ?? null,
  };
}

/** Bridge this call to another call (`otherCallControlId`). Takes a queued call out of its queue. */
export async function telnyxBridge(
  env: TelnyxEnv,
  callControlId: string,
  otherCallControlId: string,
): Promise<unknown> {
  return callControlAction(env, callControlId, 'bridge', { call_control_id: otherCallControlId });
}

export interface TelnyxSpeakOptions {
  voice?: string;
  language?: string;
  clientState?: string;
}

export async function telnyxSpeak(
  env: TelnyxEnv,
  callControlId: string,
  payload: string,
  opts?: TelnyxSpeakOptions,
): Promise<unknown> {
  return callControlAction(env, callControlId, 'speak', {
    payload,
    voice: opts?.voice ?? 'female',
    ...(opts?.language ? { language: opts.language } : {}),
    ...(opts?.clientState ? { client_state: opts.clientState } : {}),
  });
}

/** Speak a prompt and collect keypad digits; the result arrives as `call.gather.ended`. */
export async function telnyxGatherUsingSpeak(
  env: TelnyxEnv,
  callControlId: string,
  args: {
    payload: string;
    voice?: string;
    language?: string;
    minimumDigits: number;
    maximumDigits: number;
    maximumTries: number;
    timeoutMillis: number;
    validDigits: string;
    invalidPayload?: string;
    clientState?: string;
  },
): Promise<unknown> {
  return callControlAction(env, callControlId, 'gather_using_speak', {
    payload: args.payload,
    voice: args.voice ?? 'female',
    ...(args.language ? { language: args.language } : {}),
    minimum_digits: args.minimumDigits,
    maximum_digits: args.maximumDigits,
    maximum_tries: args.maximumTries,
    timeout_millis: args.timeoutMillis,
    valid_digits: args.validDigits,
    ...(args.invalidPayload ? { invalid_payload: args.invalidPayload } : {}),
    ...(args.clientState ? { client_state: args.clientState } : {}),
  });
}

export async function telnyxPlaybackStart(
  env: TelnyxEnv,
  callControlId: string,
  args: { audioUrl: string; loop?: boolean; clientState?: string },
): Promise<unknown> {
  return callControlAction(env, callControlId, 'playback_start', {
    audio_url: args.audioUrl,
    ...(args.loop ? { loop: 'infinity' } : {}),
    ...(args.clientState ? { client_state: args.clientState } : {}),
  });
}

export async function telnyxPlaybackStop(env: TelnyxEnv, callControlId: string): Promise<unknown> {
  return callControlAction(env, callControlId, 'playback_stop', {});
}

/**
 * Park the call in a Telnyx queue. `maxWaitTimeSecs` is the caller's wait
 * limit: the queue answers `call.dequeued` (reason `timeout`) when it runs out.
 */
export async function telnyxEnqueue(
  env: TelnyxEnv,
  callControlId: string,
  args: { queueName: string; maxWaitTimeSecs?: number; clientState?: string },
): Promise<unknown> {
  return callControlAction(env, callControlId, 'enqueue', {
    queue_name: args.queueName,
    ...(args.maxWaitTimeSecs ? { max_wait_time_secs: args.maxWaitTimeSecs } : {}),
    ...(args.clientState ? { client_state: args.clientState } : {}),
  });
}

// ============================================================================
// Telephony credentials (one per member softphone)
// ============================================================================

/** `POST /v2/telephony_credentials`: a SIP credential on the WebRTC connection. */
export async function telnyxCreateCredential(
  env: TelnyxEnv,
  args: { connectionId: string; name: string },
): Promise<{ id: string; sipUsername: string }> {
  const resp = await telnyxRequest<{ data?: { id?: string; sip_username?: string } }>(env, '/telephony_credentials', {
    method: 'POST',
    body: JSON.stringify({ connection_id: args.connectionId, name: args.name }),
  });
  const id = resp.data?.id;
  const sipUsername = resp.data?.sip_username;
  if (!id || !sipUsername) throw new Error('Telnyx credential answer has no id or sip_username');
  return { id, sipUsername };
}

/** `POST /v2/telephony_credentials/{id}/token`: a short-lived WebRTC login JWT (the answer is plain text). */
export async function telnyxCredentialToken(env: TelnyxEnv, credentialId: string): Promise<string> {
  const apiKey = env.TELNYX_API_KEY;
  if (!apiKey) throw new Error('Telnyx API key is not configured');
  const response = await fetch(resolveTelnyxUrl(`/telephony_credentials/${encodeURIComponent(credentialId)}/token`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new TelnyxApiError(`Telnyx API error: ${response.status} - ${response.statusText}`, response.status);
  }
  return response.text();
}

/** `DELETE /v2/telephony_credentials/{id}` (best-effort cleanup of an unused credential). */
export async function telnyxDeleteCredential(env: TelnyxEnv, credentialId: string): Promise<void> {
  await telnyxRequest(env, `/telephony_credentials/${encodeURIComponent(credentialId)}`, { method: 'DELETE' });
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
  /** Extra Telnyx tools (webhook CRM lookup, …) merged with hangup/transfer. */
  extraTools?: unknown[];
}

function buildAssistantTools(
  transferToE164?: string | null,
  extraTools: unknown[] = [],
): unknown[] {
  const tools: unknown[] = [{ type: 'hangup' }, ...extraTools];
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
    tools: buildAssistantTools(input.transferToE164, input.extraTools),
    telephony_settings: { send_message_history_updates: true },
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
    `/ai/assistants/${encodeURIComponent(assistantId)}`,
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
  await telnyxRequest(env, `/ai/assistants/${encodeURIComponent(assistantId)}`, { method: 'DELETE' });
}

// ============================================================================
// Webhook signature verification (Ed25519)
// ============================================================================

/** Max allowed clock skew between the Telnyx timestamp header and now. */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.codePointAt(i)!;
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
