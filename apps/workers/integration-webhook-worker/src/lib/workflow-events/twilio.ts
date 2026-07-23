/**
 * Twilio inbound — X-Twilio-Signature verification + SMS parsing.
 * Signature = base64(HMAC-SHA1(authToken, requestUrl + sortedConcatenatedParams)).
 */

import { hmac, bytesToBase64, timingSafeEqual } from './util';

export async function verifyTwilioSignature(
  authToken: string | undefined,
  url: string,
  params: Record<string, string>,
  signature: string | null,
): Promise<boolean> {
  if (!authToken || !signature) return false;
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  const expected = bytesToBase64(await hmac('SHA-1', authToken, data));
  return timingSafeEqual(expected, signature);
}

export interface ParsedIntegrationEvent {
  event: string;
  data: Record<string, unknown>;
}

export function parseTwilioSms(params: Record<string, string>): ParsedIntegrationEvent | null {
  if (!params.From || params.Body === undefined) return null;
  return {
    event: 'twilio.inbound_sms',
    data: { from: params.From, to: params.To, body: params.Body, messageSid: params.MessageSid },
  };
}
