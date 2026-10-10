/**
 * Wyoming: no wage income tax. Unemployment insurance only.
 *
 * Sources (fetched 9 October 2026): DWS, Unemployment Taxable Wage Base,
 * https://dws.wyo.gov/dws-division/unemployment-insurance/wyui/unemployment-taxable-wage-base/
 * (2026: $33,800); DWS, Unemployment Tax Rates,
 * https://dws.wyo.gov/dws-division/unemployment-insurance/employers/unemployment-tax-rates/
 * (page modified 28 April 2026): new employers get a base rate for their
 * industry plus four adjustment factors (the Employment Support Fund share
 * among them), and "the base rate and these four factors when added together
 * will result in their total tax rate". W.S. 27-3-503(f), 27-3-505. There is
 * no single statewide new-employer rate, so `suiRatePercent` must be the total
 * rate from the employer's notice; without it the payslip gets an error.
 */

import { d } from './common';
import { noIncomeTaxModule } from './no-income-tax';

export const WY_MODULE = noIncomeTaxModule({
  code: 'WY',
  name: 'Wyoming',
  ruleSet: 'us-wy-2026.1',
  sui: () => ({ wageBaseCents: d(33800), newEmployerRatePercent: null }),
});
