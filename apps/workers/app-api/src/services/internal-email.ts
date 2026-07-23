/**
 * Internal email sending — successor to the legacy api-worker
 * `POST /api/internal/send-email` + `/send-transactional-email` surface
 * (apps/api-worker/src/routes/internal/index.ts; W3 of the legacy-worker
 * phase-out plan).
 *
 * Pure functions, no Hono context. Reuses app-api's existing outbound mail
 * path (`lib/cloudflare-email.ts` → Cloudflare `[[send_email]]` binding) for
 * regular sends, and Resend for transactional sends (falling back to the
 * Cloudflare path when RESEND_API_KEY is not configured — same fallback the
 * legacy endpoint had).
 *
 * NOTE: the Resend call below is a deliberate minimal inline of
 * `@weldsuite/transactional-email`'s `sendEmail` (packages/core/transactional-email/
 * src/resend.ts) — app-api does not (yet) depend on that package directly.
 * If the dependency is ever added, this can be swapped for the package import.
 */

import { sendEmail as sendViaCloudflare } from '../lib/cloudflare-email';
import type { Env } from '../types';

export interface InternalEmailParams {
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  headers?: Record<string, string>;
}

export interface InternalEmailResult {
  messageId: string;
}

/**
 * Send an email through app-api's standard outbound path (Cloudflare
 * `send_email` binding). Legacy contract: the api-worker endpoint sent via
 * Stalwart JMAP; the payload + result shape are identical, only the
 * transport changed.
 */
export async function sendInternalEmail(
  env: Env,
  params: InternalEmailParams,
): Promise<InternalEmailResult> {
  const result = await sendViaCloudflare(env, {
    from: params.from,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    cc: params.cc,
    bcc: params.bcc,
    headers: params.headers,
  });
  return { messageId: result.messageId };
}

/**
 * Send a transactional email via Resend (from @mail.weldsuite.org senders).
 * Falls back to the Cloudflare send path when RESEND_API_KEY is unset —
 * mirroring the legacy api-worker behavior exactly.
 */
export async function sendInternalTransactionalEmail(
  env: Env,
  params: InternalEmailParams,
): Promise<InternalEmailResult> {
  if (env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: params.from,
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        cc: params.cc,
        bcc: params.bcc,
        headers: params.headers,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Resend API error ${res.status}: ${body}`);
    }

    const json = (await res.json()) as { id: string };
    return { messageId: json.id };
  }

  // Fallback to the Cloudflare send path.
  return sendInternalEmail(env, params);
}
