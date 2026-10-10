/**
 * Year-to-date accumulators of the US federal engine (`PayslipResult.ytd`).
 * All are cents for the calendar year of the pay date, same employer, except
 * the overtime carry keys below. State modules keep their own
 * `us.state.<ST>.*` keys in the same record.
 */

export const US_YTD = {
  /** Gross pay (tips included). */
  gross: 'us.gross',
  /** Federal income tax wages (W-2 box 1). */
  fitWages: 'us.fit_wages',
  /** Federal income tax withheld (box 2). */
  fit: 'us.fit',
  /** The part of `us.fit` withheld from regular wages (decides whether the 22% flat rate may be used). */
  fitRegular: 'us.fit_regular',
  /** Supplemental wages (bonus, commission): drives the $1 million mandatory 37% rule. */
  supplementalWages: 'us.supplemental_wages',
  /** Social Security wages taxed (box 3, wage base applied, tips excluded). */
  ssWages: 'us.ss_wages',
  /** Social Security tips taxed (box 7). Box 3 + box 7 never exceed the wage base. */
  ssTips: 'us.ss_tips',
  ssEmployee: 'us.ss_employee',
  ssEmployer: 'us.ss_employer',
  /** Medicare wages and tips (box 5). */
  medicareWages: 'us.medicare_wages',
  medicareEmployee: 'us.medicare_employee',
  medicareEmployer: 'us.medicare_employer',
  /** Wages subject to Additional Medicare Tax withholding (above $200,000), and the tax. */
  additionalMedicareWages: 'us.addl_medicare_wages',
  additionalMedicare: 'us.addl_medicare',
  /** FUTA wages taxed (first $7,000) and FUTA tax (credit reduction included). */
  futaWages: 'us.futa_wages',
  futa: 'us.futa',
  /** Payments counted for Form 940 line 3, and the FUTA-exempt part of them (line 4). */
  futaGrossWages: 'us.futa_gross_wages',
  futaExemptWages: 'us.futa_exempt_wages',
  /** Elective deferrals (pre-tax and Roth count together toward §402(g)). */
  k401: 'us.401k',
  roth401k: 'us.roth_401k',
  section125: 'us.section125',
  hsa: 'us.hsa',
  /** All dependent care deductions (box 10); the first $7,500 is excluded from wages. */
  dependentCare: 'us.dependent_care',
  employer401k: 'us.employer_401k',
  employerHealth: 'us.employer_health',
  /** Cash tips reported (box 12 code TP). */
  tips: 'us.tips',
  /** Qualified overtime compensation (box 12 code TT). */
  qualifiedOvertime: 'us.qualified_overtime',
  net: 'us.net',
} as const;

/** Every federal accumulator key. */
export const US_YTD_KEYS: readonly string[] = Object.values(US_YTD);

/**
 * Overtime carry for an FLSA workweek that straddles two pay periods
 * (`us.ot_carry.<workweek start YYYY-MM-DD>.<field>`). The engine settles a
 * workweek in the pay period that contains its last day; hours worked in
 * the earlier period are paid at straight time there and carried here:
 *
 * - `.d0` … `.d6`: hours worked on day N of the workweek, × 100 (integer),
 * - `.pay`: straight-time pay for those hours (cents),
 * - `.premium`: overtime premium already paid on them through manual
 *   overtime lines (cents).
 *
 * The keys disappear from `PayslipResult.ytd` once the workweek is settled.
 * At a tax-year boundary hr-api must copy any open `us.ot_carry.*` keys from
 * the last payslip of the old year into the first one of the new year.
 */
export const US_OT_CARRY_PREFIX = 'us.ot_carry.';
