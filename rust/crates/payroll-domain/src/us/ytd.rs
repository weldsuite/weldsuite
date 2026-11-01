//! US year-to-date keys (`us/ytd.ts`).

pub mod keys {
    pub const GROSS: &str = "us.gross";
    pub const FIT_WAGES: &str = "us.fit_wages";
    pub const FIT: &str = "us.fit";
    pub const FIT_REGULAR: &str = "us.fit_regular";
    pub const SUPPLEMENTAL_WAGES: &str = "us.supplemental_wages";
    pub const SS_WAGES: &str = "us.ss_wages";
    pub const SS_TIPS: &str = "us.ss_tips";
    pub const SS_EMPLOYEE: &str = "us.ss_employee";
    pub const SS_EMPLOYER: &str = "us.ss_employer";
    pub const MEDICARE_WAGES: &str = "us.medicare_wages";
    pub const MEDICARE_EMPLOYEE: &str = "us.medicare_employee";
    pub const MEDICARE_EMPLOYER: &str = "us.medicare_employer";
    pub const ADDITIONAL_MEDICARE_WAGES: &str = "us.addl_medicare_wages";
    pub const ADDITIONAL_MEDICARE: &str = "us.addl_medicare";
    pub const FUTA_WAGES: &str = "us.futa_wages";
    pub const FUTA: &str = "us.futa";
    pub const FUTA_GROSS_WAGES: &str = "us.futa_gross_wages";
    pub const FUTA_EXEMPT_WAGES: &str = "us.futa_exempt_wages";
    pub const K401: &str = "us.401k";
    pub const ROTH401K: &str = "us.roth_401k";
    pub const SECTION125: &str = "us.section125";
    pub const HSA: &str = "us.hsa";
    pub const DEPENDENT_CARE: &str = "us.dependent_care";
    pub const EMPLOYER401K: &str = "us.employer_401k";
    pub const EMPLOYER_HEALTH: &str = "us.employer_health";
    pub const TIPS: &str = "us.tips";
    pub const QUALIFIED_OVERTIME: &str = "us.qualified_overtime";
    pub const NET: &str = "us.net";
}

/// `US_YTD_KEYS`, in the TypeScript's order.
pub const US_YTD_KEYS: [&str; 28] = [
    keys::GROSS,
    keys::FIT_WAGES,
    keys::FIT,
    keys::FIT_REGULAR,
    keys::SUPPLEMENTAL_WAGES,
    keys::SS_WAGES,
    keys::SS_TIPS,
    keys::SS_EMPLOYEE,
    keys::SS_EMPLOYER,
    keys::MEDICARE_WAGES,
    keys::MEDICARE_EMPLOYEE,
    keys::MEDICARE_EMPLOYER,
    keys::ADDITIONAL_MEDICARE_WAGES,
    keys::ADDITIONAL_MEDICARE,
    keys::FUTA_WAGES,
    keys::FUTA,
    keys::FUTA_GROSS_WAGES,
    keys::FUTA_EXEMPT_WAGES,
    keys::K401,
    keys::ROTH401K,
    keys::SECTION125,
    keys::HSA,
    keys::DEPENDENT_CARE,
    keys::EMPLOYER401K,
    keys::EMPLOYER_HEALTH,
    keys::TIPS,
    keys::QUALIFIED_OVERTIME,
    keys::NET,
];

/// `US_OT_CARRY_PREFIX`: a workweek that straddles two pay periods.
pub const US_OT_CARRY_PREFIX: &str = "us.ot_carry.";
