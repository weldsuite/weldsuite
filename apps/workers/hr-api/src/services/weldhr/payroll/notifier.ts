/**
 * Payroll emails to employees, best effort: a transport that is not
 * configured (no SEND_EMAIL binding) means no notifier at all, and a failed
 * send is logged, never raised: these never fail an approval or a profile
 * change. Neither mail carries pay figures or account numbers.
 *
 *  - `hr.payslip-ready`: a payslip was published (sent on approval, to
 *    employees with portal access or a linked member).
 *  - `hr.bank-changed`: the salary account changed, whoever changed it:
 *    changed bank details are the classic payroll fraud.
 *
 * White-label like the portal mails: when the workspace's portal is on, the
 * mail carries the portal's name and colours.
 */

import type { Context } from 'hono';
import { resolveEmailLocale, sendSystemEmail } from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import type { Env, Variables } from '../../../types';
import { brandName, brandOf, hrPortalUrl, workspaceSlugFor } from '../portal-mail';
import { loadPortalSettings } from '../portal';
import type { PayrollNotifier } from './deps';

type HrContext = Context<{ Bindings: Env; Variables: Variables }>;

/** The portal's brand and root URL, when the workspace runs a portal. */
async function portalContext(c: HrContext) {
  const settings = await loadPortalSettings(c.get('tenantDb'));
  if (!settings.isEnabled) return { brand: undefined, fromName: undefined, url: null as string | null };
  const slug = await workspaceSlugFor(c.env, c.get('workspaceId')).catch(() => null);
  return {
    brand: brandOf(settings),
    fromName: brandName(settings),
    url: settings.employeePortalEnabled && slug ? hrPortalUrl(c.env, settings, slug) : null,
  };
}

export function createPayrollNotifier(c: HrContext): PayrollNotifier | null {
  const transport = workerTransport(c.env);
  if (!transport) return null;

  return {
    async payslipReady(args) {
      try {
        const portal = await portalContext(c);
        await sendSystemEmail(transport, {
          template: 'hr.payslip-ready',
          props: { recipientName: args.name, employerName: args.employerName, payDate: args.payDate, url: portal.url },
          to: args.email,
          locale: resolveEmailLocale(args.lang),
          ...(portal.brand ? { brand: portal.brand, fromName: portal.fromName } : {}),
        });
      } catch (err) {
        console.warn('[payroll] payslip email skipped:', err instanceof Error ? err.message : err);
      }
    },

    async bankChanged(args) {
      try {
        const portal = await portalContext(c);
        await sendSystemEmail(transport, {
          template: 'hr.bank-changed',
          props: { recipientName: args.name, employerName: args.employerName, byEmployee: args.byEmployee, changedAt: new Date().toISOString() },
          to: args.email,
          locale: resolveEmailLocale(args.lang),
          ...(portal.brand ? { brand: portal.brand, fromName: portal.fromName } : {}),
        });
      } catch (err) {
        console.warn('[payroll] bank change email skipped:', err instanceof Error ? err.message : err);
      }
    },
  };
}
