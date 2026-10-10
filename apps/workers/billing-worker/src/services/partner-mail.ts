/**
 * Partner (reseller) emails: dunning notices and portal invitations. System
 * mail through @weldsuite/emails and the SEND_EMAIL binding, like the other
 * workers (see .claude/skills/weldsuite-email).
 */

import { resolveEmailLocale, sendSystemEmail, type PartnerDunningStage } from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import type { PartnerMemberRole } from '@weldsuite/app-api-client/schemas/partners';
import type { Env } from '../index';

export function partnerPortalUrl(env: Env): string {
  return `${(env.APP_URL || 'https://app.weldsuite.org').replace(/\/+$/, '')}/partner`;
}

export interface DunningEmailInput {
  stage: PartnerDunningStage;
  to: string[];
  partnerName: string;
  /** Statement period start (ISO). */
  periodStart: string;
  amountDue: string;
  currency: string;
  dueAt: string;
  daysOverdue: number;
  readOnlyAt: string;
  invoiceUrl: string | null;
  /** Partner country, for the language (nl for NL/BE, else English). */
  country?: string | null;
}

/** Dutch-speaking partners get nl; Spanish/Portuguese are out of scope (task #1092). */
function partnerLocale(country: string | null | undefined) {
  return resolveEmailLocale(country === 'NL' || country === 'BE' ? 'nl' : undefined);
}

/**
 * Send one dunning notice to every recipient in a single message. Returns
 * false when the worker has no email transport (nothing sent, nothing to
 * retry); throws when the transport fails so the caller retries next sweep.
 */
export async function sendPartnerDunningEmail(env: Env, input: DunningEmailInput): Promise<boolean> {
  const transport = workerTransport(env);
  if (!transport) {
    console.warn('[Partner Mail] No email transport configured, skipping dunning email');
    return false;
  }
  if (input.to.length === 0) return false;
  await sendSystemEmail(transport, {
    template: 'partner.dunning',
    props: {
      stage: input.stage,
      partnerName: input.partnerName,
      periodStart: input.periodStart,
      amountDue: input.amountDue,
      currency: input.currency,
      dueAt: input.dueAt,
      daysOverdue: input.daysOverdue,
      readOnlyAt: input.readOnlyAt,
      invoiceUrl: input.invoiceUrl,
      portalUrl: `${partnerPortalUrl(env)}/statements`,
    },
    to: input.to,
    locale: partnerLocale(input.country),
  });
  return true;
}

/** Portal invitation. Best effort: the member row is what grants access, so mail failures are logged only. */
export async function sendPartnerInvitationEmail(
  env: Env,
  input: { to: string; partnerName: string; role: PartnerMemberRole; country?: string | null },
): Promise<boolean> {
  const transport = workerTransport(env);
  if (!transport) {
    console.warn('[Partner Mail] No email transport configured, skipping partner invitation email');
    return false;
  }
  try {
    await sendSystemEmail(transport, {
      template: 'partner.invitation',
      props: {
        partnerName: input.partnerName,
        role: input.role,
        portalUrl: partnerPortalUrl(env),
        recipientEmail: input.to,
      },
      to: input.to,
      locale: partnerLocale(input.country),
    });
    return true;
  } catch (err) {
    console.error('[Partner Mail] Partner invitation email failed:', err);
    return false;
  }
}
