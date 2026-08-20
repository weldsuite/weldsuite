/**
 * Magic-link / OTP email for the B2B commerce portal.
 *
 * Missing SEND_EMAIL binding is a no-op so local/pglite tests and invite
 * writes still succeed; production logs the failure.
 */

import type { Env } from '../types';
import { sendEmail } from '../lib/cloudflare-email';
import { commercePortalOrigin } from '../lib/commerce-portal-tokens';

const FROM = 'WeldCommerce <noreply@weldsuite.org>';

export async function sendPortalMagicLinkEmail(
  env: Env,
  params: {
    to: string;
    workspaceSlug: string;
    token: string;
    otp: string;
    companyName?: string | null;
  },
): Promise<boolean> {
  const origin = commercePortalOrigin(env);
  const url = `${origin}/${encodeURIComponent(params.workspaceSlug)}/auth/callback?token=${encodeURIComponent(params.token)}`;
  const company = params.companyName ? ` for ${params.companyName}` : '';
  const subject = `Sign in to your order portal${company}`;
  const text = [
    `Use this link to sign in (expires in 15 minutes):`,
    url,
    '',
    `Or enter this code: ${params.otp}`,
    '',
    `If you did not request this, you can ignore the email.`,
  ].join('\n');
  const html = `
    <p>Use this link to sign in (expires in 15 minutes):</p>
    <p><a href="${url}">${url}</a></p>
    <p>Or enter this code: <strong>${params.otp}</strong></p>
    <p>If you did not request this, you can ignore the email.</p>
  `;

  try {
    await sendEmail(env, { from: FROM, to: [params.to], subject, text, html });
    return true;
  } catch (err) {
    console.warn('[app-api/commerce-portal] magic-link email skipped:', err);
    return false;
  }
}
