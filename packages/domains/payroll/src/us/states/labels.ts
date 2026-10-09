/**
 * Payslip line labels emitted by the state modules, in English and Dutch:
 * state income tax (`us.state_income_tax.<ST>`), employer and employee SUI
 * (`us.state_sui_employer.<ST>`, `us.state_sui_employee.<ST>`) and every
 * program code (`us.state_program.<code>`).
 */

type Label = { en: string; nl: string };

/** State names; Dutch uses its own exonyms where they are customary. */
export const STATE_NAMES: Record<string, Label> = {
  AK: { en: 'Alaska', nl: 'Alaska' },
  AZ: { en: 'Arizona', nl: 'Arizona' },
  CA: { en: 'California', nl: 'Californië' },
  CO: { en: 'Colorado', nl: 'Colorado' },
  FL: { en: 'Florida', nl: 'Florida' },
  GA: { en: 'Georgia', nl: 'Georgia' },
  IL: { en: 'Illinois', nl: 'Illinois' },
  MA: { en: 'Massachusetts', nl: 'Massachusetts' },
  NC: { en: 'North Carolina', nl: 'Noord-Carolina' },
  NH: { en: 'New Hampshire', nl: 'New Hampshire' },
  NJ: { en: 'New Jersey', nl: 'New Jersey' },
  NV: { en: 'Nevada', nl: 'Nevada' },
  NY: { en: 'New York', nl: 'New York' },
  PA: { en: 'Pennsylvania', nl: 'Pennsylvania' },
  SD: { en: 'South Dakota', nl: 'Zuid-Dakota' },
  TN: { en: 'Tennessee', nl: 'Tennessee' },
  TX: { en: 'Texas', nl: 'Texas' },
  WA: { en: 'Washington', nl: 'Washington' },
  WY: { en: 'Wyoming', nl: 'Wyoming' },
};

const INCOME_TAX_STATES = ['AZ', 'CA', 'CO', 'GA', 'IL', 'MA', 'NC', 'NJ', 'NY', 'PA'];
const EMPLOYEE_SUI_STATES = ['AK', 'NJ', 'PA'];

const PROGRAM_LABELS: Record<string, Label> = {
  ca_sdi: { en: 'CA SDI (disability insurance and paid family leave)', nl: 'CA SDI (arbeidsongeschiktheid en betaald familieverlof)' },
  ca_ett: { en: 'CA Employment Training Tax', nl: 'CA opleidingsheffing (ETT)' },
  ny_pfl: { en: 'NY Paid Family Leave', nl: 'NY betaald familieverlof (PFL)' },
  ny_dbl: { en: 'NY disability benefits (DBL)', nl: 'NY arbeidsongeschiktheidsuitkering (DBL)' },
  ny_rsf: { en: 'NY Re-employment Service Fund', nl: 'NY re-integratiefonds (RSF)' },
  nj_tdi: { en: 'NJ temporary disability insurance (TDI)', nl: 'NJ tijdelijke arbeidsongeschiktheidsverzekering (TDI)' },
  nj_tdi_employer: { en: 'NJ temporary disability insurance (employer)', nl: 'NJ tijdelijke arbeidsongeschiktheidsverzekering (werkgever)' },
  nj_fli: { en: 'NJ family leave insurance (FLI)', nl: 'NJ familieverlofverzekering (FLI)' },
  nj_wf_swf: { en: 'NJ Workforce Development and Supplemental Workforce Fund (employer)', nl: 'NJ arbeidsmarktfondsen WF/SWF (werkgever)' },
  ga_admin_assessment: { en: 'GA UI administrative assessment', nl: 'GA administratieve heffing werkloosheidsverzekering' },
  nv_cep: { en: 'NV Career Enhancement Program', nl: 'NV loopbaanprogramma (CEP)' },
  sd_investment_fee: { en: 'SD investment fee', nl: 'SD investeringsheffing' },
  sd_admin_fee: { en: 'SD administrative fee', nl: 'SD administratieve heffing' },
  ma_pfml: { en: 'MA paid family and medical leave (PFML)', nl: 'MA betaald familie- en ziekteverlof (PFML)' },
  ma_covid_recovery: { en: 'MA COVID-19 recovery assessment', nl: 'MA COVID-19-herstelheffing' },
  ma_wtf: { en: 'MA Workforce Training Fund', nl: 'MA opleidingsfonds (WTFP)' },
  ma_emac: { en: 'MA employer medical assistance contribution (EMAC)', nl: 'MA werkgeversbijdrage zorg (EMAC)' },
  co_famli: { en: 'CO FAMLI (paid family and medical leave)', nl: 'CO FAMLI (betaald familie- en ziekteverlof)' },
  wa_pfml: { en: 'WA paid family and medical leave', nl: 'WA betaald familie- en ziekteverlof' },
  wa_cares: { en: 'WA Cares Fund (long-term care)', nl: 'WA Cares Fund (langdurige zorg)' },
  wa_eaf: { en: 'WA employment administration fund', nl: 'WA administratiefonds werkloosheidsverzekering (EAF)' },
};

