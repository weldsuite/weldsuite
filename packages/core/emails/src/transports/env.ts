/**
 * Transport for code without a Workers binding (the Next.js apps, scripts),
 * picked from plain environment variables. Safe to import anywhere: it never
 * touches `cloudflare:email`.
 */

import { withFromAddress, type EmailTransport } from '../transport';
import { resendTransport } from './resend';
import { restTransport } from './rest';

export interface EnvTransportVars {
  /** `resend` forces Resend (migration fallback); anything else prefers Cloudflare. */
  EMAIL_TRANSPORT?: string;
  CF_ACCOUNT_ID?: string;
  /** API token with only the "Email Sending: Send" permission. */
  CF_EMAIL_SEND_TOKEN?: string;
  RESEND_API_KEY?: string;
  /** Migration only: send from this address instead of the system one. */
  SYSTEM_EMAIL_FROM?: string;
  /** Lets `process.env` be passed as is. */
  [key: string]: string | undefined;
}

/**
 * Cloudflare REST when its credentials are set (unless EMAIL_TRANSPORT=resend),
 * else Resend when its key is set, else undefined (caller skips sending).
 */
export function transportFromEnv(env: EnvTransportVars): EmailTransport | undefined {
  const forceResend = env.EMAIL_TRANSPORT?.trim().toLowerCase() === 'resend';
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const apiToken = env.CF_EMAIL_SEND_TOKEN?.trim();
  let transport: EmailTransport | undefined;
  if (!forceResend && accountId && apiToken) {
    transport = restTransport({ accountId, apiToken });
  } else if (env.RESEND_API_KEY?.trim()) {
    transport = resendTransport({ apiKey: env.RESEND_API_KEY.trim() });
  }
  return transport ? withFromAddress(transport, env.SYSTEM_EMAIL_FROM) : undefined;
}
