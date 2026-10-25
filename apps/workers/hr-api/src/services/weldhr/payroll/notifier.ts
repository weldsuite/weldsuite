/**
 * Payroll emails to employees, best effort: a transport that is not
 * configured (no SEND_EMAIL binding) means no notifier at all, and a failed
 * send is logged, never raised: these never fail an approval or a profile
 * change. Neither mail carries pay figures or account numbers.
 *
 *  - `hr.payslip-ready`: a payslip was published (sent on approval, to
 *    employees linked to a workspace member). Links to My HR → Payroll.
 *  - `hr.bank-changed`: the salary account changed, whoever changed it:
 *    changed bank details are the classic payroll fraud.
 */

import type { Context } from 'hono';
import { resolveEmailLocale, sendSystemEmail, workspaceAppUrl } from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import type { Env, Variables } from '../../../types';
import type { PayrollNotifier } from './deps';

type HrContext = Context<{ Bindings: Env; Variables: Variables }>;

const PLATFORM_URLS: Record<string, string> = {
  development: 'http://localhost:3000',
  test: 'https://app-test.weldsuite.org',
  production: 'https://app.weldsuite.org',
};

/** My HR's payroll page, in the payslip's workspace (FE-013). `APP_URL` overrides the host. */
function myPayrollUrl(c: HrContext): string {
  const base = c.env.APP_URL?.trim() || PLATFORM_URLS[c.env.ENVIRONMENT] || PLATFORM_URLS.production!;
  return workspaceAppUrl(base, c.get('orgId'), '/weldhr/me/payroll');
}

export function createPayrollNotifier(c: HrContext): PayrollNotifier | null {
  const transport = workerTransport(c.env);
  if (!transport) return null;

  return {
    async payslipReady(args) {
      try {
        await sendSystemEmail(transport, {
          template: 'hr.payslip-ready',
          props: { recipientName: args.name, employerName: args.employerName, payDate: args.payDate, url: myPayrollUrl(c) },
          to: args.email,
          locale: resolveEmailLocale(args.lang),
        });
      } catch (err) {
        console.warn('[payroll] payslip email skipped:', err instanceof Error ? err.message : err);
      }
    },

    async bankChanged(args) {
      try {
        await sendSystemEmail(transport, {
          template: 'hr.bank-changed',
          props: { recipientName: args.name, employerName: args.employerName, byEmployee: args.byEmployee, changedAt: new Date().toISOString() },
          to: args.email,
          locale: resolveEmailLocale(args.lang),
        });
      } catch (err) {
        console.warn('[payroll] bank change email skipped:', err instanceof Error ? err.message : err);
      }
    },
  };
}
