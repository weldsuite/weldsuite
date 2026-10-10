/**
 * Alaska: no wage income tax. UI with an employee share on the same base.
 *
 * Source (fetched 9 October 2026): Alaska DOLWD Research and Analysis,
 * "Alaska Unemployment Insurance Tax Rates For New (Industry) Employers,
 * 2026" (last update 12/04/2025), laborstats.alaska.gov: 2026 tax base
 * $54,200; employee rate 0.50%; new employer rate 1.00% in every industry.
 */

import { d } from './common';
import { noIncomeTaxModule } from './no-income-tax';

export const AK_MODULE = noIncomeTaxModule({
  code: 'AK',
  name: 'Alaska',
  ruleSet: 'us-ak-2026.1',
  sui: () => ({
    wageBaseCents: d(54200),
    newEmployerRatePercent: 1.0,
    employee: { ratePercent: 0.5, wageBaseCents: d(54200) },
  }),
});
