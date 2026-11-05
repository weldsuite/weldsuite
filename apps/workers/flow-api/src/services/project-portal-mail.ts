/**
 * The sign-in code email of the client portal (FLOW-020): the shared
 * `portal.sign-in` template of @weldsuite/emails (a code, no link), in the
 * recipient's language and under the workspace's name.
 *
 * A transport that is not configured (no SEND_EMAIL binding, no RESEND_API_KEY)
 * is a no-op, so local and test runs still go through sign-in; a failed send is
 * logged, never thrown: the answer to a code request is the same either way.
 */

import { sendSystemEmail, type EmailBrand, type EmailLocale } from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import { PORTAL_CODE_TTL_SECONDS } from '@weldsuite/flow-domain/project-portal';
import type { Env } from '../types';

/** The name of the portal as the recipient knows it, per language. */
export function portalDisplayName(workspaceName: string, locale: EmailLocale): string {
  return locale === 'nl' ? `Projectportaal van ${workspaceName}` : `${workspaceName} project portal`;
}

export async function sendPortalCodeEmail(
  env: Env,
  params: { to: string; code: string; workspaceName: string; locale: EmailLocale },
): Promise<boolean> {
  const transport = workerTransport(env);
  if (!transport) return false;

  const brand: EmailBrand = { kind: 'workspace', name: params.workspaceName };
  try {
    await sendSystemEmail(transport, {
      template: 'portal.sign-in',
      props: {
        portalName: portalDisplayName(params.workspaceName, params.locale),
        code: params.code,
        expiresInMinutes: PORTAL_CODE_TTL_SECONDS / 60,
      },
      to: params.to,
      locale: params.locale,
      brand,
      fromName: params.workspaceName,
    });
    return true;
  } catch (err) {
    console.warn('[flow-api/public-project-portal] sign-in code email skipped:', err);
    return false;
  }
}
