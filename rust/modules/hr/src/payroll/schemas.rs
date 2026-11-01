//! The request schemas of the payroll routes
//! (`@weldsuite/app-api-client/schemas/weldhr-payroll`), field for field.

use serde_json::{Value, json};

use super::schema::{
    Check, S, id, int, iso_date, money, non_negative_money, number, percent, short_text, short_text_required, string, us_state,
    year_key,
};

fn loonheffingennummer(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 12
        && b[..9].iter().all(u8::is_ascii_digit)
        && (b[9] == b'L' || b[9] == b'l')
        && b[10..].iter().all(u8::is_ascii_digit)
}

fn ein(text: &str) -> bool {
    let digits: Vec<u8> = text.bytes().filter(|b| *b != b'-').collect();
    let b = text.as_bytes();
    (b.len() == 9 && b.iter().all(u8::is_ascii_digit))
        || (b.len() == 10 && b[2] == b'-' && digits.len() == 9 && digits.iter().all(u8::is_ascii_digit))
}

fn nine_digits(text: &str) -> bool {
    text.len() == 9 && text.bytes().all(|b| b.is_ascii_digit())
}

fn four_to_seventeen_digits(text: &str) -> bool {
    (4..=17).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit())
}

fn two_digits(text: &str) -> bool {
    text.len() == 2 && text.bytes().all(|b| b.is_ascii_digit())
}

/// `/^\d{3}-?\d{2}-?\d{4}$|^\d{8,9}$/`.
fn bsn_or_ssn(text: &str) -> bool {
    let b = text.as_bytes();
    if (8..=9).contains(&b.len()) && b.iter().all(u8::is_ascii_digit) {
        return true;
    }
    let parts: Vec<&str> = text.split('-').collect();
    let all_digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    match parts.as_slice() {
        [whole] => whole.len() == 9 && all_digits(whole),
        [a, rest] => {
            all_digits(a)
                && all_digits(rest)
                && ((a.len() == 3 && rest.len() == 6) || (a.len() == 5 && rest.len() == 4))
        }
        [a, b2, c] => a.len() == 3 && b2.len() == 2 && c.len() == 4 && all_digits(a) && all_digits(b2) && all_digits(c),
        _ => false,
    }
}

