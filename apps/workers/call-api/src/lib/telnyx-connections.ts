/**
 * Telnyx connections for a customer's own phone system (SIP trunk / PBX), and
 * Verified Numbers for showing one of its numbers as caller id.
 *
 * A trunk is an IP connection (the PBX's public IPs allow-listed) or a
 * credential connection (the PBX signs in). Both are created with
 * `call_parking_enabled`, so a call the PBX sends to Telnyx is parked and
 * driven by Call Control webhooks like any inbound call.
 */

import { originForPathFrom } from '@weldsuite/api-modules';
import { getHelpdeskWorkerUrl, type HelpdeskUrlEnv } from '@weldsuite/desk-domain/helpdesk-integrations';
import { telnyxRequest, type TelnyxEnv } from './telnyx';
import { SIP_TRANSPORT_TO_TELNYX } from './sip-trunk-constants';

const WEBHOOK_PATH = '/public/webhooks/telnyx';

export type SipTransport = keyof typeof SIP_TRANSPORT_TO_TELNYX;

/** The URL Telnyx sends this connection's call events to (call-api's own host). */
export function telnyxWebhookUrl(env: HelpdeskUrlEnv): string {
  return `${originForPathFrom(getHelpdeskWorkerUrl(env), WEBHOOK_PATH)}${WEBHOOK_PATH}`;
}

/** Common to both connection kinds: the webhook and call parking (plus the optional voice profile). */
function connectionBase(env: TelnyxEnv, name: string, active: boolean) {
  return {
    connection_name: name,
    active,
    webhook_event_url: telnyxWebhookUrl(env),
    webhook_api_version: '2',
    outbound: {
      call_parking_enabled: true,
      ...(env.TELNYX_OUTBOUND_VOICE_PROFILE_ID
        ? { outbound_voice_profile_id: env.TELNYX_OUTBOUND_VOICE_PROFILE_ID }
        : {}),
    },
  };
}

interface IdResponse {
  data?: { id?: string };
}

function requireId(res: IdResponse, what: string): string {
  const id = res.data?.id;
  if (!id) throw new Error(`Telnyx did not return an id for the ${what}`);
  return id;
}

const post = (env: TelnyxEnv, path: string, body: unknown) =>
  telnyxRequest<IdResponse>(env, path, { method: 'POST', body: JSON.stringify(body) });
const patch = (env: TelnyxEnv, path: string, body: unknown) =>
  telnyxRequest<unknown>(env, path, { method: 'PATCH', body: JSON.stringify(body) });
const del = (env: TelnyxEnv, path: string) => telnyxRequest<unknown>(env, path, { method: 'DELETE' });

// ── IP connection ─────────────────────────────────────────────────────────

export async function telnyxCreateIpConnection(
  env: TelnyxEnv,
  args: { name: string; transport: SipTransport; active?: boolean },
): Promise<string> {
  const res = await post(env, '/ip_connections', {
    ...connectionBase(env, args.name, args.active ?? true),
    transport_protocol: SIP_TRANSPORT_TO_TELNYX[args.transport],
  });
  return requireId(res, 'IP connection');
}

export async function telnyxUpdateIpConnection(
  env: TelnyxEnv,
  id: string,
  patchBody: { name?: string; transport?: SipTransport; active?: boolean },
): Promise<void> {
  await patch(env, `/ip_connections/${encodeURIComponent(id)}`, {
    ...(patchBody.name !== undefined ? { connection_name: patchBody.name } : {}),
    ...(patchBody.transport ? { transport_protocol: SIP_TRANSPORT_TO_TELNYX[patchBody.transport] } : {}),
    ...(patchBody.active !== undefined ? { active: patchBody.active } : {}),
  });
}

export async function telnyxDeleteIpConnection(env: TelnyxEnv, id: string): Promise<void> {
  await del(env, `/ip_connections/${encodeURIComponent(id)}`);
}

export async function telnyxCreateIp(
  env: TelnyxEnv,
  args: { connectionId: string; ip: string; port?: number },
): Promise<string> {
  const res = await post(env, '/ips', {
    connection_id: args.connectionId,
    ip_address: args.ip,
    port: args.port ?? 5060,
  });
  return requireId(res, 'IP address');
}

export async function telnyxDeleteIp(env: TelnyxEnv, id: string): Promise<void> {
  await del(env, `/ips/${encodeURIComponent(id)}`);
}

// ── Credential connection ─────────────────────────────────────────────────

export async function telnyxCreateCredentialConnection(
  env: TelnyxEnv,
  args: { name: string; username: string; password: string; active?: boolean },
): Promise<string> {
  const res = await post(env, '/credential_connections', {
    ...connectionBase(env, args.name, args.active ?? true),
    user_name: args.username,
    password: args.password,
  });
  return requireId(res, 'credential connection');
}

export async function telnyxUpdateCredentialConnection(
  env: TelnyxEnv,
  id: string,
  patchBody: { name?: string; password?: string; active?: boolean },
): Promise<void> {
  await patch(env, `/credential_connections/${encodeURIComponent(id)}`, {
    ...(patchBody.name !== undefined ? { connection_name: patchBody.name } : {}),
    ...(patchBody.password !== undefined ? { password: patchBody.password } : {}),
    ...(patchBody.active !== undefined ? { active: patchBody.active } : {}),
  });
}

export async function telnyxDeleteCredentialConnection(env: TelnyxEnv, id: string): Promise<void> {
  await del(env, `/credential_connections/${encodeURIComponent(id)}`);
}

// ── Verified numbers (caller id) ──────────────────────────────────────────

export async function telnyxRequestNumberVerification(
  env: TelnyxEnv,
  phoneNumber: string,
  method: 'sms' | 'call',
): Promise<void> {
  await post(env, '/verified_numbers', { phone_number: phoneNumber, verification_method: method });
}

export async function telnyxConfirmNumberVerification(
  env: TelnyxEnv,
  phoneNumber: string,
  code: string,
): Promise<void> {
  await post(env, `/verified_numbers/${encodeURIComponent(phoneNumber)}/actions/verify`, {
    verification_code: code,
  });
}

export async function telnyxDeleteVerifiedNumber(env: TelnyxEnv, phoneNumber: string): Promise<void> {
  await del(env, `/verified_numbers/${encodeURIComponent(phoneNumber)}`);
}
