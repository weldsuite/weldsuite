/**
 * Send Email Step Handler
 *
 * Sends an email via a configured email endpoint. Supports graceful
 * degradation — if no endpoint is available, logs the attempt and
 * returns success to avoid blocking the workflow.
 */

import type { StepHandler, StepContext, StepResult } from '../../types';

export const sendEmailHandler: StepHandler = {
  type: 'send_email',

  async execute(ctx: StepContext): Promise<StepResult> {
    const to = String(ctx.inputs.to || '');
    const subject = String(ctx.inputs.subject || '');
    const message = String(ctx.inputs.message || '');
    const from = String(ctx.inputs.from || 'noreply@weldsuite.com');

    if (!to) {
      return { success: false, error: 'Missing required field: to' };
    }

    if (!subject) {
      return { success: false, error: 'Missing required field: subject' };
    }

    const { env } = ctx.options;

    // Determine email endpoint — check for configured API worker URL or email service
    const envAny = env as unknown as Record<string, unknown>;
    const emailEndpoint = envAny.EMAIL_API_URL
      ? String(envAny.EMAIL_API_URL)
      : envAny.API_WORKER_URL
        ? `${String(envAny.API_WORKER_URL)}/api/mail/send`
        : null;

    if (!emailEndpoint) {
      // Graceful degradation — log and return success
      console.log(`[Send Email] No email endpoint configured. Would send to=${to} subject="${subject}"`);
      return {
        success: true,
        to,
        subject,
        skipped: true,
        error: 'No email endpoint configured — email not sent',
      };
    }

    try {
      const response = await fetch(emailEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to,
          from,
          subject,
          html: message,
          text: message.replace(/<[^>]*>/g, ''),
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');
        console.error(`[Send Email] Failed to send email: ${response.status} ${errorBody}`);
        return {
          success: false,
          to,
          subject,
          error: `Email send failed: ${response.status}`,
        };
      }

      return {
        success: true,
        to,
        subject,
      };
    } catch (err) {
      console.error('[Send Email] Fetch error:', err);
      // Graceful degradation — don't block workflow on email failure
      return {
        success: true,
        to,
        subject,
        skipped: true,
        error: `Email send error: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  },
};
