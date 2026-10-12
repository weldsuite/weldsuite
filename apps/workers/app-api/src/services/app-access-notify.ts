/**
 * Tells WeldSuite staff that a workspace asked for access to an on-request
 * app, with the request's answers and a link to the admin console.
 *
 * Best effort: callers run it in `executionCtx.waitUntil`, and it never throws.
 * A worker with no email transport configured (local dev) logs and skips.
 */

import { sendSystemEmail } from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import type { AppAccessRequestInput } from '@weldsuite/app-api-client/schemas/reach';
import type { Env } from '../types';

/** The admin console, used when `ADMIN_CONSOLE_URL` is not set. */
export const DEFAULT_ADMIN_CONSOLE_URL = 'https://admin.weldsuite.org';

/** Display names of the on-request apps, for the email. Unknown codes are shown as they are. */
const APP_NAMES: Record<string, string> = { weldreach: 'WeldReach' };

/** Drops every trailing slash with a single scan (a `/\/+$/` regex backtracks quadratically on long runs). */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

export function accessRequestsUrl(env: Pick<Env, 'ADMIN_CONSOLE_URL'>): string {
  const base = stripTrailingSlashes(env.ADMIN_CONSOLE_URL?.trim() || DEFAULT_ADMIN_CONSOLE_URL);
  return `${base}/access-requests`;
}

export async function notifyAccessRequested(
  env: Env,
  params: {
    appCode: string;
    workspaceId: string;
    workspaceName: string;
    input: AppAccessRequestInput;
  },
): Promise<void> {
  const to = env.ACCESS_REQUEST_NOTIFY_EMAIL?.trim();
  if (!to) {
    console.warn('[app-access] ACCESS_REQUEST_NOTIFY_EMAIL is not set; skipping the staff notification');
    return;
  }
  const transport = workerTransport(env);
  if (!transport) {
    console.warn('[app-access] no email transport configured; skipping the staff notification');
    return;
  }

  const { input } = params;
  try {
    await sendSystemEmail(transport, {
      template: 'internal.app-access-requested',
      props: {
        appName: APP_NAMES[params.appCode] ?? params.appCode,
        workspaceName: params.workspaceName,
        workspaceId: params.workspaceId,
        companyName: input.companyName,
        website: input.website,
        contactName: input.contactName,
        contactEmail: input.contactEmail,
        targetCountries: input.targetCountries,
        expectedDailySends: input.expectedDailySends,
        listSource: input.listSource,
        listSourceDetails: input.listSourceDetails,
        useCase: input.useCase,
        termsVersion: input.termsVersion,
        reviewUrl: accessRequestsUrl(env),
      },
      to,
      // Lets staff answer the requester straight from the notification. The
      // address is validated as an email by the request schema.
      replyTo: input.contactEmail,
      locale: 'en',
    });
  } catch (err) {
    console.error('[app-access] staff notification failed:', err);
  }
}
