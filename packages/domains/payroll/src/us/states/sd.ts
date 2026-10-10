/**
 * South Dakota: no wage income tax. Reemployment assistance (UI) plus the
 * investment fee and, for experience-rated employers, the administrative fee.
 *
 * Sources (fetched 9 October 2026): SD DLR, https://dlr.sd.gov/ra/businesses/default.aspx
 * (2026 wage base remains $15,000) and https://dlr.sd.gov/ra/businesses/faq.aspx
 * (new employer rates); SDCL 61-5-24 (new employers 1.2% the first year,
 * 1.0% after with a positive balance; construction 6% / 3%), SDCL 61-5-29
 * (investment fee 0.55% for employers that are not experience rated, 0–0.53%
 * otherwise), SDCL 61-5-28.1 (from 2026 an administrative fee of 0.08% for
 * experience-rated employers). Neither fee may be deducted from wages.
 *
 * Without an entered rate the module uses the first-year non-construction
 * rate (1.2%) and the 0.55% investment fee. With an entered (experience)
 * rate it applies the 0.08% administrative fee; the investment fee then
 * comes from the rate notice (`extraRates.sd_investment_fee`, else 0.55%).
 */

import { d, rateCode } from './common';
import { noIncomeTaxModule } from './no-income-tax';

export const SD_MODULE = noIncomeTaxModule({
  code: 'SD',
  name: 'South Dakota',
  employerRateCodes: [rateCode('sd_investment_fee', 0.55), rateCode('sd_admin_fee')],
  ruleSet: 'us-sd-2026.1',
  sui: (input) => ({
    wageBaseCents: d(15000),
    newEmployerRatePercent: 1.2,
    surcharges: [
      { code: 'sd_investment_fee', labelKey: 'us.state_program.sd_investment_fee', rateKey: 'sd_investment_fee', defaultRatePercent: 0.55 },
      { code: 'sd_admin_fee', labelKey: 'us.state_program.sd_admin_fee', rateKey: 'sd_admin_fee', defaultRatePercent: input.suiRatePercent === null ? 0 : 0.08 },
    ],
  }),
});
