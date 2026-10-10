/**
 * Florida: no wage income tax. Reemployment tax (SUI) only.
 *
 * Sources (fetched 9 October 2026): FL DOR, Reemployment Tax rates,
 * https://floridarevenue.com/taxes/taxesfees/Pages/rt_rate.aspx (2026 rates
 * on wages up to $7,000; new employers 2.7%); Employer Guide RT-800002
 * (R. 03/25): beginning rate 2.7%, no employee share.
 */

import { d } from './common';
import { noIncomeTaxModule } from './no-income-tax';

export const FL_MODULE = noIncomeTaxModule({
  code: 'FL',
  name: 'Florida',
  ruleSet: 'us-fl-2026.1',
  sui: () => ({ wageBaseCents: d(7000), newEmployerRatePercent: 2.7 }),
});
