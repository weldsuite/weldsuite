/**
 * Partner emails: a portal invitation and the "new territory request" notice.
 *
 * Plain text on purpose: there is no partner template in `@weldsuite/emails`
 * yet and the portal is English-only until the Spanish/Portuguese work (task
 * #1092). Sent through app-api's existing outbound path; a failure is logged
 * and never fails the request that triggered it.
 */

import { sendInternalEmail } from '../internal-email';
import type { Env } from '../../types';

const FROM = 'WeldSuite <notifications@mail.weldsuite.org>';

const appUrl = (env: Env) => (env.PUBLIC_APP_URL ?? 'https://app.weldsuite.org').replace(/\/+$/, '');

/** Strip line breaks from user text that lands in a subject line. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

async function send(env: Env, to: string[], subject: string, text: string): Promise<void> {
  if (to.length === 0) return;
  try {
    await sendInternalEmail(env, { from: FROM, to, subject: oneLine(subject), text });
  } catch (err) {
    console.error('[partner] Email not sent:', err);
  }
}

export function sendPartnerInviteEmail(env: Env, input: { to: string; partnerName: string; role: string }): Promise<void> {
  return send(
    env,
    [input.to],
    `You have been invited to the ${input.partnerName} partner portal`,
    [
      `You have been added to ${input.partnerName} on WeldSuite as ${input.role}.`,
      '',
      `Sign in with this email address (${input.to}) to open the partner portal:`,
      `${appUrl(env)}/partner`,
    ].join('\n'),
  );
}

export function sendWorkspaceRequestEmail(
  env: Env,
  input: {
    to: string[];
    partnerName: string;
    companyName: string;
    countryCode: string;
    requesterEmail: string;
    requesterName: string | null;
    selectedApps: string[];
    message?: string;
  },
): Promise<void> {
  const lines = [
    `${input.companyName} asked for a WeldSuite workspace in ${input.countryCode}.`,
    '',
    `Contact: ${input.requesterName ? `${input.requesterName} <${input.requesterEmail}>` : input.requesterEmail}`,
  ];
  if (input.selectedApps.length > 0) lines.push(`Apps: ${input.selectedApps.join(', ')}`);
  if (input.message) lines.push('', input.message);
  lines.push('', `Review it in the partner portal: ${appUrl(env)}/partner/requests`);
  return send(env, input.to, `New workspace request for ${input.partnerName}: ${input.companyName}`, lines.join('\n'));
}
