/**
 * Labels for the state withholding certificate fields
 * (`StateModule.certificate.fields[].labelKey`), keyed by `<state>.<key>`, in
 * English and Dutch. Select options are `<state>.<key>.<option>`; `<state>.form`
 * is the form's full name. The UI renders state forms from these. Line
 * references follow the 2026 forms.
 */

type Label = { en: string; nl: string };

export const STATE_CERTIFICATE_LABELS: Record<string, Label> = {
  // ---- California, DE 4 (Rev. 56 1-26) -------------------------------------
  'CA.form': { en: "DE 4 — Employee's Withholding Allowance Certificate", nl: 'DE 4 — loonheffingsverklaring Californië' },
  'CA.filingStatus': { en: 'Filing status', nl: 'Aangiftestatus' },
  'CA.filingStatus.single': { en: 'Single or Married (with two or more incomes)', nl: 'Alleenstaand of gehuwd (twee of meer inkomens)' },
  'CA.filingStatus.married': { en: 'Married (one income)', nl: 'Gehuwd (één inkomen)' },
  'CA.filingStatus.head_of_household': { en: 'Head of Household', nl: 'Hoofd van het huishouden' },
  'CA.allowances': { en: 'Line 1a — Number of regular withholding allowances (Worksheet A)', nl: 'Regel 1a — aantal reguliere heffingskortingen (werkblad A)' },
  'CA.estimated_deduction_allowances': {
    en: 'Line 1b — Number of allowances from the estimated deductions (Worksheet B)',
    nl: 'Regel 1b — aantal extra kortingen voor geschatte aftrekposten (werkblad B)',
  },
  'CA.extraWithholding': { en: 'Line 2 — Additional amount withheld each pay period (Worksheet C)', nl: 'Regel 2 — extra in te houden bedrag per betaalperiode (werkblad C)' },
  'CA.exempt': { en: 'Line 3 — I claim exemption from withholding for 2026', nl: 'Regel 3 — ik vraag vrijstelling van inhouding aan voor 2026' },
  'CA.military_spouse_exempt': {
    en: 'Line 4 — Not subject to California withholding (Servicemember Civil Relief Act)',
    nl: 'Regel 4 — geen inhouding in Californië (Servicemember Civil Relief Act)',
  },

  // ---- New York, IT-2104 (2026) ---------------------------------------------
  'NY.form': { en: "IT-2104 — Employee's Withholding Allowance Certificate", nl: 'IT-2104 — loonheffingsverklaring New York' },
  'NY.filingStatus': { en: 'Filing status', nl: 'Aangiftestatus' },
  'NY.filingStatus.single': { en: 'Single or Head of household', nl: 'Alleenstaand of hoofd van het huishouden' },
  'NY.filingStatus.married': { en: 'Married', nl: 'Gehuwd' },
  'NY.filingStatus.married_higher_single': { en: 'Married, but withhold at higher single rate', nl: 'Gehuwd, maar inhouden tegen het hogere tarief voor alleenstaanden' },
  'NY.allowances': { en: 'Line 1 — Total number of allowances for New York State', nl: 'Regel 1 — totaal aantal kortingen voor de staat New York' },
  'NY.extraWithholding': { en: 'Line 3 — New York State additional amount per pay period', nl: 'Regel 3 — extra bedrag staat New York per betaalperiode' },
  'NY.nyc_resident': {
    en: 'Resident of New York City (city tax is not withheld by WeldSuite)',
    nl: 'Inwoner van New York City (stadsbelasting wordt niet door WeldSuite ingehouden)',
  },
  'NY.yonkers_resident': { en: 'Resident of Yonkers (Yonkers tax is not withheld by WeldSuite)', nl: 'Inwoner van Yonkers (Yonkers-belasting wordt niet door WeldSuite ingehouden)' },
  'NY.exempt': { en: 'Exempt from withholding (Form IT-2104-E)', nl: 'Vrijgesteld van inhouding (formulier IT-2104-E)' },

  // ---- Illinois, IL-W-4 -------------------------------------------------------
  'IL.form': { en: "IL-W-4 — Employee's Illinois Withholding Allowance Certificate", nl: 'IL-W-4 — loonheffingsverklaring Illinois' },
  'IL.allowances': { en: 'Line 1 — Total number of basic allowances', nl: 'Regel 1 — totaal aantal basiskortingen' },
  'IL.additional_allowances': { en: 'Line 2 — Total number of additional allowances', nl: 'Regel 2 — totaal aantal aanvullende kortingen' },
  'IL.extraWithholding': { en: 'Line 3 — Additional amount withheld from each pay', nl: 'Regel 3 — extra in te houden bedrag per betaling' },

  // ---- Pennsylvania, REV-419 --------------------------------------------------
  'PA.form': { en: "REV-419 — Employee's Nonwithholding Application Certificate", nl: 'REV-419 — verzoek om geen inhouding Pennsylvania' },
  'PA.exempt': {
    en: 'No Pennsylvania withholding (REV-419: resident of a reciprocal state such as New Jersey, or eligible for Tax Forgiveness)',
    nl: 'Geen inhouding in Pennsylvania (REV-419: inwoner van een verdragsstaat zoals New Jersey, of recht op Tax Forgiveness)',
  },

  // ---- Georgia, G-4 (Rev. 06/03/26) -------------------------------------------
  'GA.form': { en: "G-4 — Employee's Withholding Allowance Certificate", nl: 'G-4 — loonheffingsverklaring Georgia' },
  'GA.filingStatus': { en: 'Line 3 — Marital status', nl: 'Regel 3 — burgerlijke staat' },
  'GA.filingStatus.single': { en: 'A. Single', nl: 'A. Alleenstaand' },
  'GA.filingStatus.married_both_working': {
    en: 'B. Married Filing Separate or Married Filing Joint, both spouses working',
    nl: 'B. Gehuwd, aparte aangifte, of gezamenlijke aangifte met twee werkende partners',
  },
  'GA.filingStatus.married_one_working': { en: 'C. Married Filing Joint, one spouse working', nl: 'C. Gehuwd, gezamenlijke aangifte, één werkende partner' },
  'GA.filingStatus.head_of_household': { en: 'D. Head of Household', nl: 'D. Hoofd van het huishouden' },
  'GA.dependent_allowances': { en: 'Line 4 — Dependent allowances', nl: 'Regel 4 — kortingen voor ten laste komende personen' },
  'GA.adjustment_allowances': { en: 'Line 5 — Georgia adjustments allowance (worksheet required)', nl: 'Regel 5 — Georgia-correctiekortingen (werkblad verplicht)' },
  'GA.extraWithholding': { en: 'Line 6 — Additional withholding per pay period', nl: 'Regel 6 — extra inhouding per betaalperiode' },
  'GA.exempt': {
    en: 'Line 8a — Exempt: no Georgia income tax liability last year and none expected this year',
    nl: 'Regel 8a — vrijgesteld: vorig jaar geen inkomstenbelasting in Georgia verschuldigd en dit jaar ook niet verwacht',
  },
  'GA.military_spouse_exempt': {
    en: 'Line 8b — Not subject to Georgia withholding (Servicemembers Civil Relief Act)',
    nl: 'Regel 8b — geen inhouding in Georgia (Servicemembers Civil Relief Act)',
  },

  // ---- North Carolina, NC-4 / NC-4 EZ -----------------------------------------
  'NC.form': { en: "NC-4 — Employee's Withholding Allowance Certificate", nl: 'NC-4 — loonheffingsverklaring Noord-Carolina' },
  'NC.filingStatus': { en: 'Filing status', nl: 'Aangiftestatus' },
  'NC.filingStatus.single': { en: 'Single or Married Filing Separately', nl: 'Alleenstaand of gehuwd met aparte aangifte' },
  'NC.filingStatus.married': { en: 'Married Filing Jointly or Surviving Spouse', nl: 'Gehuwd met gezamenlijke aangifte of nabestaande partner' },
  'NC.filingStatus.head_of_household': { en: 'Head of Household', nl: 'Hoofd van het huishouden' },
  'NC.allowances': { en: 'Line 1 — Total number of allowances', nl: 'Regel 1 — totaal aantal kortingen' },
  'NC.extraWithholding': { en: 'Line 2 — Additional amount withheld each pay period (whole dollars)', nl: 'Regel 2 — extra in te houden bedrag per betaalperiode (hele dollars)' },
  'NC.exempt': {
    en: 'NC-4 EZ line 3 — Exempt: no North Carolina tax liability last year and none expected this year',
    nl: 'NC-4 EZ regel 3 — vrijgesteld: vorig jaar geen belasting in Noord-Carolina verschuldigd en dit jaar ook niet verwacht',
  },
  'NC.military_spouse_exempt': {
    en: 'NC-4 EZ line 4 — Exempt under the Servicemembers Civil Relief Act',
    nl: 'NC-4 EZ regel 4 — vrijgesteld op grond van de Servicemembers Civil Relief Act',
  },

  // ---- New Jersey, NJ-W4 (1-21) -----------------------------------------------
  'NJ.form': { en: "NJ-W4 — Employee's Withholding Allowance Certificate", nl: 'NJ-W4 — loonheffingsverklaring New Jersey' },
  'NJ.filingStatus': { en: 'Line 2 — Filing status', nl: 'Regel 2 — aangiftestatus' },
  'NJ.filingStatus.single': { en: '1. Single', nl: '1. Alleenstaand' },
  'NJ.filingStatus.married_joint': { en: '2. Married/Civil Union Couple Joint', nl: '2. Gehuwd/geregistreerd partnerschap, gezamenlijke aangifte' },
  'NJ.filingStatus.married_separate': { en: '3. Married/Civil Union Partner Separate', nl: '3. Gehuwd/geregistreerd partnerschap, aparte aangifte' },
  'NJ.filingStatus.head_of_household': { en: '4. Head of Household', nl: '4. Hoofd van het huishouden' },
  'NJ.filingStatus.qualifying_widow': { en: '5. Qualifying Widow(er)/Surviving Civil Union Partner', nl: '5. Weduwe/weduwnaar of nabestaande geregistreerd partner' },
  'NJ.rate_table': { en: 'Line 3 — Rate table letter from the wage chart (instruction A)', nl: 'Regel 3 — letter van de tarieftabel uit de loontabel (instructie A)' },
  'NJ.rate_table.A': { en: 'Rate A', nl: 'Tarief A' },
  'NJ.rate_table.B': { en: 'Rate B', nl: 'Tarief B' },
  'NJ.rate_table.C': { en: 'Rate C', nl: 'Tarief C' },
  'NJ.rate_table.D': { en: 'Rate D', nl: 'Tarief D' },
  'NJ.rate_table.E': { en: 'Rate E', nl: 'Tarief E' },
  'NJ.allowances': { en: 'Line 4 — Total number of allowances', nl: 'Regel 4 — totaal aantal kortingen' },
  'NJ.extraWithholding': { en: 'Line 5 — Additional amount deducted from each pay', nl: 'Regel 5 — extra in te houden bedrag per betaling' },
  'NJ.exempt': { en: 'Line 6 — EXEMPT from New Jersey Gross Income Tax withholding', nl: 'Regel 6 — VRIJGESTELD van inhouding New Jersey Gross Income Tax' },
  'NJ.nj165_pa_resident': {
    en: "Pennsylvania resident with Form NJ-165 (Employee's Certificate of Nonresidence in New Jersey)",
    nl: 'Inwoner van Pennsylvania met formulier NJ-165 (verklaring van niet-ingezetenschap New Jersey)',
  },

  // ---- Arizona, A-4 (2026) ----------------------------------------------------
  'AZ.form': { en: "A-4 — Employee's Arizona Withholding Election", nl: 'A-4 — keuze inhoudingspercentage Arizona' },
  'AZ.withholding_percent': { en: 'Box 1 — Percentage of gross taxable wages to withhold', nl: 'Vak 1 — in te houden percentage van het belastbare brutoloon' },
  'AZ.withholding_percent.0.5': { en: '0.5%', nl: '0,5%' },
  'AZ.withholding_percent.1.0': { en: '1.0%', nl: '1,0%' },
  'AZ.withholding_percent.1.5': { en: '1.5%', nl: '1,5%' },
  'AZ.withholding_percent.2.0': { en: '2.0%', nl: '2,0%' },
  'AZ.withholding_percent.2.5': { en: '2.5%', nl: '2,5%' },
  'AZ.withholding_percent.3.0': { en: '3.0%', nl: '3,0%' },
  'AZ.withholding_percent.3.5': { en: '3.5%', nl: '3,5%' },
  'AZ.extraWithholding': { en: 'Box 1 — Extra amount withheld from each paycheck', nl: 'Vak 1 — extra in te houden bedrag per salarisbetaling' },
  'AZ.exempt': {
    en: 'Box 2 — Arizona withholding percentage of zero (no Arizona tax liability expected)',
    nl: 'Vak 2 — inhoudingspercentage nul (geen belasting in Arizona verwacht)',
  },

  // ---- Colorado, DR 0004 ------------------------------------------------------
  'CO.form': { en: 'DR 0004 — Colorado Employee Withholding Certificate', nl: 'DR 0004 — loonheffingsverklaring Colorado' },
  'CO.withholding_allowance': {
    en: 'Line 2 — Annual withholding allowance (leave empty to use the federal W-4 filing status)',
    nl: 'Regel 2 — jaarlijkse heffingskorting (leeg laten om de aangiftestatus van de federale W-4 te gebruiken)',
  },
  'CO.extraWithholding': { en: 'Line 3 — Additional withholding per pay period', nl: 'Regel 3 — extra inhouding per betaalperiode' },

  // ---- Massachusetts, M-4 (Rev. 3/24) -----------------------------------------
  'MA.form': { en: "M-4 — Massachusetts Employee's Withholding Exemption Certificate", nl: 'M-4 — verklaring vrijstellingen loonheffing Massachusetts' },
  'MA.allowances': {
    en: 'Line 4 — Total number of withholding exemptions (a claimed spouse counts as 4)',
    nl: 'Regel 4 — totaal aantal vrijstellingen (een opgegeven partner telt als 4)',
  },
  'MA.extraWithholding': { en: 'Line 5 — Additional withholding per pay period', nl: 'Regel 5 — extra inhouding per betaalperiode' },
  'MA.head_of_household': { en: 'A — You will file as head of household', nl: 'A — u doet aangifte als hoofd van het huishouden' },
  'MA.blind': { en: 'B — You are blind', nl: 'B — u bent blind' },
  'MA.spouse_blind': { en: 'C — Your spouse is blind and not subject to withholding', nl: 'C — uw partner is blind en heeft geen inhouding' },
  'MA.full_time_student': {
    en: 'D — Full-time student in seasonal, part-time or temporary work earning no more than $8,000 a year',
    nl: 'D — voltijdstudent met seizoens-, deeltijd- of tijdelijk werk en hoogstens $8.000 inkomen per jaar',
  },
  'MA.military_spouse_exempt': { en: 'Exempt under MSRRA (Form M-4-MS)', nl: 'Vrijgesteld op grond van MSRRA (formulier M-4-MS)' },

  // ---- Washington, WA Cares exemption -----------------------------------------
  'WA.form': { en: 'WA Cares Fund exemption', nl: 'Vrijstelling WA Cares Fund' },
  'WA.wa_cares_exempt': {
    en: 'Approved WA Cares exemption (ESD exemption approval letter given to the employer)',
    nl: 'Goedgekeurde vrijstelling WA Cares (goedkeuringsbrief van ESD aan de werkgever gegeven)',
  },
};