fn obj(fields: Vec<(&'static str, S)>) -> S {
    S::Obj(fields)
}

pub(crate) fn address() -> S {
    obj(vec![
        ("line1", short_text(255).nullish()),
        ("line2", short_text(255).nullish()),
        ("houseNumber", short_text(20).nullish()),
        ("houseNumberAddition", short_text(20).nullish()),
        ("postalCode", short_text(20).nullish()),
        ("city", short_text(120).nullish()),
        ("region", short_text(120).nullish()),
        ("country", string(&[Check::Length(2)]).nullish()),
    ])
}

fn year_string() -> S {
    string(&[Check::Regex(year_key, "Invalid")])
}

fn nl_settings() -> S {
    obj(vec![
        (
            "loonheffingennummer",
            string(&[Check::Trim, Check::Regex(loonheffingennummer, "Expected a loonheffingennummer like 123456789L01")])
                .nullish(),
        ),
        ("sectorCode", int(Some(1.0), Some(99.0)).nullish()),
        (
            "years",
            S::Record(
                Box::new(year_string()),
                Box::new(obj(vec![("whkRate", percent().nullish()), ("aofSmallEmployer", S::Bool.nullish())])),
            )
            .optional(),
        ),
        ("holidayAllowancePercent", percent().nullish()),
        ("holidayAllowancePayoutMonth", int(Some(1.0), Some(12.0)).nullish()),
        ("payslipLanguage", S::Enum(&["nl", "en"]).nullish()),
        ("contactName", short_text(120).nullish()),
        ("contactPhone", short_text(40).nullish()),
    ])
}

fn us_state_settings() -> S {
    obj(vec![
        ("withholdingAccountNumber", short_text(60).nullish()),
        ("suiAccountNumber", short_text(60).nullish()),
        ("suiRates", S::Record(Box::new(year_string()), Box::new(percent())).optional()),
        (
            "extraRates",
            S::Record(
                Box::new(year_string()),
                Box::new(S::Record(Box::new(string(&[Check::Max(60)])), Box::new(percent()))),
            )
            .optional(),
        ),
    ])
}

fn us_settings() -> S {
    obj(vec![
        ("ein", string(&[Check::Trim, Check::Regex(ein, "Expected an EIN like 12-3456789")]).nullish()),
        ("depositSchedule", S::Enum(&["monthly", "semiweekly"]).nullish()),
        ("workweekStartDay", int(Some(0.0), Some(6.0)).nullish()),
        ("states", S::Record(Box::new(us_state()), Box::new(us_state_settings())).optional()),
        ("employeeCountEstimate", int(Some(0.0), Some(1_000_000.0)).nullish()),
    ])
}

/// `createHrPayrollEmployerSchema`.
pub(crate) fn create_employer() -> S {
    obj(vec![
        ("name", short_text_required(160)),
        ("legalName", short_text_required(255)),
        ("country", S::Enum(&["NL", "US"])),
        ("currency", string(&[Check::Length(3)]).optional()),
        ("accountingEntityId", id().nullish()),
        ("address", address().optional()),
        ("nlSettings", nl_settings().optional()),
        ("usSettings", us_settings().optional()),
        ("requireSeparateApprover", S::Bool.optional()),
    ])
}

/// `updateHrPayrollEmployerSchema`: the create schema without country and
/// currency, every field optional, and `isActive`.
pub(crate) fn update_employer() -> S {
    obj(vec![
        ("name", short_text_required(160).optional()),
        ("legalName", short_text_required(255).optional()),
        ("accountingEntityId", id().nullish()),
        ("address", address().optional()),
        ("nlSettings", nl_settings().optional()),
        ("usSettings", us_settings().optional()),
        ("requireSeparateApprover", S::Bool.optional()),
        ("isActive", S::Bool.optional()),
    ])
}

/// `hrPayrollEmployerBankSchema`.
pub(crate) fn employer_bank() -> S {
    obj(vec![
        ("accountHolder", short_text(140).nullish()),
        ("iban", string(&[Check::Trim, Check::Max(34)]).nullish()),
        ("bic", string(&[Check::Trim, Check::Max(11)]).nullish()),
        ("routingNumber", string(&[Check::Trim, Check::Regex(nine_digits, "Expected a 9-digit routing number")]).nullish()),
        ("accountNumber", string(&[Check::Trim, Check::Regex(four_to_seventeen_digits, "Expected 4–17 digits")]).nullish()),
        ("accountType", S::Enum(&["checking", "savings"]).nullish()),
        ("nachaCompanyId", string(&[Check::Trim, Check::Max(10)]).nullish()),
        ("bankName", short_text(23).nullish()),
    ])
}

fn pay_date_rule() -> S {
    S::DiscUnion(
        "kind",
        vec![
            ("day_of_month", obj(vec![("day", int(Some(1.0), Some(31.0)))])),
            ("offset_after_end", obj(vec![("days", int(Some(-14.0), Some(31.0)))])),
            ("last_business_day", obj(vec![])),
        ],
    )
}

const FREQUENCIES: &[&str] = &["monthly", "four_weekly", "semimonthly", "biweekly", "weekly"];

/// `createHrPayScheduleSchema`.
pub(crate) fn create_schedule() -> S {
    obj(vec![
        ("employerId", id()),
        ("name", short_text_required(120)),
        ("frequency", S::Enum(FREQUENCIES)),
        ("anchorDate", iso_date()),
        ("payDateRule", pay_date_rule()),
    ])
}

/// `updateHrPayScheduleSchema`.
pub(crate) fn update_schedule() -> S {
    obj(vec![
        ("name", short_text_required(120).optional()),
        ("payDateRule", pay_date_rule().optional()),
        ("isActive", S::Bool.optional()),
    ])
}

/// `{ employerId?: string }` as a query.
pub(crate) fn employer_query() -> S {
    obj(vec![("employerId", string(&[]).optional())])
}

fn profile_nl() -> S {
    obj(vec![
        ("writtenContract", S::Bool.optional()),
        ("indefiniteContract", S::Bool.optional()),
        ("onCall", S::Bool.optional()),
        ("isDga", S::Bool.optional()),
        ("insuredWw", S::Bool.nullish()),
        ("insuredZw", S::Bool.nullish()),
        ("insuredWao", S::Bool.nullish()),
        ("incomeRelationshipNumber", int(Some(1.0), Some(999_999_999.0)).nullish()),
        ("caoCode", int(Some(0.0), Some(9999.0)).nullish()),
        ("endReasonCode", string(&[Check::Regex(two_digits, "Expected a two-digit code")]).nullish()),
        ("usualWorkDaysPerWeek", number(Some(1.0), Some(7.0)).nullish()),
        (
            "expatRuling",
            obj(vec![("from", iso_date()), ("to", iso_date().nullish()), ("percent", percent())]).nullish(),
        ),
        ("surnamePrefix", short_text(20).nullish()),
        ("initials", short_text(20).nullish()),
        ("gender", S::Union(vec![S::NumLiteral(0.0), S::NumLiteral(1.0), S::NumLiteral(2.0)]).nullish()),
        ("nationality", string(&[Check::Length(2)]).nullish()),
        ("contractHoursPerWeek", number(Some(0.0), Some(80.0)).nullish()),
    ])
}

fn profile_us() -> S {
    obj(vec![
        ("workState", us_state().nullish()),
        ("residenceState", us_state().nullish()),
        ("flsaStatus", S::Enum(&["exempt", "nonexempt"]).nullish()),
        ("statutoryEmployee", S::Bool.optional()),
        ("retirementPlan", S::Bool.optional()),
        ("exemptFica", S::Bool.optional()),
        ("exemptFuta", S::Bool.optional()),
    ])
}

/// `upsertHrPayrollProfileSchema`.
pub(crate) fn upsert_profile() -> S {
    obj(vec![
        ("employerId", id()),
        ("payScheduleId", id().nullish()),
        ("status", S::Enum(&["active", "paused", "ended"]).optional()),
        ("startDate", iso_date().nullish()),
        ("endDate", iso_date().nullish()),
        ("nl", profile_nl().optional()),
        ("us", profile_us().optional()),
    ])
}

/// `createHrCompensationSchema`.
pub(crate) fn create_compensation() -> S {
    obj(vec![
        ("effectiveFrom", iso_date()),
        ("payType", S::Enum(&["salary", "hourly"])),
        ("amount", non_negative_money()),
        ("period", S::Enum(&["hour", "week", "month", "year"])),
        ("currency", string(&[Check::Length(3)]).optional()),
        ("hoursPerWeek", number(Some(0.0), Some(80.0)).nullish()),
        ("reason", string(&[Check::Max(1000)]).nullish()),
        ("allowRetroactive", S::Bool.optional()),
    ])
}

fn component_params(max: usize) -> S {
    S::Record(
        Box::new(string(&[Check::Max(60)])),
        Box::new(S::Union(vec![number(None, None), string(&[Check::Max(max)]), S::Bool, S::Null])),
    )
}

/// `createHrPayComponentSchema`.
pub(crate) fn create_component() -> S {
    obj(vec![
        ("code", string(&[Check::Min(1), Check::Max(60)])),
        ("label", short_text(160).nullish()),
        ("amount", money().nullish()),
        ("params", component_params(200).optional()),
        ("effectiveFrom", iso_date()),
        ("effectiveTo", iso_date().nullish()),
    ])
}

/// `updateHrPayComponentSchema`.
pub(crate) fn update_component() -> S {
    obj(vec![
        ("label", short_text(160).nullish()),
        ("amount", money().nullish()),
        ("params", component_params(200).optional()),
        ("effectiveFrom", iso_date().optional()),
        ("effectiveTo", iso_date().nullish()),
    ])
}

/// `createHrTaxElectionSchema`.
pub(crate) fn create_election() -> S {
    let w4 = obj(vec![
        ("formYear", int(Some(1990.0), Some(2100.0))),
        ("filingStatus", S::Enum(&["single", "married_jointly", "head_of_household"])),
        ("multipleJobs", S::Bool),
        ("dependentsAmount", non_negative_money()),
        ("otherIncome", non_negative_money()),
        ("deductions", non_negative_money()),
        ("extraWithholding", non_negative_money()),
        ("exempt", S::Bool),
        ("allowances", int(Some(0.0), Some(99.0)).nullish()),
        ("nonresidentAlien", S::Bool.optional()),
    ]);
    let certificate = obj(vec![
        ("filingStatus", short_text(40).nullish()),
        ("allowances", int(Some(0.0), Some(99.0)).nullish()),
        ("values", component_params(60).optional()),
        ("extraWithholding", non_negative_money().nullish()),
        ("exempt", S::Bool.optional()),
    ]);
    S::DiscUnion(
        "kind",
        vec![
            (
                "nl_loonheffingskorting",
                obj(vec![
                    ("effectiveFrom", iso_date()),
                    ("data", obj(vec![("applyCredit", S::Bool)])),
                    ("signatureName", short_text_required(255)),
                ]),
            ),
            (
                "us_w4",
                obj(vec![("effectiveFrom", iso_date()), ("data", w4), ("signatureName", short_text_required(255))]),
            ),
            (
                "us_state_certificate",
                obj(vec![
                    ("state", us_state()),
                    ("effectiveFrom", iso_date()),
                    ("data", certificate),
                    ("signatureName", short_text_required(255)),
                ]),
            ),
        ],
    )
}

/// `hrPayrollPaymentDetailsSchema`.
pub(crate) fn payment_details() -> S {
    obj(vec![
        ("nationalId", string(&[Check::Trim, Check::Regex(bsn_or_ssn, "Expected a BSN or SSN")]).nullish()),
        ("dateOfBirth", iso_date().nullish()),
        ("bankAccountHolder", short_text(140).nullish()),
        ("bankIban", string(&[Check::Trim, Check::Max(34)]).nullish()),
        ("bankBic", string(&[Check::Trim, Check::Max(11)]).nullish()),
        (
            "bankRoutingNumber",
            string(&[Check::Trim, Check::Regex(nine_digits, "Expected a 9-digit routing number")]).nullish(),
        ),
        (
            "bankAccountNumber",
            string(&[Check::Trim, Check::Regex(four_to_seventeen_digits, "Expected 4–17 digits")]).nullish(),
        ),
        ("bankAccountType", S::Enum(&["checking", "savings"]).nullish()),
        ("homeAddress", address().nullish()),
        ("idDocumentType", S::Enum(&["passport", "id_card", "residence_permit", "drivers_license"]).nullish()),
        ("idDocumentNumber", short_text(40).nullish()),
        ("idDocumentExpiresOn", iso_date().nullish()),
        ("idVerifiedAt", iso_date().nullish()),
    ])
}

/// `createHrPayRunSchema` without its `superRefine` ([`create_run_refine`]).
pub(crate) fn create_run() -> S {
    obj(vec![
        ("employerId", id()),
        ("kind", S::Default(Box::new(S::Enum(&["regular", "off_cycle", "correction"])), json!("regular"))),
        ("payScheduleId", id().nullish()),
        ("periodStart", iso_date().optional()),
        ("periodEnd", iso_date().optional()),
        ("payDate", iso_date().optional()),
        ("employeeIds", S::Array(Box::new(id()), Some(1000)).optional()),
        ("correctsRunId", id().optional()),
        ("notes", string(&[Check::Max(2000)]).nullish()),
    ])
}

/// `createHrPayRunSchema`'s `superRefine`, on the parsed value.
pub(crate) fn create_run_refine(value: &Value) -> Vec<Value> {
    let mut issues = vec![];
    let kind = value.get("kind").and_then(Value::as_str).unwrap_or("");
    let truthy = |key: &str| value.get(key).and_then(Value::as_str).is_some_and(|s| !s.is_empty());
    if kind == "regular" && !truthy("payScheduleId") {
        issues.push(json!({ "code": "custom", "path": ["payScheduleId"], "message": "A regular run needs a pay schedule" }));
    }
    if kind == "correction" && !truthy("correctsRunId") {
        issues.push(json!({ "code": "custom", "path": ["correctsRunId"], "message": "A correction run needs the run it corrects" }));
    }
    if kind != "regular" && (!truthy("periodStart") || !truthy("periodEnd") || !truthy("payDate")) && kind != "correction" {
        issues.push(json!({ "code": "custom", "path": ["periodStart"], "message": "An off-cycle run needs its period and pay date" }));
    }
    issues
}

/// `updateHrPayRunSchema`.
pub(crate) fn update_run() -> S {
    obj(vec![("payDate", iso_date().optional()), ("notes", string(&[Check::Max(2000)]).nullish())])
}

/// `setHrPayRunEmployeeSchema`.
pub(crate) fn set_run_employee() -> S {
    obj(vec![("employeeId", id()), ("excluded", S::Bool)])
}

fn run_input_fields() -> Vec<(&'static str, S)> {
    vec![
        ("label", short_text(160).nullish()),
        ("quantity", number(Some(-10_000.0), Some(10_000.0)).nullish()),
        ("rate", number(Some(0.0), Some(100_000.0)).nullish()),
        ("amount", money().nullish()),
        ("workDate", iso_date().nullish()),
        ("notes", string(&[Check::Max(1000)]).nullish()),
    ]
}

/// `createHrPayRunInputSchema`.
pub(crate) fn create_run_input() -> S {
    let mut fields = vec![("employeeId", id()), ("code", string(&[Check::Min(1), Check::Max(60)]))];
    fields.extend(run_input_fields());
    obj(fields)
}

/// `updateHrPayRunInputSchema`.
pub(crate) fn update_run_input() -> S {
    obj(run_input_fields())
}

/// `markHrPayRunPaidSchema`.
pub(crate) fn mark_paid() -> S {
    obj(vec![("paidOn", iso_date().optional())])
}

/// `markHrPayrollFilingFiledSchema`.
pub(crate) fn mark_filed() -> S {
    obj(vec![("externalReference", short_text(120).nullish()), ("filedOn", iso_date().optional())])
}

/// `{ employeeId?: string }` as a query.
pub(crate) fn employee_query() -> S {
    obj(vec![("employeeId", string(&[]).optional())])
}

/// `{ employerId?, onPayroll?: 'true' | 'false' }` (the payroll employees list).
pub(crate) fn payroll_employees_query() -> S {
    obj(vec![("employerId", string(&[]).optional()), ("onPayroll", S::Enum(&["true", "false"]).optional())])
}

/// `z.coerce.number().int().min(2000).max(2100).optional()`.
fn year_query() -> S {
    S::CoerceNum { int: true, min: Some(2000.0), max: Some(2100.0) }.optional()
}

/// The runs list query.
pub(crate) fn runs_query() -> S {
    obj(vec![("employerId", string(&[]).optional()), ("status", string(&[]).optional()), ("year", year_query())])
}

/// The filings list query.
pub(crate) fn filings_query() -> S {
    obj(vec![
        ("employerId", string(&[]).optional()),
        ("year", year_query()),
        ("status", string(&[]).optional()),
        ("kind", string(&[]).optional()),
    ])
}
