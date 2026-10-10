/**
 * Tennessee: no wage income tax. Unemployment insurance premiums only.
 *
 * Sources (fetched 9 October 2026): TDLWD, https://www.tn.gov/workforce/employers/tax-and-insurance-redirect/unemployment-insurance-tax/ui-tax-rates.html
 * (2026 wage base $7,000; tn.gov was read through search extracts, it
 * refuses automated fetches) and https://lwdsupport.tn.gov/hc/en-us/articles/202843724-How-is-my-premium-rate-determined
 * (new employer rate 2.7% for all other industries) and LB-0441 (Rev. 08-23):
 * "all industries, starting July 1, 2021, have a new employer rate of 2.7%".
 * No employee share, no surcharge.
 */

import { d } from './common';
import { noIncomeTaxModule } from './no-income-tax';

export const TN_MODULE = noIncomeTaxModule({
  code: 'TN',
  name: 'Tennessee',
  ruleSet: 'us-tn-2026.1',
  sui: () => ({ wageBaseCents: d(7000), newEmployerRatePercent: 2.7 }),
});
