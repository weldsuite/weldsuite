/**
 * GitHub inbound — X-Hub-Signature-256 verification + issue/PR event parsing.
 */

import { hmac, bytesToHex, timingSafeEqual } from './util';
import type { ParsedIntegrationEvent } from './twilio';

export async function verifyGithubSignature(
  secret: string | undefined,
  rawBody: string,
  signature: string | null,
): Promise<boolean> {
  if (!secret || !signature) return false;
  const expected = `sha256=${bytesToHex(await hmac('SHA-256', secret, rawBody))}`;
  return timingSafeEqual(expected, signature);
}

export function parseGithubEvent(eventHeader: string, payload: any): ParsedIntegrationEvent | null {
  if (eventHeader === 'issues') {
    return {
      event: 'github.issue',
      data: {
        action: payload.action,
        number: payload.issue?.number,
        title: payload.issue?.title,
        state: payload.issue?.state,
        repository: payload.repository?.full_name,
      },
    };
  }
  if (eventHeader === 'pull_request') {
    return {
      event: 'github.pull_request',
      data: {
        action: payload.action,
        number: payload.pull_request?.number,
        title: payload.pull_request?.title,
        state: payload.pull_request?.state,
        merged: payload.pull_request?.merged,
        repository: payload.repository?.full_name,
      },
    };
  }
  return null;
}
