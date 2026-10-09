/**
 * Payslip line labels of the Dutch engine, keyed by `PayslipLine.labelKey`,
 * in the terms Dutch payslips use (Handboek Loonheffingen §12 lists what a
 * loonstrook must show). Wage-base keys (`nl.loon_lb`, …) are labelled too so
 * a payslip or report can name the bases a line counts in.
 */
export const NL_PAYSLIP_LABELS: Record<string, { en: string; nl: string }> = {
  // Earnings
  'nl.salary': { en: 'Salary', nl: 'Salaris' },
  'nl.hours_regular': { en: 'Hours worked', nl: 'Gewerkte uren' },
  'nl.overtime': { en: 'Overtime', nl: 'Overwerk' },
  'nl.unpaid_leave': { en: 'Unpaid leave', nl: 'Onbetaald verlof' },
  'nl.sick_pay_reduction': { en: 'Sick pay reduction', nl: 'Korting loondoorbetaling bij ziekte' },
  'nl.allowance_taxable': { en: 'Allowance', nl: 'Toeslag' },
  'nl.bonus': { en: 'Bonus', nl: 'Bonus' },
  'nl.commission': { en: 'Commission', nl: 'Provisie' },
  'nl.thirteenth_month': { en: '13th month', nl: 'Dertiende maand' },
  'nl.leave_payout': { en: 'Payout of untaken leave', nl: 'Uitbetaling vakantie-uren' },
  'nl.holiday_allowance': { en: 'Holiday allowance', nl: 'Vakantiegeld' },
  'nl.transition_payment': { en: 'Transition payment', nl: 'Transitievergoeding' },
  'nl.travel_allowance_taxable': { en: 'Travel allowance (taxable part)', nl: 'Reiskostenvergoeding (belast deel)' },
  'nl.home_working_allowance_taxable': { en: 'Home-working allowance (taxable part)', nl: 'Thuiswerkvergoeding (belast deel)' },

  // Wage in kind and tax-free parts
  'nl.company_car': { en: 'Company car private use (taxable benefit)', nl: 'Bijtelling auto van de zaak' },
  'nl.expat_allowance': { en: '30% ruling allowance (tax-free)', nl: 'Vergoeding extraterritoriale kosten (30%-regeling)' },

  // Deductions
  'nl.pension_employee': { en: 'Pension contribution', nl: 'Pensioenpremie werknemer' },
  'nl.company_car_contribution': { en: 'Own contribution company car', nl: 'Eigen bijdrage auto van de zaak' },
  'nl.deduction_net': { en: 'Net deduction', nl: 'Netto inhouding' },

  // Taxes
  'nl.wage_tax': { en: 'Wage tax and national insurance', nl: 'Loonheffing' },
  'nl.wage_tax_special': { en: 'Wage tax on special payments', nl: 'Loonheffing bijzondere beloningen' },
  'nl.zvw_contribution': { en: 'Health insurance contribution (Zvw)', nl: 'Bijdrage Zvw' },

  // Reimbursements (net, tax-free)
  'nl.travel_allowance': { en: 'Travel allowance', nl: 'Reiskostenvergoeding' },
  'nl.home_working_allowance': { en: 'Home-working allowance', nl: 'Thuiswerkvergoeding' },
  'nl.reimbursement': { en: 'Expense reimbursement', nl: 'Onkostenvergoeding' },
  'nl.advance': { en: 'Advance', nl: 'Voorschot' },

  // Employer costs
  'nl.awf_premium': { en: 'Unemployment insurance premium (AWf)', nl: 'Premie AWf' },
  'nl.aof_premium': { en: 'Disability insurance premium (Aof)', nl: 'Premie Aof' },
  'nl.wko_premium': { en: 'Childcare surcharge (Wko)', nl: 'Opslag Wko' },
  'nl.whk_premium': { en: 'Return-to-work fund premium (Whk)', nl: 'Premie Whk' },
  'nl.zvw_employer_levy': { en: 'Employer health insurance levy (Zvw)', nl: 'Werkgeversheffing Zvw' },
  'nl.pension_employer': { en: 'Employer pension contribution', nl: 'Pensioenpremie werkgever' },

  // Information
  'nl.labour_credit': { en: 'Labour tax credit applied', nl: 'Verrekende arbeidskorting' },
  'nl.holiday_allowance_accrued': { en: 'Holiday allowance reserved', nl: 'Reservering vakantiegeld' },
  'nl.minimum_wage': { en: 'Statutory minimum hourly wage', nl: 'Wettelijk minimumuurloon' },

  // Wage bases (`PayslipLine.bases`)
  'nl.loon_lb': { en: 'Wage for wage tax', nl: 'Loon voor de loonheffing' },
  'nl.loon_sv': { en: 'Wage for employee insurances', nl: 'Loon werknemersverzekeringen (SV-loon)' },
  'nl.loon_zvw': { en: 'Wage for the Zvw', nl: 'Loon Zvw' },
  'nl.loon_bb': { en: 'Taxed with the special-payments table', nl: 'Loon tabel bijzondere beloningen' },
};
