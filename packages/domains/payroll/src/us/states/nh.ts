/**
 * New Hampshire: no wage income tax. UI only.
 *
 * Sources (fetched 9 October 2026, read in a browser: nhes.nh.gov blocks
 * automated fetches): NHES, https://www.nhes.nh.gov/employers/employer-claims-taxes
 * ("new employer tax rate of 2.7% which is paid on the first $14,000 …
 * minus any Fund Balance Reduction in place for the applicable quarter")
 * and the tax rate chart (effective 2026-Q2): Fund Balance Reduction 1.00%
 * for 2026-Q1 and 2026-Q2, so a new employer pays 1.7%. The administrative
 * contribution is an allocation inside that rate, not an add-on. NH Paid
 * Family and Medical Leave is voluntary (paidfamilymedicalleave.nh.gov).
 *
 * Not verified: the reduction for 2026-Q3 and Q4 (the chart ends at Q2).
 * The new-employer fallback stays at 1.7% and is flagged `provisional_rules`
 * for pay dates from 1 July 2026.
 */

import { d } from './common';
import { noIncomeTaxModule } from './no-income-tax';

export const NH_MODULE = noIncomeTaxModule({
  code: 'NH',
  name: 'New Hampshire',
  ruleSet: 'us-nh-2026.1',
  sui: () => ({ wageBaseCents: d(14000), newEmployerRatePercent: 1.7 }),
  provisional: (input) => (input.suiRatePercent === null && input.payDate >= '2026-07-01' ? ['new employer rate after 2026-Q2'] : []),
});