/** Employee SUI lines whose official name differs from "unemployment insurance". */
const EMPLOYEE_SUI_OVERRIDES: Record<string, Label> = {
  NJ: { en: 'NJ unemployment and workforce funds (UI/WF/SWF)', nl: 'NJ werkloosheids- en arbeidsmarktfondsen (UI/WF/SWF)' },
  PA: { en: 'PA unemployment compensation (employee)', nl: 'Werkloosheidsverzekering Pennsylvania (werknemer)' },
};

function build(): Record<string, Label> {
  const labels: Record<string, Label> = {};
  for (const state of INCOME_TAX_STATES) {
    const name = STATE_NAMES[state];
    labels[`us.state_income_tax.${state}`] = { en: `${name.en} income tax`, nl: `Inkomstenbelasting ${name.nl}` };
  }
  for (const [state, name] of Object.entries(STATE_NAMES)) {
    labels[`us.state_sui_employer.${state}`] = {
      en: `${name.en} unemployment insurance (employer)`,
      nl: `Werkloosheidsverzekering ${name.nl} (werkgever)`,
    };
  }
  for (const state of EMPLOYEE_SUI_STATES) {
    const name = STATE_NAMES[state];
    labels[`us.state_sui_employee.${state}`] = EMPLOYEE_SUI_OVERRIDES[state] ?? {
      en: `${name.en} unemployment insurance (employee)`,
      nl: `Werkloosheidsverzekering ${name.nl} (werknemer)`,
    };
  }
  for (const [code, label] of Object.entries(PROGRAM_LABELS)) labels[`us.state_program.${code}`] = label;
  return labels;
}

/** Payslip line labels emitted by the state modules. */
export const STATE_PAYSLIP_LABELS: Record<string, Label> = build();

/** Labels of `StateModule.employerRateCodes` (keys `employer_rate.<code>`), for the employer setup UI. Percent values. */
export const STATE_EMPLOYER_RATE_LABELS: Record<string, Label> = {
  'employer_rate.ca_ett': { en: 'CA Employment Training Tax rate', nl: 'CA opleidingsheffing (ETT), tarief' },
  'employer_rate.ny_rsf': { en: 'NY Re-employment Service Fund rate', nl: 'NY re-integratiefonds (RSF), tarief' },
  'employer_rate.ny_pfl_employee': {
    en: 'NY Paid Family Leave: employee deduction rate (0 when the employer pays it)',
    nl: 'NY betaald familieverlof: inhoudingspercentage werknemer (0 als de werkgever het betaalt)',
  },
  'employer_rate.ny_dbl_employee': {
    en: 'NY disability benefits (DBL): employee deduction rate, at most $0.60 a week (0 when the employer pays it)',
    nl: 'NY arbeidsongeschiktheid (DBL): inhoudingspercentage werknemer, hoogstens $0,60 per week (0 als de werkgever het betaalt)',
  },
  'employer_rate.nj_employer_tdi': { en: 'NJ employer temporary disability (TDI) rate', nl: 'NJ werkgeverstarief tijdelijke arbeidsongeschiktheid (TDI)' },
  'employer_rate.nj_wf_swf': {
    en: 'NJ employer Workforce Development / Supplemental Workforce Fund rate',
    nl: 'NJ werkgeverstarief arbeidsmarktfondsen (WF/SWF)',
  },
  'employer_rate.nj_tdi_employee': {
    en: 'NJ worker TDI rate (0 under an approved private plan)',
    nl: 'NJ werknemerstarief TDI (0 bij een goedgekeurde particuliere regeling)',
  },
  'employer_rate.nj_fli_employee': {
    en: 'NJ worker family leave insurance rate (0 under an approved private plan)',
    nl: 'NJ werknemerstarief familieverlofverzekering (0 bij een goedgekeurde particuliere regeling)',
  },
  'employer_rate.ga_admin_assessment': { en: 'GA UI administrative assessment rate', nl: 'GA administratieve heffing werkloosheidsverzekering, tarief' },
  'employer_rate.nv_cep': { en: 'NV Career Enhancement Program rate', nl: 'NV loopbaanprogramma (CEP), tarief' },
  'employer_rate.sd_investment_fee': { en: 'SD investment fee rate', nl: 'SD investeringsheffing, tarief' },
  'employer_rate.sd_admin_fee': { en: 'SD administrative fee rate (experience-rated employers)', nl: 'SD administratieve heffing, tarief (werkgevers met ervaringstarief)' },
  'employer_rate.ma_covid_recovery': {
    en: 'MA COVID-19 recovery assessment rate (derived from the UI rate when empty)',
    nl: 'MA COVID-19-herstelheffing, tarief (afgeleid van het WW-tarief als leeg)',
  },
  'employer_rate.ma_wtf': { en: 'MA Workforce Training Fund rate', nl: 'MA opleidingsfonds (WTFP), tarief' },
  'employer_rate.ma_emac': { en: 'MA employer medical assistance contribution (EMAC) rate', nl: 'MA werkgeversbijdrage zorg (EMAC), tarief' },
  'employer_rate.ma_pfml_employee': {
    en: 'MA PFML: employee deduction rate (at most 0.46%)',
    nl: 'MA PFML: inhoudingspercentage werknemer (hoogstens 0,46%)',
  },
  'employer_rate.co_famli_employee': {
    en: 'CO FAMLI: employee deduction rate (at most 0.44%)',
    nl: 'CO FAMLI: inhoudingspercentage werknemer (hoogstens 0,44%)',
  },
  'employer_rate.wa_eaf': {
    en: 'WA employment administration fund rate (0.02% for rate classes 20 and 40 and new employers)',
    nl: 'WA administratiefonds (EAF), tarief (0,02% voor tariefklassen 20 en 40 en nieuwe werkgevers)',
  },
  'employer_rate.wa_pfml_employee': {
    en: 'WA Paid Leave: employee deduction rate (at most 0.807159%)',
    nl: 'WA betaald verlof: inhoudingspercentage werknemer (hoogstens 0,807159%)',
  },
};

