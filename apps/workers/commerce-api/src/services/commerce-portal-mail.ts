/**
 * Magic-link / OTP sign-in email for the B2B commerce portal.
 *
 * Sent through @weldsuite/emails ('portal.sign-in'). A transport that isn't
 * configured (no SEND_EMAIL binding, no RESEND_API_KEY) is a no-op so
 * local/pglite tests and invite writes still succeed; production logs the
 * failure.
 *
 * SYSTEM_EMAIL_FROM pins the sender to the pre-existing noreply@weldsuite.org
 * address until mail.weldsuite.org is onboarded in Cloudflare Email Service
 * (docs/plans/system-email-cloudflare.md, Phase 0); see the `[vars]` comment
 * in wrangler.toml.
 */

import type { Env } from '../types';
import { sendSystemEmail, type EmailBrand } from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import { commercePortalOrigin } from '@weldsuite/commerce-domain/portal-tokens';

/** The branding fields `commerce_portal_settings` carries, when already loaded at the call site. */
export interface CommercePortalBrand {
  displayName?: string | null;
  logo?: string | null;
  accentColor?: string | null;
}

export async function sendPortalMagicLinkEmail(
  env: Env,
  params: {
    to: string;
    workspaceSlug: string;
    token: string;
    otp: string;
    companyName?: string | null;
    /** The workspace's commerce portal branding; falls back to the WeldCommerce brand when unset. */
    settings?: CommercePortalBrand | null;
  },
): Promise<boolean> {
  const transport = workerTransport(env);
  if (!transport) return false;

  const origin = commercePortalOrigin(env);
  const url = `${origin}/${encodeURIComponent(params.workspaceSlug)}/auth/callback?token=${encodeURIComponent(params.token)}`;
  const displayName = params.settings?.displayName?.trim();
  const portalName = displayName || (params.companyName ? `${params.companyName} order portal` : 'Order portal');
  const brand: EmailBrand = displayName
    ? { kind: 'workspace', name: displayName, logoUrl: params.settings?.logo, accentColor: params.settings?.accentColor }
    : { kind: 'weldsuite', module: 'WeldCommerce' };

  try {
    await sendSystemEmail(transport, {
      template: 'portal.sign-in',
      props: { portalName, code: params.otp, url, expiresInMinutes: 15 },
      to: params.to,
      brand,
      fromName: displayName,
    });
    return true;
  } catch (err) {
    console.warn('[app-api/commerce-portal] magic-link email skipped:', err);
    return false;
  }
}
