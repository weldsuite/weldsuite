/**
 * Texas: no wage income tax. Unemployment tax only.
 *
 * Sources (fetched 9 October 2026): TWC tax estimator for 2026,
 * https://efte.twc.texas.gov/estimate_cbs_and_tax_rates.html ("the first
 * $9000 of each employee's earnings"; new employers 2.70%); Texas Labor Code
 * §204.006 (new employer contribution rate, at least 2.6%) and §204.121
 * (Employment and Training Investment Assessment, 0.1%); Texas Register
 * resolution for 2026 (obligation assessment 0.01% for experience-rated
 * employers only, deficit tax 0%). TWC rate notices give one effective rate
 * that already includes these assessments, so the module charges that single
 * rate (2.7% for a new employer). twc.texas.gov is geo-blocked from the
 * research machine; its 2026 rate page was read through search extracts.
 */

import { d } from './common';
import { noIncomeTaxModule } from './no-income-tax';

export const TX_MODULE = noIncomeTaxModule({
  code: 'TX',
  name: 'Texas',
  ruleSet: 'us-tx-2026.1',
  sui: () => ({ wageBaseCents: d(9000), newEmployerRatePercent: 2.7 }),
});
