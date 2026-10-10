/** One-line descriptions of a signed tax election, for the employee Payroll tab and My HR. */

import type { HrTaxElection } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { humanizeKey } from './format';

type Translate = (key: string, params?: Record<string, unknown>) => string;

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function electionSummary(election: HrTaxElection, t: Translate, stateOption: (state: string, option: string) => string): string {
  const data = election.data;
  switch (election.kind) {
    case 'nl_loonheffingskorting':
      return data.applyCredit === true ? t('weldhr.payroll.elections.summary.creditApplied') : t('weldhr.payroll.elections.summary.creditNotApplied');
    case 'us_w4': {
      const status = text(data.filingStatus);
      const parts = [
        status ? t(`weldhr.payroll.elections.w4.filingStatuses.${status}`) : null,
        typeof data.formYear === 'number' ? t('weldhr.payroll.elections.summary.formYear', { year: data.formYear }) : null,
        data.exempt === true ? t('weldhr.payroll.elections.summary.exempt') : null,
        data.multipleJobs === true ? t('weldhr.payroll.elections.summary.multipleJobs') : null,
      ];
      return parts.filter(Boolean).join(' · ');
    }
    default: {
      const status = text(data.filingStatus);
      const parts = [
        status && election.state ? stateOption(election.state, status) : status ? humanizeKey(status) : null,
        typeof data.allowances === 'number' ? t('weldhr.payroll.elections.summary.allowances', { count: data.allowances }) : null,
        data.exempt === true ? t('weldhr.payroll.elections.summary.exempt') : null,
      ];
      return parts.filter(Boolean).join(' · ') || '—';
    }
  }
}
