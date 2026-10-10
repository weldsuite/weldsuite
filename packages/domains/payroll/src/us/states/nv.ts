/**
 * Nevada: no wage income tax. UI plus the Career Enhancement Program (CEP).
 *
 * Sources (fetched 9 October 2026, read in a browser: detr.nv.gov blocks
 * automated fetches): DETR, https://detr.nv.gov/Page/UI_Tax and
 * https://detr.nv.gov/Page/NUI_View_Quarterly_Reporting_Info: 2026 wage base
 * $43,700; new employer rate 2.95%; CEP 0.05% on the same taxable wages,
 * paid by every employer except those at the 5.4% rate; no employee share.
 *
 * The Modified Business Tax (Department of Taxation, on quarterly gross
 * wages above $50,000) is an employer-level quarterly return, not a per-
 * payslip tax, and is not computed here.
 */

import { d, rateCode } from './common';
import { noIncomeTaxModule } from './no-income-tax';

export const NV_MODULE = noIncomeTaxModule({
  code: 'NV',
  name: 'Nevada',
  employerRateCodes: [rateCode('nv_cep', 0.05)],
  ruleSet: 'us-nv-2026.1',
  sui: (input) => ({
    wageBaseCents: d(43700),
    newEmployerRatePercent: 2.95,
    surcharges: [
      {
        code: 'nv_cep',
        labelKey: 'us.state_program.nv_cep',
        rateKey: 'nv_cep',
        defaultRatePercent: (input.suiRatePercent ?? 0) >= 5.4 ? 0 : 0.05,
      },
    ],
  }),
});