/**
 * What the employer enters as its SUI rate (`suiRatePercent`) per state:
 * states differ on whether the surcharges on the rate notice are in it.
 */
export const STATE_SUI_RATE_NOTES: Record<string, Label> = {
  AK: { en: 'Employer UI rate from the notice (the 0.5% employee share is separate).', nl: 'Werkgeverstarief WW volgens de beschikking (de werknemersbijdrage van 0,5% staat apart).' },
  AZ: { en: 'UI rate from the DES rate notice.', nl: 'WW-tarief volgens de beschikking van DES.' },
  CA: { en: 'UI rate from the DE 2088 notice, without the ETT.', nl: 'WW-tarief volgens de DE 2088, zonder de ETT.' },
  CO: { en: 'Total combined rate (base + support + solvency surcharge).', nl: 'Totaal gecombineerd tarief (basis + support + solvabiliteitstoeslag).' },
  FL: { en: 'Reemployment tax rate from the notice.', nl: 'Reemployment-tarief volgens de beschikking.' },
  GA: { en: 'Contribution rate, without the 0.06% administrative assessment.', nl: 'Premietarief, zonder de administratieve heffing van 0,06%.' },
  IL: { en: 'Contribution rate from the IDES notice (fund building rate included).', nl: 'Premietarief volgens de IDES-beschikking (fund building rate inbegrepen).' },
  MA: { en: 'UI rate, without the COVID-19 recovery assessment, WTFP and EMAC.', nl: 'WW-tarief, zonder COVID-19-herstelheffing, WTFP en EMAC.' },
  NC: { en: 'UI rate from the DES notice.', nl: 'WW-tarief volgens de DES-beschikking.' },
  NH: { en: 'Net rate after the fund balance reduction (administrative contribution included).', nl: 'Nettotarief na de fondskorting (administratieve bijdrage inbegrepen).' },
  NJ: { en: 'Total unemployment rate from Table C, WF/SWF included (e.g. 2.8% for new employers).', nl: 'Totaal werkloosheidstarief uit tabel C, inclusief WF/SWF (bijv. 2,8% voor nieuwe werkgevers).' },
  NV: { en: 'UI rate, without the 0.05% Career Enhancement Program.', nl: 'WW-tarief, zonder het Career Enhancement Program van 0,05%.' },
  NY: { en: 'UI rate (normal + subsidiary), without the 0.075% Re-employment Service Fund.', nl: 'WW-tarief (normal + subsidiary), zonder het re-integratiefonds van 0,075%.' },
  PA: { en: 'Total contribution rate from the UC notice (surcharge included).', nl: 'Totaal premietarief volgens de UC-beschikking (toeslag inbegrepen).' },
  SD: { en: 'Reemployment assistance rate, without the investment and administrative fees.', nl: 'Reemployment-tarief, zonder investerings- en administratieve heffing.' },
  TN: { en: 'Premium rate from the notice.', nl: 'Premietarief volgens de beschikking.' },
  TX: { en: 'Effective tax rate from the TWC notice (assessments included).', nl: 'Effectief tarief volgens de TWC-beschikking (heffingen inbegrepen).' },
  WA: { en: 'Total UI rate (experience + social cost), without the EAF; required, new employers get an industry rate.', nl: 'Totaal WW-tarief (ervaring + sociale kosten), zonder de EAF; verplicht, nieuwe werkgevers krijgen een branchetarief.' },
  WY: { en: 'Total tax rate from the DWS notice; required, new employers get an industry rate.', nl: 'Totaal tarief volgens de DWS-beschikking; verplicht, nieuwe werkgevers krijgen een branchetarief.' },
};
