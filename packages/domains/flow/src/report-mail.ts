/**
 * The two system emails of the reporting slice, sent from the worker: the
 * published status report (to a client contact; a member gets it through
 * `@weldsuite/notifications`) and the portal invitation (ADR FLOW-018 and
 * FLOW-020). flow-api reaches `@weldsuite/emails` through here, as the digest
 * workflow does.
 *
 * Sending is best-effort for the caller: with no email transport configured the
 * functions warn and answer false, a transport failure throws.
 */

import {
  periodLabel,
  resolveEmailLocale,
  sendSystemEmail,
  workspaceAppUrl,
  type EmailBrand,
  type EmailLocale,
  type FlowPortalInvitationEmailProps,
  type FlowStatusReportEmailProps,
} from '@weldsuite/emails';
import { workerTransport, type SystemEmailEnv } from '@weldsuite/emails/transports/binding';

export { periodLabel, resolveEmailLocale, workspaceAppUrl };
export type { EmailLocale, FlowPortalInvitationEmailProps, FlowStatusReportEmailProps };

interface Send<P> {
  to: string;
  locale: EmailLocale;
  brand: EmailBrand;
  props: P;
}

/** A published report to one recipient. Returns false when the worker has no email transport. */
export async function sendStatusReportEmail(env: SystemEmailEnv, send: Send<FlowStatusReportEmailProps>): Promise<boolean> {
  const transport = workerTransport(env);
  if (!transport) {
    console.warn('[flow/report-mail] No email transport configured, skipping the status report email');
    return false;
  }
  await sendSystemEmail(transport, { template: 'flow.status-report', props: send.props, to: send.to, locale: send.locale, brand: send.brand });
  return true;
}

/** The portal invitation to a client contact. Returns false when the worker has no email transport. */
export async function sendPortalInvitationEmail(env: SystemEmailEnv, send: Send<FlowPortalInvitationEmailProps>): Promise<boolean> {
  const transport = workerTransport(env);
  if (!transport) {
    console.warn('[flow/report-mail] No email transport configured, skipping the portal invitation');
    return false;
  }
  await sendSystemEmail(transport, { template: 'flow.portal-invitation', props: send.props, to: send.to, locale: send.locale, brand: send.brand });
  return true;
}
