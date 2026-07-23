/**
 * Email channel — sends a notification email via Resend, preferring the
 * template path when the caller supplies one. Both branches share the same
 * `from` address; the template path is recommended for any user-visible
 * notification type that has a branded design in the Resend dashboard.
 */

import * as resend from '@weldsuite/transactional-email';

const FROM_ADDRESS = 'WeldSuite <notifications@mail.weldsuite.org>';

interface EmailParams {
  apiKey: string;
  to: string;
  subject: string;
  /** Plain-text fallback. Used when no template is supplied, or when the
   *  template call fails (we don't fall back automatically — that would
   *  mask config errors — but a future caller could choose to retry). */
  fallbackText: string;
  /** Optional Resend template. When set, `sendTemplateEmail` is used. */
  template?: {
    id: string;
    variables: Record<string, string | number | boolean>;
  };
}

export async function sendNotificationEmail(params: EmailParams): Promise<void> {
  if (params.template) {
    await resend.sendTemplateEmail(params.apiKey, {
      from: FROM_ADDRESS,
      to: [params.to],
      subject: params.subject,
      template: params.template,
    });
    return;
  }

  await resend.sendEmail(params.apiKey, {
    from: FROM_ADDRESS,
    to: [params.to],
    subject: params.subject,
    text: params.fallbackText,
  });
}
