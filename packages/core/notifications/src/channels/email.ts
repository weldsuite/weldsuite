/**
 * Email channel — renders and sends a notification email through
 * `@weldsuite/emails`, using whichever transport the host worker has
 * configured (Cloudflare `SEND_EMAIL` binding, or Resend during the
 * migration window — see `workerTransport`).
 *
 * Exported for the deferred-email workflow, which sends the same mail on the
 * same `from` address minutes later — it must not grow its own copy.
 */

import { sendSystemEmail, type EmailBrand, type EmailLocale } from '@weldsuite/emails';
import { workerTransport, type SystemEmailEnv } from '@weldsuite/emails/transports/binding';
import type { NotificationEmailOverride } from '../types';

export interface SendNotificationEmailParams {
  to: string;
  locale: EmailLocale;
  /** Template + props to render. */
  email: NotificationEmailOverride;
  /** Sender module/brand. Defaults to the template's own default brand. */
  brand?: EmailBrand;
  replyTo?: string;
}

/**
 * Send a notification email. No-ops (with a warning) when the worker has no
 * email transport configured — the same "skip sending" behaviour the old
 * `if (!RESEND_API_KEY) return` had for local dev.
 */
export async function sendNotificationEmail(
  env: SystemEmailEnv,
  params: SendNotificationEmailParams,
): Promise<void> {
  const transport = workerTransport(env);
  if (!transport) {
    console.warn('[Notifications] No email transport configured, skipping send');
    return;
  }

  await sendSystemEmail(transport, {
    ...params.email,
    to: params.to,
    locale: params.locale,
    ...(params.brand ? { brand: params.brand } : {}),
    ...(params.replyTo ? { replyTo: params.replyTo } : {}),
  });
}
