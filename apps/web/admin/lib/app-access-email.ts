import 'server-only';

import { sendSystemEmail } from '@weldsuite/emails';
import { transportFromEnv } from '@weldsuite/emails/transports/env';
import type { WeldReachLimits } from './app-access';

/**
 * Best-effort mail to the person who asked for access, when staff approve or
 * reject. Never throws: the decision is already saved. The caller turns
 * `skipped` / `failed` into a warning toast so staff know to tell the
 * requester themselves.
 */
export type EmailOutcome = 'sent' | 'skipped' | 'failed';

/** Drops every trailing slash with a single scan (a `/\/+$/` regex backtracks quadratically on long runs). */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/** The platform the requester opens, e.g. https://app.weldsuite.org (PLATFORM_APP_URL on the console). */
export function platformUrl(): string {
  return stripTrailingSlashes(process.env.PLATFORM_APP_URL?.trim() || 'https://app.weldsuite.org');
}

export async function sendAccessApprovedEmail(params: {
  to: string | null;
  recipientName: string | null;
  workspaceName: string;
  limits: WeldReachLimits;
}): Promise<EmailOutcome> {
  if (!params.to) return 'skipped';
  const transport = transportFromEnv(process.env);
  if (!transport) {
    console.warn('[admin/app-access-email] no email transport configured; skipping the approval email');
    return 'skipped';
  }
  try {
    await sendSystemEmail(transport, {
      template: 'reach.access-approved',
      props: {
        recipientName: params.recipientName,
        workspaceName: params.workspaceName,
        url: `${platformUrl()}/weldreach`,
        limits: {
          maxDomains: params.limits.maxDomains,
          maxMailboxes: params.limits.maxMailboxes,
          maxDailySends: params.limits.maxDailySends,
        },
      },
      to: params.to,
      locale: 'en',
    });
    return 'sent';
  } catch (err) {
    console.error('[admin/app-access-email] approval email failed:', err);
    return 'failed';
  }
}

export async function sendAccessRejectedEmail(params: {
  to: string | null;
  recipientName: string | null;
  workspaceName: string;
  reason: string;
}): Promise<EmailOutcome> {
  if (!params.to) return 'skipped';
  const transport = transportFromEnv(process.env);
  if (!transport) {
    console.warn('[admin/app-access-email] no email transport configured; skipping the rejection email');
    return 'skipped';
  }
  try {
    await sendSystemEmail(transport, {
      template: 'reach.access-rejected',
      props: {
        recipientName: params.recipientName,
        workspaceName: params.workspaceName,
        reason: params.reason,
        url: `${platformUrl()}/appstore/weldreach`,
      },
      to: params.to,
      locale: 'en',
    });
    return 'sent';
  } catch (err) {
    console.error('[admin/app-access-email] rejection email failed:', err);
    return 'failed';
  }
}
