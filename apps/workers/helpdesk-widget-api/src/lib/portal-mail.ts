/**
 * The help-center sign-in code email ('portal.sign-in', code only), in the
 * help center's own brand. A worker without a mail transport (local dev,
 * tests) sends nothing and says so.
 */

import { sendSystemEmail, resolveEmailLocale, type EmailBrand } from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import type { Env } from '../index';
import { CODE_TTL_SECONDS } from './portal-auth';

export interface HelpcenterBrand {
  siteName: string | null;
  logo: string | null;
  primaryColor: string | null;
}

export async function sendPortalCodeEmail(
  env: Env,
  params: { to: string; code: string; brand: HelpcenterBrand; locale?: string | null },
): Promise<boolean> {
  const transport = workerTransport(env);
  if (!transport) {
    console.warn('[widget-api/portal] no mail transport, sign-in code not sent');
    return false;
  }
  const name = params.brand.siteName?.trim() || null;
  const brand: EmailBrand = name
    ? { kind: 'workspace', name, logoUrl: params.brand.logo, accentColor: params.brand.primaryColor }
    : { kind: 'weldsuite', module: 'WeldDesk' };
  try {
    await sendSystemEmail(transport, {
      template: 'portal.sign-in',
      props: { portalName: name ?? 'Help center', code: params.code, expiresInMinutes: CODE_TTL_SECONDS / 60 },
      to: params.to,
      brand,
      fromName: name ?? undefined,
      locale: resolveEmailLocale(params.locale),
    });
    return true;
  } catch (err) {
    console.error('[widget-api/portal] sign-in code email failed:', err);
    return false;
  }
}
